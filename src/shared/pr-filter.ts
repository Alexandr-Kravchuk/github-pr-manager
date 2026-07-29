import type { PullRequest } from "./types";

/**
 * Whether a PR survives the two exclusive category chips, `Drafts` and
 * `Ignored`. Both categories are hidden by default; turning a chip on narrows
 * the list to ONLY that category, and both on shows the union (drafts ∪
 * ignored). An ignored draft stays out of the drafts-only view — it surfaces
 * only once the Ignored chip is on too.
 *
 * Returns `true` when the PR passes the category gate (the caller then applies
 * the remaining narrowing filters); `false` hides it outright.
 *
 * Kept pure and free of `node:` builtins — unlike the rest of `shared`, which
 * is why this is the one module the renderer value-imports — so it bundles into
 * the renderer AND is unit-testable via the Node runner against
 * `dist/main/shared`, the same pattern as `ignored.ts` / `mapPr.canBeMerged`.
 */
export function isPrVisibleForCategoryFilters(
  pr: Pick<PullRequest, "isDraft" | "isIgnored">,
  showDrafts: boolean,
  showIgnored: boolean,
): boolean {
  if (showDrafts || showIgnored) {
    return (showDrafts && pr.isDraft && !pr.isIgnored) || (showIgnored && pr.isIgnored);
  }
  return !pr.isDraft && !pr.isIgnored;
}
