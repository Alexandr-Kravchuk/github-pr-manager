// The agent's PreToolUse hook, run by Claude Code before every tool call of an
// agent session: `<electron or node> hook.js <run kind>`, the tool call as JSON
// on stdin (Claude Code's hook protocol). Exit 2 blocks the call and tells the
// model why on stderr; exit 0 lets the permission rules decide as usual. The
// decision itself is `checkToolUse` — pure, and tested on its own.
//
// Started by the app with ELECTRON_RUN_AS_NODE=1 (so the app's own binary runs
// it as plain Node) and kept free of Electron imports for the same reason.

import { checkToolUse, isAgentRunKind } from "../../shared/agent-guard";

function main(): void {
  const kind = process.argv[2];
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    if (!isAgentRunKind(kind)) {
      process.stderr.write("PR agent guard: unknown run kind — refusing every tool call.\n");
      process.exit(2);
    }
    let call: { tool_name?: unknown; tool_input?: unknown };
    try {
      call = JSON.parse(input) as typeof call;
    } catch {
      process.stderr.write("PR agent guard: unreadable tool call.\n");
      process.exit(2);
    }
    const decision = checkToolUse(kind, typeof call.tool_name === "string" ? call.tool_name : "", call.tool_input);
    if (!decision.allow) {
      process.stderr.write(`PR agent guard: ${decision.reason}\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}

main();
