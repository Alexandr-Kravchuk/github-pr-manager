// The PR agent and GitHub's native stacks (`PullRequest.stack`). A stack is a
// chain of PRs, each based on the branch of the one below; each shows only its
// own layer's diff, and the whole stack merges only with a linear history —
// GitHub rebases the layers above after a lower one merges, and a "Rebase
// stack" button (or `gh stack rebase`) does it after a push to a lower layer.
// So a merge of the base into a layer breaks the stack, and a new head on a
// layer may be its old change on a new base. Node-free: the renderer
// value-imports it.

import type { AgentScenario, PullRequest } from "./types";

export interface StackLayer {
  /** The stack's number in its repository ("Stack #1623"). */
  number: number;
  /** 1 is the bottom. */
  position: number;
  size: number;
  /** The branch the bottom layer targets — the trunk. */
  trunk: string;
  /** The PR right below this layer, or null on the bottom one. */
  below: number | null;
  /** Open PRs above this layer — the ones a push here leaves to be rebased. */
  above: number[];
}

/** Where a PR sits in its stack, or null outside one. */
export function stackLayer(pr: Pick<PullRequest, "stack">): StackLayer | null {
  const s = pr.stack;
  if (!s) return null;
  const below = s.entries.find((e) => e.position === s.position - 1);
  return {
    number: s.number,
    position: s.position,
    size: s.size,
    trunk: s.baseRefName,
    below: below ? below.number : null,
    above: s.entries.filter((e) => e.position > s.position && e.state === "OPEN").map((e) => e.number),
  };
}

/** One stack across the dashboard: its repository and number. */
function stackId(pr: Pick<PullRequest, "repo" | "stack">): string | null {
  return pr.stack ? `${pr.repo.toLowerCase()}#${pr.stack.number}` : null;
}

/**
 * The lowest layer below `pr` in the same stack that `broken` says needs
 * work — the one the agent fixes first, since what breaks a layer usually
 * comes from below and fixing it there rebases this one anyway. Null when no
 * layer below needs it (or `pr` is in no stack).
 */
export function brokenLayerBelow<T extends Pick<PullRequest, "id" | "repo" | "number" | "stack">>(pr: T, prs: readonly T[], broken: (p: T) => boolean): T | null {
  const id = stackId(pr);
  if (!id || !pr.stack) return null;
  const position = pr.stack.position;
  let lowest: T | null = null;
  for (const p of prs) {
    if (p.id === pr.id || stackId(p) !== id || !p.stack || p.stack.position >= position) continue;
    if (!broken(p)) continue;
    if (!lowest || p.stack.position < lowest.stack!.position) lowest = p;
  }
  return lowest;
}

/** What to do about a stacked layer that conflicts with its base — the agent never rebases or force-pushes. */
export const STACK_REBASE_HINT = "rebase the stack: Rebase stack on GitHub, or gh stack rebase and gh stack push";

/**
 * The lines a session on a stacked PR gets on top of its rules — null outside
 * a stack. A review keeps to its layer; a drive never merges the base in, since
 * that breaks the linear history the stack needs to merge.
 */
export function stackRules(pr: Pick<PullRequest, "stack" | "baseRefName">, scenario: AgentScenario): string | null {
  const l = stackLayer(pr);
  if (!l) return null;
  const where =
    `This PR is layer ${l.position} of ${l.size} in GitHub stack #${l.number} (bottom first, onto ${l.trunk}): ` +
    (l.below !== null ? `it targets ${pr.baseRefName}, the branch of #${l.below} below it` : `it is the bottom layer, onto ${pr.baseRefName}`) +
    `, so its diff — \`gh pr diff\` — is this layer alone.`;
  if (scenario === "drive") {
    return (
      `${where} A stack merges only with a linear history: never merge the base branch into this one, and never rebase it. ` +
      `If it conflicts with its base or is behind it, change nothing for that — say in the prd-result block that the stack needs a rebase (Rebase stack on GitHub, or gh stack rebase). ` +
      `A fix that belongs to a lower layer's code goes into that PR, not this one: say so instead of patching around it here.`
    );
  }
  if (scenario === "review" || scenario === "rereview" || scenario === "brief") {
    return (
      `${where} Review this layer only: a problem in code a lower layer added belongs to that PR — name it in your summary as a note, and don't comment on it here. ` +
      `Something only a layer above adds is not a gap in this one.`
    );
  }
  return null;
}
