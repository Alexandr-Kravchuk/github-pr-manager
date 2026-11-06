import { prSignal } from "./pr-filter";
import type { ClaudeSettings, PullRequest } from "./types";

// "Start a Claude session on this PR": which prompt the session opens with, and
// the shell text that starts it. Node-free like `pr-filter.ts`, because the
// renderer value-imports `pickClaudeLaunch` to say on the button's tooltip what
// a click will do. Finding the checkout and opening the terminal need the
// filesystem and live in `main/claude-launch.ts`.

/**
 * What a session is started for, picked from the PR's state:
 *  - `drive` — your PR is blocked (failing CI, conflict, behind base, open
 *    threads, an unanswered change request) — the same test as the red accent;
 *  - `review` — your review is due (requested, returned to you, re-review);
 *  - `close` — your PR is ready to merge (`canBeMerged`);
 *  - `open` — anything else: the session gets only the link.
 * `explain` is never picked from the state — it is only in the button's menu:
 * a plain-language explanation of the PR, shown in the session, no letter.
 */
export type ClaudeLaunchKind = "drive" | "review" | "close" | "explain" | "open";

/** Every kind, in the order the button's menu lists them. */
export const CLAUDE_LAUNCH_KINDS: readonly ClaudeLaunchKind[] = ["drive", "review", "close", "explain", "open"];

/**
 * The kinds the menu offers for this PR. Closing means merging, which is the
 * author's call, so `close` is offered on your own PRs only — main refuses it
 * on any other PR too.
 */
export function claudeKindsFor(pr: Pick<PullRequest, "roles">): ClaudeLaunchKind[] {
  return CLAUDE_LAUNCH_KINDS.filter((k) => k !== "close" || pr.roles.includes("author"));
}

/**
 * A prompt template's key: one per launch kind, plus `explainGroup` — the
 * group heading's "Explain all", which is not a kind of the PR button.
 */
export type ClaudePromptKey = ClaudeLaunchKind | "explainGroup";

/**
 * `{url}` is replaced with the PR's URL. The `explainGroup` template takes
 * `{key}` (the group's Jira key), `{count}` and `{urls}` (the links, space-separated).
 */
export const DEFAULT_CLAUDE_PROMPTS: Record<ClaudePromptKey, string> = {
  drive: "/drive-pr-green {url}",
  review: "/creatio-code-review {url}",
  close: "/drive-pr-close {url}",
  explain: "/usercustom-dev:pr-first-look {url} — show the explanation here in the session; do not send a letter",
  open: "{url}",
  explainGroup:
    "Explain together the {count} open pull requests of {key}, so I get the big picture without reading each one: {urls} — " +
    "read the Jira issue {key}, then each PR (one subagent per PR, so the diffs stay out of this context), and give: " +
    "the goal they serve together, how the changes fit into one design, the order to read them in (a stack bottom-up), " +
    "where they overlap or repeat each other, and which one to review first. " +
    "Show the result here in the session; do not send a letter and post nothing on the PRs.",
};

/**
 * Starts every "Explain all" prompt, whatever the template says:
 * `[PR Dashboard overview of ENG-1]`. The session scanner reads it two ways:
 * the session is the overview of that key — the group heading's button shows
 * it and switches to it — and it holds none of the PRs it lists, since an
 * overview works on none of them and counting it would hand each of those
 * cards' Claude button to the overview.
 */
export function groupExplainMarker(key: string): string {
  return `[PR Dashboard overview of ${key}]`;
}

/** The Jira key in a prompt's `groupExplainMarker`, or null when the prompt has none. */
export function groupExplainKeyOf(text: string): string | null {
  return /\[PR Dashboard overview of ([A-Z][A-Z0-9_]{0,19}-\d{1,9})\]/.exec(text)?.[1] ?? null;
}

/**
 * At most this many PRs go into one overview: past it the overview stops
 * being high-level, and cmd.exe caps a command line at 8191 characters.
 */
export const MAX_GROUP_EXPLAIN_PRS = 30;

/** The "Explain all" prompt: the template filled in, behind the marker. */
export function renderGroupExplainPrompt(
  prompts: Partial<Record<ClaudePromptKey, string>>,
  key: string,
  prs: readonly Pick<PullRequest, "url">[],
): string {
  const template = prompts.explainGroup?.trim() || DEFAULT_CLAUDE_PROMPTS.explainGroup;
  const filled = template
    .split("{key}")
    .join(key)
    .split("{count}")
    .join(String(prs.length))
    .split("{urls}")
    .join(prs.map((p) => p.url).join(" "));
  return `${groupExplainMarker(key)} ${filled}`;
}

/** A Jira issue key — the only group key "Explain all" accepts, since it reaches the shell. */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;

/**
 * The PRs "Explain all" takes from a group, or null when the heading offers
 * none: only a Jira-key group (by issue or by parent task — the "Other" bucket
 * and a repository have no task to explain), drafts left out since nobody is
 * reviewing them yet, at least two left — one PR has its own Explain — and the
 * first `MAX_GROUP_EXPLAIN_PRS` of them in the order shown.
 */
export function groupExplainPrs<T extends Pick<PullRequest, "isDraft">>(key: string, prs: readonly T[]): T[] | null {
  if (!JIRA_KEY_RE.test(key)) return null;
  const open = prs.filter((p) => !p.isDraft);
  return open.length >= 2 ? open.slice(0, MAX_GROUP_EXPLAIN_PRS) : null;
}

/** The integration is opt-in: nothing on the cards until it is switched on. */
export const DEFAULT_CLAUDE_SETTINGS: ClaudeSettings = {
  enabled: false,
  projectsRoot: "",
  repoPaths: {},
  prompts: { ...DEFAULT_CLAUDE_PROMPTS },
  terminal: "auto",
};

export const CLAUDE_LAUNCH_LABEL: Record<ClaudeLaunchKind, string> = {
  drive: "drive it to green",
  review: "review it",
  close: "close it",
  explain: "explain what it does",
  open: "open it",
};

/** What the button itself says — the action, so a click is never a surprise. */
export const CLAUDE_BUTTON_TEXT: Record<ClaudeLaunchKind, string> = {
  drive: "Drive to green",
  review: "Review",
  close: "Close PR",
  explain: "Explain",
  open: "Open session",
};

type LaunchPr = Parameters<typeof prSignal>[0] & Pick<PullRequest, "canBeMerged">;

export function pickClaudeLaunch(pr: LaunchPr, opts: { trackComments: boolean }): ClaudeLaunchKind {
  const signal = prSignal(pr, opts);
  if (signal === "blocked") return "drive";
  if (signal === "myReview") return "review";
  if (pr.roles.includes("author") && pr.canBeMerged) return "close";
  return "open";
}

/** The template for `kind` with `{url}` filled in; an empty template falls back to the default. */
export function renderClaudePrompt(
  prompts: Partial<Record<ClaudePromptKey, string>>,
  kind: ClaudeLaunchKind,
  pr: Pick<PullRequest, "url">,
): string {
  const template = prompts[kind]?.trim() || DEFAULT_CLAUDE_PROMPTS[kind];
  return template.split("{url}").join(pr.url);
}

/** POSIX shell single-quoting: safe for any text, including quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Variables a running Claude Code session sets for the processes it starts.
 * Inherited by a new `claude`, they make it believe it is a child of that
 * session — it then turns transcript saving off ("inherited
 * CLAUDE_CODE_CHILD_SESSION marker") and talks to the parent's socket. They
 * reach the terminal when the dashboard itself was started from a Claude
 * session (`npm run dev` there), and Terminal.app, if this launch is what
 * starts it, keeps them for every later window — so they are dropped both from
 * the launcher's environment and in the command itself. A user's profile never
 * sets these, so unsetting them loses nothing.
 */
export const CLAUDE_SESSION_ENV_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
] as const;

/** The environment for the launcher process: the parent's, minus anything a Claude session put there. */
export function launcherEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("CLAUDE_AGENT_SDK_") || k === "CLAUDE_PID") {
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** The command a POSIX terminal runs: go to the checkout, start claude with the prompt. */
export function posixLaunchCommand(dir: string, prompt: string): string {
  return `unset ${CLAUDE_SESSION_ENV_MARKERS.join(" ")}; cd ${shellQuote(dir)} && claude ${shellQuote(prompt)}`;
}

/** iTerm2's bundle id — addressed by id so the app's display name ("iTerm" vs "iTerm2") doesn't matter. */
export const ITERM_BUNDLE_ID = "com.googlecode.iterm2";

/**
 * The osascript lines that run `command` in `app`. iTerm2 types the command
 * into a login shell (`write text`), so the user's profile is loaded first, the
 * same as Terminal's `do script`. Where it lands in iTerm2:
 *  - already running with a window → a new tab in the frontmost window;
 *  - running with no window → a new window;
 *  - not running → the window iTerm2 opens on launch, so no empty extra tab is
 *    left beside the session (waits up to ~5 s for it; a launch that opens no
 *    window, per the user's iTerm2 startup preference, gets a new one).
 * `running` is read before `activate`, which would start the app.
 */
export function terminalScript(app: "iterm" | "terminal", command: string): string[] {
  const cmd = appleScriptString(command);
  if (app === "iterm") {
    return [
      `tell application id "${ITERM_BUNDLE_ID}"`,
      "set wasRunning to running",
      "activate",
      "if not wasRunning then",
      "repeat 50 times",
      "if (count of windows) > 0 then exit repeat",
      "delay 0.1",
      "end repeat",
      "end if",
      "if (count of windows) = 0 then",
      "set w to (create window with default profile)",
      "else if wasRunning then",
      "set w to current window",
      "tell w to create tab with default profile",
      "else",
      "set w to current window",
      "end if",
      `tell current session of w to write text ${cmd}`,
      "end tell",
    ];
  }
  return [`tell application "Terminal"`, `do script ${cmd}`, "activate", "end tell"];
}

/**
 * Claude Desktop's documented link for a new Code session: opens the Code tab
 * in `dir` with `prompt` prefilled in the composer (not sent). Desktop treats a
 * linked folder as untrusted and confirms it on every open.
 * https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link
 */
export function claudeDesktopUrl(dir: string, prompt: string): string {
  return `claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(dir)}`;
}

/** An AppleScript string literal for `text`. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Normalizes a git remote URL (https, ssh `git@host:owner/repo`, `ssh://`) to
 * `host/owner/repo` in lower case, or null when it isn't one.
 */
export function normalizeRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2].replace(/^\/+/, "")}`.toLowerCase();
  try {
    const u = new URL(trimmed);
    const p = u.pathname.replace(/^\/+/, "");
    if (!u.hostname || !p.includes("/")) return null;
    return `${u.hostname}/${p}`.toLowerCase();
  } catch {
    return null;
  }
}

/** `host/owner/repo` of a PR, the key its checkout's remote is matched on. */
export function prRemoteKey(pr: Pick<PullRequest, "url" | "repo">): string | null {
  try {
    return `${new URL(pr.url).hostname}/${pr.repo}`.toLowerCase();
  } catch {
    return null;
  }
}
