/**
 * Runs the Atlassian `twg` CLI — the primary Jira source — and starts its
 * interactive sign-in. What the runs mean (arguments, output, failures) lives in
 * the pure `shared/jira-twg.ts`; this module only owns the processes. The
 * sign-in terminal is opened through `openTerminalWith` in `terminal.ts`, the
 * app's one terminal launcher.
 */
import { execFile } from "node:child_process";

import { twgStatusFrom, twgWhoamiArgs, type TwgRunResult } from "../shared/jira-twg";
import { launcherEnv } from "../shared/claude-launch";
import type { TwgStatus } from "../shared/types";
import { openTerminalWith } from "./terminal";

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
  return twgStatusFrom(await runTwg(twgWhoamiArgs(), TWG_STATUS_TIMEOUT_MS));
}

const LOGIN_COMMAND = "twg login --force";

/**
 * Opens a terminal window running `twg login --force`. The sign-in asks which
 * site to use and finishes in the browser, so it needs a terminal the user can
 * type into; the app picks the result up on its next poll.
 */
export function openTwgLogin(): Promise<void> {
  return openTerminalWith(
    { posix: LOGIN_COMMAND, windows: ["cmd", "/k", LOGIN_COMMAND] },
    { env: launcherEnv(twgEnv()), unsupported: `Run \`${LOGIN_COMMAND}\` in a terminal to sign in.` },
  );
}
