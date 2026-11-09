import { useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";

// Node-free (see AGENTS.md): where each PR stands, the day, and the plan's current step.
import {
  agentSummary,
  BOARD_COLUMNS,
  BOARD_LANES,
  COLUMN_TITLES,
  inLine,
  queueOrder,
  runFor,
  stageColumns,
  stageLine,
  todayKey,
  type BoardColumn,
  type BoardLane,
  type StageCard,
} from "../../../shared/agent-view";
import { currentStep } from "../../../shared/agent-stream";
import type { PublishSummary } from "../../../shared/agent-publish";
import { resultCard, type FindingSeverity, type RunAsk, type RunFinding } from "../../../shared/agent-result";
import type { AgentAction, AgentItem, AgentState, MergeMethod, PullRequest } from "../../../shared/types";
import { cn, relativeTime } from "../format";
import { AgentContext } from "./agent-context";
import { AgentDiagrams } from "./AgentDiagrams";

// The Board: every PR in the column of whose move it is — yours, the agent's,
// the people you wait on — or done today, in two lanes: your PRs and the PRs
// you review. One card per PR (`stageColumns`, which the chip and the tray
// read too). A card in Your move has one button for the one thing to do, the
// rest under ⋯; the other columns are there to look at. It follows the
// dashboard's filters and says how many prepared moves they hide. The columns
// are its order, so Sort and Group-by are off while it is on.

const LANE_TITLE: Record<BoardLane, string> = { mine: "Your PRs", review: "PRs you review" };
const LANE_DOT: Record<BoardLane, string> = { mine: "bg-violet-500", review: "bg-sky-500" };
const COLUMN_EMPTY: Record<BoardLane, Record<BoardColumn, string>> = {
  mine: { you: "Nothing waits for you", agent: "Nothing for the agent", waiting: "None waits on reviewers", done: "Nothing merged yet today" },
  review: { you: "Nothing waits for you", agent: "Nothing for the agent", waiting: "None waits on its author", done: "Nothing finished yet today" },
};
const COLUMN_DOT: Record<BoardColumn, string> = { you: "bg-amber-500", agent: "bg-sky-500", waiting: "bg-zinc-400 dark:bg-zinc-500", done: "bg-emerald-500" };

/** An answer is a note to the session, like a hint (main holds it to the same bound). */
const AGENT_ANSWER_MAX = 2_000;

const BTN = "inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-elevated disabled:opacity-60";
const BTN_PRIMARY = "inline-flex items-center gap-1 rounded-md border border-sky-600 bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-60";
const LINK = "text-xs text-sky-700 hover:underline dark:text-sky-300";

type Run = (a: AgentAction) => Promise<boolean>;

function shortRepo(repo: string): string {
  return repo.split("/")[1] ?? repo;
}

function openUrl(url: string): void {
  window.api.openExternal(url).catch(() => {});
}

export function PrBoard({
  prs,
  all,
  onOpen,
  focus,
  onClearFilters,
}: {
  /** The PRs the dashboard's filters let through. */
  prs: PullRequest[];
  /** Every PR in the snapshot — to tell a filtered-out PR from one that left the dashboard. */
  all: PullRequest[];
  onOpen: (pr: PullRequest) => void;
  focus?: { runId: string | null; n: number };
  onClearFilters?: () => void;
}) {
  const { state, act } = useContext(AgentContext);
  // Asked to show an item: its card, scrolled to and flashing (a finite animation).
  useEffect(() => {
    if (!focus?.runId) return;
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(focus.runId ?? "")}"]`);
      if (!el) return;
      // At once, not smoothly: a smooth scroll can be dropped by a render landing mid-way.
      el.scrollIntoView({ block: "center" });
      el.classList.remove("focus-flash");
      void el.offsetWidth;
      el.classList.add("focus-flash");
      window.setTimeout(() => el.classList.remove("focus-flash"), 3000);
    }, 50);
    return () => window.clearTimeout(t);
  }, [focus?.n, focus?.runId]);
  const [notice, setNotice] = useState<string | null>(null);

  if (!state) {
    return <div className="rounded-lg border border-line bg-surface/40 p-8 text-center text-sm text-fg-subtle">The PR agent isn&apos;t available here.</div>;
  }
  const board = stageColumns(prs, all, state, { today: todayKey(new Date()), idle: state.idle, orchestrated: state.orchestrated });
  const sum = agentSummary(state);
  // The queue is one queue: a card's place in it, whichever lane shows it.
  const queue = queueOrder(state.items.filter((i) => i.state === "queued"));
  const place = new Map(queue.map((i, n) => [i.runId, n + 1]));
  const run: Run = async (action) => {
    const res = await act(action);
    setNotice(res.ok ? null : res.error);
    return res.ok;
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg-muted">
        <span className="text-sm font-semibold text-fg">PR agent</span>
        {state.enabled ? (
          <>
            <span>
              {sum.running > 0 ? `Working on ${sum.running}` : "Not working on any"}
              {sum.pausedRuns > 0 && ` (${sum.pausedRuns} paused)`}
              {sum.queued > 0 && ` · ${sum.queued} in line`} · runs today {state.runsToday} of {state.perDay}
            </span>
            {sum.block === "paused" && <span className="font-medium text-amber-700 dark:text-amber-300">Paused — nothing starts, and nothing goes out on its own</span>}
            {sum.block === "quiet" && <span>{sum.blockText} — only what you ask for starts</span>}
            {sum.block === "usage" && <span className="text-amber-700 dark:text-amber-300">Claude&apos;s {sum.blockText?.toLowerCase()}</span>}
            {sum.block === "daily" && (
              <span className="text-amber-700 dark:text-amber-300">
                {sum.blockText} — {sum.queued > 0 ? `${sum.queued} in line wait` : "new runs wait"} until tomorrow (Settings › Agent › Limits)
              </span>
            )}
            {state.suggestOn && (
              <span className="text-emerald-700 dark:text-emerald-300">
                You sent {state.acceptedUnchanged} reviews exactly as drafted — reviews can go On in Settings › Agent.
              </span>
            )}
          </>
        ) : (
          <span>Off — the Board still shows whose move each PR is; switch the agent on in Settings › Agent.</span>
        )}
        {board.hiddenReady > 0 && (
          <span className="text-amber-700 dark:text-amber-300">
            {board.hiddenReady} ready for you {board.hiddenReady === 1 ? "is" : "are"} hidden by the filters
            {onClearFilters && (
              <>
                {" · "}
                <button type="button" className="font-medium underline" onClick={onClearFilters}>
                  Clear
                </button>
              </>
            )}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
          {notice && (
            <span className="text-red-700 dark:text-red-300" role="alert">
              {notice}
            </span>
          )}
          {state.enabled && (
            <button type="button" className={BTN} onClick={() => void run({ type: state.paused ? "resumeAgent" : "pauseAgent" })}>
              {state.paused ? "Resume agent" : "Pause agent"}
            </button>
          )}
        </span>
      </div>

      {BOARD_LANES.map((lane) => {
        const cols = board[lane];
        return (
          <section key={lane} aria-label={LANE_TITLE[lane]} className="mb-4">
            <h2 className="mb-2 flex items-baseline gap-2 px-1">
              <span aria-hidden className={cn("inline-block size-2 self-center rounded-full", LANE_DOT[lane])} />
              <span className="text-sm font-semibold text-fg">{LANE_TITLE[lane]}</span>
              {cols.you.length > 0 && <span className="text-xs text-amber-700 dark:text-amber-300">{cols.you.length} your move</span>}
            </h2>
            <div className="flex items-start gap-3 overflow-x-auto pb-2">
              {BOARD_COLUMNS.map((col) => (
                <Column
                  key={col}
                  title={COLUMN_TITLES[lane][col]}
                  count={cols[col].length}
                  dot={COLUMN_DOT[col]}
                  className={col === "you" ? "min-w-[15rem] flex-[1.6] border-amber-500/50 bg-amber-500/[0.05]" : "min-w-[11rem] flex-1"}
                  aside={
                    col === "done" && cols.earlier > 0 ? (
                      <span className="text-[11px] text-fg-subtle" title="Your approvals from earlier days: their PRs wait on others now">
                        +{cols.earlier} earlier
                      </span>
                    ) : undefined
                  }
                >
                  {cols[col].length === 0 ? (
                    <Empty>{state.enabled || col !== "agent" ? COLUMN_EMPTY[lane][col] : "The agent is off"}</Empty>
                  ) : (
                    cols[col].map((card) => (
                      <BoardCard key={card.prId} card={card} state={state} place={place} first={queue[0]?.runId ?? null} run={run} onOpen={() => (card.pr ? onOpen(card.pr) : card.stage.item && openUrl(card.stage.item.url))} />
                    ))
                  )}
                </Column>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Column({ title, count, dot, className, aside, children }: { title: string; count: number; dot: string; className?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className={cn("flex basis-0 flex-col self-stretch rounded-lg border border-line bg-elevated/40", className)}>
      <header className="flex items-center gap-2 px-3 py-2">
        <span aria-hidden className={cn("inline-block size-2 rounded-full", dot)} />
        <h3 className="text-sm font-semibold text-fg-secondary">{title}</h3>
        <span className="rounded-full border border-line-strong px-1.5 text-xs tabular-nums text-fg-muted">{count}</span>
        <span className="flex-1" />
        {aside}
      </header>
      <div className="flex flex-1 flex-col gap-2 px-2 pb-2">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-1 py-4 text-center text-xs text-fg-faint">{children}</div>;
}

interface MenuItem {
  label: string;
  title?: string;
  action: () => void | Promise<unknown>;
}

/** What the ⋯ menu offers on a card: at most three things, never the card's own button. */
function menuFor(card: StageCard, state: AgentState, first: string | null, run: Run, openCompanion: (runId?: string) => void): MenuItem[] {
  const { stage, pr } = card;
  const item = stage.item;
  const out: MenuItem[] = [];
  const hasSession = Boolean(item?.sessionId && (item.worktree || item.scenario === "afterMerge"));
  const hand = (label: string, title: string) => {
    if (state.enabled && pr && !stage.sdlc) out.push({ label, title, action: () => run({ type: "enqueue", prId: pr.id }) });
  };
  if (stage.column === "agent") {
    if (!item || (item.state !== "working" && item.state !== "queued")) return out;
    if (item.state === "working") {
      if (state.headerChip) out.push({ label: "Watch", title: "The plan, the log, a note to the agent", action: () => openCompanion(item.runId) });
      out.push({ label: "Stop", title: "Stop the run; it comes back as a note on the card", action: () => run({ type: "stop", runId: item.runId }) });
    } else {
      if (first && first !== item.runId) out.push({ label: "Run now", title: "Put it at the front of the line", action: () => run({ type: "moveQueued", runId: item.runId, before: first }) });
      out.push({ label: "Don't run", title: "Take it out of the line — the agent won't take it up again for this head", action: () => run({ type: "skip", runId: item.runId }) });
    }
    return out;
  }
  if (stage.column === "waiting") {
    hand(stage.lane === "mine" ? "Self-review again" : "Re-review now", stage.lane === "mine" ? "The agent reviews its head again before reviewers look" : "The agent re-reviews it now");
    return out;
  }
  if (stage.column === "done") {
    // Asked again with your approval standing on this head: one click answers the request.
    if (stage.askedAgain && pr) {
      out.push({
        label: "Approve again",
        title: "Answers the review request with your approval on this same head — one line, signed by the agent",
        action: () => run({ type: "approveAgain", prId: pr.id }).then((ok) => ok && void window.api.refresh()),
      });
    }
    return out;
  }
  if (stage.column !== "you" || !stage.action) return out;
  const discard = (label: string, title: string) => item && out.push({ label, title, action: () => run({ type: "skip", runId: item.runId }) });
  const claude = (label: string, title: string) => hasSession && item && out.push({ label, title, action: () => run({ type: "continue", runId: item.runId }) });
  switch (stage.action.kind) {
    case "send":
      claude("Edit in Claude", "Open the session in your terminal to change the review; the card shows the new draft when you're back");
      discard("Discard draft", "You'll review it yourself — the agent leaves this head alone");
      break;
    case "push":
      claude("Open in Claude", "Open the session in your terminal");
      discard("Discard", "Drop these commits — the agent leaves this head alone");
      break;
    case "decide": {
      const n = item?.drive && !item.pushed ? item.drive.commits.length : 0;
      if (item && n > 0) out.push({ label: `Push ${n} fix${n === 1 ? "" : "es"}`, title: "Push what it has without answering", action: () => run({ type: "push", runId: item.runId }) });
      claude("Open in Claude", "Answer it in the session instead");
      discard("Discard", "Drop it — the agent leaves this head alone");
      break;
    }
    case "merge":
      if (item && pr) out.push({ label: "Open on GitHub", action: () => openUrl(pr.url) });
      break;
    case "reapprove":
    case "reask":
      if (pr) out.push({ label: "Open on GitHub", action: () => openUrl(pr.url) });
      discard(stage.action.kind === "reapprove" ? "I'll look myself" : "Don't ask", "Turn the offer down — the agent leaves this head to the other rules");
      break;
    case "draftReview":
      discard("I'll review myself", "Drop the brief — the agent leaves this head alone");
      break;
    case "fix":
      if (item && stage.action.label !== "Try again") out.push({ label: "Try again", title: "Start over with a new session", action: () => run({ type: "retry", runId: item.runId }) });
      discard("Discard", "Leave it — the agent won't try this head again");
      break;
    case "review":
      hand("Let the agent draft it", "Queue a review draft for you to send");
      break;
    case "rereview":
      hand("Let the agent re-review it", "Queue a re-review for you to send");
      break;
    case "fixYourself":
      hand("Let the agent fix it", "Queue a run that fixes it; you push what it prepares");
      break;
    default:
      break;
  }
  return out.slice(0, 3);
}

function BoardCard({
  card,
  state,
  place,
  first,
  run,
  onOpen,
}: {
  card: StageCard;
  state: AgentState;
  place: ReadonlyMap<string, number>;
  first: string | null;
  run: Run;
  onOpen: () => void;
}) {
  const { openCompanion } = useContext(AgentContext);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { stage, pr } = card;
  const item = stage.item;
  const repo = pr?.repo ?? item?.repo ?? "";
  const number = pr?.number ?? item?.prNumber ?? 0;
  const title = pr?.title ?? item?.title ?? "";
  const url = pr?.url ?? item?.url ?? "";
  const line = stageLine(stage, pr);
  const note = stage.note && stage.note !== line ? stage.note : null;
  const menu = menuFor(card, state, first, run, openCompanion);
  const kind = stage.action?.kind ?? null;
  const result = item ? resultCard(item) : null;
  const doing = async (action: AgentAction) => {
    setBusy(true);
    await run(action);
    setBusy(false);
  };
  const tone =
    kind === "fix"
      ? "border-red-500/60"
      : kind === "merge" && stage.ready
        ? "border-emerald-500/50"
        : kind === "decide"
          ? "border-amber-500/60"
          : item?.state === "working"
            ? "border-sky-500/40"
            : "border-line";

  return (
    <article data-run-id={item?.runId} data-pr-id={card.prId} className={cn("rounded-md border bg-surface p-2.5 shadow-sm", tone, stage.action?.kind === "draft" && "opacity-75")}>
      <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
        <span className="truncate">
          {shortRepo(repo)} #{number}
          {pr?.issueKey ? ` · ${pr.issueKey}` : ""}
        </span>
        {stage.sdlc && (
          <span className="shrink-0 rounded border border-violet-500/50 bg-violet-500/10 px-1 text-[10px] font-medium text-violet-700 dark:text-violet-300" title="An SDLC orchestrator run drives this PR; the PR agent leaves it alone">
            SDLC · {stage.sdlc.key}
            {stage.sdlc.stage ? ` · ${stage.sdlc.stage}` : ""}
          </span>
        )}
        <span className="flex-1" />
        <span className="shrink-0" title={`Here since ${new Date(stage.since).toLocaleString()}`}>
          {relativeTime(stage.since)}
        </span>
        {menu.length > 0 && (
          <button type="button" className="shrink-0 rounded px-1 leading-none text-fg-muted hover:bg-elevated hover:text-fg" aria-expanded={more} aria-label="More actions" title="More actions" onClick={() => setMore((v) => !v)}>
            ⋯
          </button>
        )}
      </div>
      <button type="button" onClick={onOpen} className="mt-0.5 line-clamp-2 text-left text-sm font-medium text-fg hover:text-sky-600 hover:underline dark:hover:text-sky-300">
        {title}
      </button>
      <div className={cn("mt-1 text-xs", stage.column === "you" ? "font-semibold text-fg" : "text-fg-muted", kind === "fix" && "text-red-700 dark:text-red-300")}>{line}</div>

      {stage.column === "agent" && item && (item.state === "working" || item.state === "queued") && <AgentProgress item={item} state={state} place={place.get(item.runId) ?? 0} />}

      {stage.column === "you" && item && (
        <YouDetails item={item} kind={kind} open={open} setOpen={setOpen} run={run} summary={result?.summary ?? null} />
      )}
      {stage.column === "you" && !stage.ready && stage.why && <div className="mt-1 text-[11px] text-fg-subtle">The agent: {stage.why}</div>}

      {stage.action && stage.column !== "waiting" && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {kind === "merge" && item ? (
            <MergeButton item={item} run={run} />
          ) : kind === "send" && item ? (
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void doing({ type: "publish", runId: item.runId })}>
              {busy ? "Sending…" : stage.action.label}
            </button>
          ) : kind === "push" && item ? (
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void doing({ type: "push", runId: item.runId })}>
              {busy ? "Pushing…" : stage.action.label}
            </button>
          ) : (kind === "reapprove" || kind === "reask") && item ? (
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void doing({ type: "reapprove", runId: item.runId })}>
              {busy ? (kind === "reapprove" ? "Approving…" : "Asking…") : stage.action.label}
            </button>
          ) : kind === "draftReview" && item ? (
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void doing({ type: "reviewAnyway", runId: item.runId })}>
              {stage.action.label}
            </button>
          ) : kind === "fix" && item ? (
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void doing(stage.action?.label === "Open in Claude" ? { type: "continue", runId: item.runId } : { type: "retry", runId: item.runId })}>
              {stage.action.label}
            </button>
          ) : kind === "updateJira" && item ? (
            <button type="button" className={BTN} title="Opens the Jira dry run's session in your terminal, where it asks before every change" onClick={() => void doing({ type: "continue", runId: item.runId })}>
              {stage.action.label}
            </button>
          ) : kind === "decide" ? null : (
            <button type="button" className={BTN} onClick={() => openUrl(url)}>
              {stage.action.label}
            </button>
          )}
        </div>
      )}
      {stage.ready && item?.mode === "shadow" && kind === "send" && <div className="mt-1.5 text-[11px] text-fg-faint">Nothing is on GitHub until you send it. It goes out with the agent&apos;s signature.</div>}
      {stage.ready && item?.mode === "shadow" && kind === "push" && <div className="mt-1.5 text-[11px] text-fg-faint">Nothing is on the branch until you push. Fast-forward only, and only while nobody else pushed.</div>}
      {kind === "merge" && item && <div className="mt-1.5 text-[11px] text-fg-faint">Merges only the commit shown here — GitHub refuses it if anyone pushes first.</div>}
      {kind === "reapprove" && item && (
        <div className="mt-1.5 text-[11px] text-fg-faint">A push brought in only the base: the PR&apos;s own changes are line for line the ones you approved. Goes out signed by the agent.</div>
      )}
      {kind === "reask" && item && <div className="mt-1.5 text-[11px] text-fg-faint">Your push brought in only the base and changed nothing they approved. GitHub notifies them; nothing is written in the PR.</div>}

      {more && menu.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 rounded-md border border-line bg-elevated/40 p-1.5">
          {menu.map((m) => (
            <button
              key={m.label}
              type="button"
              className={BTN}
              title={m.title}
              onClick={() => {
                setMore(false);
                void m.action();
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
      {note && (
        <div className="mt-1.5 truncate text-[11px] text-fg-faint" title={note}>
          {note}
          {item?.finishedAt ? ` · ${relativeTime(item.finishedAt)}` : ""}
        </div>
      )}
    </article>
  );
}

/** A run on its card: its plan's progress and current step, or its place in line. */
function AgentProgress({ item, state, place }: { item: AgentItem; state: AgentState; place: number }) {
  if (item.state === "queued") {
    const held = item.headline.startsWith("Queued —") ? item.headline.slice("Queued — ".length) : null;
    return (
      <div className="mt-1 text-[11px] text-fg-subtle">
        <span className="font-medium text-sky-700 dark:text-sky-300">{inLine(place)}</span>
        {held && ` · ${held}`}
      </div>
    );
  }
  const r = runFor(state, item.runId);
  const steps = r?.progress.steps ?? [];
  const step = r ? currentStep(r.progress) : null;
  const paused = r?.paused ?? false;
  return (
    <>
      {steps.length > 0 && (
        <div className="mt-1.5 flex gap-0.5" aria-hidden>
          {steps.map((s) => (
            <span
              key={s.id}
              className={cn("h-1 flex-1 rounded-full", s.status === "completed" ? "bg-emerald-500" : s.status === "in_progress" ? (paused ? "bg-amber-500" : "bg-sky-500") : "bg-line-strong")}
            />
          ))}
        </div>
      )}
      <div className="mt-1 text-[11px] text-fg-secondary">{paused ? "Paused" : (step?.subject ?? item.headline)}</div>
      {r?.progress.activity && (
        <div className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle" title={r.progress.activity}>
          {r.progress.activity}
        </div>
      )}
    </>
  );
}

/** The one block of details a Your-move card has: what goes out, the commits, the question, the brief, what went wrong. */
function YouDetails({
  item,
  kind,
  open,
  setOpen,
  run,
  summary,
}: {
  item: AgentItem;
  kind: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
  run: Run;
  summary: string | null;
}) {
  const card = resultCard(item);
  const report = item.output && item.output.trim() !== summary ? item.output : null;
  const toggle = (label: string, openLabel = "Hide") => (
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={cn(LINK, "mt-1.5")}>
      {open ? openLabel : `▸ ${label}`}
    </button>
  );
  const summaryP = summary ? <p className="mt-1.5 line-clamp-6 whitespace-pre-wrap text-xs leading-snug text-fg-secondary">{summary}</p> : null;
  if (kind === "send" && item.plan) {
    const plan = item.plan;
    return (
      <>
        {plan.escalations.length > 0 && <Disputes item={item} plan={plan} run={run} />}
        <div>{toggle("What goes out")}</div>
        {open && (
          <>
            {summaryP}
            <PlanView plan={plan} />
          </>
        )}
        {item.diagrams && <AgentDiagrams diagrams={item.diagrams} posts={Boolean(plan.diagrams)} />}
      </>
    );
  }
  if ((kind === "push" || kind === "decide") && item.drive) {
    const n = item.drive.commits.length;
    const replies = item.plan?.replies.length ?? 0;
    return (
      <>
        {kind === "decide" && card && card.asks.length > 0 && <YourCall item={item} asks={card.asks} canAnswer={Boolean(item.sessionId)} run={run} />}
        {n > 0 && (
          <>
            <div>{toggle(`The ${n} commit${n === 1 ? "" : "s"}${replies > 0 ? ` and ${replies} repl${replies === 1 ? "y" : "ies"}` : ""}`)}</div>
            {open && (
              <>
                {summaryP}
                <DriveView drive={item.drive} />
                {item.plan && replies > 0 && <PlanView plan={item.plan} />}
              </>
            )}
          </>
        )}
      </>
    );
  }
  if (kind === "decide" && card && card.asks.length > 0) return <YourCall item={item} asks={card.asks} canAnswer={Boolean(item.sessionId)} run={run} />;
  if (kind === "draftReview") {
    return (
      <>
        {card && card.authorQuestions.length > 0 && (
          <div className="mt-1.5 rounded-md border border-line bg-elevated/40 p-2 text-xs">
            <div className="font-medium text-fg">Questions for the author</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-fg-secondary">
              {card.authorQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
            <div className="mt-1 text-[11px] text-fg-faint">Draft a review puts them in it, as comments.</div>
          </div>
        )}
        <div>{toggle("Read the brief")}</div>
        {open && (
          <>
            {summaryP}
            {report && <div className="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded border border-line bg-elevated/40 p-2 text-xs text-fg-secondary">{report}</div>}
          </>
        )}
        {item.diagrams && <AgentDiagrams diagrams={item.diagrams} posts={false} />}
      </>
    );
  }
  if (kind === "fix") {
    return (
      <>
        <div>{toggle("What happened")}</div>
        {open && (
          <>
            {item.error && <div className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-fg-subtle">{item.error}</div>}
            {summaryP}
            {card && card.findings.length > 0 && <FindingsList findings={card.findings} />}
            {report && <div className="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded border border-line bg-elevated/40 p-2 text-xs text-fg-secondary">{report}</div>}
          </>
        )}
      </>
    );
  }
  return null;
}

const EVENT_TEXT: Record<NonNullable<PublishSummary["event"]>, string> = {
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request changes",
  COMMENT: "Comment",
};

/** What a review would post, as GitHub would show it: the event, the body, each inline comment, replies and resolves. */
function PlanView({ plan }: { plan: PublishSummary }) {
  return (
    <div className="mt-1 max-h-80 space-y-2 overflow-y-auto rounded border border-line bg-elevated/40 p-2 text-xs text-fg-secondary">
      {plan.event && (
        <div>
          <span
            className={cn(
              "rounded px-1.5 py-px text-[11px] font-semibold",
              plan.event === "APPROVE" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : plan.event === "REQUEST_CHANGES" ? "bg-red-500/15 text-red-700 dark:text-red-300" : "bg-elevated text-fg-muted",
            )}
          >
            {EVENT_TEXT[plan.event]}
          </span>
        </div>
      )}
      {plan.body && <div className="whitespace-pre-wrap">{plan.body}</div>}
      {plan.comments.map((c, i) => (
        <div key={i} className="border-l-2 border-line-strong pl-2">
          <div className="font-mono text-[11px] text-fg-subtle">
            {c.path}
            {c.line !== undefined ? `:${c.line}` : ""}
          </div>
          <div className="whitespace-pre-wrap">{c.body}</div>
        </div>
      ))}
      {plan.replies.map((r, i) => (
        <div key={`r${i}`} className="border-l-2 border-sky-500/50 pl-2">
          <div className="text-[11px] text-fg-subtle">Reply in a thread</div>
          <div className="whitespace-pre-wrap">{r.body}</div>
        </div>
      ))}
      {plan.resolves > 0 && <div className="text-[11px] text-fg-subtle">Resolves {plan.resolves} thread{plan.resolves === 1 ? "" : "s"}.</div>}
    </div>
  );
}

/** A drive's commits, as the Push button would send them; the patch on demand. */
function DriveView({ drive }: { drive: NonNullable<AgentItem["drive"]> }) {
  const [patch, setPatch] = useState(false);
  return (
    <div className="mt-1 space-y-1.5 rounded border border-line bg-elevated/40 p-2 text-xs text-fg-secondary">
      <ul className="space-y-0.5">
        {drive.commits.map((c) => (
          <li key={c.oid} className="flex gap-2">
            <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{c.oid.slice(0, 7)}</span>
            <span className="min-w-0">{c.subject}</span>
          </li>
        ))}
      </ul>
      {drive.stat && <pre className="overflow-x-auto whitespace-pre font-mono text-[11px] text-fg-subtle">{drive.stat}</pre>}
      {drive.patch && (
        <>
          <button type="button" onClick={() => setPatch((v) => !v)} aria-expanded={patch} className="text-xs text-sky-700 hover:underline dark:text-sky-300">
            {patch ? "Hide the diff" : "Show the diff"}
          </button>
          {patch && <pre className="max-h-80 overflow-auto whitespace-pre font-mono text-[11px]">{drive.patch}</pre>}
        </>
      )}
    </div>
  );
}

function MergeButton({ item, run }: { item: AgentItem; run: Run }) {
  const allowed = item.mergeMethods?.allowed ?? [];
  const [method, setMethod] = useState<MergeMethod | undefined>(item.mergeMethod);
  const [busy, setBusy] = useState(false);
  const merge = async () => {
    setBusy(true);
    await run({ type: "merge", runId: item.runId, method });
    setBusy(false);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void merge()}>
        {busy ? "Merging…" : "Merge"}
      </button>
      {allowed.length > 1 && (
        <select
          aria-label="Merge method"
          value={method ?? ""}
          onChange={(e) => setMethod(e.target.value as MergeMethod)}
          className="rounded-md border border-line-strong bg-surface px-1.5 py-1 text-xs text-fg-secondary"
        >
          {allowed.map((m) => (
            <option key={m} value={m}>
              {m}
              {m === item.mergeMethods?.suggested ? " (GitHub's pick)" : ""}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

/** One line of a comment, without its markdown: enough to know what it says. */
function gist(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The threads where the author pushed back on your comment: keep it (the
 * thread stays open) or drop it (a short "fair point" and the thread is
 * resolved) — applied when the review is sent, no new session. Undecided
 * counts as keep: nothing changes that you didn't choose.
 */
function Disputes({ item, plan, run }: { item: AgentItem; plan: PublishSummary; run: Run }) {
  const pick = (replyTo: number, choice: "keep" | "drop") => void run({ type: "dispute", runId: item.runId, replyTo, choice });
  const opt = (on: boolean) =>
    cn("rounded-md border px-2 py-0.5 text-xs font-medium", on ? "border-sky-600 bg-sky-600 text-white" : "border-line-strong bg-surface text-fg-secondary hover:bg-elevated");
  return (
    <div className="mt-2 rounded-md border border-amber-500/50 bg-amber-500/[0.07] p-2 text-xs">
      <div className="font-medium text-amber-800 dark:text-amber-300">The author pushed back</div>
      {plan.escalations.map((e) => {
        const choice = item.disputes?.[String(e.replyTo)] ?? "keep";
        return (
          <div key={e.replyTo} className="mt-1.5">
            <div className="text-fg-secondary">{gist(e.body)}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              <button type="button" aria-pressed={choice === "keep"} className={opt(choice === "keep")} onClick={() => pick(e.replyTo, "keep")}>
                Keep my comment
              </button>
              <button type="button" aria-pressed={choice === "drop"} className={opt(choice === "drop")} onClick={() => pick(e.replyTo, "drop")}>
                Drop it
              </button>
            </div>
          </div>
        );
      })}
      <div className="mt-1.5 text-[11px] text-fg-faint">Applied when you send: a kept thread stays open; a dropped one gets &ldquo;Fair point — I&apos;m dropping this.&rdquo; and is resolved.</div>
    </div>
  );
}

const SEVERITY_CHIP: Record<FindingSeverity, string> = {
  blocker: "border-red-500/60 bg-red-500/10 text-red-700 dark:text-red-300",
  major: "border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  minor: "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  note: "border-line-strong text-fg-muted",
};

/** The findings worth a glance: the most severe few, the rest one click away. */
function FindingsList({ findings }: { findings: RunFinding[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? findings : findings.slice(0, 3);
  return (
    <ul className="mt-1.5 space-y-1">
      {shown.map((f, i) => (
        <li key={i} className="flex items-start gap-1.5 text-xs">
          <span className={cn("mt-px shrink-0 rounded border px-1 text-[10px] font-semibold uppercase leading-4", SEVERITY_CHIP[f.severity])}>{f.severity}</span>
          <span className="min-w-0 text-fg-secondary">
            {f.text}
            {f.where && <span className="ml-1 font-mono text-[11px] text-fg-subtle">{f.where}</span>}
          </span>
        </li>
      ))}
      {findings.length > 3 && (
        <li>
          <button type="button" onClick={() => setAll((v) => !v)} className="text-xs text-sky-700 hover:underline dark:text-sky-300">
            {all ? "Fewer" : `+${findings.length - 3} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

/**
 * A decision on your own PR that only you can make, with the answers the run offers and room for your own.
 * One question: an answer goes at once. Several: pick or write each, then Send.
 * The same session goes on with what you said (`answer`); where the app can't
 * do that (the Jira dry run changes nothing), the question is only shown.
 */
function YourCall({ item, asks, canAnswer, run }: { item: AgentItem; asks: RunAsk[]; canAnswer: boolean; run: Run }) {
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  const single = asks.length === 1;
  const send = async (text: string) => {
    if (!text.trim()) return;
    setSending(true);
    await run({ type: "answer", runId: item.runId, text: text.slice(0, AGENT_ANSWER_MAX) });
    setSending(false);
  };
  const answerOf = (i: number) => typed[i]?.trim() || picked[i] || "";
  const composed = () =>
    asks
      .map((a, i) => (answerOf(i) ? `Q: ${a.question}\nA: ${answerOf(i)}` : null))
      .filter(Boolean)
      .join("\n\n");
  return (
    <div className="mt-2 rounded-md border border-amber-500/50 bg-amber-500/[0.07] p-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">{single ? "Your call" : `Your call — ${asks.length} questions`}</div>
      {asks.map((a, i) => (
        <div key={i} className={cn(i > 0 && "mt-2 border-t border-amber-500/20 pt-2")}>
          <div className="text-xs text-fg">{a.question}</div>
          {a.options.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {a.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  disabled={!canAnswer || sending}
                  aria-pressed={picked[i] === o}
                  onClick={() => (single ? void send(`Q: ${a.question}\nA: ${o}`) : setPicked((p) => ({ ...p, [i]: p[i] === o ? "" : o })))}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-xs font-medium disabled:cursor-default disabled:opacity-60",
                    picked[i] === o ? "border-sky-600 bg-sky-600 text-white" : "border-line-strong bg-surface text-fg-secondary hover:bg-elevated",
                  )}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          {canAnswer && (
            <form
              className="mt-1.5 flex gap-1"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                if (single) void send(`Q: ${a.question}\nA: ${typed[i] ?? ""}`);
              }}
            >
              <input
                value={typed[i] ?? ""}
                onChange={(e) => setTyped((t) => ({ ...t, [i]: e.target.value }))}
                maxLength={1500}
                placeholder={a.options.length > 0 ? "Or your own answer…" : "Your answer…"}
                aria-label={`Answer: ${a.question}`}
                className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs text-fg placeholder:text-fg-faint focus:border-sky-500 focus:outline-none"
              />
              {single && (
                <button type="submit" className={BTN_PRIMARY} disabled={sending || !(typed[i] ?? "").trim()}>
                  {sending ? "Sending…" : "Send"}
                </button>
              )}
            </form>
          )}
        </div>
      ))}
      {canAnswer && !single && (
        <button type="button" className={cn(BTN_PRIMARY, "mt-2")} disabled={sending || !composed()} onClick={() => void send(composed())}>
          {sending ? "Sending…" : "Send answers"}
        </button>
      )}
      <div className="mt-1.5 text-[11px] text-fg-faint">
        {canAnswer ? "The same session goes on with your answer and comes back here." : "Answer it in the session: the dry run changes nothing by itself."}
      </div>
    </div>
  );
}
