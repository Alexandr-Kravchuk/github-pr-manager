import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { launcherEnv, normalizeRemote, prRemoteKey } from "../../shared/claude-launch";
import type { PullRequest } from "../../shared/types";

// Each agent run gets its own git worktree on the PR's head commit, so your
// checkout — its branch, its uncommitted work — is never touched. Detached
// HEAD: the PR's branch may already be checked out in your checkout, and git
// refuses the same branch in two worktrees. `pull/N/head` is fetched rather
// than the branch name, which also covers PRs from forks.

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
export function worktreeDir(base: string, pr: Pick<PullRequest, "repo" | "number" | "headOid">): string {
  const repo = pr.repo.split("/")[1] ?? pr.repo;
  const safe = repo.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(base, `agent-${safe}-${pr.number}-${(pr.headOid ?? "head").slice(0, 10)}`);
}

/** The worktree base: the setting, else `<checkout>/.claude/worktrees`. */
export function worktreeBase(setting: string, checkout: string): string {
  return setting.trim() ? setting.trim() : path.join(checkout, ".claude", "worktrees");
}

/** The git commands that set a run's worktree up, in order. */
export function prepareCommands(remote: string, pr: Pick<PullRequest, "number" | "headOid">, dir: string): string[][] {
  if (!pr.headOid) throw new Error("The PR has no head commit to check out.");
  return [
    ["fetch", "--no-tags", remote, `pull/${pr.number}/head`],
    ["worktree", "add", "--detach", "--force", dir, pr.headOid],
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
  opts: { checkout: string; remote: string; base: string; pr: Pick<PullRequest, "repo" | "number" | "headOid"> },
): Promise<string> {
  const dir = worktreeDir(opts.base, opts.pr);
  if (fs.existsSync(dir)) await removeWorktree(git, opts.checkout, dir);
  fs.mkdirSync(opts.base, { recursive: true });
  for (const args of prepareCommands(opts.remote, opts.pr, dir)) await git(args, opts.checkout);
  return dir;
}

export async function removeWorktree(git: GitRunner, checkout: string, dir: string): Promise<void> {
  try {
    await git(["worktree", "remove", "--force", dir], checkout);
  } catch {
    // Not a registered worktree any more (removed by hand): drop the folder.
    fs.rmSync(dir, { recursive: true, force: true });
    await git(["worktree", "prune"], checkout).catch(() => {});
  }
}
