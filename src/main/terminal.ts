/**
 * Opens terminal windows — the one place the app starts them, for the Claude
 * launcher and the `twg login` sign-in alike.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";

import { ITERM_BUNDLE_ID, launcherEnv, terminalScript } from "../shared/claude-launch";
import type { ClaudeTerminal } from "../shared/types";

type LauncherEnv = Record<string, string | undefined>;

function run(cmd: string, args: string[], env: LauncherEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, env }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Whether iTerm2 is installed — asked of Launch Services, so any install location counts. */
function hasITerm(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile("mdfind", [`kMDItemCFBundleIdentifier == '${ITERM_BUNDLE_ID}'`], { timeout: 5_000 }, (err, out) =>
      resolve(!err && out.trim().length > 0),
    );
  }).then((found) => {
    if (found) return true;
    try {
      return fs.statSync("/Applications/iTerm.app").isDirectory();
    } catch {
      return false;
    }
  });
}

/** What a new terminal window runs, spelled for each platform's launcher. */
export interface TerminalCommand {
  /** The command line a macOS terminal's login shell runs. */
  posix: string;
  /**
   * The arguments after `cmd /c start ""` on Windows, passed verbatim (quote
   * any that need it) — e.g. `["/D", "\"C:\\dir\"", "cmd", "/k", "claude"]`.
   */
  windows: string[];
}

/**
 * Opens a new terminal window running `command`. On macOS `terminal` picks the
 * app (`auto`: iTerm2 when installed, else Terminal); Windows always uses a
 * `cmd` window.
 */
export async function openTerminalWith(
  command: TerminalCommand,
  opts: { terminal?: Exclude<ClaudeTerminal, "desktop">; env?: LauncherEnv; unsupported?: string } = {},
): Promise<void> {
  const env = opts.env ?? launcherEnv(process.env);
  const terminal = opts.terminal ?? "auto";
  if (process.platform === "darwin") {
    const app = terminal === "auto" ? ((await hasITerm()) ? "iterm" : "terminal") : terminal;
    const lines = terminalScript(app, command.posix);
    await run("osascript", lines.flatMap((l) => ["-e", l]), env);
    return;
  }
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", '""', ...command.windows], {
      detached: true,
      stdio: "ignore",
      env,
      windowsVerbatimArguments: true,
    });
    child.unref();
    return;
  }
  throw new Error(opts.unsupported ?? "Opening a terminal is supported on macOS and Windows only.");
}
