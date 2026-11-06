import { laneOfScenario } from "./agent-view";
import type { AgentItem } from "./types";

// When an item of the agent's stops being worth your attention, decided in one
// place: a newer run on the same PR replaced it, its PR left the dashboard
// (merged, closed, no longer yours to act on), or the run found nothing for
// you. Pure and Node-free, so the rules are unit-tested as a table; main
// applies what they return (`main/agent/index.ts`).

/** Snapshots in a row a PR must be missing from — its host answering — before its items close. */
export const GONE_AFTER = 2;

/** The work of these scenarios is never closed for its PR being gone: a merge offer has its own rule, the Jira run follows a merge. */
const OUTLIVES_ITS_PR: ReadonlySet<AgentItem["scenario"]> = new Set(["merge", "afterMerge"]);

/**
 * Items whose PR has left the dashboard. `misses` (PR id → snapshots in a
 * row it was missing from) is updated in place; a PR whose host failed this
 * time is not counted — a fetch error is not a merge. A running item is left
 * alone: its result closes on a later snapshot.
 */
export function goneItems(
  items: readonly AgentItem[],
  present: ReadonlySet<string>,
  failedHosts: ReadonlySet<string>,
  misses: Map<string, number>,
): AgentItem[] {
  const live = items.filter((i) => (i.state === "queued" || i.state === "needsYou" || i.state === "error") && !OUTLIVES_ITS_PR.has(i.scenario));
  const counted = new Set<string>();
  const out: AgentItem[] = [];
  for (const item of live) {
    if (present.has(item.prId)) {
      misses.delete(item.prId);
      continue;
    }
    if (failedHosts.has(item.hostLabel)) continue;
    if (!counted.has(item.prId)) {
      counted.add(item.prId);
      misses.set(item.prId, (misses.get(item.prId) ?? 0) + 1);
    }
    if ((misses.get(item.prId) ?? 0) >= GONE_AFTER) out.push(item);
  }
  // A PR with nothing live any more needs no count.
  const livePrs = new Set(live.map((i) => i.prId));
  for (const id of [...misses.keys()]) if (!livePrs.has(id)) misses.delete(id);
  return out;
}

/**
 * The results a newer run replaces: what waits on the same PR in the same
 * lane — an older review of it, or an older drive of your PR. A newer head or
 * a new answer from the author makes them stale; they go quietly.
 */
export function supersededBy(items: readonly AgentItem[], fresh: Pick<AgentItem, "runId" | "prId" | "scenario">): AgentItem[] {
  const lane = laneOfScenario(fresh.scenario);
  return items.filter(
    (i) =>
      i.runId !== fresh.runId &&
      i.prId === fresh.prId &&
      (i.state === "needsYou" || i.state === "error") &&
      !OUTLIVES_ITS_PR.has(i.scenario) &&
      laneOfScenario(i.scenario) === lane,
  );
}

/**
 * A review or re-review that prepared nothing to post, asks you nothing and
 * found nothing major: no decision is left, so it goes straight to Done today.
 * A drive that made no commits does not — CI is still red, and you should see
 * why; nor a review without its publish folder, whose text is yours to post.
 */
export function nothingForYou(item: Pick<AgentItem, "scenario" | "plan" | "result" | "runFolder">): boolean {
  if (item.scenario !== "review" && item.scenario !== "rereview") return false;
  if (!item.runFolder || item.plan) return false;
  const card = item.result;
  if (!card) return false;
  return card.asks.length === 0 && !card.findings.some((f) => f.severity === "blocker" || f.severity === "major");
}
