import type { AgentItem, AgentRunState, AgentState, PullRequest } from "./types";

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
  done: AgentItem[];
}

/**
 * The Board: the dashboard's filtered PRs by what the agent is doing with
 * them. A PR with live work sits in that column; every other PR is Idle with
 * the reason the agent gives. Done today also shows PRs that left the
 * dashboard (merged, closed) — their work was still today's.
 */
export function boardColumns(prs: readonly PullRequest[], allPrIds: ReadonlySet<string>, state: AgentState, today: string): BoardColumns {
  const shown = new Set(prs.map((p) => p.id));
  const cols: BoardColumns = { idle: [], queued: [], working: [], needsYou: [], done: [] };
  const busy = new Set<string>();
  for (const item of state.items) {
    const onBoard = shown.has(item.prId);
    if (item.state === "queued" && onBoard) cols.queued.push(item);
    else if (item.state === "working" && onBoard) cols.working.push(item);
    else if ((item.state === "needsYou" || item.state === "error") && onBoard) cols.needsYou.push(item);
    else if (item.state === "done" && !isQuiet(item) && finishedOn(item, today) && (onBoard || !allPrIds.has(item.prId))) {
      cols.done.push(item);
    }
    if (item.state === "queued" || item.state === "working" || item.state === "needsYou" || item.state === "error") busy.add(item.prId);
  }
  for (const pr of prs) {
    if (!busy.has(pr.id)) cols.idle.push({ pr, reason: state.idle[pr.id] ?? (state.enabled ? "Nothing for the agent" : "The agent is off") });
  }
  const byQueued = (a: AgentItem, b: AgentItem) => a.queuedAt.localeCompare(b.queuedAt);
  cols.queued.sort(byQueued);
  cols.working.sort(byQueued);
  cols.needsYou.sort((a, b) => Number(a.later ?? false) - Number(b.later ?? false) || (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
  cols.done.sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
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
  if (item.state === "error") return "Run again";
  if (item.state !== "needsYou") return null;
  if (item.scenario === "brief" && item.output) return "Review anyway";
  if (item.sessionId) return "Continue in session";
  return null;
}
