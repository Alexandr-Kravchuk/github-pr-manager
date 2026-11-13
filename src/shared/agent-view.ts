import type { NotifyEventKind } from "./notify";
import type { PlanStep } from "./agent-stream";
import { isReviewDue } from "./pr-filter";
import type { AgentItem, AgentRunState, AgentSettings, AgentState, PullRequest } from "./types";

/**
 * Why the agent leaves a PR alone while a Claude session of yours holds it — the
 * plan's reason, and the one the Board reads to offer no "Let the agent …" on
 * that PR: a second session on one PR edits the same branch and answers the
 * same threads twice.
 */
export const OWN_SESSION_WHY = "Your Claude session is on it";

/** True when `why` says a Claude session of yours holds the PR. */
export function isOwnSessionWhy(why: string | null | undefined): boolean {
  return typeof why === "string" && why.toLowerCase().includes(OWN_SESSION_WHY.toLowerCase());
}

// How the agent's state reads on the dashboard: where each PR stands on the
// Board and what its card, the chip, the tray and a notification say about
// it. Node-free (the renderer value-imports it) and pure, so the rules are
// unit-tested without a DOM.

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

export function runFor(state: Pick<AgentState, "running">, runId: string): AgentRunState | null {
  return state.running.find((r) => r.runId === runId) ?? null;
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

/** What a run is doing, as the chip and the tray say it — "Drafting review #911", "Fixing CI on #142". */
export function itemVerb(item: Pick<AgentItem, "scenario" | "reasons">): string {
  if (item.scenario !== "drive") return SCENARIO_VERB[item.scenario];
  const r = item.reasons ?? [];
  if (r.includes("self")) return "Self-reviewing";
  if (r.length === 1) return { comments: "Answering reviewers on", ci: "Fixing CI on", conflicts: "Resolving the conflict on" }[r[0]] ?? "Fixing";
  return "Fixing";
}

/** What a run of each scenario is doing, as the chip and the tray say it. */
export const SCENARIO_VERB: Record<AgentItem["scenario"], string> = {
  review: "Drafting review",
  brief: "Briefing",
  rereview: "Re-reviewing",
  drive: "Driving",
  merge: "Merging",
  afterMerge: "Checking Jira for",
  reapprove: "Approving again",
  reask: "Asking reviewers again on",
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
  /** Moves the agent prepared for you — the Your-move cards it made ready (`readyItems`). */
  readyForYou: number;
  /** What holds the queue; null when nothing does. */
  block: QueueBlock | null;
  /** That, in words: "Paused", "Quiet hours until 08:00", "Usage limit — waits until 14:05", "Daily limit reached (30)". */
  blockText: string | null;
}

export function agentSummary(state: AgentState): AgentSummary {
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
    readyForYou: readyItems(state.items, state.heads).length,
    block,
    blockText,
  };
}

/**
 * The agent in one line, for the tray's tooltip and menu: what runs (with
 * the step its plan is on), else why nothing does, plus what waits for you —
 * "Drafting review #911 · 4/6 · 2 ready for you", "Paused", "Quiet hours until 08:00 · 3 in line".
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
    line = `${itemVerb(item)} #${item.prNumber}${first.paused ? " (paused)" : step ? ` · ${step}` : ""}${sum.running > 1 ? ` +${sum.running - 1}` : ""}`;
  } else if (sum.blockText && sum.queued > 0) {
    line = `${sum.blockText} · ${sum.queued} in line`;
  } else if (sum.blockText && sum.block !== "daily") {
    line = sum.blockText;
  } else if (sum.queued > 0) {
    line = `${sum.queued} in line`;
  } else {
    line = "Idle";
  }
  return sum.readyForYou > 0 ? `${line} · ${sum.readyForYou} ready for you` : line;
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

/** Your PR's work (drive, a merge, the Jira run after it, re-asking reviewers) — or a review of someone else's (review, brief, re-review, re-approve). */
export function laneOfScenario(scenario: AgentItem["scenario"]): BoardLane {
  return scenario === "drive" || scenario === "merge" || scenario === "afterMerge" || scenario === "reask" ? "mine" : "review";
}

/** An idle PR's lane: yours if you wrote it. */
export function laneOfPr(pr: Pick<PullRequest, "roles">): BoardLane {
  return pr.roles.includes("author") ? "mine" : "review";
}


// ---------------------------------------------------------------------------
// The Board by whose move it is. A column is not the state of an agent run but
// who has to act next on the PR — you, the agent, the people you wait on — or
// that its journey (or your part in it) ended today. One pure function decides
// it for every surface, so the Board, the header chip, the tray and a card's
// status line can't disagree; the Board holds one card per PR because the
// column is a function of the PR.

/** Your move · Agent on it · With reviewers / With the author · Done today / Merged today. */
export type BoardColumn = "you" | "agent" | "waiting" | "done";
export const BOARD_COLUMNS: readonly BoardColumn[] = ["you", "agent", "waiting", "done"];

/** What each column is called in each lane — on the Board, and in the agent's line on a card, a cell, a tile. */
export const COLUMN_TITLES: Record<BoardLane, Record<BoardColumn, string>> = {
  mine: { you: "Your move", agent: "Agent on it", waiting: "With reviewers", done: "Merged today" },
  review: { you: "Your move", agent: "Agent on it", waiting: "With the author", done: "Done today" },
};

/** A queued run's place in the agent's one queue, as a card says it: "Up next", "2nd in line". */
export function inLine(n: number): string {
  if (n <= 1) return "Up next";
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix} in line`;
}

/**
 * What a card asks of you, as its one button. The first six are moves the
 * agent prepared ("ready for you"); the next four are GitHub's say-so with the
 * agent not on it; `updateJira` is the quiet offer on a merged PR.
 */
export type StageActionKind =
  | "send"
  | "push"
  | "decide"
  | "merge"
  | "reapprove"
  | "reask"
  | "draftReview"
  | "fix"
  | "review"
  | "rereview"
  | "fixYourself"
  | "draft"
  | "updateJira";

export interface StageAction {
  kind: StageActionKind;
  /** The button's words: a verb and what goes out — "Send review", "Push 2 fixes". */
  label: string;
}

/** An SDLC orchestrator run that drives your PR: the badge its card wears instead of the agent's buttons. */
export interface SdlcBadge {
  /** The Jira key of the run, "ENG-93412". */
  key: string;
  /** The run's current stage as the orchestrator names it; null when it names none. */
  stage: string | null;
}

export interface BoardStage {
  lane: BoardLane;
  column: BoardColumn;
  /** The one thing to do; null where nothing waits on you. */
  action: StageAction | null;
  /** The agent prepared this move — it counts in "N ready for you". */
  ready: boolean;
  /** The item the card reads: the live run, else the result for you, else today's latest. */
  item: AgentItem | null;
  /** The agent's last word on the PR when that isn't what placed the card: "Published: …", "Stopped by you". */
  note: string | null;
  /** Why the agent isn't on it, for a card GitHub alone placed in Your move. */
  why: string | null;
  sdlc: SdlcBadge | null;
  /** An approval of yours from an earlier day: counted as "+N earlier" under Done today, not a card. */
  earlier: boolean;
  /** Your approval stands on this head, yet GitHub lists a request for your review made after it (`approvalStands`). */
  askedAgain: boolean;
  /** The result on the card can't be acted on any more (`staleRun`): GitHub places the card, the run is a note with Discard. */
  stale: StaleRun | null;
  /** When the PR came to this column, as near as is known: the age a card shows and the order in a column. */
  since: string;
}

export interface StageContext {
  /** The local day (`todayKey`) "today" means. */
  today: string;
  /** Why the agent isn't on a PR, by PR id (`AgentState.idle`). */
  idle?: Readonly<Record<string, string>>;
  /** The SDLC runs that drive your PRs, by PR id. */
  orchestrated?: Readonly<Record<string, SdlcBadge>>;
}

/** A PR's items, as the card reads them: the live run, the result waiting on you, today's latest. */
function stageItems(items: readonly AgentItem[], today: string): { live: AgentItem | null; result: AgentItem | null; last: AgentItem | null } {
  let live: AgentItem | null = null;
  let result: AgentItem | null = null;
  let last: AgentItem | null = null;
  const later = (a: AgentItem, b: AgentItem) => (a.finishedAt ?? a.queuedAt) > (b.finishedAt ?? b.queuedAt);
  for (const i of items) {
    if (i.state === "working" || i.state === "queued") {
      if (!live || (live.state === "queued" && i.state === "working") || (live.state === i.state && queueRank(i) < queueRank(live))) live = i;
    } else if (i.state === "needsYou" || i.state === "error") {
      if (!result || later(i, result)) result = i;
    } else if (!isQuiet(i) && finishedOn(i, today)) {
      if (!last || later(i, last)) last = i;
    }
  }
  return { live, result, last };
}

/** The head commit an item was keyed on ("<id>|<scenario>|<head>…"); null when its key names none. */
export function keyHead(key: string): string | null {
  const h = key.split("|")[2];
  return h && h !== "-" ? h : null;
}

/** Two commit ids name the same commit — either may be abbreviated, as git does it (7 characters at least); an empty id names none. */
function sameCommit(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a));
}

/**
 * The PR's head is a commit of the run's own — its last one or one before it —
 * whoever pushed it: the app's Push, or the session you continued in Claude
 * (which never sets `pushed`), all of its commits or only some.
 */
function headIsRuns(item: AgentItem, headOid: string): boolean {
  const d = item.drive;
  return Boolean(d && (sameCommit(headOid, d.head) || d.commits.some((c) => sameCommit(headOid, c.oid))));
}

/**
 * Why a drive's result waiting on you can't be acted on any more:
 * - `restart`: the app restarted after it (`needsRerun`), so its commits can't
 *   be pushed and its session can't go on with your answer;
 * - `headMoved`: the PR's head is past the commit it started from — someone
 *   pushed since, so its commits and questions are about a PR that moved on.
 * Null while it still is a move of yours. Commits in its worktree the app
 * couldn't read (`localWork`) are never stale: that work is on no branch.
 */
export type StaleRun = "restart" | "headMoved";

export function staleRun(item: AgentItem, headOid: string | null | undefined): StaleRun | null {
  if (item.scenario !== "drive" || item.state !== "needsYou") return null;
  if (item.localWork && !item.localWork.kept && item.localWork.ahead !== 0) return null;
  const from = item.drive?.base ?? keyHead(item.key);
  // The head moved to a commit of the run's own: its push, not someone else's.
  if (headOid && from && !sameCommit(headOid, from) && !headIsRuns(item, headOid)) return "headMoved";
  const unpushed = !item.pushed && (item.drive?.commits.length ?? 0) > 0;
  if (item.needsRerun && ((item.result?.asks.length ?? 0) > 0 || unpushed)) return "restart";
  return null;
}

/** A stale run in a line, for its card's note: what happened and that it needs nothing from you. */
export function staleLine(why: StaleRun, item: AgentItem, headOid: string | null | undefined): string {
  if (why === "headMoved") {
    const from = (item.drive?.base ?? keyHead(item.key) ?? "").slice(0, 7);
    const to = headOid ? ` (now ${headOid.slice(0, 7)})` : "";
    return `Superseded — the PR moved past ${from || "the commit this run started from"}${to}; this run's result is out of date`;
  }
  return "Stale — the app restarted after this run, so it can't push or take your answer";
}

/**
 * What a result waiting on you asks you to do — or null when it asks nothing
 * (stopped, taken over in a terminal, timed out, nothing to post, cut short by
 * a restart, stale — `staleRun`): such a run is a line on its card, not a
 * decision. `headOid` is the PR's head now — null only where it isn't known,
 * so no caller can leave it out by accident.
 */
export function resultAction(item: AgentItem, lane: BoardLane, headOid: string | null): StageAction | null {
  const fix = (): StageAction => ({ kind: "fix", label: lane === "mine" && item.sessionId ? "Open in Claude" : "Try again" });
  // The Jira run follows a merge: its PR is gone, there's nothing to try again.
  if (item.state === "error") return item.scenario === "afterMerge" ? null : fix();
  if (item.state !== "needsYou" || item.interrupted) return null;
  switch (item.scenario) {
    case "merge":
      return { kind: "merge", label: "Merge" };
    case "reapprove":
      return { kind: "reapprove", label: "Re-approve" };
    case "reask": {
      const n = item.reapproval?.logins.length ?? 0;
      return { kind: "reask", label: n > 1 ? `Ask ${n} again` : "Ask again" };
    }
    case "brief":
      return item.output ? { kind: "draftReview", label: "Draft a review" } : null;
    case "afterMerge":
      return item.sessionId ? { kind: "updateJira", label: "Update Jira…" } : null;
    case "review":
    case "rereview":
      if (!item.plan || item.published) return null;
      return { kind: "send", label: item.plan.event === "APPROVE" ? "Approve" : item.scenario === "rereview" ? "Send re-review" : "Send review" };
    case "drive": {
      // Commits in its worktree the app couldn't read: never "nothing to push", never a Send on its own.
      if (item.localWork && !item.localWork.kept && item.localWork.ahead !== 0) return { kind: "push", label: "Unpushed work" };
      if (staleRun(item, headOid)) return null;
      if ((item.result?.asks.length ?? 0) > 0) return { kind: "decide", label: "Your call" };
      const n = item.drive?.commits.length ?? 0;
      const replies = item.plan && !item.published ? item.plan.replies.length : 0;
      if (n > 0 && !item.pushed) {
        return { kind: "push", label: replies > 0 ? "Push & reply" : `Push ${n} fix${n === 1 ? "" : "es"}` };
      }
      // Nothing to push, yet answers for the reviewers: they go out by themselves.
      if (n === 0 && replies > 0) return { kind: "send", label: replies === 1 ? "Send reply" : `Send ${replies} replies` };
      // It ran to the end and has nothing to push: it couldn't do it.
      return item.drive ? fix() : null;
    }
  }
}

/**
 * The moves the agent prepared for you, one per PR, oldest first: the result
 * a PR's card asks you to act on in Your move (`boardStage` rule 2) — not
 * while the agent is on the PR again, never a run that asks nothing or a
 * stale one (`heads`: each PR's head now, by PR id). What the header chip,
 * the tray and the popover count as "ready for you".
 */
export function readyItems(items: readonly AgentItem[], heads?: Readonly<Record<string, string>>): AgentItem[] {
  const byPr = new Map<string, AgentItem[]>();
  for (const i of items) {
    const list = byPr.get(i.prId);
    if (list) list.push(i);
    else byPr.set(i.prId, [i]);
  }
  const out: AgentItem[] = [];
  for (const list of byPr.values()) {
    const { live, result } = stageItems(list, "");
    if (live || !result) continue;
    const action = resultAction(result, laneOfScenario(result.scenario), heads?.[result.prId] ?? null);
    if (action && action.kind !== "updateJira") out.push(result);
  }
  return out.sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
}

/**
 * Your approval stands on the PR's current head and the author hasn't answered
 * in a thread since: a request for your review that came after it — GitHub
 * keeps listing you as asked — asks nothing new of you.
 */
export function approvalStands(pr: Pick<PullRequest, "viewerApproved" | "viewerReviewedHead" | "viewerReviewedAt" | "authorRepliedAt">): boolean {
  if (!pr.viewerApproved || !pr.viewerReviewedHead) return false;
  return !(pr.authorRepliedAt !== null && pr.viewerReviewedAt !== null && pr.authorRepliedAt > pr.viewerReviewedAt);
}

/** Your PR is ready to merge as GitHub sees it. */
function githubReady(pr: PullRequest): boolean {
  return !pr.isDraft && pr.canBeMerged && !pr.awaitingReview && pr.ciState !== "failure" && !pr.hasConflicts;
}

/** Your PR has something wrong the agent would drive: red CI, a conflict, reviewers waiting on an answer. */
function needsWork(pr: PullRequest): boolean {
  return pr.ciState === "failure" || pr.hasConflicts || pr.hasUnaddressedChangeRequest || pr.hasUnaddressedComments;
}

/**
 * The column a PR's card sits in, and the one thing it asks of you. `pr` is
 * null for a PR that has left the dashboard (merged, closed) — then only the
 * agent's items place it. `items` are the PR's own. Null: no card at all.
 *
 * The rules, first that applies:
 * 1. The agent is on it (queued, working) → Agent on it.
 * 2. The agent prepared your move → Your move, its one button; a run that asks
 *    nothing goes on to rule 3 with its line as the card's note.
 * 3. GitHub: your PR — an SDLC run's work is that run's (Agent on it, no
 *    buttons), a draft or something broken is yours, ready is Merge, else With
 *    reviewers; a PR you review — asked of you is yours, approved by you is
 *    done (today's) or "+N earlier", else With the author.
 * 4. Gone from the dashboard, and the agent did something on it today → Done today.
 */
export function boardStage(pr: PullRequest | null, items: readonly AgentItem[], ctx: StageContext): BoardStage | null {
  const { live, result, last } = stageItems(items, ctx.today);
  const first = live ?? result ?? last;
  const lane: BoardLane | null = pr ? laneOfPr(pr) : first ? laneOfScenario(first.scenario) : null;
  if (!lane) return null;
  const sdlc = pr ? (ctx.orchestrated?.[pr.id] ?? null) : null;
  const headOid = pr?.headOid ?? null;
  const stale = result ? staleRun(result, headOid) : null;
  const base = { lane, action: null, ready: false, note: null, why: null, sdlc, earlier: false, askedAgain: false, stale };
  const at = (i: AgentItem) => i.finishedAt ?? i.startedAt ?? i.queuedAt;

  // 1. The agent is on it.
  if (live) return { ...base, stale: null, column: "agent", item: live, since: live.startedAt ?? live.queuedAt };

  // 2. The agent prepared your move — unless the PR moved past it or a restart left it unusable.
  if (result) {
    const action = resultAction(result, lane, headOid);
    if (action?.kind === "updateJira") return { ...base, column: "done", action, item: result, note: result.headline, since: at(result) };
    if (action) return { ...base, column: "you", action, ready: true, item: result, since: at(result) };
  }
  const item = result ?? last;
  const note = stale && result ? staleLine(stale, result, headOid) : (item?.headline ?? null);

  // 4. Gone from the dashboard: merged or closed, as far as the agent knows.
  if (!pr) return item ? { ...base, column: "done", item, note, since: at(item) } : null;

  // 3. GitHub says whose move it is.
  const card = (column: BoardColumn, since: string, action: StageAction | null = null, extra: Partial<BoardStage> = {}): BoardStage => ({
    ...base,
    column,
    action,
    item,
    note,
    since,
    why: column === "you" ? (ctx.idle?.[pr.id] ?? null) : null,
    ...extra,
  });
  // What the agent just posted or pushed isn't in the snapshot yet: the move it made is not yours again.
  if (last && !result && (last.published || last.pushed) && at(last) >= pr.updatedAt) return card("waiting", at(last));
  const waitedSince = lane === "mine" ? (pr.lastCommitPushedAt ?? pr.createdAt) : (pr.viewerReviewedAt ?? pr.updatedAt);

  if (lane === "mine") {
    if (sdlc) {
      // The orchestrator waits for someone to merge; everything else is its run's work.
      if (githubReady(pr)) return card("you", pr.updatedAt, { kind: "merge", label: "Merge on GitHub" });
      if (pr.isDraft || needsWork(pr)) return card("agent", pr.updatedAt);
      return card("waiting", waitedSince);
    }
    if (pr.isDraft) return card("you", pr.createdAt, { kind: "draft", label: "Open on GitHub" });
    if (needsWork(pr)) return card("you", pr.updatedAt, { kind: "fixYourself", label: "Open on GitHub" });
    if (githubReady(pr)) return card("you", pr.updatedAt, { kind: "merge", label: "Merge on GitHub" });
    return card("waiting", waitedSince);
  }

  // Asked again with your approval standing on this very head: nothing waits on
  // you. It sits with today's approvals, with "Approve again" in its menu to
  // answer the request — never in Your move with only a link to GitHub.
  if (isReviewDue(pr) && approvalStands(pr)) return card("done", pr.viewerReviewedAt ?? pr.updatedAt, null, { askedAgain: true });
  if (isReviewDue(pr)) {
    const again = pr.viewerHasReviewed || pr.myReReviewDue;
    return card("you", pr.updatedAt, { kind: again ? "rereview" : "review", label: "Open on GitHub" });
  }
  if (pr.viewerApproved) {
    const on = pr.viewerReviewedAt ?? pr.updatedAt;
    return card("done", on, null, { earlier: todayKey(new Date(on)) !== ctx.today });
  }
  return card("waiting", waitedSince);
}

/** A card on the Board: its PR (null once the PR has left the dashboard) and where it stands. */
export interface StageCard {
  prId: string;
  pr: PullRequest | null;
  stage: BoardStage;
}

export type LaneColumns = Record<BoardColumn, StageCard[]> & {
  /** Approvals of yours from earlier days, under Done today as "+N earlier". */
  earlier: number;
};

export interface StageBoard {
  mine: LaneColumns;
  review: LaneColumns;
  /** Moves the agent prepared on PRs the dashboard's filters hide. */
  hiddenReady: number;
}

/** Your move, cheapest and readiest first; what is yours without the agent next; drafts last. */
const YOU_ORDER: Record<StageActionKind, number> = {
  merge: 0,
  reapprove: 0,
  reask: 1,
  send: 1,
  push: 1,
  draftReview: 1,
  decide: 2,
  fix: 3,
  review: 4,
  rereview: 4,
  fixYourself: 4,
  updateJira: 5,
  draft: 9,
};

function laneColumns(): LaneColumns {
  return { you: [], agent: [], waiting: [], done: [], earlier: 0 };
}

/**
 * The Board. `shown` are the PRs the dashboard's filters let through, `all`
 * every PR in the snapshot; a PR missing from both has left the dashboard and
 * is placed by the agent's items alone. Your move: readiest first, drafts last.
 * Agent on it: running, then the queue in its order. Waiting: longest first —
 * the one to nudge. Done today: newest first.
 */
export function stageColumns(shown: readonly PullRequest[], all: readonly PullRequest[], state: Pick<AgentState, "items">, ctx: StageContext): StageBoard {
  const board: StageBoard = { mine: laneColumns(), review: laneColumns(), hiddenReady: 0 };
  const byPr = new Map<string, AgentItem[]>();
  for (const item of state.items) {
    const list = byPr.get(item.prId);
    if (list) list.push(item);
    else byPr.set(item.prId, [item]);
  }
  const place = (prId: string, pr: PullRequest | null) => {
    const stage = boardStage(pr, byPr.get(prId) ?? [], ctx);
    if (!stage) return;
    const lane = board[stage.lane];
    if (stage.earlier) lane.earlier++;
    else lane[stage.column].push({ prId, pr, stage });
  };
  const shownIds = new Set(shown.map((p) => p.id));
  const allIds = new Set(all.map((p) => p.id));
  for (const pr of shown) place(pr.id, pr);
  for (const pr of all) {
    if (!shownIds.has(pr.id) && boardStage(pr, byPr.get(pr.id) ?? [], ctx)?.ready) board.hiddenReady++;
  }
  for (const prId of byPr.keys()) if (!allIds.has(prId) && !shownIds.has(prId)) place(prId, null);

  const live = (c: StageCard) => (c.stage.item?.state === "working" ? 0 : c.stage.item?.state === "queued" ? 1 : 2);
  for (const lane of [board.mine, board.review]) {
    lane.you.sort((a, b) => YOU_ORDER[a.stage.action!.kind] - YOU_ORDER[b.stage.action!.kind] || a.stage.since.localeCompare(b.stage.since));
    lane.agent.sort(
      (a, b) =>
        live(a) - live(b) ||
        (live(a) === 1 ? queueRank(a.stage.item!) - queueRank(b.stage.item!) : 0) ||
        a.stage.since.localeCompare(b.stage.since),
    );
    lane.waiting.sort((a, b) => a.stage.since.localeCompare(b.stage.since));
    lane.done.sort((a, b) => b.stage.since.localeCompare(a.stage.since));
  }
  return board;
}

const EVENT_WORD: Record<string, string> = { APPROVE: "Approve", REQUEST_CHANGES: "Request changes", COMMENT: "Comment" };
const REASON_WORK: Record<string, string> = { self: "Self-review before reviewers look", ci: "Fixing CI", conflicts: "Resolving the conflict", comments: "Answering reviewers' comments" };
const REASON_NAME: Record<string, string> = { self: "Self-review", ci: "CI", conflicts: "Conflict", comments: "Reviewers' comments" };

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the agent is doing on a PR, in the words of the card, the tray and a list row. */
export function workLine(item: Pick<AgentItem, "scenario" | "reasons">): string {
  switch (item.scenario) {
    case "review":
      return "Drafting your review";
    case "brief":
      return "Reading a big PR for a brief";
    case "rereview":
      return "Re-reviewing — the author answered";
    case "merge":
      return "Merging";
    case "reapprove":
      return "Approving again — only the base changed";
    case "reask":
      return "Asking your reviewers again";
    case "afterMerge":
      return "Checking Jira after the merge";
    case "drive": {
      const r = item.reasons ?? [];
      return r.length > 0 ? r.map((x) => REASON_WORK[x] ?? x).join(" · ") : "Working on your PR";
    }
  }
}

/**
 * A card's action line: what goes out, what waits, what happened — in your
 * words, never the implementation's ("Request changes · 2 comments", "Self-review:
 * 2 fixes ready to push", "Approved by anna, ivan · CI green").
 */
export function stageLine(stage: BoardStage, pr: PullRequest | null): string {
  const item = stage.item;
  if (stage.column === "agent") {
    // On the agent only while a run of its is live; else an SDLC run has the PR.
    if (item && (item.state === "working" || item.state === "queued")) return workLine(item);
    return "The SDLC run is on it";
  }
  const kind = stage.action?.kind;
  if (stage.column === "you" && item) {
    if (kind === "send" && item.plan && item.scenario === "drive") {
      const what = (item.reasons ?? []).map((x) => REASON_NAME[x] ?? x).join(" + ") || "The agent";
      return `${what}: ${count(item.plan.replies.length, "reply", "replies")} ready to send, nothing to push`;
    }
    if (kind === "send" && item.plan) {
      const p = item.plan;
      return [
        p.event ? EVENT_WORD[p.event] : "Comment",
        p.comments.length > 0 ? count(p.comments.length, "comment") : null,
        p.replies.length > 0 ? count(p.replies.length, "reply", "replies") : null,
        p.escalations.length > 0 ? `${p.escalations.length} pushed back` : null,
        (p.held?.length ?? 0) > 0 ? `${p.held!.length} held back` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    if (kind === "push" && item.localWork && !item.localWork.kept) {
      const a = item.localWork.ahead;
      return `${a === null ? "Commits" : count(a, "commit")} in the run's worktree the app couldn't read — not on the PR`;
    }
    if (kind === "push") {
      const n = item.drive?.commits.length ?? 0;
      const what = (item.reasons ?? []).map((x) => REASON_NAME[x] ?? x).join(" + ") || "The agent";
      const replies = item.plan && !item.published ? item.plan.replies.length : 0;
      return `${what}: ${count(n, "fix", "fixes")}${replies > 0 ? ` and ${count(replies, "answer")}` : ""} ready to push`;
    }
    if (kind === "decide") {
      const asks = item.result?.asks ?? [];
      return `Your call: ${asks[0]?.question ?? ""}${asks.length > 1 ? ` (+${asks.length - 1} more)` : ""}`;
    }
    if (kind === "draftReview") {
      const q = item.result?.authorQuestions.length ?? 0;
      const lines = pr ? pr.additions + pr.deletions : 0;
      return `${lines > 0 ? `Big PR, ${lines.toLocaleString("en-US")} lines — brief` : "Brief ready"}${q > 0 ? ` · ${count(q, "question")} for the author` : ""}`;
    }
    if (kind === "fix") return item.headline;
  }
  if (kind === "merge" && pr) {
    const approved = pr.reviewers.filter((r) => r.reviewState === "approved").map((r) => r.login);
    const ci = pr.ciState === "success" ? "CI green" : null;
    return [approved.length > 0 ? `Approved by ${approved.join(", ")}` : "Ready to merge", ci].filter(Boolean).join(" · ");
  }
  if (kind === "reapprove" && item?.reapproval) return `Only the base changed since your approval at ${item.reapproval.oldHead.slice(0, 7)}`;
  if (kind === "reask" && item?.reapproval) return `Only the base changed — approvals of ${item.reapproval.logins.join(", ")} dismissed`;
  if (kind === "updateJira") return "Merged — Jira changes to apply";
  if (pr && stage.column === "you") {
    if (kind === "review") return pr.requestedOfMe ? "Review requested" : "Review requested of your team";
    if (kind === "rereview") return pr.myReReviewDue ? "The author answered your review" : "Asked to review again";
    if (kind === "draft") return "Draft — the agent self-reviews it once it's ready for review";
    if (kind === "fixYourself") {
      const parts: string[] = [];
      if (pr.ciState === "failure") {
        const names = pr.failingChecks.map((c) => c.name);
        parts.push(names.length > 0 ? `CI failing: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}` : "CI failing");
      }
      // A stack mends a conflict by a rebase of its layers, never by a merge of the base in.
      if (pr.hasConflicts) parts.push(pr.stack ? "Conflicts in the stack — it needs Rebase stack" : "Conflicts with the base branch");
      if (pr.hasUnaddressedChangeRequest || pr.hasUnaddressedComments) parts.push("Reviewers wait for your answer");
      return parts.join(" · ");
    }
  }
  if (stage.column === "waiting" && pr) {
    if (stage.lane === "mine") {
      if (pr.blockedByStack) return "Waits for the PR below it in the stack";
      const parts = pr.reviewers
        .filter((r) => r.reviewState !== "commented")
        .map((r) => (r.reviewState === "approved" ? `${r.login} ✓` : r.reviewState === "changes_requested" ? `${r.login} asked for changes` : r.reviewState === "dismissed" ? `${r.login}'s review dismissed` : `${r.login} pending`));
      return parts.length > 0 ? parts.join(" · ") : "Waiting for reviewers";
    }
    const verdict = pr.viewerHasReviewed ? (pr.viewerApproved ? "You approved" : "You asked for changes") : pr.roles.includes("reviewed") ? "You commented" : "Waiting for the author";
    return `${verdict}${pr.unresolvedThreads > 0 ? ` · ${count(pr.unresolvedThreads, "thread")} open` : ""}`;
  }
  if (stage.column === "done") {
    if (stage.askedAgain) return "Asked again — your approval stands on this head";
    if (pr?.viewerApproved) return "You approved";
    if (item) return item.headline;
  }
  return item?.headline ?? "";
}

/**
 * A notification's title, in the Board's words: what is ready for you and on
 * which PR — "Review ready to send: #929", "2 fixes ready to push: #142",
 * "Ready to merge: #85", "Your call on #150" — or that a run couldn't finish.
 * Null: no toast at all — a result the PR already moved past (`staleRun`,
 * `headOid` the PR's head now) is nobody's move, as on the Board.
 */
export function agentNoticeTitle(kind: "needsYou" | "failed" | "finished", item: AgentItem, headOid: string | null): string | null {
  if (kind === "needsYou" && staleRun(item, headOid)) return null;
  const pr = `#${item.prNumber}`;
  if (kind === "failed") {
    // A run the agent planned is tried once more on its own: the toast says so, rather than asking you to.
    const at = item.retryAt ? new Date(item.retryAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
    return at ? `The agent couldn't finish ${pr} — it tries again at ${at}` : `The agent couldn't finish ${pr}`;
  }
  if (kind === "finished") {
    // Before `published`: what an offer gives is marked published too.
    if (item.scenario === "reapprove") return `Approved again: ${pr}`;
    if (item.scenario === "reask") return `Reviewers asked again: ${pr}`;
    if (item.published) return `${item.scenario === "drive" ? "Replies" : item.scenario === "rereview" ? "Re-review" : "Review"} sent: ${pr}`;
    if (item.pushed) return `Fixes pushed: ${pr}`;
    if (item.scenario === "merge") return `Merged: ${pr}`;
    return `The agent finished ${pr}`;
  }
  const action = resultAction(item, laneOfScenario(item.scenario), headOid);
  switch (action?.kind) {
    case "send":
      if (item.scenario === "drive") return `${action.label === "Send reply" ? "Reply" : "Replies"} to reviewers ready to send: ${pr}`;
      return `${action.label === "Approve" ? "Approval" : item.scenario === "rereview" ? "Re-review" : "Review"} ready to send: ${pr}`;
    case "push": {
      const n = item.drive?.commits.length ?? 0;
      if (action.label === "Unpushed work") return `Unpushed work in the run's worktree: ${pr}`;
      return action.label === "Push & reply" ? `Fixes and replies ready to push: ${pr}` : `${n} fix${n === 1 ? "" : "es"} ready to push: ${pr}`;
    }
    case "merge":
      return `Ready to merge: ${pr}`;
    case "reapprove":
      return `Only the base changed — approve again: ${pr}`;
    case "reask":
      return `Approvals dismissed by a base update: ${pr}`;
    case "decide":
      return `Your call on ${pr}`;
    case "draftReview":
      return `Brief ready: ${pr}`;
    case "fix":
      return `The agent couldn't finish ${pr}`;
    case "updateJira":
      return `Jira changes to apply: ${pr}`;
    default:
      return `The PR agent: ${pr}`;
  }
}
