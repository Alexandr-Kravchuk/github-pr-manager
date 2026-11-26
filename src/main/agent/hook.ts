// The agent's PreToolUse hook, run by Claude Code before every tool call of an
// agent session: `<electron or node> hook.js <run kind> <PR url> [<guard file>]`,
// the tool call as JSON on stdin (Claude Code's hook protocol). Exit 2 blocks
// the call and tells the model why on stderr; exit 0 lets the permission rules
// decide as usual. The decision itself is `checkToolUse` — pure, and tested on
// its own, with reads followed through links on disk (`realRead`) — plus
// `checkRealWrite`, which follows a drive's writes the same way.
//
// Started by the app with ELECTRON_RUN_AS_NODE=1 (so the app's own binary runs
// it as plain Node) and kept free of Electron imports for the same reason.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  checkDriveWrite,
  checkOrchestratorUse,
  checkToolUse,
  guardPrFromUrl,
  isAgentRunKind,
  isWriteTool,
  REPEAT_LIMIT,
  repeatKey,
  repeatRefusal,
  toolFilePath,
  workflowLaunchedThisTurn,
  WORKFLOW_RUNNING_REFUSAL,
  type GuardDecision,
  type GuardRun,
  type RequestStore,
} from "../../shared/agent-guard";
import { isInsideDir, PUBLISH_SUBS, type PublishSub } from "../../shared/agent-publish";
import type { AgentRunKind } from "../../shared/types";

/**
 * The run's guard file (written by the app next to its settings, where the
 * session can't write): the folders it reads, a review's publish wrapper and
 * payload folder, the wrapper subcommands a drive may use, the run's working
 * folder, the plugin folders a Workflow may run from, the session's own
 * folders. Missing or broken → no file is read or written — and so is a `subs`
 * that is there but not a list of known subcommands, since a missing one means
 * every subcommand. A folder list keeps absolute paths only: an empty or
 * relative one would be read against the hook's own working folder.
 */
export function readGuardFile(file: string | undefined): GuardRun | null {
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const run: GuardRun = {};
    if ("mode" in raw) {
      if (raw.mode !== "full") return null;
      run.mode = "full";
    }
    const folders = (v: unknown): string[] | null =>
      Array.isArray(v) ? v.filter((d): d is string => typeof d === "string" && d.length > 0 && path.isAbsolute(d)) : null;
    if (typeof raw.wrapperPath === "string" && typeof raw.outDir === "string") {
      run.wrapperPath = raw.wrapperPath;
      run.outDir = raw.outDir;
    }
    if ("subs" in raw) {
      const known = (v: unknown): v is PublishSub => PUBLISH_SUBS.includes(v as PublishSub);
      if (!Array.isArray(raw.subs) || !raw.subs.every(known)) return null;
      run.subs = [...raw.subs];
    }
    if ("workDir" in raw) {
      if (typeof raw.workDir !== "string" || !raw.workDir || !path.isAbsolute(raw.workDir)) return null;
      run.workDir = raw.workDir;
    }
    if (Array.isArray(raw.workflowDirs)) run.workflowDirs = raw.workflowDirs.filter((d): d is string => typeof d === "string" && d.length > 0);
    // Hints only, never a decision: a malformed list just leaves the hint plain.
    if (Array.isArray(raw.allowedTools)) run.allowedTools = raw.allowedTools.filter((r): r is string => typeof r === "string" && r.length > 0);
    if ("readDirs" in raw) {
      const dirs = folders(raw.readDirs);
      if (!dirs) return null;
      run.readDirs = dirs;
    }
    // Only a plain yes: anything else is a guard file the app didn't write.
    if ("orchestrator" in raw) {
      if (typeof raw.orchestrator !== "boolean") return null;
      if (raw.orchestrator) run.orchestrator = true;
    }
    // A session id names one folder per root; anything but an id's characters could name another.
    if ("sessionId" in raw) {
      if (typeof raw.sessionId !== "string" || !/^[A-Za-z0-9-]{8,}$/.test(raw.sessionId)) return null;
      run.sessionId = raw.sessionId;
    }
    if ("sessionRoots" in raw) {
      const roots = folders(raw.sessionRoots);
      if (!roots) return null;
      run.sessionRoots = roots;
    }
    // The review preflight: every path absolute, or the whole guard file is refused.
    if ("preflight" in raw) {
      const p = raw.preflight as { helpers?: unknown; installedPlugins?: unknown; tmpDir?: unknown } | null;
      const abs = (v: unknown): v is string => typeof v === "string" && v.length > 0 && path.isAbsolute(v);
      if (!p || !Array.isArray(p.helpers) || !p.helpers.every(abs) || !abs(p.installedPlugins) || !abs(p.tmpDir)) return null;
      run.preflight = { helpers: [...p.helpers], installedPlugins: p.installedPlugins, tmpDir: p.tmpDir };
    }
    return run;
  } catch {
    return null;
  }
}

/**
 * The review preflight's requests (`RequestStore`): read as they are — a
 * request over 64 KB, or anything but a file, is not read — and each checked
 * one copied into `dir`, the `requests` folder next to the run's guard file,
 * where the session writes nothing. `node` reads that copy, so nothing the
 * session does to its own file after the check reaches the helper.
 */
export function requestStore(dir: string): RequestStore {
  return {
    read(file) {
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > 64 * 1024) return null;
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    keep(text) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const copy = path.join(dir, `${randomUUID()}.json`);
        fs.writeFileSync(copy, text, { flag: "wx", mode: 0o444 });
        return copy;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Where a write to `file` really lands: its nearest existing ancestor resolved
 * through every link and junction, the parts that don't exist yet appended.
 * Null when that can't be told — a link whose target is missing, which a
 * write would follow to create the target wherever it points.
 */
export function realTarget(file: string): string | null {
  let cur = path.resolve(file);
  const rest: string[] = [];
  for (;;) {
    let exists = true;
    try {
      fs.lstatSync(cur);
    } catch {
      exists = false;
    }
    if (exists) {
      try {
        return path.join(fs.realpathSync.native(cur), ...rest);
      } catch {
        return null;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

/**
 * Where a read really lands, for `checkToolUse`'s read check: links and
 * junctions followed (`realTarget`), so a link the PR's branch carries is
 * judged by where it leads, and Windows' short names (`VB641~1.KUV`) read the
 * same as long ones. Git Bash's `/c/…` is `C:\…` on Windows — Claude Code
 * reads it so.
 */
export function realRead(p: string): string | null {
  const drive = process.platform === "win32" ? /^\/([A-Za-z])(\/|$)/.exec(p) : null;
  return realTarget(drive ? `${drive[1].toUpperCase()}:\\${p.slice(3)}` : p);
}

/**
 * The part of a drive's write check that needs the disk: `checkDriveWrite` is
 * lexical, and a link committed in the PR's branch (`docs/x -> ../../.git`)
 * passes it while the write lands outside the worktree or in git's own folder.
 * So the path is followed to where it really is and checked again against the
 * worktree's real path; a payload file is held to the payload folder's.
 */
export function checkRealWrite(kind: AgentRunKind, toolName: string, input: unknown, run: GuardRun | null): GuardDecision {
  if (kind !== "drive" || !isWriteTool(toolName)) return { allow: true };
  // A full-context drive writes wherever you can (`checkFullToolUse`).
  if (run?.mode === "full") return { allow: true };
  const file = toolFilePath(input);
  const real = realTarget(file);
  if (!real) return { allow: false, reason: `${file} is a link to nowhere; agent runs don't write through it.` };
  const realDir = (dir: string): string | null => {
    try {
      return fs.realpathSync.native(dir);
    } catch {
      return null;
    }
  };
  if (run?.outDir && toolName === "Write" && isInsideDir(file, run.outDir)) {
    const out = realDir(run.outDir);
    return out && isInsideDir(real, out) ? { allow: true } : { allow: false, reason: `${file} leads out of the payload folder.` };
  }
  const work = run?.workDir ? realDir(run.workDir) : null;
  if (!work) return { allow: false, reason: "This run has no worktree to change." };
  const decision = checkDriveWrite(real, work);
  return decision.allow ? decision : { allow: false, reason: `${file} really is ${real}: ${decision.reason}` };
}

/**
 * Whether the orchestrating session launched a workflow in this very turn that
 * hasn't reported back (`workflowLaunchedThisTurn`), from its transcript — the
 * hook input's `transcript_path`, taken only when it is the run's own session
 * file (`<sessionId>.jsonl`), and read up to 64 MB. Anything that can't be
 * read reads as no: this check only ever refuses.
 */
export function launchedThisTurn(run: GuardRun | null, transcriptPath: unknown, promptId: unknown): boolean {
  if (!run?.sessionId || typeof transcriptPath !== "string" || typeof promptId !== "string" || !promptId) return false;
  if (!path.isAbsolute(transcriptPath) || path.basename(transcriptPath).toLowerCase() !== `${run.sessionId.toLowerCase()}.jsonl`) return false;
  try {
    const st = fs.statSync(transcriptPath);
    if (!st.isFile() || st.size > 64 * 1024 * 1024) return false;
    return workflowLaunchedThisTurn(fs.readFileSync(transcriptPath, "utf8"), promptId);
  } catch {
    return false;
  }
}

/**
 * How many times in a row `agent` has now made this call (`repeatKey`): one
 * small file per agent in the run's `repeats` folder, next to its guard file,
 * holding its last call's hash and how many times it came in a row — another
 * call starts the count over, so a re-read after something else is never held
 * against it. Written through a temporary file renamed over the old one; a
 * file that is missing, half written or not ours counts as no call yet, and a
 * folder that can't be written still answers. Best effort: the count only ever
 * stops a loop, it never allows anything.
 */
export function countInARow(dir: string, agent: string, key: string): number {
  const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
  const file = path.join(dir, hash(agent));
  const id = hash(key);
  let n = 1;
  try {
    const last = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: unknown; n?: unknown } | null;
    if (last && last.id === id && typeof last.n === "number" && Number.isInteger(last.n) && last.n > 0) n = last.n + 1;
  } catch {
    // None yet, or unreadable: a first call.
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ id, n }));
    fs.renameSync(tmp, file);
  } catch {
    // Unwritable: the call still goes through the rest of the guard.
  }
  return n;
}

function main(): void {
  const kind = process.argv[2];
  // The PR the run works on: its gh reads are held to it.
  const prUrl = process.argv[3];
  const pr = prUrl ? guardPrFromUrl(prUrl) : null;
  const guardFile = process.argv[4];
  const run = readGuardFile(guardFile);
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    if (!isAgentRunKind(kind) || (prUrl && !pr)) {
      process.stderr.write("PR agent guard: unknown run — refusing every tool call.\n");
      process.exit(2);
    }
    let call: { tool_name?: unknown; tool_input?: unknown; agent_id?: unknown; transcript_path?: unknown; prompt_id?: unknown };
    try {
      call = JSON.parse(input) as typeof call;
    } catch {
      process.stderr.write("PR agent guard: unreadable tool call.\n");
      process.exit(2);
    }
    // A guard that throws must block: Claude Code reads any exit but 2 as "carry on".
    let decision: GuardDecision;
    try {
      const tool = typeof call.tool_name === "string" ? call.tool_name : "";
      // A workflow's agents come with an id of their own; the session itself has none.
      const agent = typeof call.agent_id === "string" && call.agent_id ? call.agent_id : null;
      // The orchestrating session: nothing at all while the workflow it launched this turn runs, then only its own part.
      const orchestrating = run?.orchestrator === true && agent === null;
      if (orchestrating && launchedThisTurn(run, call.transcript_path, call.prompt_id)) {
        decision = { allow: false, reason: WORKFLOW_RUNNING_REFUSAL };
      } else {
        // Checked preflight requests are copied next to the guard file, out of the session's reach.
        const requests = requestStore(path.join(path.dirname(guardFile ?? "."), "requests"));
        decision = (orchestrating ? checkOrchestratorUse(tool, call.tool_input, run, realRead) : null) ?? checkToolUse(kind, tool, call.tool_input, pr, run, realRead, guardFile ? requests : undefined);
      }
      if (decision.allow) {
        const real = checkRealWrite(kind, tool, call.tool_input, run);
        decision = real.allow ? decision : real;
      }
      // The same read again and again — waiting for a background workflow by looking: stopped after a few in a row.
      if (decision.allow && guardFile) {
        const key = repeatKey(kind, tool, call.tool_input, agent);
        const n = key ? countInARow(path.join(path.dirname(guardFile), "repeats"), agent ?? "main", key) : 0;
        if (n > REPEAT_LIMIT) decision = { allow: false, reason: repeatRefusal(n - 1) };
      }
    } catch (e) {
      decision = { allow: false, reason: `the check failed (${(e as Error).message}) — refusing.` };
    }
    if (!decision.allow) {
      process.stderr.write(`PR agent guard: ${decision.reason}\n`);
      process.exit(2);
    }
    if (decision.command !== undefined) {
      // Claude Code runs the command the hook hands back (`updatedInput`), allowed here: the guard
      // built all of it — the listed helper and its own copy of the checked request — and the copy
      // sits outside the session's folders, where Claude Code would ask for approval nobody can give.
      const updatedInput = { ...(call.tool_input as Record<string, unknown>), command: decision.command };
      const out = { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "PR agent guard: the review preflight on its checked request", updatedInput };
      process.stdout.write(JSON.stringify({ hookSpecificOutput: out }), () => process.exit(0));
      return;
    }
    process.exit(0);
  });
}

if (require.main === module) main();
