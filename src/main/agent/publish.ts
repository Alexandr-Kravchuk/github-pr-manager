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

import { heldLabel, isUsableWrapperPath, planRequests,postedSteps, readPlanLines, type HeldWrite, type PublishContext, type PublishRequest, type PublishStep, type PublishSub } from "../../shared/agent-publish";
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
  "query($id:ID!){ node(id:$id){ ... on PullRequestReviewThread { isResolved pullRequest { number repository { nameWithOwner } } comments(first:1){ nodes{ url author{ login } } } } } }";

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

/** `root`: a reply to a mid-thread comment of a thread you opened goes to this, its first comment. */
type StepCheck = { ok: true; root?: number } | { held: HeldWrite } | { error: string };

interface ReviewComment {
  pull_request_url?: unknown;
  html_url?: unknown;
  user?: { login?: unknown };
  in_reply_to_id?: unknown;
}

/** One review comment, checked to be on this PR. `what` names it in the refusal. */
async function readComment(id: number, what: string, prUrl: string, repo: string, number: number, gh: GhRunner): Promise<{ comment: ReviewComment } | { error: string }> {
  const r = await gh(["api", `repos/${repo}/pulls/comments/${id}`, ...hostFlag(prUrl)]);
  if (r.code !== 0) return { error: `couldn't check ${what}: ${ghError(r)}` };
  const c = (json(r.stdout) as ReviewComment | null) ?? {};
  const url = String(c.pull_request_url ?? "").toLowerCase();
  if (!url.endsWith(`/repos/${repo}/pulls/${number}`.toLowerCase())) return { error: `${what} is not on ${repo}#${number}` };
  return { comment: c };
}

const loginOf = (c: ReviewComment): string | null => (typeof c.user?.login === "string" ? c.user.login : null);

/**
 * One reply or resolve against GitHub: fine, held back (it lands in a thread
 * a colleague opened, and this is a review), or refused outright (another PR,
 * an unreadable target, a run that may not do it). A review's reply to a
 * comment in the middle of a thread you opened is fine too, posted to the
 * thread's first comment (`root`) — the one GitHub takes replies to.
 */
async function checkStep(s: PublishStep, prUrl: string, repo: string, number: number, targets: PlanTargets, gh: GhRunner): Promise<StepCheck> {
  const here = `${repo}#${number}`.toLowerCase();
  const me = targets.viewer?.toLowerCase() ?? null;
  if (s.kind === "resolve") {
    if (!targets.mine) return { error: `this run doesn't resolve threads (${s.threadId})` };
    if (!me) return { error: "couldn't tell whose threads these are — your login on the host is unknown" };
    const r = await gh(["api", "graphql", "--input", "-", ...hostFlag(prUrl)], { input: JSON.stringify({ query: THREAD_PR_QUERY, variables: { id: s.threadId } }) });
    if (r.code !== 0) return { error: `couldn't check thread ${s.threadId}: ${ghError(r)}` };
    type ThreadNode = {
      isResolved?: boolean;
      pullRequest?: { number?: number; repository?: { nameWithOwner?: string } };
      comments?: { nodes?: Array<{ url?: string; author?: { login?: string } | null }> };
    };
    const t = (json(r.stdout) as { data?: { node?: ThreadNode } } | null)?.data?.node;
    const pr = t?.pullRequest;
    if (!pr || `${pr.repository?.nameWithOwner ?? ""}#${pr.number}`.toLowerCase() !== here) return { error: `thread ${s.threadId} is not on ${repo}#${number}` };
    const first = t?.comments?.nodes?.[0];
    const author = first?.author?.login ?? null;
    if ((author ?? "").toLowerCase() !== me) return { held: { kind: "resolve", threadId: s.threadId, author, url: first?.url ?? null } };
    return { ok: true };
  }
  if (s.kind === "reply") {
    const read = await readComment(s.replyTo, `comment ${s.replyTo}`, prUrl, repo, number, gh);
    if ("error" in read) return read;
    if (!targets.mine) return { ok: true };
    if (!me) return { error: "couldn't tell whose threads these are — your login on the host is unknown" };
    const c = read.comment;
    const link = typeof c.html_url === "string" ? c.html_url : null;
    const held = (author: string | null): StepCheck => ({ held: { kind: "reply", replyTo: s.replyTo, body: s.body, author, url: link } });
    if (c.in_reply_to_id == null) {
      // The thread's first comment: your thread, or a colleague's.
      const author = loginOf(c);
      return (author ?? "").toLowerCase() === me ? { ok: true } : held(author);
    }
    // In the middle of a thread: GitHub names the thread's first comment in
    // `in_reply_to_id` and takes replies to that one only. A reply of yours
    // in a colleague's thread is still their thread — what counts is the root.
    const root = Number(c.in_reply_to_id);
    if (!Number.isInteger(root) || root <= 0) return held(null);
    const rootRead = await readComment(root, `comment ${root} (the thread of comment ${s.replyTo})`, prUrl, repo, number, gh);
    if ("error" in rootRead) return rootRead;
    if (rootRead.comment.in_reply_to_id != null) return held(null);
    const opener = loginOf(rootRead.comment);
    return (opener ?? "").toLowerCase() === me ? { ok: true, root } : held(opener);
  }
  return { ok: true };
}

/** "a reply in a-kravchuk's thread (https://…)" — one held write, as a person reads it. */
export function describeHeld(h: HeldWrite): string {
  const what = heldLabel(h);
  return h.url ? `${what} (${h.url})` : what;
}

/**
 * Each step's check with at most `CHECKS_AT_ONCE` in flight, in the steps'
 * order: every gh call may sit out its 60 s timeout on an unreachable host,
 * and checked one after another a plan of N replies waited N of them.
 */
const CHECKS_AT_ONCE = 4;
async function checkSteps(steps: readonly PublishStep[], check: (s: PublishStep) => Promise<StepCheck>): Promise<StepCheck[]> {
  const out: StepCheck[] = new Array<StepCheck>(steps.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < steps.length) {
      const i = next++;
      out[i] = await check(steps[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECKS_AT_ONCE, steps.length) }, worker));
  return out;
}

/**
 * What the run-end check found: the replies and resolves a review would
 * write in threads a colleague opened, and — when a target couldn't be
 * checked — why (`unchecked`). Then those targets are left to
 * `checkPlanTargets`, which refuses them at publish with the reason, so On
 * must not send the plan by itself.
 */
export interface HeldCheck {
  held: HeldWrite[];
  unchecked: string | null;
}

/**
 * The replies and resolves of a review that land in threads a colleague
 * opened. Read when the run ends, so the card shows them as held back and
 * Approve posts the rest.
 */
export async function heldWrites(
  steps: readonly PublishStep[],
  prUrl: string,
  repo: string,
  number: number,
  viewer: string | null,
  gh: GhRunner = runGh,
  /** Re-review: resolving is off in Settings — a resolve that would never go out isn't held back either. */
  allowResolve?: boolean,
): Promise<HeldCheck> {
  const writes = postedSteps(steps, { allowResolve }).filter((s) => s.kind === "reply" || s.kind === "resolve");
  const checks = await checkSteps(writes, (s) => checkStep(s, prUrl, repo, number, { viewer, mine: true }, gh));
  const held: HeldWrite[] = [];
  const errors: string[] = [];
  for (const c of checks) {
    if ("held" in c) held.push(c.held);
    else if ("error" in c && !errors.includes(c.error)) errors.push(c.error);
  }
  return { held, unchecked: errors.length > 0 ? errors.join("; ") : null };
}

/**
 * Whether every thread a plan resolves and every comment it replies to is on
 * this PR — or why not (`error`). A thread id or comment id is just a value
 * the session wrote; on its own it could name a thread on any PR your account
 * can reach. Checked against GitHub before anything is posted. Every step is
 * checked, so the answer names all that is wrong at once, not one per press
 * of Publish. `replyRoots`: the mid-thread replies that go to their thread's
 * first comment instead (`PublishContext.replyRoots`).
 */
async function checkPlan(
  steps: readonly PublishStep[],
  prUrl: string,
  repo: string,
  number: number,
  targets: PlanTargets,
  gh: GhRunner,
): Promise<{ error: string | null; replyRoots: Map<number, number> }> {
  const errors: string[] = [];
  const held: HeldWrite[] = [];
  const replyRoots = new Map<number, number>();
  const checks = await checkSteps(steps, (s) => checkStep(s, prUrl, repo, number, targets, gh));
  checks.forEach((c, i) => {
    const s = steps[i]!;
    if ("error" in c) {
      if (!errors.includes(c.error)) errors.push(c.error);
    } else if ("held" in c) held.push(c.held);
    else if (c.root !== undefined && s.kind === "reply") replyRoots.set(s.replyTo, c.root);
  });
  if (held.length > 0) {
    errors.push(
      `${held.map(describeHeld).join("; ")} — a review answers and resolves only in threads you opened. ` +
        `Use Edit in Claude to drop ${held.length === 1 ? "it" : "them"}, or answer there yourself on GitHub`,
    );
  }
  return { error: errors.length > 0 ? errors.join("; ") : null, replyRoots };
}

/** `checkPlan`'s answer alone: why the plan may not go out, or null. */
export async function checkPlanTargets(
  steps: readonly PublishStep[],
  prUrl: string,
  repo: string,
  number: number,
  targets: PlanTargets,
  gh: GhRunner = runGh,
): Promise<string | null> {
  return (await checkPlan(steps, prUrl, repo, number, targets, gh)).error;
}

const PR_THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ reviewThreads(first:100){ nodes{ id comments(first:1){ nodes{ databaseId } } } } } } }";

/** Each review thread of a PR by its first comment's id — what a dispute names, mapped to what resolve needs. */
export async function threadIdsByFirstComment(prUrl: string, repo: string, number: number, gh: GhRunner = runGh): Promise<Map<number, string>> {
  const [owner, name] = repo.split("/");
  const r = await gh(["api", "graphql", "--input", "-", ...hostFlag(prUrl)], {
    input: JSON.stringify({ query: PR_THREADS_QUERY, variables: { owner, name, number } }),
  });
  const out = new Map<number, string>();
  if (r.code !== 0) return out;
  type Threads = { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Array<{ id?: string; comments?: { nodes?: Array<{ databaseId?: number }> } }> } } } } };
  for (const t of (json(r.stdout) as Threads | null)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
    const first = t.comments?.nodes?.[0]?.databaseId;
    if (typeof first === "number" && typeof t.id === "string") out.set(first, t.id);
  }
  return out;
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
  /** Writes of your own choices (a dispute you dropped), after the plan's: checked and posted the same way. */
  extra: readonly PublishStep[] = [],
): Promise<PublishOutcome> {
  // Read once: what is checked against what you saw is exactly what goes out.
  const text = readPlanText(runDir);
  if (shownHash !== undefined && planHash(text) !== shownHash) {
    return { ok: false, changed: true, error: "it changed since you saw it", posted: readDone(runDir), total: 0 };
  }
  const steps = readPlanLines(text);
  // Your choices go after the plan's own writes, so a retry finds them at the same place.
  let requests = [...planRequests(steps, ctx), ...planRequests(extra, ctx)];
  // Everything it wrote was held back: Approve would post nothing and still mark it published.
  if (requests.length === 0 && (ctx.held?.length ?? 0) > 0) {
    return { ok: false, error: "nothing is left to post — everything it wrote is held back (a colleague's thread, or a comment in the middle of a thread). Answer there yourself, or Discard it", posted: 0, total: 0 };
  }
  let done = Math.min(readDone(runDir), requests.length);
  // Nothing goes out unless every thread and comment the rest of the plan
  // touches is this PR's — and, for a review, yours.
  const { error: stray, replyRoots } = await checkPlan([...postedSteps(steps, ctx), ...postedSteps(extra, ctx)].slice(done), prUrl, ctx.repo, ctx.number, targets, gh);
  if (stray) return { ok: false, error: stray, posted: done, total: requests.length };
  if (replyRoots.size > 0) {
    // A mid-thread reply in a thread you opened goes to the thread's first
    // comment. The same steps in the same order: only those endpoints change.
    const rooted = { ...ctx, replyRoots };
    requests = [...planRequests(steps, rooted), ...planRequests(extra, rooted)];
  }
  for (let i = done; i < requests.length; i++) {
    const req = requests[i];
    const r = await gh(ghApiArgs(req, prUrl), { input: JSON.stringify(req.body) });
    if (r.code !== 0) return { ok: false, error: `${req.label}: ${ghError(r)}`, posted: done, total: requests.length };
    done = i + 1;
    fs.writeFileSync(path.join(runDir, PROGRESS_FILE), JSON.stringify({ done }));
  }
  return { ok: true, posted: done, total: requests.length };
}
