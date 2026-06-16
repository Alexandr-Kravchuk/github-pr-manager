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

/**
 * State is namespaced by a stable per-user key (see `sessionUserKey` — the
 * viewer login, falling back to the session id): each user sees their own pull
 * requests, so their "seen" snapshots must not collide, and the NEW badges
 * survive logout/login rather than resetting with every new session.
 */
type UserState = Record<string, SeenEntry>;
type StateFile = Record<string, UserState>;

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");

/** Serializes the whole read-modify-write cycle to avoid concurrent corruption. */
let writeChain: Promise<unknown> = Promise.resolve();

async function readState(): Promise<StateFile> {
  try {
    const text = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as StateFile) : {};
  } catch {
    return {};
  }
}

/**
 * Runs `fn` against the latest on-disk state inside the serialized chain, so
 * concurrent sessions can't clobber each other's read-modify-write. Persists
 * only when `fn` reports a mutation.
 */
async function withState<T>(fn: (state: StateFile) => { value: T; dirty: boolean }): Promise<T> {
  const op = writeChain.then(async () => {
    const state = await readState();
    const { value, dirty } = fn(state);
    if (dirty) {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
    }
    return value;
  });
  // The chain must not break because of a single failure.
  writeChain = op.catch(() => {});
  return op;
}

/**
 * Sets the activity flags on a session's PRs (hasNewActivity, lastSeenAt,
 * needsAttention) by comparing against that session's last stored snapshot.
 *
 * First encounter of a PR creates a baseline (not highlighted as new), so a
 * "forest" of NEW badges doesn't light up on first run.
 */
export async function applyActivity(userKey: string, prs: PullRequest[]): Promise<void> {
  await withState((file) => {
    const state = (file[userKey] ??= {});
    const now = new Date().toISOString();
    let dirty = false;

    for (const pr of prs) {
      const entry = state[pr.id];
      if (!entry) {
        state[pr.id] = { comments: pr.totalComments, updatedAt: pr.updatedAt, seenAt: now };
        dirty = true;
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

    return { value: undefined, dirty };
  });
}

/** Data for marking a PR as seen (sent by the client from its own copy). */
export interface SeenInput {
  id: string;
  comments: number;
  updatedAt: string;
}

/** Updates a session's snapshot of the given PRs to the provided values (clears NEW). */
export async function markSeen(userKey: string, items: SeenInput[]): Promise<void> {
  if (items.length === 0) return;
  await withState((file) => {
    const state = (file[userKey] ??= {});
    const now = new Date().toISOString();
    for (const item of items) {
      state[item.id] = { comments: item.comments, updatedAt: item.updatedAt, seenAt: now };
    }
    return { value: undefined, dirty: true };
  });
}
