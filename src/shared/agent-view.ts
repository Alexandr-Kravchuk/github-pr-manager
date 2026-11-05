import type { NotifyEventKind } from "./notify";
import type { PlanStep } from "./agent-stream";
import type { AgentItem, AgentRunState, AgentSettings, AgentState, PullRequest } from "./types";

// How the agent's state reads on the dashboard: which of a PR's items its card
// shows, and how the Board lays the PRs out. Node-free (the renderer
// value-imports it) and pure, so the rules are unit-tested without a DOM.

/** The order a card prefers a PR's items in: what is happening, then what waits for you. */
const RANK: Record<AgentItem["state"], number> = { working: 0, needsYou: 1, error: 2, queued: 3, done: 4 };

/**
 * The headlines main gives an item it closes as housekeeping — the PR no longer
 * needs it, you dismissed it, or a newer item replaced it. Such an item is
 * never worth a card's status line or a "Done today" card. One table so main
 * and the renderer can't drift.
 */
export const AGENT_CLOSED = {
  gone: "No longer needed",
  dismissed: "Dismissed",
  rerun: "Run again",
  reviewed: "Reviewed instead",
  /** A newer run on the same PR replaced it (a new head, a new answer from the author). */
  superseded: "Superseded by a newer run",
  /** Its PR left the dashboard: merged, closed, or no longer yours to act on. */
  offDashboard: "Its PR left the dashboard — merged, closed or no longer yours",
} as const;

const CLOSED_HEADLINES: ReadonlySet<string> = new Set(Object.values(AGENT_CLOSED));

function isQuiet(item: AgentItem): boolean {
  return item.state === "done" && CLOSED_HEADLINES.has(item.headline);
}

/** The item a PR's card shows, or null. Done items count only on the day they finished. */
export function itemForPr(items: readonly AgentItem[], prId: string, today: string): AgentItem | null {
  let best: AgentItem | null = null;
  for (const item of items) {
    if (item.prId !== prId || isQuiet(item)) continue;
    if (item.state === "done" && !finishedOn(item, today)) continue;
    if (
      !best ||
      RANK[item.state] < RANK[best.state] ||
      (RANK[item.state] === RANK[best.state] && (item.finishedAt ?? item.queuedAt) > (best.finishedAt ?? best.queuedAt))
    ) {
      best = item;
    }
  }
  return best;
}

export function runFor(state: Pick<AgentState, "running">, runId: string): AgentRunState | null {
  return state.running.find((r) => r.runId === runId) ?? null;
}

export interface BoardColumns {
  idle: Array<{ pr: PullRequest; reason: string }>;
  queued: AgentItem[];
  working: AgentItem[];
  /** Waiting for you; the ones put aside with "Later" come last. */
  needsYou: AgentItem[];
  /** One card per PR: the latest of today's results, for a PR with no live work. */
  done: AgentItem[];
  /** How many of today's results a Done card stands for, by its run id — set only where more than one. */
  doneRuns: Record<string, number>;
}

/**
 * The Board: ALL of the agent's work in its columns — whatever the
 * dashboard's filters show, so the Board, the header chip and the tray count
 * the same runs and the same decisions — and the filtered PRs it has done
 * nothing with today as Idle, with the reason the agent gives. Done today also
 * shows PRs that left the dashboard (merged, closed): their work was today's.
 *
 * A kanban: a PR is in one column only. Live work (Queued, Working, Needs you)
 * comes first, then today's result, then Idle — a PR the agent finished with
 * today stays in Done today (its card can hand it over again) and is back in
 * Idle tomorrow.
 */
export function boardColumns(prs: readonly PullRequest[], state: AgentState, today: string): BoardColumns {
  const cols: BoardColumns = { idle: [], queued: [], working: [], needsYou: [], done: [], doneRuns: {} };
  const busy = new Set<string>();
  for (const item of state.items) {
    if (item.state === "queued") cols.queued.push(item);
    else if (item.state === "working") cols.working.push(item);
    else if (item.state === "needsYou" || item.state === "error") cols.needsYou.push(item);
    else if (item.state === "done" && !isQuiet(item) && finishedOn(item, today)) cols.done.push(item);
    if (item.state === "queued" || item.state === "working" || item.state === "needsYou" || item.state === "error") busy.add(item.prId);
  }
  // Today's result only for a PR with no live work; Idle only for a PR with neither.
  cols.done = cols.done.filter((item) => !busy.has(item.prId));
  const doneToday = new Set(cols.done.map((item) => item.prId));
  for (const pr of prs) {
    if (!busy.has(pr.id) && !doneToday.has(pr.id)) cols.idle.push({ pr, reason: state.idle[pr.id] ?? (state.enabled ? "Nothing for the agent" : "The agent is off") });
  }
  cols.queued = queueOrder(cols.queued);
  cols.working.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  cols.needsYou.sort((a, b) => Number(a.later ?? false) - Number(b.later ?? false) || (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
  cols.done.sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  // A PR with several results today (you handed it over again, it was merged
  // and then its Jira run finished) is one card — the latest — that says so.
  const latest = new Map<string, AgentItem>();
  cols.done = cols.done.filter((item) => {
    const key = item.prId;
    const kept = latest.get(key);
    if (!kept) {
      latest.set(key, item);
      return true;
    }
    cols.doneRuns[kept.runId] = (cols.doneRuns[kept.runId] ?? 1) + 1;
    return false;
  });
  return cols;
}

/**
 * The local calendar day as "YYYY-MM-DD" — the day "Done today" and the daily
 * run limit mean. Local, not UTC: in Kyiv a UTC day rolls over at 02:00 or
 * 03:00 and would empty "Done today" in the middle of an evening.
 */
export function todayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Whether an item finished on the local day `today` (a `todayKey`). */
export function finishedOn(item: Pick<AgentItem, "finishedAt">, today: string): boolean {
  if (!item.finishedAt) return false;
  const at = new Date(item.finishedAt);
  return !Number.isNaN(at.getTime()) && todayKey(at) === today;
}

/** What a needs-you item asks of you, as the words of its first button. */
export function primaryActionLabel(item: AgentItem): string | null {
  // The Jira dry run follows a merge: its PR is gone, so it can't run again — only be put away.
  if (item.state === "error") return item.scenario === "afterMerge" ? "Done" : "Run again";
  if (item.state !== "needsYou") return null;
  // A drive starts over: its push is checked against what the app read
  // before any session worked in that worktree.
  if (item.interrupted) return item.scenario === "drive" || !item.sessionId ? "Run again" : "Resume";
  if (item.scenario === "merge") return "Merge";
  if (item.scenario === "drive" && item.drive && item.drive.commits.length > 0 && !item.pushed) return "Push";
  if (item.plan && !item.published) return "Publish";
  if (item.scenario === "brief" && item.output) return "Review anyway";
  if (item.scenario === "afterMerge" && item.sessionId) return "Apply in session";
  // A question waits: the card's answer box is the way on.
  if ((item.result?.asks.length ?? 0) > 0) return "Answer";
  // Nothing left for you: acknowledge it and it moves to Done today.
  return "Done";
}

/** What a run of each scenario is doing, as the chip and the tray say it. */
export const SCENARIO_VERB: Record<AgentItem["scenario"], string> = {
  review: "Reviewing",
  brief: "Briefing",
  rereview: "Re-reviewing",
  drive: "Driving",
  merge: "Merging",
  afterMerge: "Checking Jira for",
};

/** "HH:MM" → minutes after midnight; null for anything else. */
function clockMinutes(clock: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * Inside quiet hours at `now` (local time): the clock they end at, as set
 * ("08:00"); null outside them. The span may wrap past midnight (20:00–08:00
 * holds 23:30 and 07:59, not 08:00); `from` equal to `to` is no span at all.
 */
export function quietUntil(now: Date, quiet: AgentSettings["limits"]["quietHours"]): string | null {
  if (!quiet.enabled) return null;
  const from = clockMinutes(quiet.from);
  const to = clockMinutes(quiet.to);
  if (from === null || to === null || from === to) return null;
  const t = now.getHours() * 60 + now.getMinutes();
  const inside = from < to ? t >= from && t < to : t >= from || t < to;
  return inside ? quiet.to : null;
}

function localClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The step a plan is on, as "3/6" — the same in the tray and the popover; "" without a plan. */
export function stepLabel(steps: readonly Pick<PlanStep, "status">[]): string {
  if (steps.length === 0) return "";
  const at = steps.findIndex((s) => s.status === "in_progress");
  const next = at >= 0 ? at : steps.findIndex((s) => s.status !== "completed");
  return `${next >= 0 ? next + 1 : steps.length}/${steps.length}`;
}

/** Why the queue isn't moving, when something holds it. */
export type QueueBlock = "paused" | "quiet" | "usage" | "daily";

/**
 * The agent's state in the numbers and words every place shows — the header
 * chip, the tray, the Board's header and lanes, a card's status line — read
 * from one function so no two of them can disagree.
 */
export interface AgentSummary {
  running: number;
  /** Of those, paused (by you, or by pausing the agent). */
  pausedRuns: number;
  queued: number;
  /** Results waiting for you, not put aside with Later. */
  waiting: number;
  later: number;
  /** What holds the queue; null when nothing does. */
  block: QueueBlock | null;
  /** That, in words: "Paused", "Quiet hours until 08:00", "Usage limit — waits until 14:05", "Daily limit reached (30)". */
  blockText: string | null;
}

export function agentSummary(state: AgentState): AgentSummary {
  const results = state.items.filter((i) => i.state === "needsYou" || i.state === "error");
  const block: QueueBlock | null = state.paused
    ? "paused"
    : state.quietUntil
      ? "quiet"
      : state.heldUntil
        ? "usage"
        : state.perDay > 0 && state.runsToday >= state.perDay
          ? "daily"
          : null;
  const blockText =
    block === "paused"
      ? "Paused"
      : block === "quiet"
        ? `Quiet hours until ${state.quietUntil}`
        : block === "usage" && state.heldUntil
          ? `Usage limit — waits until ${localClock(state.heldUntil)}`
          : block === "daily"
            ? `Daily limit reached (${state.perDay})`
            : null;
  return {
    running: state.running.length,
    pausedRuns: state.running.filter((r) => r.paused).length,
    queued: state.items.filter((i) => i.state === "queued").length,
    waiting: results.filter((i) => !i.later).length,
    later: results.filter((i) => i.later).length,
    block,
    blockText,
  };
}

/**
 * The agent in one line, for the tray's tooltip and menu: what runs (with
 * the step its plan is on), else why nothing does, plus what waits for you —
 * "Reviewing #911 · 4/6 · 2 wait for you", "Paused", "Quiet hours until 08:00 · 3 queued".
 */
export function agentTrayLine(state: AgentState): string {
  const sum = agentSummary(state);
  const first = state.running[0];
  const item = first ? state.items.find((i) => i.runId === first.runId) : undefined;
  let line: string;
  if (state.paused) {
    line = "Paused";
  } else if (first && item) {
    const step = stepLabel(first.progress.steps);
    line = `${SCENARIO_VERB[item.scenario]} #${item.prNumber}${first.paused ? " (paused)" : step ? ` · ${step}` : ""}${sum.running > 1 ? ` +${sum.running - 1}` : ""}`;
  } else if (sum.blockText && sum.queued > 0) {
    line = `${sum.blockText} · ${sum.queued} queued`;
  } else if (sum.blockText && sum.block !== "daily") {
    line = sum.blockText;
  } else if (sum.queued > 0) {
    line = `${sum.queued} queued`;
  } else {
    line = "Idle";
  }
  return sum.waiting > 0 ? `${line} · ${sum.waiting} wait${sum.waiting === 1 ? "s" : ""} for you` : line;
}

/** Which of the agent's runs stands in for each regular toast. */
const TOAST_SCENARIOS: Partial<Record<NotifyEventKind, { scenarios: ReadonlyArray<AgentItem["scenario"]>; reason?: string }>> = {
  review_requested: { scenarios: ["review", "brief"] },
  returned_to_me: { scenarios: ["rereview"] },
  ci_failed: { scenarios: ["drive"], reason: "ci" },
  changes_requested: { scenarios: ["drive"], reason: "comments" },
  unanswered_comment: { scenarios: ["drive"], reason: "comments" },
};

/**
 * Whether a regular toast is one the agent already stands in for: it took
 * the PR for that very trigger in On mode, so its own result — posted, or a
 * "needs you" — is what you hear about. Shadow runs leave the toast alone:
 * there the trigger still waits on you.
 */
export function agentTakesToast(items: readonly AgentItem[], event: { prId: string; kind: NotifyEventKind }): boolean {
  const rule = TOAST_SCENARIOS[event.kind];
  if (!rule) return false;
  return items.some(
    (i) =>
      i.prId === event.prId &&
      i.mode === "on" &&
      (i.state === "queued" || i.state === "working") &&
      rule.scenarios.includes(i.scenario) &&
      (!rule.reason || (i.reasons ?? []).includes(rule.reason)),
  );
}

/** An item's place in the queue: the rank you gave it, else the time it was queued. Lower runs first. */
export function queueRank(item: Pick<AgentItem, "rank" | "queuedAt">): number {
  return item.rank ?? Date.parse(item.queuedAt);
}

/** The queue in the order it runs — the Board's Queued column and the agent's own tick read the same order. */
export function queueOrder<T extends Pick<AgentItem, "rank" | "queuedAt">>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => queueRank(a) - queueRank(b));
}

/**
 * The rank that puts an item right in front of `beforeRunId` in `queue` (the
 * other queued items); null, or a run no longer queued, is the end. Undefined
 * when the queue is empty — the item's own queued time will do.
 */
export function rankBefore(queue: readonly AgentItem[], beforeRunId: string | null): number | undefined {
  const ordered = queueOrder(queue);
  const at = beforeRunId === null ? -1 : ordered.findIndex((i) => i.runId === beforeRunId);
  if (at < 0) return ordered.length > 0 ? queueRank(ordered[ordered.length - 1]) + 1 : undefined;
  const next = queueRank(ordered[at]);
  const prev = at > 0 ? queueRank(ordered[at - 1]) : next - 2;
  return (prev + next) / 2;
}

/** The Board's two lanes: your own PRs, and the PRs you review. */
export type BoardLane = "mine" | "review";
export const BOARD_LANES: readonly BoardLane[] = ["mine", "review"];

/** Your PR's work (drive, a merge, the Jira run after it) — or a review of someone else's (review, brief, re-review). */
export function laneOfScenario(scenario: AgentItem["scenario"]): BoardLane {
  return scenario === "drive" || scenario === "merge" || scenario === "afterMerge" ? "mine" : "review";
}

/** An idle PR's lane: yours if you wrote it. */
export function laneOfPr(pr: Pick<PullRequest, "roles">): BoardLane {
  return pr.roles.includes("author") ? "mine" : "review";
}

/**
 * The Board's columns split into its two lanes, each in the columns' own
 * order. The queue stays one queue — the lanes only show which of it is yours.
 */
export function boardLanes(cols: BoardColumns): Record<BoardLane, BoardColumns> {
  const lane = (l: BoardLane): BoardColumns => ({
    idle: cols.idle.filter((x) => laneOfPr(x.pr) === l),
    queued: cols.queued.filter((i) => laneOfScenario(i.scenario) === l),
    working: cols.working.filter((i) => laneOfScenario(i.scenario) === l),
    needsYou: cols.needsYou.filter((i) => laneOfScenario(i.scenario) === l),
    done: cols.done.filter((i) => laneOfScenario(i.scenario) === l),
    doneRuns: cols.doneRuns,
  });
  return { mine: lane("mine"), review: lane("review") };
}
