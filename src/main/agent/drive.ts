// A drive run's result, read by the app from the run's worktree, and the push
// the app makes with it. The session commits; it never pushes — its guard
// refuses `git push`, and its environment (NO_PUSH_ENV) takes away the means:
// no credential helper, no SSH, every push URL rewritten to nowhere. The app
// pushes, as a fast-forward only, the exact commit you were shown.
//
// Every git command the app runs in the worktree ignores what the repository
// could have been made to run: no hooks (an empty core.hooksPath, and
// `--no-verify` on the push — a hook manager such as lefthook reads its
// commands from files in the worktree), no fsmonitor, no external diff or
// textconv. And before pushing, the app checks that the repository's git
// config, its hooks and your global git config are what they were before the
// session started: a session that ran code (tests you allowed it) and
// changed them gets nothing pushed.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentDriveResult } from "../../shared/types";
import type { GitRunner } from "./worktrees";

const PATCH_MAX = 100_000;

/** An empty folder for core.hooksPath: no hook runs from any git command the app makes in a run's worktree. */
export function noHooksDir(): string {
  const dir = path.join(os.tmpdir(), "prd-agent-no-hooks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** `git -c …` options for every git command the app runs in a run's worktree. */
export function safeGit(hooksDir: string): string[] {
  return ["-c", `core.hooksPath=${hooksDir}`, "-c", "core.fsmonitor=false"];
}

/** Plain-text diffs only: no external diff program, no textconv filter, whatever the repository configures. */
const PLAIN = ["--no-color", "--no-ext-diff", "--no-textconv"];

/**
 * The commits a drive run made on top of `base` (oldest first), their stat
 * and patch, the head they end at — the one commit a Push may send — and
 * whether they are a fast-forward of `base`: a rebase or an amend of a
 * commit that was already there is not, and is never pushed.
 */
export async function collectDrive(
  git: GitRunner,
  dir: string,
  base: string,
  reasons: string[],
  hooksDir: string = noHooksDir(),
): Promise<{ drive: AgentDriveResult; fastForward: boolean }> {
  if (!/^[0-9a-f]{7,40}$/.test(base)) throw new Error(`no head commit to compare with (${base || "none"})`);
  const g = (args: string[]) => git([...safeGit(hooksDir), ...args], dir);
  const range = `${base}..HEAD`;
  const head = (await g(["rev-parse", "HEAD"])).trim();
  const log = await g(["log", "--no-color", "--format=%H%x09%s", range]);
  const commits = log
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [oid, ...subject] = l.split("\t");
      return { oid: oid.trim(), subject: subject.join("\t").trim() };
    })
    .reverse();
  if (commits.length === 0) return { drive: { base, head, reasons, commits, stat: "", patch: "" }, fastForward: true };
  let fastForward = true;
  try {
    await g(["merge-base", "--is-ancestor", base, "HEAD"]);
  } catch {
    fastForward = false;
  }
  const stat = await g(["diff", ...PLAIN, "--stat", range]);
  let patch = await g(["diff", ...PLAIN, range]);
  if (patch.length > PATCH_MAX) patch = `${patch.slice(0, PATCH_MAX)}\n… (cut at 100 kB)`;
  return { drive: { base, head, reasons, commits, stat: stat.trim(), patch }, fastForward };
}

/** A branch name the app will put in a refspec: plain characters, no `..`, not an option. */
export function isPlainBranch(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith("-") && !name.includes("..") && !name.endsWith(".lock") && !name.endsWith("/");
}

/**
 * The push: the exact commit you were shown (`<oid>:refs/heads/<branch>`, not
 * HEAD), to the remote URL read before the session started (not a remote
 * name the session could have repointed), never `--force` — git itself
 * refuses anything but a fast-forward — and with no hook run.
 */
export function pushArgs(url: string, oid: string, branch: string, hooksDir: string): string[] {
  if (!isPlainBranch(branch)) throw new Error(`"${branch}" isn't a branch name the agent pushes to`);
  if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error(`"${oid}" isn't a commit the agent pushes`);
  if (!/^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/.test(url) || url.startsWith("-")) throw new Error(`"${url}" isn't a remote URL the agent pushes to`);
  return [...safeGit(hooksDir), "push", "--no-verify", url, `${oid}:refs/heads/${branch}`];
}

/**
 * What git would run code from, read as one fingerprint: the repository's
 * config and hooks (the shared git folder all worktrees use, and this
 * worktree's own config), and your global git config. Taken before a drive
 * session and again before its push.
 */
export function gitFingerprint(commonDir: string, worktreeGitDir: string | null): string {
  const h = createHash("sha256");
  const add = (label: string, file: string) => {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      text = "<none>";
    }
    h.update(`${label}\0${text}\0`);
  };
  add("config", path.join(commonDir, "config"));
  if (worktreeGitDir) add("config.worktree", path.join(worktreeGitDir, "config.worktree"));
  const home = os.homedir();
  add("global", path.join(home, ".gitconfig"));
  add("xdg", path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "git", "config"));
  try {
    const hooks = path.join(commonDir, "hooks");
    for (const name of fs.readdirSync(hooks).sort()) add(`hook:${name}`, path.join(hooks, name));
  } catch {
    h.update("hooks\0<none>\0");
  }
  return h.digest("hex");
}
