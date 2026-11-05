// The agent's PreToolUse hook, run by Claude Code before every tool call of an
// agent session: `<electron or node> hook.js <run kind> <PR url> [<guard file>]`,
// the tool call as JSON on stdin (Claude Code's hook protocol). Exit 2 blocks
// the call and tells the model why on stderr; exit 0 lets the permission rules
// decide as usual. The decision itself is `checkToolUse` — pure, and tested on
// its own.
//
// Started by the app with ELECTRON_RUN_AS_NODE=1 (so the app's own binary runs
// it as plain Node) and kept free of Electron imports for the same reason.

import fs from "node:fs";

import { checkToolUse, guardPrFromUrl, isAgentRunKind, type GuardRun } from "../../shared/agent-guard";

/**
 * The run's guard file (written by the app next to its settings, where the
 * session can't write): a review's publish wrapper and payload folder, the
 * plugin folders a Workflow may run from. Missing or broken → nothing beyond
 * reading is allowed.
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
    if (Array.isArray(raw.workflowDirs)) run.workflowDirs = raw.workflowDirs.filter((d): d is string => typeof d === "string" && d.length > 0);
    return run;
  } catch {
    return null;
  }
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
    let decision: ReturnType<typeof checkToolUse>;
    try {
      decision = checkToolUse(kind, typeof call.tool_name === "string" ? call.tool_name : "", call.tool_input, pr, run);
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
