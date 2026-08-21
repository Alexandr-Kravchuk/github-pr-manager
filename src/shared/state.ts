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
 * `trackComments: false` (the `trackComments` setting off) makes the dashboard a
 * function of live GitHub state rather than of this app's stored snapshot. Two
 * halves:
 *
 *  - **No comment-shaped signal claims attention.** `hasNewActivity` stays false
 *    for every PR, so the `New comments` chip, the card badge with its
 *    Mark-as-seen button and the `newOnly` filter go quiet; a comment awaiting a
 *    reply (`hasUnaddressedComments`) and an unresolved thread
 *    (`unresolvedThreads`) stop turning the card red too (see `needsAttention`
 *    below and `prSignal`). A thread that needs a reply doesn't stop being real
 *    work — it stops being THIS app's job to surface while the setting is off.
 *  - **No signal is derived from the snapshot.** `returnedToMe`'s push term
 *    switches from "newer than my stored snapshot" to "pushed after my last
 *    review" (`viewerReviewedAt`, straight off the PR). The snapshot goes stale
 *    whenever the app isn't polling, which is what made the dashboard show a
 *    state that silently corrected itself the moment a card was opened; a live
 *    comparison is true before the click and unchanged by it. `markSeen`
 *    correspondingly writes nothing at all while off.
 *
 * The stored snapshot is kept CURRENT anyway (comments AND lastCommitPushedAt):
 * it has no reader while tracking is off, and letting it go stale would turn
 * re-enabling the setting into exactly the "forest of NEW badges" the first-run
 * baseline exists to prevent — now for pushes as well as comments.
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
        if (!trackComments) {
          // Keep the whole snapshot CURRENT while tracking is off: nothing reads
          // it then (`hasNewActivity` is false and `returnedToMe` switches to the
          // live comparison below), and a stale snapshot is exactly what made the
          // dashboard show a state that only corrected itself when the card was
          // opened. Keeping it fresh also means re-enabling the setting starts
          // from what is there NOW instead of replaying everything that landed
          // while off — for pushes as well as comments.
          //
          // Corollary, deliberate: pushes and comments that arrive while the
          // setting is off are absorbed silently, never announced later.
          //
          // Written only when a field actually moved, so an untracked poll does
          // not rewrite the state file every tick.
          if (entry.comments !== pr.totalComments) {
            entry.comments = pr.totalComments;
            mutated = true;
          }
          if (entry.lastCommitPushedAt !== pr.lastCommitPushedAt) {
            entry.lastCommitPushedAt = pr.lastCommitPushedAt;
            mutated = true;
          }
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
        // A push you have ALREADY reviewed is not "back in your court". The
        // snapshot alone can't tell: `entry.lastCommitPushedAt` is written only
        // on a PR's first encounter and by `markSeen`, so it goes stale while
        // the app isn't polling — a push from before your review then read as
        // new and latched the card into Need attention until you opened it
        // (observed with `trackComments` off, where this is the only remaining
        // trigger, but the defect is not specific to that setting, so the guard
        // isn't gated on it). `viewerReviewedAt` is null for a comment-only
        // reviewer, which leaves that case exactly as it was.
        //
        // Same `committedDate` fallback caveat as `myReReviewDue` in github.ts:
        // `pushedDate` is often null, so a rebase preserving old committer dates
        // can read as "already reviewed" and stay quiet.
        const pushPredatesMyReview =
          pr.viewerReviewedAt != null &&
          pr.lastCommitPushedAt != null &&
          pr.lastCommitPushedAt <= pr.viewerReviewedAt;
        // With tracking OFF the push question is answered from live GitHub state
        // instead of the snapshot: "did the author push after my last review?".
        // That is a fact about the PR, not about when this app last looked, so it
        // is neither stale before the card is opened nor cleared by opening it —
        // which is the whole point. It only reaches PRs where the viewer left an
        // opinionated review (`viewerReviewedAt` is null after a plain "Comment"
        // review — the 4-of-5 case above — and such a PR stays quiet).
        const pushAfterMyReview =
          pr.viewerReviewedAt != null &&
          pr.lastCommitPushedAt != null &&
          pr.lastCommitPushedAt > pr.viewerReviewedAt;
        const newPush = trackComments
          ? pr.lastCommitPushedAt != null &&
            entry.lastCommitPushedAt != null &&
            pr.lastCommitPushedAt > entry.lastCommitPushedAt &&
            !pushPredatesMyReview
          : pushAfterMyReview;
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
 * `applyActivity`, and while it is off this function is a NO-OP: with the
 * dashboard derived from live GitHub state, opening a PR has nothing to record,
 * and recording anything would be the one remaining way a glance could change
 * the view (`viewedAt` feeds the "Needs my action" sort order). See the guard
 * at the top of the body for the field-by-field reasoning.
 *
 * Writing the renderer's `totalComments` while off would have been wrong on its
 * own terms too: `hashSnapshot` doesn't hash the count then, so the renderer's
 * copy can lag, and persisting a lagging, lower number would LOWER the baseline
 * and make re-enabling the setting re-read those comments as new — the flood the
 * resync in `applyActivity` exists to prevent. Saving settings refreshes the
 * poller immediately (`main.ts`), so there would be no intervening tick to
 * repair it.
 *
 * With tracking ON nothing changes: the whole snapshot is advanced, and the
 * renderer's copy is authoritative because the count is hashed.
 */
export async function markSeen(
  items: SeenInput[],
  statePath: string,
  { trackComments }: { trackComments: boolean },
): Promise<void> {
  if (items.length === 0) return;
  // Tracking off: opening a PR writes NOTHING, so it cannot change the
  // dashboard. Every field this would write is either unread bookkeeping that
  // has no reader while off (`comments`, `lastCommitPushedAt` — `applyActivity`
  // owns them and keeps them current), dead weight (`updatedAt`, `seenAt`, which
  // nothing reads at all), or `viewedAt`, whose only consumer is the
  // "Needs my action" sort order via `lastSeenAt` — so writing it would reorder
  // the list on a mere glance. Skipping the write is what makes "the dashboard
  // shows the current state, not the state it reaches once I open the card" hold
  // for the whole view rather than just the attention flag.
  if (!trackComments) return;
  const now = new Date().toISOString();
  await updateState(statePath, (state) => {
    for (const item of items) {
      state[item.id] = {
        comments: item.comments,
        updatedAt: item.updatedAt,
        seenAt: now,
        viewedAt: now,
        lastCommitPushedAt: item.lastCommitPushedAt,
      };
    }
    return true;
  });
}
