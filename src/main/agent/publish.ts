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
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isUsableWrapperPath, planRequests, postedSteps, readPlanLines, type PublishContext, type PublishRequest, type PublishStep, type PublishSub } from "../../shared/agent-publish";
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
  subs?: PublishSub[],
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
      const run: CaptureRun = { repo: pr.repo, number: pr.number, outDir, wrapperPath, ...(subs ? { subs } : {}) };
      fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run, null, 2));
      return { runDir, outDir, wrapperPath };
    } catch {
      // Not writable — try the next root.
    }
  }
  return null;
}

/** The plan file as it is now; "" when there is none. */
export function readPlanText(runDir: string): string {
  try {
    return fs.readFileSync(path.join(runDir, PLAN_FILE), "utf8");
  } catch {
    return "";
  }
}

export function readPlan(runDir: string): PublishStep[] {
  return readPlanLines(readPlanText(runDir));
}

/** A fingerprint of the plan as it was shown to you — Publish posts only that. */
export function planHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const PROGRESS_FILE = "published.json";

/** How many of the plan's writes went out already (a publish that stopped part-way). */
export function publishedCount(runDir: string): number {
  return readDone(runDir);
}

function readDone(runDir: string): number {
  try {
    const n = (JSON.parse(fs.readFileSync(path.join(runDir, PROGRESS_FILE), "utf8")) as { done?: unknown }).done;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** `changed`: the plan is not the one you were shown (edited in the session since) — nothing was posted. */
export type PublishOutcome = { ok: true; posted: number; total: number } | { ok: false; error: string; posted: number; total: number; changed?: boolean };

const THREAD_PR_QUERY =
  "query($id:ID!){ node(id:$id){ ... on PullRequestReviewThread { isResolved pullRequest { number repository { nameWithOwner } } comments(first:1){ nodes{ author{ login } } } } } }";

/**
 * Whose threads a plan may touch. A review answers and resolves only threads
 * YOU opened (`mine`) — never a colleague's; your own PR's drive run answers
 * reviewers in theirs and resolves nothing.
 */
export interface PlanTargets {
  /** Your login on the PR's host; null when unknown — then nothing that needs it goes out. */
  viewer: string | null;
  mine: boolean;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Whether every thread a plan resolves and every comment it replies to is on
 * this PR — or why not. A thread id or comment id is just a value the session
 * wrote; on its own it could name a thread on any PR your account can reach.
 * Checked against GitHub before anything is posted.
 */
export async function checkPlanTargets(
  steps: readonly PublishStep[],
  prUrl: string,
  repo: string,
  number: number,
  targets: PlanTargets,
  gh: GhRunner = runGh,
): Promise<string | null> {
  const here = `${repo}#${number}`.toLowerCase();
  const me = targets.viewer?.toLowerCase() ?? null;
  for (const s of steps) {
    if (s.kind === "resolve") {
      if (!targets.mine) return `this run doesn't resolve threads (${s.threadId})`;
      if (!me) return "couldn't tell whose threads these are — your login on the host is unknown";
      const r = await gh(["api", "graphql", "--input", "-", ...hostFlag(prUrl)], { input: JSON.stringify({ query: THREAD_PR_QUERY, variables: { id: s.threadId } }) });
      if (r.code !== 0) return `couldn't check thread ${s.threadId}: ${ghError(r)}`;
      type ThreadNode = {
        isResolved?: boolean;
        pullRequest?: { number?: number; repository?: { nameWithOwner?: string } };
        comments?: { nodes?: Array<{ author?: { login?: string } | null }> };
      };
      const t = (json(r.stdout) as { data?: { node?: ThreadNode } } | null)?.data?.node;
      const pr = t?.pullRequest;
      if (!pr || `${pr.repository?.nameWithOwner ?? ""}#${pr.number}`.toLowerCase() !== here) return `thread ${s.threadId} is not on ${repo}#${number}`;
      if ((t?.comments?.nodes?.[0]?.author?.login ?? "").toLowerCase() !== me) return `thread ${s.threadId} is not yours — the agent never closes a colleague's thread`;
    } else if (s.kind === "reply") {
      const r = await gh(["api", `repos/${repo}/pulls/comments/${s.replyTo}`, ...hostFlag(prUrl)]);
      if (r.code !== 0) return `couldn't check comment ${s.replyTo}: ${ghError(r)}`;
      const c = json(r.stdout) as { pull_request_url?: unknown; user?: { login?: unknown }; in_reply_to_id?: unknown } | null;
      const url = String(c?.pull_request_url ?? "").toLowerCase();
      if (!url.endsWith(`/repos/${repo}/pulls/${number}`.toLowerCase())) return `comment ${s.replyTo} is not on ${repo}#${number}`;
      if (targets.mine) {
        if (!me) return "couldn't tell whose threads these are — your login on the host is unknown";
        // The thread's first comment, and yours: a reply of yours in a colleague's thread is still their thread.
        if (c?.in_reply_to_id != null) return `comment ${s.replyTo} is a reply, not the start of a thread — a review answers only in threads it opened`;
        if (String(c?.user?.login ?? "").toLowerCase() !== me) return `comment ${s.replyTo} opens a colleague's thread — a review answers only in yours`;
      }
    }
  }
  return null;
}

/**
 * Posts a run's plan: every write in order, the count of those that landed
 * kept on disk after each one. Called again after a failure, it starts at the
 * first write that didn't land; called on a plan that is all posted, it posts
 * nothing.
 */
export async function publishPlan(
  runDir: string,
  prUrl: string,
  ctx: PublishContext,
  targets: PlanTargets,
  gh: GhRunner = runGh,
  /** The fingerprint of the plan you were shown; a plan that differs posts nothing. */
  shownHash?: string,
): Promise<PublishOutcome> {
  // Read once: what is checked against what you saw is exactly what goes out.
  const text = readPlanText(runDir);
  if (shownHash !== undefined && planHash(text) !== shownHash) {
    return { ok: false, changed: true, error: "it changed since you saw it", posted: readDone(runDir), total: 0 };
  }
  const steps = readPlanLines(text);
  const requests = planRequests(steps, ctx);
  let done = Math.min(readDone(runDir), requests.length);
  // Nothing goes out unless every thread and comment the rest of the plan
  // touches is this PR's — and, for a review, yours.
  const stray = await checkPlanTargets(postedSteps(steps, ctx).slice(done), prUrl, ctx.repo, ctx.number, targets, gh);
  if (stray) return { ok: false, error: stray, posted: done, total: requests.length };
  for (let i = done; i < requests.length; i++) {
    const req = requests[i];
    const r = await gh(ghApiArgs(req, prUrl), { input: JSON.stringify(req.body) });
    if (r.code !== 0) return { ok: false, error: `${req.label}: ${ghError(r)}`, posted: done, total: requests.length };
    done = i + 1;
    fs.writeFileSync(path.join(runDir, PROGRESS_FILE), JSON.stringify({ done }));
  }
  return { ok: true, posted: done, total: requests.length };
}
