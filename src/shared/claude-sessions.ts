import { appleScriptString, groupExplainKeyOf, prRemoteKey } from "./claude-launch";
import type { ClaudeSessionInfo, PullRequest } from "./types";

// Which running Claude Code session works on which PR, and what the card says
// about it. Node-free like `claude-launch.ts`: the renderer value-imports
// `sessionsForPr` to match the sessions main pushes against each card. Reading
// the session registry and the transcripts lives in `main/claude-sessions.ts`.

/** A PR link: exactly `owner/repo` between the host and `/pull/N`. */
const PR_URL_RE = /https?:\/\/[^\s/"'<>()[\]]+\/[^\s/"'<>()[\]]+\/[^\s/"'<>()[\]]+\/pull\/\d+/gi;

/** `host/owner/repo/pull/N` in lower case, or null when `url` is not a PR link. */
export function prUrlKey(url: string): string | null {
  const m = /^https?:\/\/([^\s/]+)\/([^\s/]+)\/([^\s/]+)\/pull\/(\d+)/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}/${m[3]}/pull/${m[4]}`.toLowerCase() : null;
}

/** The PR keys of every PR link in `text`, `/files` and query suffixes dropped. */
export function extractPrKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(PR_URL_RE)) {
    const key = prUrlKey(m[0]);
    if (key) keys.add(key);
  }
  return [...keys];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * What one transcript line binds the session to, when the line is a prompt
 * the user sent; nothing for anything else. Tool results, skill bodies (`isMeta`), subagent
 * turns, messages from other sessions (`origin.kind` "peer") and task
 * notifications quote PR links the user never asked this session about — a
 * routine's report alone lists dozens. Transcripts written before Claude Code
 * recorded `origin` are judged by the content alone. System reminders the app
 * adds to a prompt are dropped too, for the same reason. A prompt the group
 * heading's "Explain all" started (`groupExplainMarker`) gives its Jira key
 * instead of PR keys: it lists every PR of the group but works on none of them.
 */
export function promptLinks(line: string): { prKeys: string[]; overviewKey: string | null } {
  const none = { prKeys: [], overviewKey: null };
  // Most lines are tool traffic megabytes long — skip them before parsing.
  if (!line.includes('"type":"user"') || !line.includes("/pull/")) return none;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return none;
  }
  if (!isRecord(entry) || entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) return none;
  if (isRecord(entry.origin) && entry.origin.kind !== "human") return none;
  const message = entry.message;
  if (!isRecord(message) || message.role !== "user") return none;
  const texts: string[] = [];
  if (typeof message.content === "string") {
    texts.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_result") return none;
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  const text = texts.join("\n").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  const overviewKey = groupExplainKeyOf(text);
  return overviewKey ? { prKeys: [], overviewKey } : { prKeys: extractPrKeys(text), overviewKey: null };
}

/** The PR keys one transcript line binds the session to (`promptLinks`). */
export function promptPrKeys(line: string): string[] {
  return promptLinks(line).prKeys;
}

const STATUS_RANK: Record<ClaudeSessionInfo["status"], number> = { waiting: 0, busy: 1, idle: 2, paused: 3 };

/**
 * The sessions working on `pr`, the one that most needs the user first: asked
 * a question, then working, then idle, then paused; a session with a window
 * before one without; the latest of several paused ones first. A session
 * counts when the user sent it the PR's link or Claude Desktop bound the PR to
 * it, or when its folder is a checkout of the PR's repository on the PR's head
 * branch — the last catches a session started from a Jira key that later
 * opened the PR.
 */
export function sessionsForPr(
  pr: Pick<PullRequest, "url" | "repo" | "headRefName">,
  sessions: readonly ClaudeSessionInfo[],
): ClaudeSessionInfo[] {
  const key = prUrlKey(pr.url);
  const repo = prRemoteKey(pr);
  return sessions
    .filter(
      (s) =>
        (key !== null && s.prKeys.includes(key)) ||
        (repo !== null && s.branch !== null && s.branch === pr.headRefName && s.repoKeys.includes(repo)),
    )
    .sort(bySessionNeed);
}

/** The order `sessionsForPr` and `sessionsForGroup` give: the one that most needs the user first. */
function bySessionNeed(a: ClaudeSessionInfo, b: ClaudeSessionInfo): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    Number(a.where === "background") - Number(b.where === "background") ||
    (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) ||
    a.name.localeCompare(b.name)
  );
}

/** The "Explain all" sessions of a group heading's Jira key, in `sessionsForPr`'s order. */
export function sessionsForGroup(key: string, sessions: readonly ClaudeSessionInfo[]): ClaudeSessionInfo[] {
  return sessions.filter((s) => s.overviewKeys?.includes(key)).sort(bySessionNeed);
}

/**
 * The session a PR's Claude button shows — one with a window first, since a
 * click switches to it — taken from `sessionsForPr`'s ordering.
 */
export function shownSession(sessions: readonly ClaudeSessionInfo[]): ClaudeSessionInfo | undefined {
  return sessions.find((s) => s.where !== "background") ?? sessions[0];
}

/**
 * Whether the PR's card glows, and in which colour: only while the shown
 * session works or waits for the user. Idle and paused ones leave the card plain.
 */
export function sessionGlow(session: ClaudeSessionInfo | undefined): "busy" | "waiting" | null {
  return session?.status === "busy" || session?.status === "waiting" ? session.status : null;
}

/** What the button says while a session works on the PR. */
export const SESSION_STATUS_TEXT: Record<ClaudeSessionInfo["status"], string> = {
  busy: "Working",
  waiting: "Needs you",
  idle: "Idle",
  paused: "Paused",
};

/**
 * What a group heading's button says while an "Explain all" overview runs. Not
 * the card's words: on a heading "Needs you" read as "these reviews need you",
 * and the overview's most useful state — its turn ended, the result is there
 * to read — would say only "Idle".
 */
export const OVERVIEW_STATUS_TEXT: Record<ClaudeSessionInfo["status"], string> = {
  busy: "Explaining…",
  waiting: "Overview asks you",
  idle: "Overview ready",
  paused: "Overview paused",
};

const SESSION_STATUS_PHRASE: Record<ClaudeSessionInfo["status"], string> = {
  busy: "working",
  waiting: "waiting for you",
  idle: "idle — its last turn ended",
  paused: "paused by Claude Desktop — opening it resumes it",
};

const SESSION_WHERE_TEXT: Record<ClaudeSessionInfo["where"], string> = {
  desktop: "in Claude Desktop",
  terminal: "in a terminal",
  background: "in the background, with no window to switch to",
};

/** One line on a session: its title, what it is doing and where it runs. */
export function describeSession(s: ClaudeSessionInfo): string {
  const status = s.status === "waiting" && s.waitingFor ? `waiting for you (${s.waitingFor})` : SESSION_STATUS_PHRASE[s.status];
  return `“${s.name}” — ${status}, ${SESSION_WHERE_TEXT[s.where]}`;
}

/**
 * Claude Desktop's link to an existing Code session — the `link` the app gives
 * a session "to open it from outside". Takes the Desktop's own id
 * (`local_…`, the registry's `hostSessionId`), not Claude Code's session id.
 */
export function claudeDesktopSessionUrl(hostSessionId: string): string {
  return `claude://claude.ai/epitaxy/${encodeURIComponent(hostSessionId)}`;
}

/**
 * The osascript lines that bring the terminal tab on `tty` to the front, in
 * iTerm2 (`app` "iterm") or Terminal. Each prints "ok" when it found the tab
 * and "missing" otherwise; neither starts the app when it isn't running. They
 * are separate scripts because a script naming iTerm2's terms does not
 * compile where iTerm2 isn't installed.
 *
 * The window is brought forward last: `w`, `t` and `s` are positions in the
 * `windows` list, and raising a window reorders it — selecting the tab after
 * that picked the tab at the same position in whichever window took the old
 * place, so with two windows the right window came up on the wrong tab.
 */
export function focusTtyScript(app: "iterm" | "terminal", tty: string): string[] {
  const target = appleScriptString(tty);
  if (app === "iterm") {
    return [
      `if application id "com.googlecode.iterm2" is not running then return "missing"`,
      `tell application id "com.googlecode.iterm2"`,
      "repeat with w in windows",
      "repeat with t in tabs of w",
      "repeat with s in sessions of t",
      `if tty of s is ${target} then`,
      "tell t to select",
      "tell s to select",
      "tell w to select",
      "activate",
      `return "ok"`,
      "end if",
      "end repeat",
      "end repeat",
      "end repeat",
      "end tell",
      `return "missing"`,
    ];
  }
  return [
    `if application "Terminal" is not running then return "missing"`,
    `tell application "Terminal"`,
    "repeat with w in windows",
    "repeat with t in tabs of w",
    `if tty of t is ${target} then`,
    "set miniaturized of w to false",
    "set selected tab of w to t",
    "set index of w to 1",
    "activate",
    `return "ok"`,
    "end if",
    "end repeat",
    "end repeat",
    "end tell",
    `return "missing"`,
  ];
}
