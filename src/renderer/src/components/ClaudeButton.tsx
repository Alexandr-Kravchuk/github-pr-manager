import { useCallback, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { ClaudeSessionInfo, PullRequest } from "../../../shared/types";
// Node-free, like pr-filter.ts — value-imported for the tooltip and the menu.
// The button itself sends no kind: main picks again from its own copy of the PR.
import {
  CLAUDE_BUTTON_TEXT,
  CLAUDE_LAUNCH_LABEL,
  claudeKindsFor,
  pickClaudeLaunch,
  type ClaudeLaunchKind,
} from "../../../shared/claude-launch";
import {
  describeSession,
  SESSION_STATUS_TEXT,
  sessionGlow,
  sessionsForPr,
  shownSession,
} from "../../../shared/claude-sessions";
import { cn } from "../format";
import { useAnchoredMenu } from "./anchored-menu";
import { ClaudeEnabledContext, ClaudeSessionsContext } from "./claude-context";

const MENU_WIDTH_PX = 240;
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
  const allSessions = useContext(ClaudeSessionsContext);
  const sessions = useMemo(() => sessionsForPr(pr, allSessions), [pr, allSessions]);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const menu = useAnchoredMenu(sessions.length > 0 ? SESSIONS_MENU_WIDTH_PX : MENU_WIDTH_PX);
  // Without `kind` main picks from the PR's state, exactly as the button shows.
  const launch = useCallback(
    (kind?: ClaudeLaunchKind) => {
      setState("busy");
      window.api
        .launchClaude(pr.id, kind)
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
    },
    [pr.id],
  );
  const focus = useCallback((sessionId: string) => {
    window.api
      .focusClaudeSession(sessionId)
      .then((res) => {
        if (!res.ok) window.alert(res.error);
      })
      .catch((e: unknown) => window.alert((e as Error).message));
  }, []);

  if (!enabled) return null;
  const kind = pickClaudeLaunch(pr, { trackComments });
  // `sessionsForPr` puts the one that most needs the user first.
  const shown = shownSession(sessions);
  const current = shown?.where === "background" ? undefined : shown;
  const more = sessions.length > 1 ? ` ${sessions.length - 1} more in the menu.` : "";
  const label = current
    ? `Claude session ${describeSession(current)}. Click to switch to it.${more}`
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
    <span className={cn("inline-flex shrink-0 whitespace-nowrap", className)}>
      <button
        type="button"
        onClick={() => (current ? focus(current.id) : launch())}
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
        ref={menu.buttonRef}
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
                      focus(s.id);
                    }}
                  />
                ))}
                <div className={cn(MENU_HEADING, "mt-1 border-t border-line pt-2")}>Start a new session</div>
              </>
            )}
            {claudeKindsFor(pr).map((k) => (
              <button
                key={k}
                type="button"
                role="menuitem"
                onClick={() => {
                  menu.close();
                  launch(k);
                }}
                title={`Start Claude in the repo folder to ${CLAUDE_LAUNCH_LABEL[k]}`}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated"
              >
                <span className={cn("h-2 w-2 shrink-0 rounded-full", KIND_DOT[k])} aria-hidden />
                <span className={cn("flex-1", k === kind ? "font-semibold text-fg" : "text-fg-secondary")}>
                  {CLAUDE_BUTTON_TEXT[k]}
                </span>
                {k === kind && <span className="text-xs text-fg-subtle">suggested</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * The card's glow while a Claude session works on the PR (orange) or waits for
 * the user (fuchsia), from the corner the button sits in. The parent needs
 * `relative isolate overflow-hidden`: `-z-10` keeps the glow under the text,
 * and `isolate` keeps it above the card's own background.
 */
export function ClaudeGlow({ pr }: { pr: PullRequest }) {
  const enabled = useContext(ClaudeEnabledContext);
  const allSessions = useContext(ClaudeSessionsContext);
  const session = useMemo(() => shownSession(sessionsForPr(pr, allSessions)), [pr, allSessions]);
  const glow = sessionGlow(session);
  if (!enabled || !session || !glow) return null;
  // Keyed on the status, not on the push: the breaths replay only when it changes.
  return (
    <span
      key={`${session.id}:${glow}`}
      aria-hidden
      className={cn("claude-glow pointer-events-none absolute inset-0 -z-10", `claude-glow-${glow}`)}
    />
  );
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

/** The menu's colour key — the same colour each kind gives the button. */
const KIND_DOT: Record<ClaudeLaunchKind, string> = {
  drive: "bg-red-500",
  review: "bg-violet-500",
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
