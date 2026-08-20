import type { PrRole, PullRequest } from "./types";

/**
 * The dashboard's view-filter logic, kept pure so it can be unit-tested.
 *
 * Two kinds of chips sit in the Filters row and they behave differently:
 *
 * - **narrowing** chips (`Needs attention`, `Failing CI`, `New comments`,
 *   `Ready to merge`, `No reviews yet`) drop every PR that doesn't match — an
 *   AND over whatever is active. `New comments` is the one chip the renderer may
 *   not render at all: with the `trackComments` setting off, `hasNewActivity` is
 *   never set (see `applyActivity`), so the chip is removed and `newOnly` reset
 *   rather than left as a filter that would match nothing;
 * - the **exclude** chip (`Hide my approvals`) is the mirror image: it takes a
 *   category OFF the board rather than narrowing to it. It isn't a sixth
 *   narrowing chip because "show me only what I approved" is not what anyone
 *   wants from it — see `isFinishedApproval`;
 * - **reveal** chips (`Drafts`, `Ignored`) un-hide a category that is hidden by
 *   default. They ADD to the list rather than narrowing it, and a PR in both
 *   categories (an ignored draft) needs only ONE of them — see
 *   `isRevealed`. Requiring both is what made a live
 *   `Drafts (2)` / `Ignored (2)` pair show zero cards: the two PRs were ignored
 *   drafts, so each chip alone was vetoed by the other's gate.
 *
 * Chip badges are facet counts (`narrowFacetCount` / `revealDelta` /
 * `excludeDelta`): each one answers "what does clicking this chip do to the
 * list, given everything else that's active" — rows you get for the narrowing
 * chips, rows added or taken away for the two delta kinds — so a badge can never
 * advertise rows the click won't produce.
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
  hideApproved: boolean;
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
  | "viewerApproved"
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

/**
 * Drops the filters the current settings have made unreachable, so a persisted
 * preference can't survive as a filter whose chip is gone from the row.
 *
 * Today that is `newOnly` under `trackComments: false`: with the setting off no
 * PR ever has `hasNewActivity` (see `applyActivity`), so a stored `newOnly: true`
 * would filter the list down to nothing with nothing on screen to switch off —
 * the one thing a filter must never do. Returns the same object when there is
 * nothing to clear, so a caller can use it as an "is a reset needed" check.
 */
export function sanitizeFilterState(
  state: FilterState,
  { trackComments }: { trackComments: boolean },
): FilterState {
  if (trackComments || !state.newOnly) return state;
  return { ...state, newOnly: false };
}

/** The `FilterState` flag each reveal chip toggles — the reveal counterpart of `NARROW_CHIPS[].flag`. */
export const REVEAL_FLAG: Record<RevealKey, "showDrafts" | "showIgnored"> = {
  drafts: "showDrafts",
  ignored: "showIgnored",
};

/**
 * The standing workload: PRs that are neither ignored nor drafts. The single
 * definition behind `baselineStats`, the header's `· N shown` reconciliation and
 * the mascot's mood, so those three can't drift apart.
 */
export function isBaselinePr(pr: Pick<PullRequest, "isDraft" | "isIgnored">): boolean {
  return !pr.isIgnored && !pr.isDraft;
}

/**
 * Whether the PR is on the dashboard ONLY because you already reviewed it: no
 * outstanding request, and not your own PR. Such a PR is *passive* — nobody is
 * waiting on you — which is why it neither claims attention on its own (see
 * `applyActivity` in state.ts) nor repeats a badge the card already carries in a
 * louder form (`PrCard`). One definition rather than two, so the main-process
 * flag and the renderer's badge can't drift apart when a role is added.
 */
export function isPassiveReviewed(pr: Pick<PullRequest, "roles">): boolean {
  return (
    pr.roles.includes("reviewed") &&
    !pr.roles.includes("reviewer") &&
    !pr.roles.includes("author")
  );
}

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

/**
 * What the `Hide my approvals` chip takes off the board: a PR whose last word
 * from you was "approved" and which is not asking for you again.
 *
 * The second half is the whole subtlety. A re-request outranks your approval —
 * if someone has asked for your review again, the PR is waiting on you no matter
 * what you said last time, and hiding it would drop live work off the dashboard
 * silently, which is the one thing a filter must never do. Your approval also
 * un-sets itself (`viewerApproved`) when you supersede it with a change request
 * or branch protection dismisses it on a new push, so nothing here has to track
 * staleness.
 */
export function isFinishedApproval(
  pr: Pick<PullRequest, "viewerApproved" | "roles">,
): boolean {
  return pr.viewerApproved && !pr.roles.includes("reviewer");
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
  if (state.hideApproved && isFinishedApproval(pr)) return false;
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

/**
 * Badge for the exclude chip: how many rows the click TAKES AWAY (or, while it
 * is on, how many turning it off would bring back). The mirror of `revealDelta`,
 * and a delta for the same reason — a PR already hidden by a narrowing chip or
 * the draft gate isn't a row this click can remove, so counting the category
 * itself would promise a change the click doesn't make.
 */
export function excludeDelta(prs: readonly FilterablePr[], state: FilterState): number {
  const kept = filterPrs(prs, { ...state, hideApproved: false }).length;
  const dropped = filterPrs(prs, { ...state, hideApproved: true }).length;
  return kept - dropped;
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
  const base = prs.filter(isBaselinePr);
  return {
    total: base.length,
    attention: base.filter((pr) => pr.needsAttention).length,
    failing: base.filter((pr) => pr.failingChecks.length > 0).length,
    fresh: base.filter((pr) => pr.hasNewActivity).length,
    returned: base.filter((pr) => pr.returnedToMe).length,
  };
}

/**
 * How many filters currently SHRINK the list — what `Clear filters` resets and
 * badges. Derived from `NARROW_CHIPS`, so a sixth chip is counted without
 * touching this. `Hide my approvals` counts too: it removes rows, so clearing it
 * means "show me more", the same promise the narrowing chips make.
 * `Drafts`/`Ignored` are left out on purpose — they REVEAL rows, so clearing
 * them would shrink the list and break that promise.
 */
export function activeFilterCount(state: FilterState): number {
  let n = 0;
  if (state.search.trim()) n += 1;
  if (state.role !== "all") n += 1;
  if (state.host !== "all") n += 1;
  if (state.hideApproved) n += 1;
  for (const chip of NARROW_CHIPS) {
    if (state[chip.flag]) n += 1;
  }
  return n;
}

/**
 * Which "nothing to show" story the empty state tells:
 *
 * - `no-prs` — the fetch itself came back empty;
 * - `all-hidden` — no filter is narrowing anything, so every PR is a draft
 *   and/or ignored and only the reveal chips can surface them;
 * - `no-match` — a filter really is at work.
 *
 * Only meaningful while the rendered list is empty — the caller checks that
 * before asking. Keeping the discriminant here (rather than inline in the
 * renderer) is what lets the copy's claims be unit-tested.
 */
export type EmptyStateKind = "no-prs" | "all-hidden" | "no-match";

export function emptyStateKind(state: FilterState, totalCount: number): EmptyStateKind {
  if (totalCount === 0) return "no-prs";
  return activeFilterCount(state) === 0 ? "all-hidden" : "no-match";
}

/**
 * How many of the hidden PRs still want you — what the `all-hidden` empty state
 * may not stay silent about, since `baselineStats` no longer counts them and
 * notifications still fire for them.
 *
 * Ignored PRs are excluded even when `needsAttention` is true (nothing clears it
 * for them — see `applyActivity`): the user muted those on purpose, so claiming
 * they need attention would be the same false statement in the other direction.
 * In the `all-hidden` case every PR is a draft and/or ignored, so what remains is
 * exactly "drafts that need you".
 */
export function hiddenAttentionCount(
  prs: readonly Pick<PullRequest, "isIgnored" | "needsAttention">[],
): number {
  return prs.filter((pr) => !pr.isIgnored && pr.needsAttention).length;
}

/**
 * Card signal, in priority order — drives the left accent and the header buddy.
 *
 * Lives here rather than in `PrCard` so it can be unit-tested: it is a pure
 * function of a PullRequest, and this is the renderer-importable, Node-free half
 * of `shared`. Only the decision moved; the colour mapping (`ACCENT`) stays in
 * the component. Two of its branches read `hasNewActivity`, which is what makes
 * the accent change under `trackComments: false` a testable promise rather than
 * a hand-checked one.
 */
export type PrSignal = "blocked" | "myReview" | "waiting" | "attention" | "approved" | "idle";

/**
 * Classify a PR by signal priority.
 *  - blocked (red): your PR is blocked and needs your action — failing CI, a
 *    change request you haven't re-requested review on, a reviewer comment
 *    you haven't answered (an unresolved thread whose last comment isn't yours,
 *    even from a plain "Comment" review with green CI), or a merge conflict you
 *    must resolve (`hasConflicts`) — the latter blocks merge even when CI is
 *    green and the PR is approved, so it belongs here, not in `approved`. Only
 *    for PRs you authored.
 *  - myReview (violet): a review is being requested of you and you haven't
 *    submitted one yet — your turn to act. The `reviewer` role comes from
 *    GitHub's `review-requested:@me`, so it clears itself once you review.
 *    Also covers a PR that came back to you (`returnedToMe`) after you reviewed
 *    or opened it — GitHub drops the reviewer role once you review, so this is
 *    what keeps a re-review on your radar. Ranked right after your own blocked
 *    PRs so review requests never blend into the rest.
 *  - waiting (gray): your PR is awaiting someone else's review and nobody has
 *    approved yet (ball in their court) — nothing required from you, even with
 *    open threads.
 *  - approved (green): at least one human approval, CI isn't failing or
 *    running, and there are no open threads. A single human approve is enough —
 *    even if other reviewers are still pending, and even if the PR has no checks
 *    at all. We key off an actual approval rather than requiring
 *    `reviewDecision === "APPROVED"`, which stays null/REVIEW_REQUIRED on repos
 *    without required-review rules — but we still consult `reviewDecision` as a
 *    disqualifier: a live `CHANGES_REQUESTED` (e.g. a second reviewer whose
 *    change request gates the merge even after being re-requested) keeps the PR
 *    out of green, since it isn't actually mergeable. Ranked
 *    ABOVE attention: an approved, green PR stays green even when it has unread
 *    comments, so opening it (which clears `hasNewActivity`) doesn't flip the
 *    accent from amber to green. Open threads and running CI still demote it,
 *    since those are unfinished work.
 *  - attention (amber): new comments, open threads, CI running.
 */
export function prSignal(pr: PullRequest): PrSignal {
  const isAuthor = pr.roles.includes("author");

  if (
    isAuthor &&
    (pr.failingChecks.length > 0 ||
      pr.hasUnaddressedChangeRequest ||
      pr.hasUnaddressedComments ||
      pr.hasConflicts)
  ) {
    return "blocked";
  }
  // `myReReviewDue` belongs with these two: it is the same "your move" state,
  // just reached by your own standing change request rather than by a request
  // or new activity. Kept in step with `needsAttention` in state.ts, which this
  // function mirrors — moving one without the other lets the count and the
  // accent disagree.
  if (pr.roles.includes("reviewer") || pr.returnedToMe || pr.myReReviewDue) {
    return "myReview";
  }
  if (isAuthor && pr.awaitingReview && !pr.hasNewActivity && !pr.hasHumanApproval) {
    return "waiting";
  }
  if (
    pr.hasHumanApproval &&
    pr.reviewDecision !== "CHANGES_REQUESTED" &&
    pr.ciState !== "failure" &&
    pr.ciState !== "pending" &&
    pr.unresolvedThreads === 0
  ) {
    return "approved";
  }
  if (pr.hasNewActivity || pr.unresolvedThreads > 0 || pr.pendingChecks.length > 0) {
    return "attention";
  }
  return "idle";
}
