// Merging one of your PRs on your click: which method, and the `gh` call that
// can't merge anything but the commit you were shown.

import { stackLayer } from "../../shared/agent-stack";
import type { AgentSettings, MergeMethod, PullRequest } from "../../shared/types";

/**
 * The method to merge with: the one you picked in the button's menu, else the
 * one Settings names, else GitHub's suggestion for you — each only if the
 * repository allows it. Null when it allows none of them (rulesets can hide
 * that; GitHub's refusal is then shown as it is).
 */
export function chooseMergeMethod(
  pr: Pick<PullRequest, "mergeMethods">,
  setting: AgentSettings["scenarios"]["merge"]["method"],
  picked?: MergeMethod,
): MergeMethod | null {
  const allowed = pr.mergeMethods.allowed;
  for (const m of [picked, setting === "github" ? undefined : setting, pr.mergeMethods.suggested ?? undefined]) {
    if (m && allowed.includes(m)) return m;
  }
  return allowed[0] ?? null;
}

/**
 * `gh pr merge` held to the head you saw: GitHub refuses the merge if anyone
 * pushed since, so the click can't merge code nobody reviewed. Run outside any
 * checkout (`runGh` does), so `--delete-branch` only deletes the remote branch.
 */
export function mergeArgs(prUrl: string, method: MergeMethod, headOid: string, deleteBranch: boolean): string[] {
  return ["pr", "merge", prUrl, `--${method}`, "--match-head-commit", headOid, ...(deleteBranch ? ["--delete-branch"] : [])];
}

/**
 * The open PRs built on `pr`'s branch: the layers above it in its GitHub
 * stack, and any PR of its repository whose base is its head branch. GitHub
 * retargets them when the branch is deleted after the merge — but gh's own
 * delete can win that race and close them instead, so their branch stays
 * (the repository's own "delete branch on merge" still applies).
 */
export function builtOn(
  pr: Pick<PullRequest, "id" | "repo" | "hostLabel" | "headRefName" | "stack">,
  prs: readonly Pick<PullRequest, "id" | "repo" | "hostLabel" | "baseRefName" | "number">[],
): number[] {
  const above = stackLayer(pr)?.above ?? [];
  const repo = pr.repo.toLowerCase();
  const based = prs
    .filter((p) => p.id !== pr.id && p.hostLabel === pr.hostLabel && p.repo.toLowerCase() === repo && p.baseRefName === pr.headRefName)
    .map((p) => p.number);
  return [...new Set([...above, ...based])].sort((a, b) => a - b);
}
