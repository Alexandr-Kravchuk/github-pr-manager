// A PR card's CI line: one badge per failing or pending check made a long
// "sausage" on big pipelines (fifteen shards, all amber, all saying the same).
// Checks in the same state collapse into one badge — "15 checks running" —
// whose tooltip names them; a lone check keeps its own badge and name.
// Node-free (see AGENTS.md): PrCard.tsx value-imports it.

import type { CheckItem, CheckState } from "./types";

export type CheckBadgeItem =
  | { kind: "one"; check: CheckItem }
  | { kind: "group"; state: CheckState; label: string; names: string[] };

const VERB: Partial<Record<CheckState, string>> = {
  failure: "failing",
  pending: "running",
};

/** "3 checks failing", "15 checks running". */
export function checkGroupLabel(state: CheckState, count: number): string {
  return `${count} checks ${VERB[state] ?? state}`;
}

/**
 * The badges for `checks`, in order of first appearance of each state: a state
 * with one check keeps that check's badge, a state with several gets one group.
 */
export function collapseChecks(checks: readonly CheckItem[]): CheckBadgeItem[] {
  const byState = new Map<CheckState, CheckItem[]>();
  for (const c of checks) {
    const list = byState.get(c.state);
    if (list) list.push(c);
    else byState.set(c.state, [c]);
  }
  return [...byState].map(([state, list]) =>
    list.length === 1
      ? { kind: "one", check: list[0] }
      : { kind: "group", state, label: checkGroupLabel(state, list.length), names: list.map((c) => c.name) },
  );
}
