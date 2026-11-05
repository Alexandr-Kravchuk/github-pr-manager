// A drive run's result, read by the app from the run's worktree, and the push
// the app makes with it. The session commits; it never pushes — its guard
// refuses `git push`, and its environment (NO_PUSH_ENV) takes away the means:
// no network, no credential helper, no SSH. The app pushes, as a
// fast-forward only, the exact commit you were shown.
//
// Every git command the app runs in the worktree names its git folder and
// work tree outright (`--git-dir`, `--work-tree`: a rewritten `.git` file
// can't send it elsewhere) and runs nothing the repository could have been
// made to run: hooks point at a fresh empty folder of its own (and the push
// adds `--no-verify` — a hook manager such as lefthook reads its commands
// from worktree files), no fsmonitor, no external diff or textconv. Before
// the push, a fingerprint of everything git would read — every config file
// it loads (includes too), the repository's hooks, the worktree's links to
// its git folder, and your SSH config for an SSH remote — must match the one
// taken before the session. All of this matters only if you let a drive run
// your tests: by default it runs no code of yours, and none of it can.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentDriveResult } from "../../shared/types";
import type { GitRunner } from "./worktrees";

const PATCH_MAX = 100_000;

/** Where a worktree's git lives, as read before the session. */
export interface GitPlace {
  /** The worktree itself. */
  workTree: string;
  /** Its own git folder (`.git/worktrees/<name>`). */
  gitDir: string;
}

/**
 * A fresh empty folder for core.hooksPath, made for one operation and
 * removed after it: nothing can have been put there in advance.
 */
export function withNoHooks<T>(fn: (hooksDir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-nohooks-"));
  const run = async () => {
    if (fs.readdirSync(dir).length > 0) throw new Error("the empty hooks folder wasn't empty");
    return fn(dir);
  };
  return run().finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/**
 * Global git options for an app command in a run's worktree: the git folder
 * named outright, and none of the programs a config can make git start for
 * reading — hooks, fsmonitor, signature checks (gpg), a pager.
 */
export function safeGit(hooksDir: string, place?: GitPlace): string[] {
  const off = [
    `core.hooksPath=${hooksDir}`,
    "core.fsmonitor=false",
    "core.pager=cat",
    "log.showSignature=false",
    "gpg.program=pr-agent-no-gpg",
    "gpg.ssh.program=pr-agent-no-gpg",
    "gpg.x509.program=pr-agent-no-gpg",
  ];
  return [...(place ? [`--git-dir=${place.gitDir}`, `--work-tree=${place.workTree}`] : []), ...off.flatMap((c) => ["-c", c])];
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
  hooksDir: string,
  place?: GitPlace,
): Promise<{ drive: AgentDriveResult; fastForward: boolean }> {
  if (!/^[0-9a-f]{7,40}$/.test(base)) throw new Error(`no head commit to compare with (${base || "none"})`);
  const g = (args: string[]) => git([...safeGit(hooksDir, place), ...args], dir);
  const range = `${base}..HEAD`;
  const head = (await g(["rev-parse", "HEAD"])).trim();
  const log = await g(["log", "--no-color", "--no-show-signature", "--format=%H%x09%s", range]);
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

/** An SSH remote: ssh reads ~/.ssh/config, which can name programs to run. */
export function isSshUrl(url: string): boolean {
  return /^(ssh:\/\/|git@|[^/:@\s]+@[^/:\s]+:)/.test(url);
}

/**
 * The push: the exact commit you were shown (`<oid>:refs/heads/<branch>`, not
 * HEAD), to the remote URL read before the session started (not a remote
 * name the session could have repointed), never `--force` — git itself
 * refuses anything but a fast-forward — and with no hook run.
 */
export function pushArgs(url: string, oid: string, branch: string, hooksDir: string, place?: GitPlace): string[] {
  if (!isPlainBranch(branch)) throw new Error(`"${branch}" isn't a branch name the agent pushes to`);
  if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error(`"${oid}" isn't a commit the agent pushes`);
  if (!/^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/.test(url) || url.startsWith("-")) throw new Error(`"${url}" isn't a remote URL the agent pushes to`);
  return [...safeGit(hooksDir, place), "push", "--no-verify", url, `${oid}:refs/heads/${branch}`];
}

/**
 * The config files git loads for this worktree — includes too — from
 * `git config --list --show-origin --name-only -z`: NUL-separated pairs of
 * origin and key, never quoted, so a path with odd characters reads as it is.
 */
export function parseConfigOrigins(out: string, cwd: string): string[] {
  const parts = out.split("\0");
  const files = new Set<string>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i].startsWith("file:")) files.add(path.resolve(cwd, parts[i].slice(5)));
  }
  return [...files].sort();
}

export async function configFiles(git: GitRunner, place: GitPlace, hooksDir: string): Promise<string[]> {
  const out = await git([...safeGit(hooksDir, place), "config", "--list", "--show-origin", "--name-only", "-z"], place.workTree);
  return parseConfigOrigins(out, place.workTree);
}

/**
 * The SSH config files ssh would read for a push: yours and the system's,
 * and every file their `Include` lines name (wildcards too), a few levels
 * deep. Any of them can name a program for ssh to run.
 */
export function sshConfigFiles(home = os.homedir()): string[] {
  const seen = new Set<string>();
  const sshDir = path.join(home, ".ssh");
  const system =
    process.platform === "win32"
      ? [path.join(process.env.ProgramData ?? "C:\\ProgramData", "ssh", "ssh_config")]
      : ["/etc/ssh/ssh_config", ...listDir("/etc/ssh/ssh_config.d")];
  const visit = (file: string, depth: number) => {
    if (seen.has(file) || depth > 4) return;
    seen.add(file);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*Include\s+(.+)$/i.exec(line);
      if (!m) continue;
      for (const raw of m[1].trim().split(/\s+/)) {
        const p0 = raw.replace(/^"|"$/g, "").replace(/^~(?=[\\/]|$)/, home);
        const p = path.normalize(path.isAbsolute(p0) ? p0 : path.join(sshDir, p0));
        for (const f of expandGlob(p)) visit(f, depth + 1);
      }
    }
  };
  visit(path.join(sshDir, "config"), 0);
  for (const f of system) visit(f, 0);
  return [...seen].sort();
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** `*` and `?` in the last part of a path, as ssh's Include allows. */
function expandGlob(p: string): string[] {
  const base = path.basename(p);
  if (!/[*?]/.test(base)) return [p];
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return listDir(path.dirname(p)).filter((f) => re.test(path.basename(f)));
}

/**
 * One fingerprint of what git (and ssh) would read for a push: every config
 * file git loads, the repository's hooks, the worktree's links to its git
 * folder (`.git`, `commondir`, `gitdir`), and ~/.ssh/config for an SSH
 * remote. Taken before a drive session and again before its push.
 */
export async function gitFingerprint(git: GitRunner, place: GitPlace, commonDir: string, url: string): Promise<string> {
  const h = createHash("sha256");
  const add = (label: string, file: string, mustExist = false) => {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      // A file git says it loads but that can't be read is not a file to vouch for.
      if (mustExist) throw new Error(`couldn't read ${file}, which git loads`);
      text = "<none>";
    }
    h.update(`${label}\0${file}\0${text}\0`);
  };
  const files = await withNoHooks((hooksDir) => configFiles(git, place, hooksDir));
  for (const f of files) add("config", f, true);
  add("config", path.join(commonDir, "config"));
  add("config.worktree", path.join(place.gitDir, "config.worktree"));
  add("commondir", path.join(place.gitDir, "commondir"));
  add("gitdir", path.join(place.gitDir, "gitdir"));
  add(".git", path.join(place.workTree, ".git"));
  add("global", path.join(os.homedir(), ".gitconfig"));
  if (isSshUrl(url)) for (const f of sshConfigFiles()) add("ssh", f);
  try {
    const hooks = path.join(commonDir, "hooks");
    for (const name of fs.readdirSync(hooks).sort()) add(`hook:${name}`, path.join(hooks, name));
  } catch {
    h.update("hooks\0<none>\0");
  }
  return h.digest("hex");
}
