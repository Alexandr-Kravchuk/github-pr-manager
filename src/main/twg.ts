/**
 * Runs the Atlassian `twg` CLI — the primary Jira source — and starts its
 * interactive sign-in. What the runs mean (arguments, output, failures) lives in
 * the pure `shared/jira-twg.ts`; this module only owns the processes.
 */
import { execFile, spawn } from "node:child_process";

import { classifyTwgRun, parseTwgAccount, twgWhoamiArgs, type TwgRunResult } from "../shared/jira-twg";
import { launcherEnv, terminalScript } from "../shared/claude-launch";
import type { TwgStatus } from "../shared/types";

/**
 * A query of up to 50 keys answers in about 1.5 s; this only bounds a hung
 * process. Kept to the REST lookup's own per-request cap: the pass is awaited
 * inside the poll tick, and the token fallback only starts once twg gives up.
 */
const TWG_TIMEOUT_MS = 10_000;
/**
 * `whoami` for the Settings and grouping status runs outside the poll tick, and
 * a twg renewing its session can take several seconds longer than a lookup.
 */
const TWG_STATUS_TIMEOUT_MS = 30_000;
const TWG_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * The environment twg runs with: without `TWG_AGENT_DEFAULTS`, which switches
 * its output to the agent envelope (the arguments override it too — this is
 * belt and braces for a twg that reads the variable first).
 */
function twgEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TWG_AGENT_DEFAULTS;
  return env;
}

/** Runs `twg` with `args`. Never rejects: a missing binary is reported as `notFound`. */
export function runTwg(args: string[], timeoutMs = TWG_TIMEOUT_MS): Promise<TwgRunResult> {
  return new Promise((resolve) => {
    execFile(
      "twg",
      args,
      { timeout: timeoutMs, maxBuffer: TWG_MAX_BUFFER, windowsHide: true, env: twgEnv(), encoding: "utf8" },
      (err, stdout, stderr) => {
        // `code` is the exit status for a process that ran, an errno string
        // ("ENOENT") for one that never started, and absent on a kill (timeout).
        const errCode = (err as { code?: unknown } | null)?.code;
        if (errCode === "ENOENT") {
          resolve({ stdout: "", stderr: "", code: null, notFound: true });
          return;
        }
        const exit = !err ? 0 : typeof errCode === "number" ? errCode : null;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: exit });
      },
    );
  });
}

/** Whether twg is installed and signed in, from `twg whoami`. */
export async function getTwgStatus(): Promise<TwgStatus> {
  const run = await runTwg(twgWhoamiArgs(), TWG_STATUS_TIMEOUT_MS);
  const failure = classifyTwgRun(run);
  if (!failure) {
    const account = parseTwgAccount(run.stdout);
    return account ? { state: "signed-in", account } : { state: "signed-in" };
  }
  if (failure.kind === "not-installed") return { state: "not-installed" };
  if (failure.kind === "auth") return { state: "signed-out", message: failure.message };
  return { state: "error", message: failure.message };
}

const LOGIN_COMMAND = "twg login --force";

/**
 * Opens a terminal window running `twg login --force`. The sign-in asks which
 * site to use and finishes in the browser, so it needs a terminal the user can
 * type into; the app picks the result up on its next poll.
 */
export async function openTwgLogin(): Promise<void> {
  if (process.platform === "darwin") {
    const lines = terminalScript("terminal", LOGIN_COMMAND);
    await new Promise<void>((resolve, reject) => {
      execFile("osascript", lines.flatMap((l) => ["-e", l]), { timeout: 15_000, env: launcherEnv(twgEnv()) }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    return;
  }
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", '""', "cmd", "/k", LOGIN_COMMAND], {
      detached: true,
      stdio: "ignore",
      env: launcherEnv(twgEnv()),
      windowsVerbatimArguments: true,
    });
    child.unref();
    return;
  }
  throw new Error(`Run \`${LOGIN_COMMAND}\` in a terminal to sign in.`);
}
