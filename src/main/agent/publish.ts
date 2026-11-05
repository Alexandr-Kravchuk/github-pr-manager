// How the app posts what a review session prepared — and the per-run folder
// the session prepares it in.
//
// A review session never writes to GitHub: its publish step goes through a
// wrapper that only records (`capture.ts`). Here the app reads that plan back
// and posts it itself with `gh api`, the signature added to every body, one
// write at a time with progress on disk, so a retry after a failure (or a
// restart) carries on from the first write that didn't land instead of posting
// the review twice.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isUsableWrapperPath, planRequests, readPlanLines, type PublishContext, type PublishRequest, type PublishStep } from "../../shared/agent-publish";
import { launcherEnv } from "../../shared/claude-launch";
import { PLAN_FILE, type CaptureRun } from "./capture";

export interface GhResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: string[], opts?: { input?: string; cwd?: string; timeoutMs?: number }) => Promise<GhResult>;

/**
 * `gh` with your login, out of any repository (`cwd` defaults to the temp
 * folder: `gh pr merge --delete-branch` inside a checkout would also switch and
 * delete its local branch), never prompting, with a time limit.
 */
export const runGh: GhRunner = (args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn("gh", args, {
      cwd: opts.cwd ?? os.tmpdir(),
      env: { ...launcherEnv(process.env), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout = (stdout + d).slice(-200_000)));
    child.stderr.on("data", (d: string) => (stderr = (stderr + d).slice(-20_000)));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${e.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.input ?? "");
  });

/** The last thing gh said, for an error line. */
export function ghError(r: GhResult): string {
  const lines = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-2).join(" — ") || `gh exited with ${r.code}`;
}

/** `--hostname` for a GHE PR; github.com is gh's default. */
export function hostFlag(prUrl: string): string[] {
  const host = /^https?:\/\/([^/]+)\//.exec(prUrl)?.[1]?.toLowerCase() ?? "github.com";
  return host === "github.com" ? [] : ["--hostname", host];
}

/** A plan request as `gh api` arguments; the JSON goes in on stdin. */
export function ghApiArgs(req: PublishRequest, prUrl: string): string[] {
  return ["api", req.endpoint, "--method", "POST", "--input", "-", ...hostFlag(prUrl)];
}

/** A review run's folder: its publish wrapper, the payload folder the session may write, and the plan. */
export interface RunFolder {
  runDir: string;
  outDir: string;
  wrapperPath: string;
}

/**
 * Folders a run's wrapper may live in, best first. The review skill takes a
 * wrapper only at a path of plain characters (`isUsableWrapperPath`), so the
 * temp folder comes first by its real name (Windows hands out an 8.3 alias
 * with a `~` in it); a checkout's worktree folder is the fallback.
 */
export function runFolderRoots(worktreeBase: string | null): string[] {
  const roots: string[] = [];
  try {
    roots.push(path.join(fs.realpathSync.native(os.tmpdir()), "prd-agent"));
  } catch {
    roots.push(path.join(os.tmpdir(), "prd-agent"));
  }
  if (worktreeBase) roots.push(path.join(worktreeBase, ".prd-agent"));
  return roots;
}

/** POSIX-style forward slashes for a path inside a shell script, quoted for sh. */
function shQuote(p: string): string {
  return `'${p.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
}

/** The wrapper script: it hands the call to the capture script, which records it. */
export function wrapperScript(execPath: string, captureScript: string, runDir: string): string {
  return [
    "#!/bin/sh",
    "# PR Dashboard — the PR agent's publish wrapper for one review run.",
    "# It records what the review would post, for the app to publish; it never posts.",
    `ELECTRON_RUN_AS_NODE=1 exec ${shQuote(execPath)} ${shQuote(captureScript)} ${shQuote(runDir)} "$@"`,
    "",
  ].join("\n");
}

/**
 * Makes a review run's folder under the first usable root, or returns null —
 * then the review runs as a dry run and its result is text only.
 */
export function prepareRunFolder(
  roots: readonly string[],
  runId: string,
  pr: { repo: string; number: number },
  execPath: string,
  captureScript: string,
): RunFolder | null {
  for (const root of roots) {
    const runDir = path.join(root, runId);
    const wrapperPath = path.join(runDir, "bin", "pr-review-publish.sh");
    if (!isUsableWrapperPath(wrapperPath)) continue;
    try {
      // Fresh every time: nothing left from an earlier run (or put there by anyone else) is trusted.
      fs.rmSync(runDir, { recursive: true, force: true });
      const outDir = path.join(runDir, "out");
      fs.mkdirSync(outDir, { recursive: true });
      fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
      fs.writeFileSync(wrapperPath, wrapperScript(execPath, captureScript, runDir), { mode: 0o755 });
      const run: CaptureRun = { repo: pr.repo, number: pr.number, outDir, wrapperPath };
      fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run, null, 2));
      return { runDir, outDir, wrapperPath };
    } catch {
      // Not writable — try the next root.
    }
  }
  return null;
}

export function readPlan(runDir: string): PublishStep[] {
  try {
    return readPlanLines(fs.readFileSync(path.join(runDir, PLAN_FILE), "utf8"));
  } catch {
    return [];
  }
}

const PROGRESS_FILE = "published.json";

function readDone(runDir: string): number {
  try {
    const n = (JSON.parse(fs.readFileSync(path.join(runDir, PROGRESS_FILE), "utf8")) as { done?: unknown }).done;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export type PublishOutcome = { ok: true; posted: number; total: number } | { ok: false; error: string; posted: number; total: number };

/**
 * Posts a run's plan: every write in order, the count of those that landed
 * kept on disk after each one. Called again after a failure, it starts at the
 * first write that didn't land; called on a plan that is all posted, it posts
 * nothing.
 */
export async function publishPlan(runDir: string, prUrl: string, ctx: PublishContext, gh: GhRunner = runGh): Promise<PublishOutcome> {
  const requests = planRequests(readPlan(runDir), ctx);
  let done = Math.min(readDone(runDir), requests.length);
  for (let i = done; i < requests.length; i++) {
    const req = requests[i];
    const r = await gh(ghApiArgs(req, prUrl), { input: JSON.stringify(req.body) });
    if (r.code !== 0) return { ok: false, error: `${req.label}: ${ghError(r)}`, posted: done, total: requests.length };
    done = i + 1;
    fs.writeFileSync(path.join(runDir, PROGRESS_FILE), JSON.stringify({ done }));
  }
  return { ok: true, posted: done, total: requests.length };
}
