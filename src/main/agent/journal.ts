import type { BoardColumn, BoardLane, BoardStage, StageActionKind, StageContext } from "../../shared/agent-view";
import { boardStage, stageLine } from "../../shared/agent-view";
import type { RunOutcome } from "./runner";
import type { AgentLogEntry, AgentItemRecord } from "./store";
import type { AgentItem, AgentSettings, PullRequest } from "../../shared/types";

// The agent's journal: what it did and why, and where each PR's card went on
// the Board — one JSON line per event in userData/agent/log.jsonl, to read
// back when something went wrong and to see where the time goes.
//
// The run events are written where they happen (index.ts). Everything that is
// a change of state — an item's state, a card's column, why the agent leaves a
// PR alone, what holds the queue — is found here instead, by comparing what
// was with what is: a code path that forgets to log can't leave a hole.
// Pure functions, so the tests feed them states and read the lines.

/** Where a PR's card stood on the Board when the journal last looked. */
export interface BoardMark {
  lane: BoardLane;
  column: BoardColumn;
  action: StageActionKind | null;
  /** When the journal saw the card come to this column — what a move's `ms` counts from. */
  at: string;
  prNumber: number;
  repo: string;
  hostLabel: string;
}

/** An item's state when the journal last looked. */
export interface ItemMark {
  state: AgentItem["state"];
  at: string;
}

/** Strings in the log stay short: a line is for finding things, the session's transcript has the rest. */
export function clip(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const msBetween = (from: string, to: string): number | undefined => {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

/** The fields every line about one item carries. */
export function itemFields(item: Pick<AgentItem, "prId" | "prNumber" | "repo" | "scenario" | "runId">): Pick<AgentLogEntry, "prId" | "prNumber" | "repo" | "scenario" | "runId"> {
  return { prId: item.prId, prNumber: item.prNumber, repo: item.repo, scenario: item.scenario, runId: item.runId };
}

/**
 * Items whose state changed since `prev`: one `item`/`state` line each, with
 * how long the old state lasted. A new item comes in from null. Items gone
 * from the list (pruned) are dropped from the marks without a line.
 */
export function diffItems(prev: ReadonlyMap<string, ItemMark>, items: readonly AgentItemRecord[], at: string): { entries: AgentLogEntry[]; marks: Map<string, ItemMark> } {
  const entries: AgentLogEntry[] = [];
  const marks = new Map<string, ItemMark>();
  for (const item of items) {
    const was = prev.get(item.runId);
    if (was && was.state === item.state) {
      marks.set(item.runId, was);
      continue;
    }
    marks.set(item.runId, { state: item.state, at });
    const ms = was ? msBetween(was.at, at) : undefined;
    entries.push({
      at,
      kind: "item",
      event: "state",
      ...itemFields(item),
      from: was?.state ?? null,
      to: item.state,
      detail: clip(item.headline),
      ...(ms !== undefined ? { ms } : {}),
    });
  }
  return { entries, marks };
}

/** Every card the Board would show now, by PR id — the dashboard's PRs and the ones only the agent's items still place. */
export function boardNow(
  prs: readonly PullRequest[],
  items: readonly AgentItem[],
  ctx: StageContext,
): Map<string, { stage: BoardStage; pr: PullRequest | null; prNumber: number; repo: string; hostLabel: string }> {
  const byPr = new Map<string, AgentItem[]>();
  for (const item of items) {
    const list = byPr.get(item.prId);
    if (list) list.push(item);
    else byPr.set(item.prId, [item]);
  }
  const out = new Map<string, { stage: BoardStage; pr: PullRequest | null; prNumber: number; repo: string; hostLabel: string }>();
  const onDashboard = new Set(prs.map((p) => p.id));
  for (const pr of prs) {
    const stage = boardStage(pr, byPr.get(pr.id) ?? [], ctx);
    if (stage) out.set(pr.id, { stage, pr, prNumber: pr.number, repo: pr.repo, hostLabel: pr.hostLabel });
  }
  for (const [prId, list] of byPr) {
    if (onDashboard.has(prId)) continue;
    const stage = boardStage(null, list, ctx);
    if (stage) out.set(prId, { stage, pr: null, prNumber: list[0].prNumber, repo: list[0].repo, hostLabel: list[0].hostLabel });
  }
  return out;
}

/**
 * The cards that moved since `prev`, as `board` lines:
 * - `seen`   — the first look ever (`prev` null): where every card stood;
 * - `move`   — to another column or lane; from null, a new card;
 * - `action` — the same column, another button ("Open on GitHub" → "Send review");
 * - `left`   — off the Board (merged or closed and nothing today, a new day).
 * A PR missing because its host failed this time keeps its mark: it didn't move,
 * the dashboard just couldn't see it.
 */
export function diffBoard(
  prev: Readonly<Record<string, BoardMark>> | null,
  now: ReturnType<typeof boardNow>,
  at: string,
  failedHosts: ReadonlySet<string> = new Set(),
): { entries: AgentLogEntry[]; marks: Record<string, BoardMark> } {
  const entries: AgentLogEntry[] = [];
  const marks: Record<string, BoardMark> = {};
  for (const [prId, card] of now) {
    const { stage } = card;
    const action = stage.action?.kind ?? null;
    const was = prev?.[prId];
    if (was && was.column === stage.column && was.lane === stage.lane && was.action === action) {
      marks[prId] = was;
      continue;
    }
    const moved = !was || was.column !== stage.column || was.lane !== stage.lane;
    marks[prId] = { lane: stage.lane, column: stage.column, action, at: moved ? at : was.at, prNumber: card.prNumber, repo: card.repo, hostLabel: card.hostLabel };
    const ms = was && moved ? msBetween(was.at, at) : undefined;
    entries.push({
      at,
      kind: "board",
      event: prev === null ? "seen" : moved ? "move" : "action",
      prId,
      prNumber: card.prNumber,
      repo: card.repo,
      ...(stage.item ? { runId: stage.item.runId, scenario: stage.item.scenario } : {}),
      from: was ? was.column : null,
      to: stage.column,
      detail: clip(stageLine(stage, card.pr)),
      ...(ms !== undefined ? { ms } : {}),
      data: {
        lane: stage.lane,
        ...(was && was.lane !== stage.lane ? { fromLane: was.lane } : {}),
        action,
        ...(was && was.action !== action ? { fromAction: was.action } : {}),
        ...(stage.ready ? { ready: true } : {}),
        ...(stage.item ? { itemState: stage.item.state } : {}),
        ...(stage.why ? { why: clip(stage.why, 200) } : {}),
        ...(stage.sdlc ? { sdlc: stage.sdlc.key } : {}),
        ...(stage.earlier ? { earlier: true } : {}),
      },
    });
  }
  for (const [prId, was] of Object.entries(prev ?? {})) {
    if (now.has(prId)) continue;
    if (failedHosts.has(was.hostLabel)) {
      marks[prId] = was;
      continue;
    }
    const ms = msBetween(was.at, at);
    entries.push({ at, kind: "board", event: "left", prId, prNumber: was.prNumber, repo: was.repo, from: was.column, to: null, ...(ms !== undefined ? { ms } : {}), data: { lane: was.lane } });
  }
  return { entries, marks };
}

/**
 * Why the agent leaves each PR alone, where that changed: a `plan`/`idle` line
 * per PR whose reason is new or different. A PR the agent took up (its reason
 * went away) writes nothing — its `queued` run line says so.
 */
export function diffIdle(
  prev: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
  at: string,
  prs: ReadonlyMap<string, Pick<PullRequest, "number" | "repo">>,
): AgentLogEntry[] {
  const entries: AgentLogEntry[] = [];
  for (const [prId, reason] of Object.entries(next)) {
    if (prev[prId] === reason) continue;
    const pr = prs.get(prId);
    entries.push({
      at,
      kind: "plan",
      event: "idle",
      prId,
      ...(pr ? { prNumber: pr.number, repo: pr.repo } : {}),
      from: prev[prId] ?? null,
      to: reason,
    });
  }
  return entries;
}

/** Flattens settings into "a.b.c" → value, arrays and long strings kept whole but clipped. */
function flatten(value: unknown, prefix: string, out: Record<string, unknown>): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out[prefix] = typeof value === "string" ? clip(value, 120) : Array.isArray(value) ? clip(JSON.stringify(value), 200) : value;
}

/** What changed between two agent settings, path by path: `{ "scenarios.review.mode": ["shadow", "on"] }`. Null: nothing. */
export function settingsDiff(before: AgentSettings | null, after: AgentSettings | null): Record<string, [unknown, unknown]> | null {
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  flatten(before ?? {}, "", a);
  flatten(after ?? {}, "", b);
  const out: Record<string, [unknown, unknown]> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out[key] = [a[key] ?? null, b[key] ?? null];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * How a run went, for its end line: time, turns, cost and tokens as Claude
 * reported them, tool calls, refused tools, how it ended, its plan's progress,
 * and on a failure the last of stderr.
 */
export function runStats(item: Pick<AgentItem, "startedAt">, outcome: RunOutcome, at: string, how: { takeOver?: boolean; offStop?: boolean } = {}): Record<string, unknown> {
  const p = outcome.progress;
  const r = p.result;
  const ms = item.startedAt ? msBetween(item.startedAt, at) : undefined;
  const done = p.steps.filter((s) => s.status === "completed").length;
  const failed = !r || r.isError || r.subtype !== "success" || p.backgroundTasks > 0;
  const stderr = outcome.stderr.trim();
  return {
    ...(ms !== undefined ? { ms } : {}),
    exitCode: outcome.exitCode,
    ...(outcome.signal ? { signal: outcome.signal } : {}),
    // Still running when the process ended: the result, if any, was a waiting turn's.
    ...(p.backgroundTasks > 0 ? { backgroundTasks: p.backgroundTasks } : {}),
    ...(r ? { subtype: r.subtype } : {}),
    ...(r?.turns !== undefined ? { turns: r.turns } : {}),
    ...(r?.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
    ...(r?.durationMs !== undefined ? { claudeMs: r.durationMs } : {}),
    ...(r?.tokens ? { tokens: r.tokens } : {}),
    toolCalls: p.toolCalls,
    ...(r && r.denials > 0 ? { denials: r.denials, deniedTools: r.deniedTools ?? [] } : {}),
    ...(p.steps.length > 0 ? { steps: `${done}/${p.steps.length}` } : {}),
    ...(outcome.timedOut ? { timedOut: true } : {}),
    ...(outcome.stopped && !how.takeOver && !how.offStop ? { stopped: true } : {}),
    ...(how.takeOver ? { takenOver: true } : {}),
    ...(how.offStop ? { offStop: true } : {}),
    ...(failed && stderr ? { stderr: clip(stderr.split("\n").slice(-8).join("\n"), 1500) } : {}),
  };
}

/** The action's own arguments for its line — ids are fields of their own; text is clipped. */
export function actionArgs(action: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action)) {
    if (k === "type" || k === "runId" || k === "prId" || v === undefined) continue;
    out[k] = typeof v === "string" ? clip(v) : v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
