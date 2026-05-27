import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PullRequest } from "./types";

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

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");

/** Serializes writes to the file to avoid concurrent corruption. */
let writeChain: Promise<void> = Promise.resolve();

async function readState(): Promise<StateFile> {
  try {
    const text = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as StateFile) : {};
  } catch {
    return {};
  }
}

async function writeState(state: StateFile): Promise<void> {
  const op = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  });
  // The chain must not break because of a single failure.
  writeChain = op.catch(() => {});
  return op;
}

/**
 * Sets the activity flags on PRs (hasNewActivity, lastSeenAt, needsAttention)
 * by comparing against the last stored snapshot.
 *
 * Behavior on first encounter of a PR: we create a baseline snapshot from the
 * current values and do NOT highlight it as new — so a "forest" of NEW badges
 * doesn't light up on first run. Existing snapshots are not updated on read
 * (only mark-seen advances them).
 */
export async function applyActivity(prs: PullRequest[]): Promise<void> {
  const state = await readState();
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

    // Mirrors the card accent: a re-requested change request and "just awaiting
    // someone else's review" (for your own PR) don't count as needing attention.
    const isAuthor = pr.roles.includes("author");
    pr.needsAttention =
      pr.failingChecks.length > 0 ||
      pr.hasUnaddressedChangeRequest ||
      pr.hasNewActivity ||
      (pr.unresolvedThreads > 0 && !(isAuthor && pr.awaitingReview));
  }

  if (mutated) await writeState(state);
}

/** Data for marking a PR as seen (sent by the client from its own copy). */
export interface SeenInput {
  id: string;
  comments: number;
  updatedAt: string;
}

/** Updates the snapshot of the given PRs to the provided values (clears NEW). */
export async function markSeen(items: SeenInput[]): Promise<void> {
  if (items.length === 0) return;
  const state = await readState();
  const now = new Date().toISOString();
  for (const item of items) {
    state[item.id] = {
      comments: item.comments,
      updatedAt: item.updatedAt,
      seenAt: now,
    };
  }
  await writeState(state);
}
