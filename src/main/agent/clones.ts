import fs from "node:fs";
import path from "node:path";

import type { PullRequest } from "../../shared/types";
import { safeGit, withNoHooks } from "./drive";
import type { GitRunner } from "./worktrees";

// A PR whose repository you have no checkout of — common on a fresh install,
// and for a review asked of you in a repository you never cloned — would only
// fail with "No checkout". With Settings › Agent › "Clone a repository it has
// no checkout of" on, the agent keeps a clone of its own instead, in its own
// folder (`userData/agent/clones/<host>/<owner>/<repo>`), never in yours:
//
// - blobless (`--filter=blob:none`), one branch, no tags, no working tree — the
//   history's commits and trees only; a run's worktree fetches the files it
//   checks out, so a large repository costs what one checkout costs;
// - signed in through gh, like everything else the app reads: the clone's own
//   config resets the credential helpers and names `gh auth git-credential`,
//   so a later fetch or a drive's push uses the token gh holds for that host
//   and no credential manager pops a window up behind the app;
// - made under a `.partial` name and renamed when complete, so a clone cut
//   short is never taken for a usable one; no hook runs on the way (`safeGit`).

const GH_HELPER = "!gh auth git-credential";

/** A folder name from a URL part: only plain characters, never `.` or `..`. */
function part(s: string): string | null {
  const safe = s.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe && safe !== "." && safe !== ".." ? safe : null;
}

/** The PR's repository as `https://host/owner/repo.git`, and the agent's folder for its clone. Null for a URL it can't read. */
export function agentClonePlace(agentDir: string, pr: Pick<PullRequest, "url" | "repo">): { url: string; dir: string } | null {
  let host: string;
  try {
    const u = new URL(pr.url);
    if (u.protocol !== "https:") return null;
    host = u.host;
  } catch {
    return null;
  }
  const [owner, name, ...rest] = pr.repo.split("/");
  if (!owner || !name || rest.length > 0) return null;
  const parts = [part(host), part(owner), part(name)];
  if (parts.some((p) => !p)) return null;
  return {
    url: `https://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`,
    dir: path.join(agentDir, "clones", ...(parts as string[])),
  };
}

/** The agent's clone of the PR's repository when it has one (made earlier), else null. */
export function findAgentClone(agentDir: string, pr: Pick<PullRequest, "url" | "repo">): string | null {
  const place = agentClonePlace(agentDir, pr);
  return place && fs.existsSync(path.join(place.dir, ".git", "config")) ? place.dir : null;
}

/** Whether `dir` is one of the agent's own clones (under `<agentDir>/clones`). */
export function isAgentClone(agentDir: string, dir: string): boolean {
  const rel = path.relative(path.join(agentDir, "clones"), dir);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The agent's clone has no file contents but what a checkout fetched, and a
 * drive's session has no network: a `git diff` against the base, or the merge
 * of the base that settles a conflict, would stop at the first missing file.
 * So before the session the app reads the same — a diff from the merge base,
 * one from the base's tip, and the merge itself, written to the object store
 * only — and git fetches every file they need in a batch, signed in as the
 * clone is. Each step's failure is left to the session to meet.
 */
export async function prefetchForDrive(git: GitRunner, off: readonly string[], worktree: string, base: string): Promise<void> {
  for (const args of [
    ["diff", "--stat", `${base}...HEAD`],
    ["diff", "--stat", base, "HEAD"],
    ["merge-tree", "--write-tree", "HEAD", base],
  ]) {
    await git([...off, ...args], worktree).catch(() => {});
  }
}

/** The git commands that make the clone at `dir` — hooks off, signed in through gh, in order. */
export function cloneCommands(url: string, dir: string, hooksDir: string): string[][] {
  const gh = ["-c", "credential.helper=", "-c", `credential.helper=${GH_HELPER}`];
  return [
    [...safeGit(hooksDir), ...gh, "clone", "--filter=blob:none", "--no-checkout", "--single-branch", "--no-tags", "--origin", "origin", "--", url, dir],
    // Kept in the clone, so every later fetch, worktree and push signs in the same way.
    [...safeGit(hooksDir), "-C", dir, "config", "--local", "credential.helper", ""],
    [...safeGit(hooksDir), "-C", dir, "config", "--local", "--add", "credential.helper", GH_HELPER],
  ];
}

const making = new Map<string, Promise<string>>();

/**
 * The agent's clone of the PR's repository, made now when it has none. Two runs
 * on one repository share one clone in the making.
 */
export function ensureAgentClone(git: GitRunner, agentDir: string, pr: Pick<PullRequest, "url" | "repo">): Promise<string> {
  const place = agentClonePlace(agentDir, pr);
  if (!place) return Promise.reject(new Error(`Can't tell where ${pr.repo} is cloned from (${pr.url})`));
  const ready = findAgentClone(agentDir, pr);
  if (ready) return Promise.resolve(ready);
  const pending = making.get(place.dir);
  if (pending) return pending;
  const partial = `${place.dir}.partial`;
  const job = (async () => {
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(place.dir), { recursive: true });
    try {
      await withNoHooks(async (hooksDir) => {
        for (const args of cloneCommands(place.url, partial, hooksDir)) await git(args, path.dirname(place.dir));
      });
      fs.renameSync(partial, place.dir);
      return place.dir;
    } catch (e) {
      fs.rmSync(partial, { recursive: true, force: true });
      throw e;
    }
  })().finally(() => making.delete(place.dir));
  making.set(place.dir, job);
  return job;
}
