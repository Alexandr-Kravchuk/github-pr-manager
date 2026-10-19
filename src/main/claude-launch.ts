import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ITERM_BUNDLE_ID,
  claudeDesktopUrl,
  launcherEnv,
  normalizeRemote,
  pickClaudeLaunch,
  posixLaunchCommand,
  prRemoteKey,
  renderClaudePrompt,
  terminalScript,
} from "../shared/claude-launch";
import type { ClaudeLaunchResult, ClaudeSettings, ClaudeTerminal, PullRequest } from "../shared/types";

/** Expands a leading `~` to the home directory. */
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(1)) : p;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The remote URLs in a checkout's `.git/config`. Read from the file rather than
 * by spawning `git` once per folder; a linked worktree (`.git` is a file) has
 * none of its own and is skipped — its main checkout is found instead.
 */
export function readRemoteUrls(dir: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
  } catch {
    return [];
  }
  const urls: string[] = [];
  let inRemote = false;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      inRemote = /^remote\s+"/.test(section[1].trim());
      continue;
    }
    const url = inRemote ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line) : null;
    if (url) urls.push(url[1]);
  }
  return urls;
}

/**
 * The PR's local checkout: the explicit `repoPaths` entry when set, else the
 * first subfolder of the projects root whose git remote is the PR's repository
 * on the PR's host. Null when neither finds one.
 */
export function findCheckout(
  pr: Pick<PullRequest, "url" | "repo">,
  settings: Pick<ClaudeSettings, "projectsRoot" | "repoPaths">,
): string | null {
  const explicit = settings.repoPaths[pr.repo];
  if (explicit) {
    const dir = expandHome(explicit);
    return isDir(dir) ? dir : null;
  }
  const key = prRemoteKey(pr);
  if (!key) return null;
  const root = expandHome(settings.projectsRoot || "~/Projects");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (readRemoteUrls(dir).some((u) => normalizeRemote(u) === key)) return dir;
  }
  return null;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, env: launcherEnv(process.env) }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/** Whether iTerm2 is installed — asked of Launch Services, so any install location counts. */
function hasITerm(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile("mdfind", [`kMDItemCFBundleIdentifier == '${ITERM_BUNDLE_ID}'`], { timeout: 5_000 }, (err, out) =>
      resolve(!err && out.trim().length > 0),
    );
  }).then((found) => found || isDir("/Applications/iTerm.app"));
}

/** Opens a new terminal window in `dir` running `claude <prompt>`. */
async function openTerminal(
  dir: string,
  prompt: string,
  terminal: Exclude<ClaudeTerminal, "desktop">,
): Promise<void> {
  if (process.platform === "darwin") {
    const app = terminal === "auto" ? ((await hasITerm()) ? "iterm" : "terminal") : terminal;
    const lines = terminalScript(app, posixLaunchCommand(dir, prompt));
    await run("osascript", lines.flatMap((l) => ["-e", l]));
    return;
  }
  if (process.platform === "win32") {
    // cmd.exe has no quoting that survives every character, so the prompt must
    // not carry one that would end the argument early.
    if (/["%^&|<>]/.test(prompt)) {
      throw new Error(`The prompt contains a character Windows can't pass to claude: ${prompt}`);
    }
    const child = spawn("cmd.exe", ["/c", "start", '""', "/D", `"${dir}"`, "cmd", "/k", "claude", `"${prompt}"`], {
      detached: true,
      stdio: "ignore",
      env: launcherEnv(process.env),
      windowsVerbatimArguments: true,
    });
    child.unref();
    return;
  }
  throw new Error("Starting a Claude session is supported on macOS and Windows only.");
}

/**
 * Picks the prompt for the PR's state, finds its checkout and opens the
 * terminal — or Claude Desktop, through `openUrl` (Electron's
 * `shell.openExternal`, injected so this module stays Electron-free).
 */
export async function launchClaude(
  pr: PullRequest,
  settings: ClaudeSettings,
  opts: { trackComments: boolean; openUrl: (url: string) => Promise<void> },
): Promise<ClaudeLaunchResult> {
  if (!settings.enabled) return { ok: false, error: "Claude integration is off — turn it on in Settings." };
  const dir = findCheckout(pr, settings);
  if (!dir) {
    const where = settings.repoPaths[pr.repo]
      ? `the folder set for it in Settings (${settings.repoPaths[pr.repo]}) does not exist`
      : `no checkout of it was found in ${settings.projectsRoot || "~/Projects"}`;
    return { ok: false, error: `${pr.repo}: ${where}. Set its folder in Settings → Claude.` };
  }
  const kind = pickClaudeLaunch(pr, opts);
  const prompt = renderClaudePrompt(settings.prompts, kind, pr);
  if (settings.terminal === "desktop") {
    try {
      await opts.openUrl(claudeDesktopUrl(dir, prompt));
    } catch (e) {
      return { ok: false, error: `Could not open Claude Desktop (is it installed?): ${(e as Error).message}` };
    }
    return { ok: true, kind, dir };
  }
  try {
    await openTerminal(dir, prompt, settings.terminal);
  } catch (e) {
    return { ok: false, error: `Could not open a terminal: ${(e as Error).message}` };
  }
  return { ok: true, kind, dir };
}
