// Approvals dismissed by a push that only brought in the base branch.
//
// A branch rule that dismisses approvals on every push (GitHub's "dismiss
// stale pull request approvals", on in creatio-ui's master) takes them away
// when the base is merged into a PR, or when a stack's base merges under it,
// although nothing of the PR changed. Across three epics that was 211
// approvals in 70 PRs, and 42% of their review hours passed after the first
// approval. Here: which approvals stand dismissed (from the PR's timeline),
// and whether everything pushed since was merges of the base (from the
// commits). Pure and Node-free — the reads are main's
// (`main/agent/reapprove.ts`), and the policy asks here too.

export interface DismissedApproval {
  /** As GitHub spells it — what a review request names. */
  login: string;
  /** The head the approval was given on. */
  head: string;
}

/** One node of the PR's timeline, as the query reads it. */
export interface ReviewTimelineNode {
  __typename: string;
  /** PullRequestReview */
  id?: string | null;
  author?: { login?: string | null } | null;
  state?: string | null;
  submittedAt?: string | null;
  commit?: { oid?: string | null } | null;
  /** ReviewDismissedEvent */
  previousReviewState?: string | null;
  review?: { id?: string | null; author?: { login?: string | null } | null; commit?: { oid?: string | null } | null } | null;
}

/**
 * The approvals standing dismissed on a PR, per reviewer: their latest review
 * is DISMISSED, the dismissal event of that very review (by its id — not its
 * author and commit, which an earlier dismissed approval may share) says it was
 * an approval, and it was given on another head than `head`. A dismissed change
 * request is never one, and a review left after the dismissal (even a plain
 * comment) means the reviewer has spoken since: theirs to repeat. `exclude`
 * drops logins (the author, on your own PR), any case.
 */
export function dismissedApprovals(nodes: readonly ReviewTimelineNode[], head: string, exclude: readonly string[] = []): DismissedApproval[] {
  const latest = new Map<string, { login: string; id: string; state: string; at: string; head: string }>();
  const dismissedApprovalIds = new Set<string>();
  for (const n of nodes) {
    if (n.__typename === "PullRequestReview") {
      const login = n.author?.login;
      const at = n.submittedAt;
      // A pending review has no submission time: it isn't on the PR yet.
      if (!login || !at || !n.state || !n.id) continue;
      const key = login.toLowerCase();
      const prev = latest.get(key);
      if (!prev || at >= prev.at) latest.set(key, { login, id: n.id, state: n.state, at, head: n.commit?.oid ?? "" });
    } else if (n.__typename === "ReviewDismissedEvent") {
      if (n.previousReviewState === "APPROVED" && n.review?.id) dismissedApprovalIds.add(n.review.id);
    }
  }
  const skip = new Set(exclude.map((l) => l.toLowerCase()));
  const out: DismissedApproval[] = [];
  for (const [key, r] of latest) {
    if (skip.has(key) || r.state !== "DISMISSED" || !r.head || r.head === head) continue;
    if (dismissedApprovalIds.has(r.id)) out.push({ login: r.login, head: r.head });
  }
  return out.sort((a, b) => a.login.localeCompare(b.login));
}

export interface BaseMerge {
  sha: string;
  /** The branch side first, the base side second. */
  parents: [string, string];
}

/**
 * The merges a push added since the approval — or why the push was more than
 * merging the base. Comparing diffs can't settle it: a change moved to a spot
 * with the same context reads the same. The commits are what settle it:
 * `own` are those reachable from the new head but neither from the approved
 * head nor from the base, each as `[sha, ...parents]` (`git rev-list --parents
 * old..new --not <base>`), and `chain` the first-parent walk from the new head
 * down to the approved head. A base-only push has nothing in `own` but merges
 * on that walk, two parents each, the second one the base's. Main then checks
 * each merge is exactly what merging its parents gives (`git merge-tree`).
 */
export function baseMerges(own: readonly string[][], chain: ReadonlySet<string>): { merges: BaseMerge[] } | { why: string } {
  if (own.length === 0) return { why: "nothing new on the branch since the approval" };
  for (const c of own) {
    if (c.length < 3) return { why: "the author pushed commits of their own since the approval" };
    if (c.length > 3) return { why: "an octopus merge since the approval" };
    if (!chain.has(c[0])) return { why: "a merge brought in commits that aren't the base's" };
  }
  // A step of the branch's own walk that is the base's: it was moved onto base commits, not merged.
  if (chain.size !== own.length) return { why: "the branch took base commits without a merge" };
  return { merges: own.map((c) => ({ sha: c[0], parents: [c[1], c[2]] })) };
}

/** The line a re-approval posts above the signature. */
export function reapprovalBody(oldHead: string): string {
  return `Re-approved: only the base branch changed since my approval at \`${oldHead.slice(0, 7)}\` — the PR's own changes are the same.`;
}
