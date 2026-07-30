import type { PrRole, PullRequest } from "./types";

/**
 * The dashboard's view-filter logic, kept pure so it can be unit-tested.
 *
 * Two kinds of chips sit in the Filters row and they behave differently:
 *
 * - **narrowing** chips (`Needs attention`, `Failing CI`, `New comments`,
 *   `Ready to merge`, `No reviews yet`) drop every PR that doesn't match — an
 *   AND over whatever is active;
 * - **reveal** chips (`Drafts`, `Ignored`) un-hide a category that is hidden by
 *   default. They ADD to the list rather than narrowing it, and a PR in both
 *   categories (an ignored draft) needs only ONE of them — see
 *   `isRevealed`. Requiring both is what made a live
 *   `Drafts (2)` / `Ignored (2)` pair show zero cards: the two PRs were ignored
 *   drafts, so each chip alone was vetoed by the other's gate.
 *
 * Chip badges are facet counts (`narrowFacetCount` / `revealDelta`): each one
 * answers "how many cards does clicking this chip get me, given everything else
 * that's active", so a badge can never advertise rows the click won't produce.
 *
 * Kept free of `node:` builtins — unlike the rest of `shared`, which is why this
 * is one of the two modules the renderer value-imports — so it bundles into the
 * renderer AND is unit-testable via the Node runner against `dist/main/shared`.
 *
 * Chip flags are passed as a named state object, never as positional booleans:
 * they are all `boolean`, so a swapped pair would type-check and silently invert
 * the behavior.
 */

export type RoleFilter = "all" | PrRole;

/** Everything that narrows or reveals rows. Sort/group are view controls, not filters. */
export interface FilterState {
  role: RoleFilter;
  host: string;
  search: string;
  attentionOnly: boolean;
  failingOnly: boolean;
  newOnly: boolean;
  mergeableOnly: boolean;
  noReviewsOnly: boolean;
  showDrafts: boolean;
  showIgnored: boolean;
}

/** The PR fields the filters read — a structural subset, so tests can use light fixtures. */
export type FilterablePr = Pick<
  PullRequest,
  | "isDraft"
  | "isIgnored"
  | "roles"
  | "hostLabel"
  | "needsAttention"
  | "failingChecks"
  | "hasNewActivity"
  | "canBeMerged"
  | "hasNoReviews"
  | "title"
  | "repo"
  | "author"
  | "number"
>;

export type NarrowKey = "attention" | "failing" | "fresh" | "mergeable" | "noReviews";
export type RevealKey = "drafts" | "ignored";

interface NarrowChip {
  readonly key: NarrowKey;
  /** The `FilterState` flag this chip toggles. */
  readonly flag: "attentionOnly" | "failingOnly" | "newOnly" | "mergeableOnly" | "noReviewsOnly";
  readonly matches: (pr: FilterablePr) => boolean;
}

/** The five narrowing chips, in the order they render. */
export const NARROW_CHIPS: readonly NarrowChip[] = [
  { key: "attention", flag: "attentionOnly", matches: (pr) => pr.needsAttention },
  { key: "failing", flag: "failingOnly", matches: (pr) => pr.failingChecks.length > 0 },
  { key: "fresh", flag: "newOnly", matches: (pr) => pr.hasNewActivity },
  { key: "mergeable", flag: "mergeableOnly", matches: (pr) => pr.canBeMerged },
  { key: "noReviews", flag: "noReviewsOnly", matches: (pr) => pr.hasNoReviews },
];

const REVEAL_FLAG: Record<RevealKey, "showDrafts" | "showIgnored"> = {
  drafts: "showDrafts",
  ignored: "showIgnored",
};

/**
 * Whether a PR survives the two reveal chips. Drafts and ignored PRs are hidden
 * by default; ANY chip that owns one of the PR's categories reveals it, so an
 * ignored draft needs `Drafts` OR `Ignored`, not both.
 */
export function isRevealed(
  pr: Pick<PullRequest, "isDraft" | "isIgnored">,
  { showDrafts, showIgnored }: Pick<FilterState, "showDrafts" | "showIgnored">,
): boolean {
  if (!pr.isDraft && !pr.isIgnored) return true;
  return (showDrafts && pr.isDraft) || (showIgnored && pr.isIgnored);
}

function matchesSearch(pr: FilterablePr, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const hay = `${pr.title} ${pr.repo} ${pr.author?.login ?? ""} #${pr.number}`.toLowerCase();
  return hay.includes(q);
}

/** Whether a PR is rendered under the given view state. */
export function isVisible(pr: FilterablePr, state: FilterState): boolean {
  if (!isRevealed(pr, state)) return false;
  if (state.role !== "all" && !pr.roles.includes(state.role)) return false;
  if (state.host !== "all" && pr.hostLabel !== state.host) return false;
  for (const chip of NARROW_CHIPS) {
    if (state[chip.flag] && !chip.matches(pr)) return false;
  }
  return matchesSearch(pr, state.search);
}

export function filterPrs<T extends FilterablePr>(prs: readonly T[], state: FilterState): T[] {
  return prs.filter((pr) => isVisible(pr, state));
}

/**
 * Badge for a narrowing chip: how many rows remain once this chip is on, with
 * every other active filter still applied. Equals `filterPrs(state with the flag
 * on).length` by construction, which is the invariant the badge promises.
 */
export function narrowFacetCount(
  prs: readonly FilterablePr[],
  state: FilterState,
  key: NarrowKey,
): number {
  const chip = NARROW_CHIPS.find((c) => c.key === key);
  if (!chip) return 0;
  return filterPrs(prs, { ...state, [chip.flag]: false }).filter(chip.matches).length;
}

/**
 * Badge for a reveal chip: how many rows the click ADDS (or, when the chip is
 * already on, how many turning it off would take away). Delta rather than
 * category size, so a category already revealed by the other chip reads as 0
 * instead of promising rows that are on screen already.
 */
export function revealDelta(
  prs: readonly FilterablePr[],
  state: FilterState,
  key: RevealKey,
): number {
  const flag = REVEAL_FLAG[key];
  const shown = filterPrs(prs, { ...state, [flag]: true }).length;
  const hidden = filterPrs(prs, { ...state, [flag]: false }).length;
  return shown - hidden;
}

/** Header summary: the standing "is there work for me" picture. */
export interface BaselineStats {
  total: number;
  attention: number;
  failing: number;
  fresh: number;
  returned: number;
}

/**
 * The header stats, over the PRs that are neither ignored nor drafts — the same
 * base `buddyMood` reads, so the mascot and the numbers can't disagree.
 * Deliberately independent of the filters: it answers "how much work is there",
 * not "what's on screen" (the `· N shown` suffix covers the latter).
 */
export function baselineStats(
  prs: readonly (FilterablePr & Pick<PullRequest, "returnedToMe">)[],
): BaselineStats {
  const base = prs.filter((pr) => !pr.isIgnored && !pr.isDraft);
  return {
    total: base.length,
    attention: base.filter((pr) => pr.needsAttention).length,
    failing: base.filter((pr) => pr.failingChecks.length > 0).length,
    fresh: base.filter((pr) => pr.hasNewActivity).length,
    returned: base.filter((pr) => pr.returnedToMe).length,
  };
}
