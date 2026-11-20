import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { launcherEnv, normalizeRemote, prRemoteKey } from "../../shared/claude-launch";
import type { PullRequest } from "../../shared/types";
import { safeGit, withNoHooks } from "./drive";

// Each agent run gets its own git worktree on the PR's head commit, so your
// checkout — its branch, its uncommitted work — is never touched. Detached
// HEAD: the PR's branch may already be checked out in your checkout, and git
// refuses the same branch in two worktrees. `pull/N/head` is fetched rather
// than the branch name, which also covers PRs from forks.
//
// No hook of the clone runs on the way: `worktree add` runs post-checkout and
// reference-transaction from the new worktree, and a relative core.hooksPath
// (husky's `.husky/_`) resolves inside it — to scripts the PR itself brings,
// before any guard or session exists. Every command here goes through
// `safeGit` with a fresh empty hooks folder, as the drive's own git does.

/** `[remote "name"]` sections of a git config file: name and url. */
export function parseRemotes(configText: string): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  let current: string | null = null;
  for (const line of configText.split(/\r?\n/)) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
    if (section) {
      current = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const url = current ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line) : null;
    if (url && current) out.push({ name: current, url: url[1] });
  }
  return out;
}

/** The remote of `checkout` that points at the PR's repository on the PR's host. */
export function remoteFor(checkout: string, pr: Pick<PullRequest, "url" | "repo">): string | null {
  const key = prRemoteKey(pr);
  if (!key) return null;
  let text: string;
  try {
    text = fs.readFileSync(path.join(checkout, ".git", "config"), "utf8");
  } catch {
    return null;
  }
  return parseRemotes(text).find((r) => normalizeRemote(r.url) === key)?.name ?? null;
}

/** Where a run's worktree goes: one folder per PR head, so a rerun on the same head reuses the name. */
/**
 * A run's own worktree folder. The run id is part of the name: a second run on
 * the same PR and head (Run again, Review anyway) must never reuse — and so
 * remove — a folder the first one's result still owns, where your session may
 * be working ("Continue in session").
 */
export function worktreeDir(base: string, pr: Pick<PullRequest, "repo" | "number" | "headOid">, runId?: string): string {
  const repo = pr.repo.split("/")[1] ?? pr.repo;
  const safe = repo.replace(/[^A-Za-z0-9._-]/g, "_");
  const run = runId ? `-${runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}` : "";
  return path.join(base, `agent-${safe}-${pr.number}-${(pr.headOid ?? "head").slice(0, 10)}${run}`);
}

/** The worktree base: the setting, else `<checkout>/.claude/worktrees`. */
export function worktreeBase(setting: string, checkout: string): string {
  return setting.trim() ? setting.trim() : path.join(checkout, ".claude", "worktrees");
}

/** The git commands that set a run's worktree up, in order — hooks off (`hooksDir` is a fresh empty folder). */
export function prepareCommands(remote: string, pr: Pick<PullRequest, "number" | "headOid">, dir: string, hooksDir: string): string[][] {
  if (!pr.headOid) throw new Error("The PR has no head commit to check out.");
  const off = safeGit(hooksDir);
  return [
    [...off, "fetch", "--no-tags", remote, `pull/${pr.number}/head`],
    [...off, "worktree", "add", "--detach", "--force", dir, pr.headOid],
  ];
}

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/** git with the launcher's scrubbed environment, a timeout, and no prompts. */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 120_000, env: { ...launcherEnv(process.env), GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`)) : resolve(stdout)),
    );
  });

/** Creates (or recreates) the worktree for the PR's head commit and returns its folder. */
export async function prepareWorktree(
  git: GitRunner,
  opts: { checkout: string; remote: string; base: string; pr: Pick<PullRequest, "repo" | "number" | "headOid">; runId?: string },
): Promise<string> {
  const dir = worktreeDir(opts.base, opts.pr, opts.runId);
  if (fs.existsSync(dir)) await removeWorktree(git, opts.checkout, dir);
  fs.mkdirSync(opts.base, { recursive: true });
  await withNoHooks(async (hooksDir) => {
    for (const args of prepareCommands(opts.remote, opts.pr, dir, hooksDir)) await git(args, opts.checkout);
  });
  return dir;
}

export async function removeWorktree(git: GitRunner, checkout: string, dir: string): Promise<void> {
  await withNoHooks(async (hooksDir) => {
    const off = safeGit(hooksDir);
    try {
      await git([...off, "worktree", "remove", "--force", dir], checkout);
    } catch {
      // Not a registered worktree any more (removed by hand): drop the folder.
      fs.rmSync(dir, { recursive: true, force: true });
      await git([...off, "worktree", "prune"], checkout).catch(() => {});
    }
  });
}

/**
 * A worktree's own git folder, found from the clone's side: the
 * `<commonDir>/worktrees/<name>` entry whose `gitdir` names `<dir>/.git`. The
 * worktree's `.git` file is not asked — a session could have rewritten it to
 * send the app's git elsewhere. Null when no entry names it.
 */
export function worktreeGitDirFor(commonDir: string, dir: string): string | null {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const want = real(path.join(dir, ".git"));
  let names: string[];
  try {
    names = fs.readdirSync(path.join(commonDir, "worktrees"));
  } catch {
    return null;
  }
  for (const name of names) {
    const entry = path.join(commonDir, "worktrees", name);
    try {
      const named = fs.readFileSync(path.join(entry, "gitdir"), "utf8").trim();
      if (named && real(path.resolve(entry, named)) === want) return entry;
    } catch {
      // Not a worktree entry (or one being removed): the next.
    }
  }
  return null;
}

/** Where a run's worktree's git lives, rebuilt from the clone it was made from (after a restart dropped what the run took). */
export async function recoverPlace(git: GitRunner, checkout: string, dir: string): Promise<{ commonDir: string; worktreeGitDir: string }> {
  if (!fs.existsSync(dir)) throw new Error("the run's worktree is gone");
  const commonDir = await withNoHooks(async (h) => path.resolve(checkout, (await git([...safeGit(h), "rev-parse", "--git-common-dir"], checkout)).trim()));
  const worktreeGitDir = worktreeGitDirFor(commonDir, dir);
  if (!worktreeGitDir) throw new Error("the clone doesn't list the run's worktree any more");
  return { commonDir, worktreeGitDir };
}

/** What a worktree holds that the PR doesn't: commits on top of the PR's head (null: none of the heads could be compared) and uncommitted changes. */
export interface LocalWork {
  ahead: number | null;
  dirty: boolean | null;
  /** The worktree's HEAD, when it could be read. */
  head: string | null;
}

/**
 * Counts the commits in a run's worktree that are not on the PR —
 * `rev-list --count HEAD ^<base>` against the first of `bases` git knows (the
 * PR's head now, then the head the run started from) — and, only when
 * `checkFiles`, whether files are changed. Hooks and fsmonitor off, as for
 * every app command in a worktree, and the git folder named outright: with
 * none (`gitDir` unknown) nothing is read — the worktree's own `.git` file is
 * the session's to rewrite.
 *
 * `git status` reads the files themselves, and for that runs any clean or
 * process filter the config names — a program. So `checkFiles` only while
 * git's config is what it was before the session (its fingerprint matches);
 * else `dirty` stays unknown (null).
 */
export async function readLocalWork(
  git: GitRunner,
  dir: string,
  bases: ReadonlyArray<string | null | undefined>,
  gitDir: string | null | undefined,
  checkFiles = false,
): Promise<LocalWork> {
  if (!gitDir) return { ahead: null, dirty: null, head: null };
  return withNoHooks(async (h) => {
    const g = (args: string[]) => git([...safeGit(h, { workTree: dir, gitDir }), ...args], dir);
    const head = await g(["rev-parse", "HEAD"])
      .then((o) => o.trim() || null)
      .catch(() => null);
    let ahead: number | null = null;
    for (const base of bases) {
      if (!base || !/^[0-9a-f]{7,40}$/.test(base)) continue;
      try {
        ahead = Number.parseInt((await g(["rev-list", "--count", "HEAD", `^${base}`])).trim(), 10) || 0;
        break;
      } catch {
        // Not a commit this clone has (someone pushed since): the next base.
      }
    }
    const dirty = checkFiles
      // Changes to tracked files only: a test run's or a build's leftovers would keep every worktree.
      ? await g(["status", "--porcelain", "--untracked-files=no", "--ignore-submodules"])
          .then((o) => o.trim().length > 0)
          .catch(() => null)
      : null;
    return { ahead, dirty, head };
  });
}

/**
 * Work a worktree must not be removed with: commits not on the PR (or a count
 * git couldn't make), or files known to be changed. Files that weren't checked
 * (`dirty` null — git's config can't be vouched for) don't keep it by
 * themselves: every drive whose card outlived a restart would stay forever.
 */
export function holdsWork(w: LocalWork): boolean {
  return w.ahead !== 0 || w.dirty === true;
}

/**
 * The ref that keeps a run's commits reachable once its card is closed:
 * `refs/prd-agent/<runId>` — only for a run id of the app's own shape (a
 * UUID); the id comes from state.json, so anything else gets no ref.
 */
export function keepRef(runId: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) ? `refs/prd-agent/${runId}` : null;
}
