// The agent's PreToolUse hook, run by Claude Code before every tool call of an
// agent session: `<electron or node> hook.js <run kind> <PR url> [<guard file>]`,
// the tool call as JSON on stdin (Claude Code's hook protocol). Exit 2 blocks
// the call and tells the model why on stderr; exit 0 lets the permission rules
// decide as usual. The decision itself is `checkToolUse` — pure, and tested on
// its own — plus `checkRealWrite`, which follows links on disk.
//
// Started by the app with ELECTRON_RUN_AS_NODE=1 (so the app's own binary runs
// it as plain Node) and kept free of Electron imports for the same reason.

import fs from "node:fs";
import path from "node:path";

import {
  checkDriveWrite,
  checkToolUse,
  guardPrFromUrl,
  isAgentRunKind,
  isWriteTool,
  toolFilePath,
  type GuardDecision,
  type GuardRun,
} from "../../shared/agent-guard";
import { isInsideDir, PUBLISH_SUBS, type PublishSub } from "../../shared/agent-publish";
import type { AgentRunKind } from "../../shared/types";

/**
 * The run's guard file (written by the app next to its settings, where the
 * session can't write): a review's publish wrapper and payload folder, the
 * wrapper subcommands a drive may use, a drive's worktree, the plugin folders
 * a Workflow may run from. Missing or broken → nothing beyond reading is
 * allowed — and so is a `subs` that is there but not a list of known
 * subcommands, since a missing one means every subcommand.
 */
export function readGuardFile(file: string | undefined): GuardRun | null {
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const run: GuardRun = {};
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
      if (typeof raw.workDir !== "string" || !raw.workDir) return null;
      run.workDir = raw.workDir;
    }
    if (Array.isArray(raw.workflowDirs)) run.workflowDirs = raw.workflowDirs.filter((d): d is string => typeof d === "string" && d.length > 0);
    return run;
  } catch {
    return null;
  }
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
 * The part of a drive's write check that needs the disk: `checkDriveWrite` is
 * lexical, and a link committed in the PR's branch (`docs/x -> ../../.git`)
 * passes it while the write lands outside the worktree or in git's own folder.
 * So the path is followed to where it really is and checked again against the
 * worktree's real path; a payload file is held to the payload folder's.
 */
export function checkRealWrite(kind: AgentRunKind, toolName: string, input: unknown, run: GuardRun | null): GuardDecision {
  if (kind !== "drive" || !isWriteTool(toolName)) return { allow: true };
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

function main(): void {
  const kind = process.argv[2];
  // The PR the run works on: its gh reads are held to it.
  const prUrl = process.argv[3];
  const pr = prUrl ? guardPrFromUrl(prUrl) : null;
  const run = readGuardFile(process.argv[4]);
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    if (!isAgentRunKind(kind) || (prUrl && !pr)) {
      process.stderr.write("PR agent guard: unknown run — refusing every tool call.\n");
      process.exit(2);
    }
    let call: { tool_name?: unknown; tool_input?: unknown };
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
      decision = checkToolUse(kind, tool, call.tool_input, pr, run);
      if (decision.allow) decision = checkRealWrite(kind, tool, call.tool_input, run);
    } catch (e) {
      decision = { allow: false, reason: `the check failed (${(e as Error).message}) — refusing.` };
    }
    if (!decision.allow) {
      process.stderr.write(`PR agent guard: ${decision.reason}\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}

if (require.main === module) main();
