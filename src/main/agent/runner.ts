import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { applyStreamEvent, initialProgress, parseStreamLine, type RunProgress } from "../../shared/agent-stream";
import { launcherEnv } from "../../shared/claude-launch";
import type { AgentRunKind } from "../../shared/types";

// One agent session: `claude -p` with stream-json both ways, isolated from the
// PR's repository and from your own Claude settings (spike, 2026-11-05):
//   --restricted         no user/project/local settings, hooks or CLAUDE.md; no
//                        code-running tools unless named; file tools confined to
//                        the worktree;
//   --strict-mcp-config  no MCP servers but the ones given (none, for now);
//   --plugin-dir         only the plugins the prompt's skills come from;
//   --settings           the app's own file, carrying only the guard hook;
//   --permission-prompts none — anything the rules don't allow is refused, not asked.
// A hint is a user message on stdin, pause is an `interrupt` control request
// (the process stays alive), resume is another user message.

export interface RunSpec {
  cwd: string;
  sessionId: string;
  kind: AgentRunKind;
  prompt: string;
  appendSystemPrompt: string;
  allowedTools: string[];
  pluginDirs: string[];
  model: string;
  effort: string;
  /** The per-run settings file with the guard hook (see `writeRunSettings`). */
  settingsFile: string;
  timeoutMs: number;
}

/** Built-in tool names for `--tools`, from the `--allowedTools` rules ("Bash(gh pr view *)" → "Bash"). */
export function builtInTools(allowedTools: readonly string[]): string[] {
  const names = new Set<string>();
  for (const rule of allowedTools) {
    const name = rule.split("(")[0].trim();
    if (name && !name.startsWith("mcp__")) names.add(name);
  }
  return [...names];
}

export function buildClaudeArgs(spec: RunSpec): string[] {
  return [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--session-id",
    spec.sessionId,
    "--restricted",
    "--strict-mcp-config",
    "--permission-prompts",
    "none",
    "--settings",
    spec.settingsFile,
    "--append-system-prompt",
    spec.appendSystemPrompt,
    ...spec.pluginDirs.flatMap((d) => ["--plugin-dir", d]),
    ...(spec.model ? ["--model", spec.model] : []),
    ...(spec.effort ? ["--effort", spec.effort] : []),
    "--tools",
    builtInTools(spec.allowedTools).join(","),
    // Last: it takes every argument after it.
    "--allowedTools",
    ...spec.allowedTools,
  ];
}

/** The command line Claude Code runs as the guard hook. Forward slashes: hooks run through a shell. */
export function hookCommand(execPath: string, hookScript: string, kind: AgentRunKind): string {
  const q = (p: string) => `"${p.replace(/\\/g, "/")}"`;
  return `${q(execPath)} ${q(hookScript)} ${kind}`;
}

/** Writes the per-run settings file: nothing but the guard on every tool call. */
export function writeRunSettings(file: string, command: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }] } };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

/** A stream-json user message. */
export function userMessage(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

let controlSeq = 0;
export function interruptRequest(): string {
  controlSeq += 1;
  return `${JSON.stringify({ type: "control_request", request_id: `prd-${controlSeq}`, request: { subtype: "interrupt" } })}\n`;
}

export interface RunOutcome {
  progress: RunProgress;
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  stderr: string;
}

export interface RunHandle {
  progress(): RunProgress;
  hint(text: string): void;
  interrupt(): void;
  resume(text?: string): void;
  stop(): void;
  done: Promise<RunOutcome>;
}

export type Spawner = (args: string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;

export const spawnClaude: Spawner = (args, cwd, env) => spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

/**
 * Starts a session and folds its events into progress. The prompt goes in as
 * the first user message; stdin stays open for hints and is closed once the
 * session reports its result, which ends the process.
 */
export function startRun(spec: RunSpec, onProgress: (p: RunProgress) => void, spawner: Spawner = spawnClaude): RunHandle {
  const env: NodeJS.ProcessEnv = {
    ...launcherEnv(process.env),
    // The guard hook is the app's own binary running as Node.
    ELECTRON_RUN_AS_NODE: "1",
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
  };
  const child = spawner(buildClaudeArgs(spec), spec.cwd, env);
  let progress = initialProgress();
  let stderr = "";
  let buf = "";
  let timedOut = false;
  let stopped = false;
  let stdinOpen = true;

  const write = (text: string) => {
    if (stdinOpen && child.stdin && !child.stdin.destroyed) child.stdin.write(text);
  };
  const closeStdin = () => {
    if (stdinOpen) {
      stdinOpen = false;
      child.stdin?.end();
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const ev = parseStreamLine(line);
      if (ev === null) continue;
      const before = progress;
      progress = applyStreamEvent(progress, ev);
      if (progress !== before) onProgress(progress);
      // An interrupted turn also ends in a result (error_during_execution), but
      // the session goes on: only a finished turn closes stdin.
      if (progress.result && progress.result !== before.result && progress.result.subtype !== "error_during_execution") {
        closeStdin();
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_000);
  });

  // Not unref'd: the time limit is a real deadline, and while a run is alive
  // there is a process to wait for anyway.
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, spec.timeoutMs);

  const done = new Promise<RunOutcome>((resolve) => {
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      stdinOpen = false;
      resolve({ progress, exitCode, timedOut, stopped, stderr });
    };
    child.on("error", (e) => {
      stderr += `\n${(e as Error).message}`;
      finish(null);
    });
    child.on("exit", (code) => finish(code));
  });

  write(userMessage(spec.prompt));

  return {
    progress: () => progress,
    hint: (text) => write(userMessage(`A note from the user while you work: ${text}`)),
    interrupt: () => write(interruptRequest()),
    resume: (text = "Continue where you stopped.") => write(userMessage(text)),
    stop: () => {
      stopped = true;
      closeStdin();
      child.kill();
    },
    done,
  };
}
