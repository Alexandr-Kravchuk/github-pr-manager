// A drive run's result, read by the app from the run's worktree, and the push
// the app makes with it. The session commits; it never pushes (its guard
// refuses `git push`, and NO_PUSH_ENV breaks any push in its process tree);
// the app pushes, as a fast-forward only, after checking the commits sit on
// top of the head the run started from.

import type { AgentDriveResult } from "../../shared/types";
import type { GitRunner } from "./worktrees";

const PATCH_MAX = 100_000;

/** Plain-text diffs only: no external diff program, no textconv filter, whatever the repository configures. */
const PLAIN = ["--no-color", "--no-ext-diff", "--no-textconv"];

/**
 * The commits a drive run made on top of `base` (oldest first), their stat
 * and patch, and whether they are a fast-forward of `base` — a rebase or an
 * amend of a commit that was already there is not, and is never pushed.
 */
export async function collectDrive(
  git: GitRunner,
  dir: string,
  base: string,
  reasons: string[],
): Promise<{ drive: AgentDriveResult; fastForward: boolean }> {
  if (!/^[0-9a-f]{7,40}$/.test(base)) throw new Error(`no head commit to compare with (${base || "none"})`);
  const range = `${base}..HEAD`;
  const log = await git(["log", "--no-color", "--format=%H%x09%s", range], dir);
  const commits = log
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [oid, ...subject] = l.split("\t");
      return { oid: oid.trim(), subject: subject.join("\t").trim() };
    })
    .reverse();
  if (commits.length === 0) return { drive: { base, reasons, commits, stat: "", patch: "" }, fastForward: true };
  let fastForward = true;
  try {
    await git(["merge-base", "--is-ancestor", base, "HEAD"], dir);
  } catch {
    fastForward = false;
  }
  const stat = await git(["diff", ...PLAIN, "--stat", range], dir);
  let patch = await git(["diff", ...PLAIN, range], dir);
  if (patch.length > PATCH_MAX) patch = `${patch.slice(0, PATCH_MAX)}\n… (cut at 100 kB)`;
  return { drive: { base, reasons, commits, stat: stat.trim(), patch }, fastForward };
}

/** A branch name the app will put in a refspec: plain characters, no `..`, not an option. */
export function isPlainBranch(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith("-") && !name.includes("..") && !name.endsWith(".lock") && !name.endsWith("/");
}

/**
 * `git push <remote> HEAD:refs/heads/<branch>` — never `--force`, so git
 * itself refuses anything but a fast-forward; the repository's own pre-push
 * hooks run as they would for you.
 */
export function pushArgs(remote: string, branch: string): string[] {
  if (!isPlainBranch(branch)) throw new Error(`"${branch}" isn't a branch name the agent pushes to`);
  if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith("-")) throw new Error(`"${remote}" isn't a remote name the agent pushes to`);
  return ["push", remote, `HEAD:refs/heads/${branch}`];
}
