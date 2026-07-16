import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PullRequest } from "./types";

/**
 * Persistent "ignored PRs" store — a JSON file under userData mapping a PR's
 * node id to when it was ignored. An ignored PR is hidden from the dashboard
 * (and excluded from counts / buddy mood) until the user un-ignores it; unlike
 * the in-memory filter chips, this survives a relaunch. Mirrors the seen-state
 * store in `state.ts`.
 */
interface IgnoredEntry {
  /** When the user ignored this PR. */
  ignoredAt: string;
}

type IgnoredFile = Record<string, IgnoredEntry>;

/** Serializes writes to the file to avoid concurrent corruption. */
let writeChain: Promise<void> = Promise.resolve();

async function readIgnored(statePath: string): Promise<IgnoredFile> {
  try {
    const text = await readFile(statePath, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as IgnoredFile) : {};
  } catch {
    return {};
  }
}

async function writeIgnored(statePath: string, state: IgnoredFile): Promise<void> {
  const op = writeChain.then(async () => {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  });
  // The chain must not break because of a single failure.
  writeChain = op.catch(() => {});
  return op;
}

/** Flags each PR as ignored (or not) from the stored set in `statePath`. */
export async function applyIgnored(prs: PullRequest[], statePath: string): Promise<void> {
  const state = await readIgnored(statePath);
  for (const pr of prs) {
    pr.isIgnored = pr.id in state;
  }
}

/** Adds or removes a PR from the ignored set. */
export async function setIgnored(
  id: string,
  ignored: boolean,
  statePath: string,
): Promise<void> {
  const state = await readIgnored(statePath);
  if (ignored) {
    if (id in state) return;
    state[id] = { ignoredAt: new Date().toISOString() };
  } else {
    if (!(id in state)) return;
    delete state[id];
  }
  await writeIgnored(statePath, state);
}
