import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PullRequest, SeenInput } from "./types";

/** A stored "snapshot" of a PR at the time it was last viewed. */
interface SeenEntry {
  /** Number of comments the user saw last time. */
  comments: number;
  /** The PR's updatedAt at the time it was last viewed. */
  updatedAt: string;
  /** When the user last marked the PR as seen. */
  seenAt: string;
}

type StateFile = Record<string, SeenEntry>;

/** Serializes writes to the file to avoid concurrent corruption. */
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

async function writeState(statePath: string, state: StateFile): Promise<void> {
  const op = writeChain.then(async () => {
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
 */
export async function applyActivity(prs: PullRequest[], statePath: string): Promise<void> {
  const state = await readState(statePath);
  let mutated = false;

  for (const pr of prs) {
    const entry = state[pr.id];
    if (!entry) {
      state[pr.id] = {
        comments: pr.totalComments,
        updatedAt: pr.updatedAt,
        seenAt: new Date().toISOString(),
      };
      mutated = true;
      pr.hasNewActivity = false;
      pr.lastSeenAt = null;
    } else {
      // Signal specifically NEW COMMENTS: a change in updatedAt (your own commit
      // push, labels, reviewer changes) does not count as new activity —
      // otherwise it drowns out the signal on your own PRs, where pushes are frequent.
      pr.hasNewActivity = pr.totalComments > entry.comments;
      pr.lastSeenAt = entry.seenAt;
    }

    // Mirrors the card accent: a review requested of you needs attention (your
    // turn to act); a re-requested change request and "just awaiting someone
    // else's review" (for your own PR) don't count as needing attention.
    const isAuthor = pr.roles.includes("author");
    pr.needsAttention =
      pr.roles.includes("reviewer") ||
      pr.failingChecks.length > 0 ||
      pr.hasUnaddressedChangeRequest ||
      pr.hasNewActivity ||
      (pr.unresolvedThreads > 0 && !(isAuthor && pr.awaitingReview));
  }

  if (mutated) await writeState(statePath, state);
}

/** Updates the snapshot of the given PRs to the provided values (clears NEW). */
export async function markSeen(items: SeenInput[], statePath: string): Promise<void> {
  if (items.length === 0) return;
  const state = await readState(statePath);
  const now = new Date().toISOString();
  for (const item of items) {
    state[item.id] = {
      comments: item.comments,
      updatedAt: item.updatedAt,
      seenAt: now,
    };
  }
  await writeState(statePath, state);
}
