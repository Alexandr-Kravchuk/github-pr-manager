import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import type { ClaudeSessionInfo, PullRequest } from "../../../shared/types";
// Node-free, like pr-filter.ts — value-imported for the tooltip and the menu.
// The button itself sends no kind: main picks again from its own copy of the PR.
import {
  CLAUDE_BUTTON_TEXT,
  CLAUDE_LAUNCH_LABEL,
  claudeMenuItems,
  claudeMenuTarget,
  isReviewKind,
  type ClaudeMenuItem,
  groupLaunchPrs,
  MAX_GROUP_PRS,
  pickClaudeLaunch,
  type ClaudeLaunchKind,
  type GroupLaunchKind,
} from "../../../shared/claude-launch";
import {
  describeSession,
  GROUP_STATUS_TEXT,
  groupKindOf,
  SESSION_STATUS_TEXT,
  sessionGlow,
  sessionsForGroup,
  sessionsForPr,
  shownSession,
} from "../../../shared/claude-sessions";
import { cn } from "../format";
import { forgetAnswer, isAnswered, markAnswered, needsYouVersion, subscribeNeedsYou, subscribeShown, windowShown } from "../needs-you";
import { useAnchoredMenu } from "./anchored-menu";
import { ClaudeDesktopContext, ClaudeEnabledContext, ClaudeSessionsContext, CodexAvailableContext } from "./claude-context";

const MENU_WIDTH_PX = 280;
/** Wider once it lists sessions: their titles carry a task key and a summary. */
const SESSIONS_MENU_WIDTH_PX = 320;

/**
 * "Start a Claude session on this PR" — a split button. The main part starts
 * the action the PR's state suggests; the arrow opens a menu of every action,
 * so a PR the state calls "Drive to green" can still be closed (or reviewed)
 * on purpose. Renders nothing while the integration is off.
 *
 * While a Claude session is on the PR the main part belongs to it: it says
 * what the session is doing (working / needs you / idle, or paused — a Desktop
 * session whose process Desktop stopped without archiving it) and a click
 * switches to it — its Claude Desktop session or its terminal tab. Starting a
 * second one moves to the menu, because two sessions on one PR edit the same
 * branch over each other. A session with no window (`claude -p`, the SDK) is
 * listed in the menu but cannot take the button, since there is nothing to
 * switch to.
 */
export function ClaudeButton({
  pr,
  trackComments,
  compact = false,
  iconOnly = false,
  className,
}: {
  pr: PullRequest;
  trackComments: boolean;
  /** Smaller text for the table row and the tile. */
  compact?: boolean;
  /** Just the mark, coloured by the action — the tile's glyph row has no room for a label. */
  iconOnly?: boolean;
  className?: string;
}) {
  const enabled = useContext(ClaudeEnabledContext);
  const desktop = useContext(ClaudeDesktopContext);
  const codex = useContext(CodexAvailableContext);
  const allSessions = useContext(ClaudeSessionsContext);
  const sessions = useMemo(() => sessionsForPr(pr, allSessions), [pr, allSessions]);
  const [state, run] = useLaunchState();
  // Anchored on the whole split button: the menu hangs under its left edge,
  // and a click on either half is "inside" it.
  const menu = useAnchoredMenu<HTMLSpanElement>(sessions.length > 0 ? SESSIONS_MENU_WIDTH_PX : MENU_WIDTH_PX);
  // Without `kind` main picks from the PR's state, exactly as the button shows.
  const launch = useCallback(
    (kind?: ClaudeLaunchKind, inTerminal?: boolean) => run(() => window.api.launchClaude(pr.id, kind, inTerminal)),
    [run, pr.id],
  );

  if (!enabled) return null;
  const kind = pickClaudeLaunch(pr, { trackComments });
  // `sessionsForPr` puts the one that most needs the user first.
  const shown = shownSession(sessions);
  const current = shown?.where === "background" ? undefined : shown;
  // With several sessions on the PR the status can't say which one a click
  // means, so the main part opens the menu that lists them all.
  const choose = sessions.length > 1;
  const label = choose
    ? `${sessions.length} Claude sessions on this PR — click to choose one. Shown: ${describeSession(shown!)}.`
    : current
    ? `Claude session ${describeSession(current)}. Click to switch to it.`
    : `Start Claude in the repo folder to ${CLAUDE_LAUNCH_LABEL[kind]}${shown ? `. Running: ${describeSession(shown)}.` : ""}`;
  const tone = state === "done" ? KIND_CLASS.done : current ? SESSION_CLASS[current.status] : KIND_CLASS[kind];
  const text = state === "done" ? "Started" : current ? SESSION_STATUS_TEXT[current.status] : CLAUDE_BUTTON_TEXT[kind];
  const segment = cn(
    "inline-flex items-center border font-medium transition-colors disabled:opacity-50",
    iconOnly ? "h-[18px]" : compact ? "py-0.5 text-[11px]" : "py-1 text-xs",
    tone,
  );
  const mainPadding = iconOnly ? "px-1" : compact ? "pl-1.5 pr-1" : "pl-2 pr-1.5";
  return (
    <span ref={menu.buttonRef} data-split className={cn("inline-flex shrink-0 whitespace-nowrap", className)}>
      <button
        type="button"
        onClick={() => (choose ? menu.toggle() : current ? focusSession(current.id) : launch())}
        aria-haspopup={choose ? "menu" : undefined}
        aria-expanded={choose ? menu.open : undefined}
        disabled={state === "busy"}
        title={iconOnly ? `${text} — ${label}` : label}
        aria-label={label}
        className={cn(segment, "relative flex-1 justify-center gap-1 rounded-l-md", mainPadding)}
      >
        <ClaudeMark size={compact || iconOnly ? 12 : 14} />
        {shown && state !== "done" && (
          <StatusDot
            status={shown.status}
            // The tile's button has no room for a dot beside the mark — it sits on its corner.
            className={iconOnly ? "absolute -right-0.5 -top-0.5 ring-2 ring-surface" : undefined}
          />
        )}
        {!iconOnly && text}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          menu.toggle();
        }}
        disabled={state === "busy"}
        title="Choose what Claude does"
        aria-label="Choose what Claude does"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        className={cn(segment, "-ml-px rounded-r-md", compact || iconOnly ? "px-0.5" : "px-1")}
      >
        <ChevronDown size={compact || iconOnly ? 10 : 12} />
      </button>
      {menu.open &&
        createPortal(
          <div
            ref={menu.menuRef}
            role="menu"
            aria-label={sessions.length > 0 ? "Claude sessions" : "Start Claude to"}
            style={menu.style}
            className="z-50 overflow-hidden rounded-lg border border-line bg-surface py-1 text-sm shadow-xl"
          >
            {sessions.length > 0 && (
              <>
                <div className={MENU_HEADING}>Running on this PR</div>
                {sessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    onSwitch={() => {
                      menu.close();
                      focusSession(s.id);
                    }}
                  />
                ))}
                <div className={cn(MENU_HEADING, "mt-1 border-t border-line pt-2")}>Start a new session</div>
              </>
            )}
            {groupReviewItems(claudeMenuItems(pr, desktop, codex)).map((group) => {
              const rows = group.items.map((item) => {
                const { kind: k, inTerminal } = item;
                const target = claudeMenuTarget(item, desktop);
                const tool = target?.name ?? "Claude";
                return (
                  <button
                    key={inTerminal ? `${k}-terminal` : k}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      menu.close();
                      launch(k, inTerminal);
                    }}
                    title={`Start ${tool}${inTerminal ? " in a terminal" : ""} in the repo folder to ${CLAUDE_LAUNCH_LABEL[k]}`}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated"
                  >
                    {target ? (
                      <span className="flex w-2 shrink-0 justify-center" aria-hidden>
                        {target.tool === "codex" ? <CodexMark size={12} /> : <ClaudeMark size={12} />}
                      </span>
                    ) : (
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", KIND_DOT[k])} aria-hidden />
                    )}
                    <span className="flex-1 text-fg-secondary">{target ? `${CLAUDE_BUTTON_TEXT.review} with ${target.name}` : CLAUDE_BUTTON_TEXT[k]}</span>
                    {target && <span className="text-xs text-fg-subtle">{target.place}</span>}
                  </button>
                );
              });
              return group.review ? (
                <div key="review-group" role="group" aria-label="Review" className="my-1 border-y border-line py-1">
                  {rows}
                </div>
              ) : (
                rows
              );
            })}
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * The "needs you" pulse: the whole tile grows a little and settles back,
 * again and again until the user clicks the tile or anything in it. It is
 * the one animation in the renderer that runs on until something happens
 * (AGENTS.md), so it runs only while the window is on screen — paused while
 * hidden to the tray or minimized, focused or not — and only on transform, which the
 * compositor applies to a cached layer.
 *
 * The tile scales about the centre of its Claude button, and the button
 * scales back by the inverse about that same point, so the button neither
 * moves nor changes size: it stays easy to hit. The tile is lifted above its
 * neighbours while it pulses, or a grown tile slides under the next one.
 */
const PULSE_SCALE = 1.04;
const PULSE_TIMING: KeyframeAnimationOptions = { duration: 900, iterations: Infinity, easing: "ease-in-out" };

function startPulse(tile: HTMLElement, button: HTMLElement | null): { pause(): void; play(): void; stop(): void } {
  const t = tile.getBoundingClientRect();
  const anims: Animation[] = [];
  if (button) {
    const b = button.getBoundingClientRect();
    tile.style.transformOrigin = `${b.left - t.left + b.width / 2}px ${b.top - t.top + b.height / 2}px`;
    anims.push(
      button.animate(
        [{ transform: "scale(1)" }, { transform: `scale(${1 / PULSE_SCALE})` }, { transform: "scale(1)" }],
        PULSE_TIMING,
      ),
    );
  }
  anims.push(
    tile.animate([{ transform: "scale(1)" }, { transform: `scale(${PULSE_SCALE})` }, { transform: "scale(1)" }], PULSE_TIMING),
  );
  tile.style.zIndex = "5";
  return {
    pause: () => anims.forEach((a) => a.pause()),
    play: () => anims.forEach((a) => a.play()),
    stop: () => {
      anims.forEach((a) => a.cancel());
      tile.style.transformOrigin = "";
      tile.style.zIndex = "";
    },
  };
}

/**
 * The card's glow while a Claude session works on the PR (orange) or waits for
 * the user (fuchsia). Working is a wash from the corner the button sits in.
 * Waiting asks for the user, so it takes the whole tile: a fuchsia wash and an
 * inset ring that stay lit, and the tile itself pulses in size until the user
 * clicks it. The parent needs `relative isolate overflow-hidden`: `-z-10`
 * keeps the glow under the text, and `isolate` keeps it above the card's own
 * background.
 */
export function ClaudeGlow({ pr }: { pr: PullRequest }) {
  const enabled = useContext(ClaudeEnabledContext);
  const allSessions = useContext(ClaudeSessionsContext);
  const session = useMemo(() => shownSession(sessionsForPr(pr, allSessions)), [pr, allSessions]);
  const glow = sessionGlow(session);
  const shown = useSyncExternalStore(subscribeShown, windowShown);
  const ref = useRef<HTMLSpanElement>(null);
  const pulse = useRef<ReturnType<typeof startPulse> | null>(null);
  const answered = useSyncExternalStore(subscribeNeedsYou, needsYouVersion);
  const waitingId = enabled && glow === "waiting" ? session?.id : undefined;
  if (session && glow !== "waiting") forgetAnswer(session.id);

  // The ring: the tile's own outline (styles.css), lit for the whole wait.
  useEffect(() => {
    const tile = ref.current?.parentElement;
    if (!waitingId || !tile) return;
    tile.dataset.needsYou = "";
    return () => {
      delete tile.dataset.needsYou;
    };
  }, [waitingId]);

  // Start on a wait the user hasn't answered; any click in the tile answers it.
  useEffect(() => {
    const tile = ref.current?.parentElement;
    if (!waitingId || !tile || isAnswered(waitingId)) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const p = startPulse(tile, tile.querySelector<HTMLElement>("[data-split]"));
    pulse.current = p;
    const answer = () => markAnswered(waitingId);
    tile.addEventListener("pointerdown", answer, true);
    return () => {
      tile.removeEventListener("pointerdown", answer, true);
      p.stop();
      pulse.current = null;
    };
  }, [waitingId, answered]);

  // Frames only while the window is on screen, focused or not.
  useEffect(() => {
    if (shown) pulse.current?.play();
    else pulse.current?.pause();
  }, [shown, waitingId, answered]);

  if (!enabled || !session || !glow) return null;
  // Keyed on the status, not on the push: the breaths replay only when it changes.
  return (
    <span
      ref={ref}
      key={`${session.id}:${glow}`}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 -z-10",
        glow === "waiting" ? "claude-attention" : "claude-glow claude-glow-busy",
      )}
    />
  );
}

/**
 * A launch button's state — idle, waiting for main, or "Started" for a
 * moment — and `run`, which starts a launch and shows its refusal.
 */
function useLaunchState(): [
  "idle" | "busy" | "done",
  (start: () => Promise<{ ok: true } | { ok: false; error: string }>) => void,
] {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const run = useCallback((start: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setState("busy");
    start()
      .then((res) => {
        if (res.ok) {
          setState("done");
          setTimeout(() => setState("idle"), 1500);
        } else {
          setState("idle");
          window.alert(res.error);
        }
      })
      .catch((e: unknown) => {
        setState("idle");
        window.alert((e as Error).message);
      });
  }, []);
  return [state, run];
}

/** Brings a running session to the front; a refusal says why. */
function focusSession(sessionId: string): void {
  window.api
    .focusClaudeSession(sessionId)
    .then((res) => {
      if (!res.ok) window.alert(res.error);
    })
    .catch((e: unknown) => window.alert((e as Error).message));
}

const MENU_HEADING = "px-3 pb-1 pt-1 text-xs font-semibold text-fg-subtle";

const WHERE_TEXT: Record<ClaudeSessionInfo["where"], string> = {
  desktop: "Claude Desktop",
  terminal: "terminal",
  background: "background, no window",
};

/** One running session in the menu: its title, its status and where a click takes you. */
function SessionItem({ session, onSwitch }: { session: ClaudeSessionInfo; onSwitch: () => void }) {
  const background = session.where === "background";
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSwitch}
      disabled={background}
      title={background ? describeSession(session) : `Switch to ${describeSession(session)}`}
      className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-elevated disabled:cursor-default disabled:hover:bg-transparent"
    >
      <StatusDot status={session.status} className="mt-1.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-fg">{session.name}</span>
        <span className="block text-xs text-fg-subtle">
          {SESSION_STATUS_TEXT[session.status].toLowerCase()}
          {session.waitingFor && ` (${session.waitingFor})`} · {WHERE_TEXT[session.where]}
        </span>
      </span>
    </button>
  );
}

/** A session's status as a dot — static: an infinite animation would keep the GPU busy while hidden. */
function StatusDot({ status, className }: { status: ClaudeSessionInfo["status"]; className?: string }) {
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", SESSION_DOT[status], className)} aria-hidden />;
}

const SESSION_DOT: Record<ClaudeSessionInfo["status"], string> = {
  busy: "bg-orange-500",
  waiting: "bg-fuchsia-500",
  idle: "bg-fg-subtle",
  // Hollow: the session is there, its process is not. A border, since the tile adds a ring of its own.
  paused: "border border-fg-subtle bg-surface",
};

/** The button while a session holds it: orange like the mark while it works, fuchsia when it waits for you. */
const SESSION_CLASS: Record<ClaudeSessionInfo["status"], string> = {
  busy: "border-orange-500/50 bg-orange-500/10 text-orange-700 hover:bg-orange-500/20 dark:text-orange-300",
  waiting:
    "border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-700 hover:bg-fuchsia-500/20 dark:text-fuchsia-300",
  idle: "border-line-strong bg-elevated/60 text-fg-secondary hover:bg-elevated",
  paused: "border-line-strong bg-elevated/60 text-fg-secondary hover:bg-elevated",
};

/** Consecutive review items form one group (rendered with dividers); every other item stands alone. */
function groupReviewItems(items: ClaudeMenuItem[]): { review: boolean; items: ClaudeMenuItem[] }[] {
  const out: { review: boolean; items: ClaudeMenuItem[] }[] = [];
  for (const item of items) {
    const review = isReviewKind(item.kind);
    const last = out[out.length - 1];
    if (last && last.review === review) last.items.push(item);
    else out.push({ review, items: [item] });
  }
  return out;
}

/** A plain terminal prompt — the mark of the Codex CLI row, in the text colour (no vendor logo). */
function CodexMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="m5 7 6 5-6 5" />
      <path d="M13 18h6" />
    </svg>
  );
}

/** The menu's colour key — the same colour each kind gives the button. */
const KIND_DOT: Record<ClaudeLaunchKind, string> = {
  drive: "bg-red-500",
  review: "bg-violet-500",
  codexReview: "bg-violet-500",
  close: "bg-emerald-500",
  explain: "bg-sky-500",
  open: "bg-line-strong",
};

function ChevronDown({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Coloured like the card accent the state comes from, so the button reads with the card. */
const KIND_CLASS: Record<ClaudeLaunchKind | "done", string> = {
  drive:
    "border-red-500/50 bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-300",
  review:
    "border-violet-500/50 bg-violet-500/10 text-violet-700 hover:bg-violet-500/20 dark:text-violet-300",
  close:
    "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300",
  codexReview:
    "border-indigo-500/50 bg-indigo-500/10 text-indigo-700 hover:bg-indigo-500/20 dark:text-indigo-300",
  explain: "border-sky-500/50 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300",
  open: "border-line-strong bg-elevated/60 text-fg-secondary hover:bg-elevated",
  done: "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

/**
 * The Claude spark — twelve tapered rays, in Claude's orange whatever the
 * button's colour, so the mark alone says which tool the click starts.
 */
function ClaudeMark({ size }: { size: number }) {
  const rays = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <g fill="#D97757">
        {rays.map((deg, i) => (
          <path
            key={deg}
            // Alternating ray lengths give the hand-drawn burst its uneven edge.
            d={i % 2 === 0 ? "M11 12 L12 1.2 L13 12 Z" : "M11.2 12 L12 3.4 L12.8 12 Z"}
            transform={`rotate(${deg} 12 12)`}
          />
        ))}
        <circle cx="12" cy="12" r="2.2" />
      </g>
    </svg>
  );
}

/**
 * The Claude button beside a Jira group heading's PR count. Two actions, both
 * sending only the kind, the key and the PR ids — main reads the PRs from its
 * own snapshot and picks them again:
 *  - "Explain all" — one session that explains the group's open PRs together
 *    (the goal, how the changes fit, the order to read them in, where they
 *    overlap), shown in the session, no letter;
 *  - "Review all" — a parent session that starts one nested Claude Desktop
 *    session per PR awaiting your review and sums their reports up. Offered
 *    only with Claude Desktop, the one place a session can nest others; with a
 *    terminal it stays in the menu, disabled, saying why.
 *
 * Split like the PR's own button: while a session of this key runs, the main
 * part shows its status in that kind's words (`GROUP_STATUS_TEXT`) and a click
 * switches to it; otherwise it starts "Explain all". The arrow lists the
 * running sessions and both actions. Renders nothing while the integration is
 * off or the group offers neither action (`groupLaunchPrs`).
 */
export function GroupClaudeButton({
  groupKey,
  prs,
}: {
  groupKey: string;
  prs: readonly PullRequest[];
}) {
  const enabled = useContext(ClaudeEnabledContext);
  // Whether sessions open in Claude Desktop — "Review all" needs it.
  const desktop = useContext(ClaudeDesktopContext);
  const allSessions = useContext(ClaudeSessionsContext);
  const sessions = useMemo(() => sessionsForGroup(groupKey, allSessions), [groupKey, allSessions]);
  const [state, run] = useLaunchState();
  const menu = useAnchoredMenu<HTMLSpanElement>(SESSIONS_MENU_WIDTH_PX);
  const explainPrs = useMemo(() => groupLaunchPrs("explain", groupKey, prs), [groupKey, prs]);
  const reviewPrs = useMemo(() => groupLaunchPrs("review", groupKey, prs), [groupKey, prs]);
  const launch = useCallback(
    (kind: GroupLaunchKind) => {
      const picked = kind === "explain" ? explainPrs : reviewPrs;
      if (picked) run(() => window.api.launchClaudeGroup(kind, groupKey, picked.map((p) => p.id)));
    },
    [run, groupKey, explainPrs, reviewPrs],
  );

  if (!enabled || (!explainPrs && !reviewPrs)) return null;
  const drafts = prs.filter((p) => p.isDraft).length;
  const explainLabel = explainPrs
    ? `Start Claude to explain the ${explainPrs.length} open PRs of ${groupKey} together` +
      (prs.length - drafts > MAX_GROUP_PRS ? ` (the first ${MAX_GROUP_PRS} shown)` : "") +
      (drafts > 0 ? `; ${drafts} draft${drafts === 1 ? "" : "s"} left out` : "")
    : `${groupKey} has fewer than two open PRs to explain together`;
  const reviewLabel = !reviewPrs
    ? `None of the PRs of ${groupKey} waits for your review`
    : !desktop
      ? "Review all starts one nested session per PR, which only Claude Desktop can do — choose Claude Desktop in Settings → Claude"
      : `Start Claude Desktop to review the ${reviewPrs.length} PR${reviewPrs.length === 1 ? "" : "s"} of ${groupKey} ` +
        "that wait for your review, one nested session per PR, and sum the reviews up";
  const shown = shownSession(sessions);
  const current = shown?.where === "background" ? undefined : shown;
  const words = (s: ClaudeSessionInfo) => GROUP_STATUS_TEXT[groupKindOf(s, groupKey)][s.status];
  const choose = sessions.length > 1;
  // With no session the main part starts what the group offers, Explain first.
  const mainKind: GroupLaunchKind = explainPrs ? "explain" : "review";
  const mainDisabled = !current && mainKind === "review" && !desktop;
  const label = choose
    ? `${sessions.length} Claude sessions on this group — click to choose one. Shown: ${words(shown!)}: ${describeSession(shown!)}.`
    : current
    ? `${words(current)}: ${describeSession(current)}. Click to switch to it.`
    : mainKind === "explain"
      ? explainLabel
      : reviewLabel;
  const tone = state === "done" ? KIND_CLASS.done : current ? SESSION_CLASS[current.status] : KIND_CLASS[mainKind];
  const text = state === "done" ? "Started" : current ? words(current) : mainKind === "explain" ? "Explain all" : "Review all";
  const segment = cn(
    "inline-flex items-center border py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50",
    tone,
  );
  const actions: Array<{ kind: GroupLaunchKind; text: string; title: string; disabled: boolean }> = [
    { kind: "explain", text: "Explain all", title: explainLabel, disabled: !explainPrs },
    {
      kind: "review",
      text: reviewPrs ? `Review all (${reviewPrs.length})` : "Review all",
      title: reviewLabel,
      disabled: !reviewPrs || !desktop,
    },
  ];
  return (
    <span ref={menu.buttonRef} data-split className="inline-flex shrink-0 whitespace-nowrap">
      <button
        type="button"
        onClick={() => (choose ? menu.toggle() : current ? focusSession(current.id) : launch(mainKind))}
        aria-haspopup={choose ? "menu" : undefined}
        aria-expanded={choose ? menu.open : undefined}
        disabled={state === "busy" || (!choose && mainDisabled)}
        title={label}
        aria-label={label}
        className={cn(segment, "gap-1 rounded-l-md pl-1.5 pr-1")}
      >
        <ClaudeMark size={12} />
        {shown && state !== "done" && <StatusDot status={shown.status} />}
        {text}
      </button>
      <button
        type="button"
        onClick={menu.toggle}
        disabled={state === "busy"}
        title="Claude on this group"
        aria-label="Claude on this group"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        className={cn(segment, "-ml-px rounded-r-md px-0.5")}
      >
        <ChevronDown size={10} />
      </button>
      {menu.open &&
        createPortal(
          <div
            ref={menu.menuRef}
            role="menu"
            aria-label="Claude on this group"
            style={menu.style}
            className="z-50 overflow-hidden rounded-lg border border-line bg-surface py-1 text-sm shadow-xl"
          >
            {sessions.length > 0 && (
              <>
                <div className={MENU_HEADING}>Running for {groupKey}</div>
                {sessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    onSwitch={() => {
                      menu.close();
                      focusSession(s.id);
                    }}
                  />
                ))}
                <div className={cn(MENU_HEADING, "mt-1 border-t border-line pt-2")}>Start a new session</div>
              </>
            )}
            {actions.map((a) => (
              <button
                key={a.kind}
                type="button"
                role="menuitem"
                disabled={a.disabled}
                onClick={() => {
                  menu.close();
                  launch(a.kind);
                }}
                title={a.title}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <span className={cn("h-2 w-2 shrink-0 rounded-full", KIND_DOT[a.kind])} aria-hidden />
                <span className="flex-1 text-fg-secondary">{a.text}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}
