import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ITERM_BUNDLE_ID,
  claudeDesktopUrl,
  launcherEnv,
  normalizeRemote,
  claudeKindsFor,
  pickClaudeLaunch,
  type ClaudeLaunchKind,
  posixLaunchCommand,
  prRemoteKey,
  renderClaudePrompt,
  groupLaunchPrs,
  renderGroupPrompt,
  type GroupLaunchKind,
  terminalScript,
} from "../shared/claude-launch";
import type {
  ClaudeGroupLaunchResult,
  ClaudeLaunchResult,
  ClaudeSettings,
  ClaudeTerminal,
  PullRequest,
} from "../shared/types";

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
  return parseRemoteUrls(text);
}

/** The `url` of every `[remote "…"]` section in a git config file's text. */
export function parseRemoteUrls(text: string): string[] {
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
 * Starts `claude <prompt>` in `dir` where Settings say: Claude Desktop through
 * `openUrl`, else a terminal. Returns the error to show, or null once started.
 */
async function startSession(
  dir: string,
  prompt: string,
  settings: ClaudeSettings,
  openUrl: (url: string) => Promise<void>,
): Promise<string | null> {
  if (settings.terminal === "desktop") {
    try {
      await openUrl(claudeDesktopUrl(dir, prompt));
    } catch (e) {
      return `Could not open Claude Desktop (is it installed?): ${(e as Error).message}`;
    }
    return null;
  }
  try {
    await openTerminal(dir, prompt, settings.terminal);
  } catch (e) {
    return `Could not open a terminal: ${(e as Error).message}`;
  }
  return null;
}

/**
 * Picks the prompt for the PR's state, finds its checkout and opens the
 * terminal — or Claude Desktop, through `openUrl` (Electron's
 * `shell.openExternal`, injected so this module stays Electron-free).
 */
export async function launchClaude(
  pr: PullRequest,
  settings: ClaudeSettings,
  opts: {
    trackComments: boolean;
    openUrl: (url: string) => Promise<void>;
    /** Picked from the button's menu; without it the PR's state picks. */
    kind?: ClaudeLaunchKind;
  },
): Promise<ClaudeLaunchResult> {
  if (!settings.enabled) return { ok: false, error: "Claude integration is off — turn it on in Settings." };
  if (opts.kind && !claudeKindsFor(pr).includes(opts.kind)) {
    return { ok: false, error: "Only the PR's author can close it." };
  }
  const dir = findCheckout(pr, settings);
  if (!dir) {
    const where = settings.repoPaths[pr.repo]
      ? `the folder set for it in Settings (${settings.repoPaths[pr.repo]}) does not exist`
      : `no checkout of it was found in ${settings.projectsRoot || "~/Projects"}`;
    return { ok: false, error: `${pr.repo}: ${where}. Set its folder in Settings → Claude.` };
  }
  const kind = opts.kind ?? pickClaudeLaunch(pr, opts);
  const prompt = renderClaudePrompt(settings.prompts, kind, pr);
  const error = await startSession(dir, prompt, settings, opts.openUrl);
  return error ? { ok: false, error } : { ok: true, kind, dir };
}

/**
 * The folder an overview of `prs` runs in: a checkout of the repository most
 * of them belong to (the first one listed on a tie), or of the next one when
 * that one has no checkout. The session reads every PR through `gh` anyway;
 * the folder only gives it the code most of them change.
 */
export function overviewCheckout(
  prs: readonly Pick<PullRequest, "url" | "repo">[],
  settings: Pick<ClaudeSettings, "projectsRoot" | "repoPaths">,
): string | null {
  const byRepo = new Map<string, { pr: Pick<PullRequest, "url" | "repo">; count: number }>();
  for (const pr of prs) {
    const key = prRemoteKey(pr) ?? pr.repo;
    const entry = byRepo.get(key);
    if (entry) entry.count += 1;
    else byRepo.set(key, { pr, count: 1 });
  }
  // A stable sort keeps first-listed order among equal counts.
  for (const { pr } of [...byRepo.values()].sort((a, b) => b.count - a.count)) {
    const dir = findCheckout(pr, settings);
    if (dir) return dir;
  }
  return null;
}

/**
 * A group heading's launch, in the folder `overviewCheckout` picks: "Explain
 * all" or "Review all". The PRs are picked again here by `groupLaunchPrs` from
 * main's own copies, so "Review all" can never be handed your own PR or one
 * nobody asked you to review, whatever the renderer sent; it also needs
 * Claude Desktop, the only place a session can start nested sessions.
 */
export async function launchGroup(
  kind: GroupLaunchKind,
  key: string,
  candidates: readonly PullRequest[],
  settings: ClaudeSettings,
  opts: { openUrl: (url: string) => Promise<void> },
): Promise<ClaudeGroupLaunchResult> {
  if (!settings.enabled) return { ok: false, error: "Claude integration is off — turn it on in Settings." };
  if (kind === "review" && settings.terminal !== "desktop") {
    return {
      ok: false,
      error: "Review all starts nested sessions, which only Claude Desktop can do. Choose Claude Desktop in Settings → Claude.",
    };
  }
  const prs = groupLaunchPrs(kind, key, candidates);
  if (!prs) {
    return {
      ok: false,
      error:
        kind === "explain"
          ? "Fewer than two of these PRs are still open on the dashboard."
          : "None of these PRs waits for your review any more.",
    };
  }
  const dir = overviewCheckout(prs, settings);
  if (!dir) {
    const repos = [...new Set(prs.map((p) => p.repo))].join(", ");
    return {
      ok: false,
      error: `No checkout of ${repos} was found in ${settings.projectsRoot || "~/Projects"}. Set its folder in Settings → Claude.`,
    };
  }
  // A review runs in its own PR's checkout when that is not the parent's
  // folder; with no checkout found it stays in the parent's.
  const folders =
    kind === "review"
      ? prs.map((pr) => {
          const own = findCheckout(pr, settings);
          return own && own !== dir ? own : null;
        })
      : [];
  const prompt = renderGroupPrompt(settings.prompts, kind, key, prs, folders);
  const error = await startSession(dir, prompt, settings, opts.openUrl);
  return error ? { ok: false, error } : { ok: true, count: prs.length, dir };
}
