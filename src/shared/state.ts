import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isPassiveReviewed } from "./pr-filter";
import type { PullRequest, SeenInput } from "./types";

/** A stored "snapshot" of a PR at the time it was last recorded. */
interface SeenEntry {
  /** Number of comments in the recorded snapshot. */
  comments: number;
  /** The PR's updatedAt in the recorded snapshot. */
  updatedAt: string;
  /** When this snapshot was recorded (baseline creation OR an explicit view). */
  seenAt: string;
  /**
   * The latest commit's push time in the recorded snapshot — basis for detecting
   * a new push since. Optional: older state files predate it.
   */
  lastCommitPushedAt?: string | null;
  /**
   * When the user actually opened / marked the PR seen. Distinct from `seenAt`,
   * which is also written when the auto-baseline is created on first encounter.
   * Absent means the user has never opened this PR ("not yet opened").
   */
  viewedAt?: string;
}

type StateFile = Record<string, SeenEntry>;

/** Serializes access to the file to avoid concurrent corruption. */
let writeChain: Promise<void> = Promise.resolve();

async function readState(statePath: string): Promise<StateFile> {
  try {
    const text = await readFile(statePath, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as StateFile) : {};
  } catch {
    return {};
  }
}

/**
 * Runs a whole read-modify-write cycle as one chained task, and writes only when
 * the mutator reports a change.
 *
 * The read has to be inside the chain, not just the write: `applyActivity` and
 * `markSeen` touch the same entries, and a read taken before a concurrent
 * `markSeen` lands would be written back afterwards, replaying the pre-mark
 * state — `viewedAt` disappears, `lastSeenAt` reverts to null, and the PR loses
 * the engagement `returnedToMe` needs. Rare while a write only happened on a
 * PR's first encounter; the comment resync (below) writes far more often, which
 * is what made this worth serializing properly.
 */
async function updateState(
  statePath: string,
  mutate: (state: StateFile) => boolean,
): Promise<void> {
  const op = writeChain.then(async () => {
    const state = await readState(statePath);
    if (!mutate(state)) return;
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  });
  // The chain must not break because of a single failure.
  writeChain = op.catch(() => {});
  return op;
}

/**
 * Sets the activity flags on PRs (hasNewActivity, lastSeenAt, needsAttention)
 * by comparing against the last stored snapshot in `statePath`.
 *
 * Behavior on first encounter of a PR: we create a baseline snapshot from the
 * current values and do NOT highlight it as new — so a "forest" of NEW badges
 * doesn't light up on first run. Existing snapshots are not updated on read
 * (only mark-seen advances them).
 *
 * The flag is required and named rather than a defaulted positional boolean: a
 * default would have to be the permissive value, and dropping the argument at
 * the single call site would then silently restore comment tracking with every
 * test here still green. Required means `tsc` reports it instead.
 *
 * `trackComments: false` (the `trackComments` setting off) drops ALL
 * comment-shaped signals from `needsAttention`: `hasNewActivity` stays false for
 * every PR, so the `New comments` chip, the card badge with its Mark-as-seen
 * button and the `newOnly` filter go quiet, `returnedToMe` is left with a new
 * push as its only trigger, and a comment awaiting a reply (`hasUnaddressedComments`)
 * or an unresolved thread (`unresolvedThreads`) no longer turns the card red
 * either. The setting means "don't make me look at this dashboard for
 * comments" — a thread that still needs a reply doesn't stop being real work,
 * but it stops being THIS app's job to surface it while the setting is off.
 *
 * The stored comment count is then kept CURRENT instead — that snapshot field has
 * no reader while tracking is off, and letting it go stale would turn re-enabling
 * the setting into exactly the "forest of NEW badges" the first-run baseline
 * exists to prevent.
 */
export async function applyActivity(
  prs: PullRequest[],
  statePath: string,
  { trackComments }: { trackComments: boolean },
): Promise<void> {
  await updateState(statePath, (state) => {
    let mutated = false;

    for (const pr of prs) {
      const entry = state[pr.id];
      if (!entry) {
        state[pr.id] = {
          comments: pr.totalComments,
          updatedAt: pr.updatedAt,
          seenAt: new Date().toISOString(),
          lastCommitPushedAt: pr.lastCommitPushedAt,
        };
        mutated = true;
        pr.hasNewActivity = false;
        pr.returnedToMe = false;
        pr.lastSeenAt = null;
      } else {
        // Signal specifically NEW COMMENTS: a change in updatedAt (your own commit
        // push, labels, reviewer changes) does not count as new activity —
        // otherwise it drowns out the signal on your own PRs, where pushes are frequent.
        pr.hasNewActivity = trackComments && pr.totalComments > entry.comments;
        if (!trackComments && entry.comments !== pr.totalComments) {
          // Written only on an actual change, so an untracked poll doesn't rewrite
          // the state file every tick. `lastCommitPushedAt` is deliberately left
          // alone — it is what `newPush` below compares against.
          entry.comments = pr.totalComments;
          mutated = true;
        }
        // lastSeenAt reflects an ACTUAL view (viewedAt), not the auto-baseline —
        // so a PR the user has never opened reports null.
        pr.lastSeenAt = entry.viewedAt ?? null;

        // "Returned to me": a PR you've engaged with (reviewed, or opened from the
        // dashboard) that has new comments OR a newer push than the recorded
        // snapshot — the ball is back in your court. Your own PRs are excluded so
        // your pushes never trigger it.
        //
        // The `reviewed` role counts as engagement in its own right, and is the
        // broader of the two review signals: it comes from `reviewed-by:@me`, which
        // matches a plain "Comment" review, while `viewerHasReviewed` reads
        // `latestOpinionatedReviews` and therefore only sees approve /
        // request-changes. Observed live: 4 of 5 reviewed-role PRs had
        // `viewerHasReviewed === false`. Without this term those PRs could never
        // return to you, which for a passive-reviewed PR (whose attention flag is
        // exactly `returnedToMe`, below) would mean a card that never speaks again.
        const isAuthor = pr.roles.includes("author");
        const engaged =
          pr.viewerHasReviewed ||
          pr.roles.includes("reviewed") ||
          entry.viewedAt != null;
        const newPush =
          pr.lastCommitPushedAt != null &&
          entry.lastCommitPushedAt != null &&
          pr.lastCommitPushedAt > entry.lastCommitPushedAt;
        pr.returnedToMe =
          !isAuthor && engaged && (pr.hasNewActivity || newPush);
      }

      // Mirrors the card accent: a review requested of you needs attention (your
      // turn to act); a re-requested change request and "just awaiting someone
      // else's review" (for your own PR) don't count as needing attention.
      const isAuthor = pr.roles.includes("author");

      // A PR you have ONLY already reviewed (see `isPassiveReviewed`) is on the
      // dashboard so it doesn't vanish the moment you submit a review — not
      // because someone is waiting on you. Its failing CI, open threads and
      // pending change request are the author's business, and claiming they need
      // your attention would light up every PR you ever reviewed that is still
      // open. Only its return to your court counts, and `returnedToMe` already
      // folds in new comments and new pushes since your last snapshot.
      // `myReReviewDue` is the one term here that does not come from the snapshot
      // diff: your standing change request blocks the merge until you re-review,
      // and marking the card seen must not clear that. Without it, a passive-
      // reviewed PR whose author has done the work goes quiet the first time you
      // open it and never speaks again — see issue #14.
      //
      // `hasUnaddressedComments` and `unresolvedThreads` are gated by
      // `trackComments` too: without it, someone who turned the setting off to
      // stop comment noise kept seeing PRs light up (and disappear the moment
      // they replied on GitHub) for the exact channel they'd just muted.
      pr.needsAttention = isPassiveReviewed(pr)
        ? pr.returnedToMe || pr.myReReviewDue
        : pr.roles.includes("reviewer") ||
          pr.returnedToMe ||
          pr.failingChecks.length > 0 ||
          pr.hasUnaddressedChangeRequest ||
          (trackComments && pr.hasUnaddressedComments) ||
          pr.hasNewActivity ||
          (trackComments && pr.unresolvedThreads > 0 && !(isAuthor && pr.awaitingReview));
    }

    return mutated;
  });
}

/**
 * Updates the snapshot of the given PRs to the provided values (clears NEW).
 *
 * `trackComments` is required and named for the same reason as in
 * `applyActivity`, and it guards the comment count specifically. While tracking
 * is off the renderer's `totalComments` can lag: `hashSnapshot` no longer hashes
 * the count, so a tick whose only delta is the count pushes nothing (a real new
 * comment usually still pushes, via `updatedAt`). Writing a lagging, lower
 * number here would LOWER the baseline while stamping
 * `viewedAt`. Turning tracking back on then re-reads those same comments as new:
 * a NEW badge and a "back to you" toast for comments that landed while the user
 * had the channel switched off, which is exactly what the off-path resync in
 * `applyActivity` exists to prevent. Saving settings refreshes the poller
 * immediately (`main.ts`), so there is no intervening tick to repair it.
 *
 * While off, the stored count is therefore left alone — `applyActivity` owns
 * that field — and only the view stamps are advanced. With tracking on nothing
 * changes: the renderer's copy is current, because the count is hashed.
 */
export async function markSeen(
  items: SeenInput[],
  statePath: string,
  { trackComments }: { trackComments: boolean },
): Promise<void> {
  if (items.length === 0) return;
  const now = new Date().toISOString();
  await updateState(statePath, (state) => {
    for (const item of items) {
      const previous = state[item.id];
      state[item.id] = {
        comments: trackComments
          ? item.comments
          : (previous?.comments ?? item.comments),
        updatedAt: item.updatedAt,
        seenAt: now,
        viewedAt: now,
        lastCommitPushedAt: item.lastCommitPushedAt,
      };
    }
    return true;
  });
}
