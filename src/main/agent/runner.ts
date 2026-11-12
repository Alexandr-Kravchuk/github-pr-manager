import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyStreamEvent, initialProgress, parseStreamLine, type RunProgress } from "../../shared/agent-stream";
import { launcherEnv } from "../../shared/claude-launch";
import type { GuardRun } from "../../shared/agent-guard";
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
// A drive on your own PR may run with full context instead (`isolation:
// "full"`, Settings › Agent): none of the isolation above, your whole Claude
// setup, with the guard hook refusing writes to GitHub and `sessionGitEnv`
// keeping the push to the app.
// A hint is a user message on stdin, pause is an `interrupt` control request
// (the process stays alive), resume is another user message.

export interface RunSpec {
  cwd: string;
  sessionId: string;
  /** Continue `sessionId` (`--resume`) — a run the app's closing interrupted — rather than start it. */
  resume?: boolean;
  kind: AgentRunKind;
  /**
   * "restricted" (the default): isolated from your Claude setup, as above.
   * "full": a drive on your own PR — your settings, CLAUDE.md, hooks, plugins
   * and MCP servers load as in your own sessions; only the app's guard hook
   * (writes to GitHub) and the push block in `env` stay.
   */
  isolation?: "restricted" | "full";
  prompt: string;
  appendSystemPrompt: string;
  allowedTools: string[];
  pluginDirs: string[];
  model: string;
  effort: string;
  /** The per-run settings file with the guard hook (see `writeRunSettings`). */
  settingsFile: string;
  timeoutMs: number;
  /**
   * More folders the session's file tools may use (`--add-dir`): a review's
   * payload folder, and the plugins' own folders — a skill's Workflow reads its
   * bundled script from there, and `--restricted` confines file access to the
   * working folders.
   */
  addDirs?: string[];
  /** More environment for the session (a drive run's push block). */
  env?: Record<string, string>;
}

/**
 * Git config every session's git takes over the repository's — the
 * `GIT_CONFIG_*` variables win over every config file, and every git process
 * the session starts reads them, Claude Code's own `git status` included.
 *
 * Every session: no hooks — core.hooksPath at a fresh empty folder the app
 * made in the run's own folder, where the session can't write — and no
 * fsmonitor. A relative hooksPath (husky's `.husky/_`) resolves inside the
 * worktree, so without this a drive's `git commit` (pre-commit, commit-msg)
 * or any index write (post-index-change) would run scripts from the PR's
 * branch with your environment and gh's token.
 *
 * A drive also has no network and no credentials: every remote URL — fetch
 * and push, `url` and an explicit `pushurl` alike — is rewritten
 * (`insteadOf`) to a scheme git has no helper for; the credential helpers are
 * reset, SSH and the askpass programs point nowhere. The app fetches the base
 * branch before the session and pushes after it. Defence in depth, not the
 * boundary: the guard refuses `git push`, and a drive runs no code of yours
 * unless you add test commands in Settings.
 */
const NO_NET = ["https://", "http://", "git@", "ssh://", "git://"];
export function sessionGitEnv(hooksDir: string, drive: boolean): Record<string, string> {
  const config: Array<[string, string]> = [
    ["core.hooksPath", hooksDir],
    ["core.fsmonitor", "false"],
    ...(drive
      ? [
          ...NO_NET.map((prefix): [string, string] => ["url.pr-agent-no-push://.insteadOf", prefix]),
          // An empty value resets the helper list: no stored credential is handed out.
          ["credential.helper", ""] as [string, string],
        ]
      : []),
  ];
  return {
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
    ...(drive
      ? {
          GIT_SSH_COMMAND: "pr-agent-no-ssh",
          GIT_ASKPASS: "pr-agent-no-askpass",
          SSH_ASKPASS: "pr-agent-no-askpass",
          GCM_INTERACTIVE: "never",
        }
      : {}),
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The run's empty hooks folder for `sessionGitEnv`: made afresh, so nothing can have been put there in advance. */
export function freshHooksDir(runDir: string): string {
  const dir = path.join(runDir, "no-hooks");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length > 0) throw new Error("the empty hooks folder wasn't empty");
  return dir;
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
  const full = spec.isolation === "full";
  return [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    spec.resume ? "--resume" : "--session-id",
    spec.sessionId,
    ...(full ? [] : ["--restricted", "--strict-mcp-config"]),
    "--permission-prompts",
    "none",
    "--settings",
    spec.settingsFile,
    "--append-system-prompt",
    spec.appendSystemPrompt,
    ...spec.pluginDirs.flatMap((d) => ["--plugin-dir", d]),
    ...(spec.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    ...(spec.model ? ["--model", spec.model] : []),
    ...(spec.effort ? ["--effort", spec.effort] : []),
    // Full context keeps every built-in tool; its rules only add to yours.
    ...(full ? [] : ["--tools", builtInTools(spec.allowedTools).join(",")]),
    // Last: it takes every argument after it.
    "--allowedTools",
    ...spec.allowedTools,
  ];
}

/**
 * The command line Claude Code runs as the guard hook: the run kind and the PR
 * it works on, whose gh reads the guard holds it to. Forward slashes: hooks run
 * through a shell. The URL is the PR's own (`https://host/owner/name/pull/N`),
 * so it carries no quote.
 */
export function hookCommand(execPath: string, hookScript: string, kind: AgentRunKind, prUrl: string, guardFile?: string): string {
  const q = (p: string) => `"${p.replace(/\\/g, "/").replace(/"/g, "")}"`;
  return `${q(execPath)} ${q(hookScript)} ${kind} ${q(prUrl)}${guardFile ? ` ${q(guardFile)}` : ""}`;
}

/**
 * Where Claude Code files what a session spills over, by project and session
 * id (`<root>/<project>/<sessionId>/…`), for the guard's `sessionRoots`:
 * `projects` in its config folder holds a tool result too long to show, its
 * temp folder's `claude` a background task's output — a Workflow's, say. The
 * temp folder is `CLAUDE_CODE_TMPDIR` when the session's environment has one
 * (`launcherEnv` drops it), else the system's; off Windows `/tmp` too, since
 * Claude Code may not take `$TMPDIR` there. A root that doesn't exist only
 * means nothing is read from it.
 */
export function claudeSessionRoots(env: Record<string, string | undefined>, platform: string = process.platform): string[] {
  const config = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  const tmp = env.CLAUDE_CODE_TMPDIR?.trim();
  const temps = tmp ? [tmp] : platform === "win32" ? [env.TEMP?.trim() || env.TMP?.trim() || os.tmpdir()] : [os.tmpdir(), "/tmp"];
  return [...new Set([path.join(config, "projects"), ...temps.map((t) => path.join(t, "claude"))])];
}

/**
 * The run's guard file, next to its settings file (outside every folder the
 * session may write): what the guard lets it reach — see `GuardRun`.
 */
export function writeGuardFile(file: string, run: GuardRun): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
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
  /** The signal that ended the process (macOS, Linux); null when it exited. */
  signal?: NodeJS.Signals | null;
  timedOut: boolean;
  stopped: boolean;
  stderr: string;
}

/**
 * Windows' exit status for a console process ended by Ctrl+C, by its console
 * closing, or by the user's session ending — shutdown, restart, sign-out.
 */
export const STATUS_CONTROL_C_EXIT = 0xc000013a;
const CUT_SIGNALS: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL"]);

/**
 * Why a run's process ended before its session finished, or null when the
 * session finished — or failed by itself, which stays a failure. A session
 * finishes with a result while no background task runs: a result while one
 * runs is the turn that launched a skill's Workflow ("I'll report once it
 * completes"), not the run's answer, and taking it for one turned a review cut
 * short by a Windows restart into "Reviewed — nothing to post". The app's own
 * Stop and time limit are told apart before this is asked.
 */
export function cutShort(outcome: Pick<RunOutcome, "progress" | "exitCode" | "signal">): string | null {
  const { result, backgroundTasks } = outcome.progress;
  if (result && result.subtype !== "error_during_execution" && backgroundTasks === 0) return null;
  if (outcome.exitCode === STATUS_CONTROL_C_EXIT) return "its process was ended (Ctrl+C, or Windows shutting down or signing out)";
  if (outcome.signal && CUT_SIGNALS.has(outcome.signal)) return `its process was ended (${outcome.signal})`;
  if (backgroundTasks > 0) return "its process ended while its workflow was still running";
  return null;
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
    ...spec.env,
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
      // the session goes on: only a finished turn closes stdin — and not while
      // a background workflow runs, whose notification starts another turn
      // (Claude Code runs it either way; stdin stays open so hints still land).
      if (progress.result && progress.result !== before.result && progress.result.subtype !== "error_during_execution" && progress.backgroundTasks === 0) {
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
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null = null) => {
      clearTimeout(timer);
      stdinOpen = false;
      resolve({ progress, exitCode, signal, timedOut, stopped, stderr });
    };
    child.on("error", (e) => {
      stderr += `\n${(e as Error).message}`;
      finish(null);
    });
    child.on("exit", (code, signal) => finish(code, signal));
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
