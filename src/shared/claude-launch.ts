import { DEFAULT_AGENT_PROMPTS } from "./agent-defaults";
import { isReviewDue, prSignal } from "./pr-filter";
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

/** One item of the button's menu: what it starts, and whether in a terminal although Settings pick Claude Desktop. */
export interface ClaudeMenuItem {
  kind: ClaudeLaunchKind;
  inTerminal: boolean;
}

/**
 * The button's menu for this PR: every kind `claudeKindsFor` offers, plus
 * "Review in terminal" right after "Review" while Settings open sessions in
 * Claude Desktop (`desktop`). With a terminal chosen, "Review" already opens
 * one, so the extra item would repeat it.
 */
export function claudeMenuItems(pr: Pick<PullRequest, "roles">, desktop: boolean): ClaudeMenuItem[] {
  return claudeKindsFor(pr).flatMap((kind): ClaudeMenuItem[] =>
    kind === "review" && desktop
      ? [
          { kind, inTerminal: false },
          { kind, inTerminal: true },
        ]
      : [{ kind, inTerminal: false }],
  );
}

/**
 * What a group heading's Claude button starts for a Jira key:
 *  - `explain` — "Explain all": one session that explains the group's open PRs
 *    together, shown in the session;
 *  - `review` — "Review all": a parent session that starts one nested Claude
 *    Desktop session per PR awaiting your review and sums their reports up.
 *    Nesting is something only a Desktop session can do (its `start_session`
 *    tool) — a `claude://` link starts a top-level session — so it is offered
 *    only while Settings → Claude opens sessions in Claude Desktop.
 */
export type GroupLaunchKind = "explain" | "review";

export const GROUP_LAUNCH_KINDS: readonly GroupLaunchKind[] = ["explain", "review"];

/** A prompt template's key: one per PR launch kind, plus one per group launch kind. */
export type ClaudePromptKey = ClaudeLaunchKind | "explainGroup" | "reviewGroup";

/** The template a group launch kind fills in. */
export const GROUP_PROMPT_KEY: Record<GroupLaunchKind, "explainGroup" | "reviewGroup"> = {
  explain: "explainGroup",
  review: "reviewGroup",
};

/**
 * The first three of the lines "Review all" adds to every nested review prompt:
 * the user's publishing permission, quoted in their own words since a request
 * from another session is not their consent, and the rules that bound it.
 * `hold` keeps every APPROVE for the user's word in that PR's session;
 * `approve` lets a review with no Blocker and no Major approve the head commit
 * it read — only for a user who turned on Settings → Claude → "Review all may
 * approve" (`ClaudeSettings.reviewGroupApprove`), since the approval is posted
 * under their own GitHub account.
 */
export const REVIEW_GROUP_PERMISSIONS: Record<"hold" | "approve", string> = {
  hold:
    "a) Користувач сказав: «Публікуй рев'ю на PR: рядкові коментарі до Blocker і Major, підсумок одним рев'ю. " +
    "Подія — `REQUEST_CHANGES`, коли є Blocker або Major з високою впевненістю, інакше `COMMENT`. `APPROVE` не ставити.». " +
    "Публікуй рев'ю на PR за цим дозволом. " +
    "b) A Major with low confidence is a ground for REQUEST_CHANGES only once it is checked against the platform code, on a stand " +
    "or by a test; without that check, ask it as a question in the summary. " +
    "c) APPROVE only on my separate word for that PR: this permission does not cover it.",
  approve:
    "a) Користувач сказав: «Публікуй рев'ю на PR: рядкові коментарі до Blocker і Major, підсумок одним рев'ю. " +
    "Подія цього рев'ю — `REQUEST_CHANGES`, коли є Blocker або Major з високою впевненістю; `COMMENT`, коли лишився " +
    "лише Major з низькою впевненістю; `APPROVE`, коли немає ні Blocker, ні жодного Major.». " +
    "Публікуй рев'ю на PR за цим дозволом. " +
    "b) A Major with low confidence is a ground for REQUEST_CHANGES only once it is checked against the platform code, on a stand " +
    "or by a test; without that check, ask it as a question in the summary — and it still blocks the APPROVE. " +
    "c) Post the review through the reviews API (gh api …/pulls/{number}/reviews) with commit_id set to the head commit you " +
    "reviewed, and APPROVE only while that commit is still the PR's head: when the PR has a newer commit, post a COMMENT " +
    "instead and say so in your report.",
};

/**
 * `{url}` is replaced with the PR's URL. The group templates take `{key}` (the
 * group's Jira key), `{count}` and `{urls}` (the links, space-separated);
 * `reviewGroup` also takes `{prompts}` — each PR's own "Your review is due"
 * prompt, numbered, for the sessions it starts, behind the folder of that PR's
 * own checkout when it differs from the parent's (`in <folder>:`) — and
 * `{permission}`, one of `REVIEW_GROUP_PERMISSIONS` by the user's setting.
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
  reviewGroup:
    "Review the {count} pull requests of {key} that wait for my review. Do not review them here: start one session per PR " +
    "with the start_session tool (initiation user_asked, context fresh, use_worktree false), so each review runs in its own " +
    "session nested under this one. A prompt that starts with a folder (in, the folder, a colon) is that PR's own repository: start its " +
    "session there through start_session's cwd, so it reads that repository's rules and code; the others run in this folder. " +
    "Give each session its prompt word for word, and add to it these five lines, each word for word as a line of its own " +
    "and without its letter: " +
    "{permission} " +
    "d) Skip the PR when I already reviewed it after its last commit. " +
    "e) Start your report with the link to the review you published on the PR (#pullrequestreview-…) and your decision, " +
    "or with why you published none. " +
    "The prompts: {prompts}. " +
    "When every session has reported, give me one summary: for each PR the link to its review, its decision and its Blocker and Major findings, " +
    "then anything that spans several PRs — a change asked for in one PR that another already makes, a contract two PRs change differently. " +
    "Read each report whole with list_events, paging back to the session's last message, since the note on a session's turn " +
    "keeps only its first 400 characters. " +
    "A later decision on one PR — a review its session could not publish, an APPROVE — is mine to give in that PR's session: " +
    "link me to the session and leave my answer for me to type there, so each session hears it once and from me.",
};

/**
 * Defaults a template had before its current text. The Settings screen used to
 * save every prompt, defaults included, so a user who never edited one kept the
 * old default in settings.json, where it would win over the new default for
 * good. `validateClaude` reads such a saved copy as "the default"; extend the
 * list with the outgoing text whenever a default changes.
 */
export const PREVIOUS_DEFAULT_PROMPTS: Partial<Record<ClaudePromptKey, readonly string[]>> = {
  reviewGroup: [
    // The first Review all.
    "Review the {count} pull requests of {key} that wait for my review. Do not review them here: start one session per PR " +
    "with the start_session tool (initiation user_asked, context fresh, use_worktree false), so each review runs in its own " +
    "session nested under this one, with these prompts: {prompts}. " +
    "When every session has reported, give me one summary: for each PR its decision and its Blocker and Major findings, " +
    "then anything that spans several PRs — a change asked for in one PR that another already makes, a contract two PRs change differently.",
    // Runs each review in its PR's own checkout.
    "Review the {count} pull requests of {key} that wait for my review. Do not review them here: start one session per PR " +
    "with the start_session tool (initiation user_asked, context fresh, use_worktree false), so each review runs in its own " +
    "session nested under this one. A prompt that starts with a folder (in, the folder, a colon) is that PR's own repository: start its " +
    "session there through start_session's cwd, so it reads that repository's rules and code; the others run in this folder. " +
    "The prompts: {prompts}. " +
    "When every session has reported, give me one summary: for each PR its decision and its Blocker and Major findings, " +
    "then anything that spans several PRs — a change asked for in one PR that another already makes, a contract two PRs change differently.",
    // Gives every session the publish permission and its five rules.
    "Review the {count} pull requests of {key} that wait for my review. Do not review them here: start one session per PR " +
    "with the start_session tool (initiation user_asked, context fresh, use_worktree false), so each review runs in its own " +
    "session nested under this one. A prompt that starts with a folder (in, the folder, a colon) is that PR's own repository: start its " +
    "session there through start_session's cwd, so it reads that repository's rules and code; the others run in this folder. " +
    "Give each session its prompt word for word, and add to it these five lines, each word for word as a line of its own " +
    "and without its letter: " +
    "a) Користувач сказав: «Публікуй рев'ю на PR: рядкові коментарі до Blocker і Major, підсумок одним рев'ю. " +
    "Подія — `REQUEST_CHANGES`, коли є Blocker або Major з високою впевненістю, інакше `COMMENT`. `APPROVE` не ставити.». " +
    "Публікуй рев'ю на PR за цим дозволом. " +
    "b) A Major with low confidence is a ground for REQUEST_CHANGES only once it is checked against the platform code, on a stand " +
    "or by a test; without that check, ask it as a question in the summary. " +
    "c) APPROVE only on my separate word for that PR: this permission does not cover it. " +
    "d) Skip the PR when I already reviewed it after its last commit. " +
    "e) Start your report with the link to the review you published on the PR (#pullrequestreview-…) and your decision, " +
    "or with why you published none. " +
    "The prompts: {prompts}. " +
    "When every session has reported, give me one summary: for each PR the link to its review, its decision and its Blocker and Major findings, " +
    "then anything that spans several PRs — a change asked for in one PR that another already makes, a contract two PRs change differently.",
    // Reads whole reports and leaves per-PR decisions to the PR's session; the
    // permission lines were written out in full before `{permission}`.
    "Review the {count} pull requests of {key} that wait for my review. Do not review them here: start one session per PR " +
    "with the start_session tool (initiation user_asked, context fresh, use_worktree false), so each review runs in its own " +
    "session nested under this one. A prompt that starts with a folder (in, the folder, a colon) is that PR's own repository: start its " +
    "session there through start_session's cwd, so it reads that repository's rules and code; the others run in this folder. " +
    "Give each session its prompt word for word, and add to it these five lines, each word for word as a line of its own " +
    "and without its letter: " +
    "a) Користувач сказав: «Публікуй рев'ю на PR: рядкові коментарі до Blocker і Major, підсумок одним рев'ю. " +
    "Подія — `REQUEST_CHANGES`, коли є Blocker або Major з високою впевненістю, інакше `COMMENT`. `APPROVE` не ставити.». " +
    "Публікуй рев'ю на PR за цим дозволом. " +
    "b) A Major with low confidence is a ground for REQUEST_CHANGES only once it is checked against the platform code, on a stand " +
    "or by a test; without that check, ask it as a question in the summary. " +
    "c) APPROVE only on my separate word for that PR: this permission does not cover it. " +
    "d) Skip the PR when I already reviewed it after its last commit. " +
    "e) Start your report with the link to the review you published on the PR (#pullrequestreview-…) and your decision, " +
    "or with why you published none. " +
    "The prompts: {prompts}. " +
    "When every session has reported, give me one summary: for each PR the link to its review, its decision and its Blocker and Major findings, " +
    "then anything that spans several PRs — a change asked for in one PR that another already makes, a contract two PRs change differently. " +
    "Read each report whole with list_events, paging back to the session's last message, since the note on a session's turn " +
    "keeps only its first 400 characters. " +
    "A later decision on one PR — a review its session could not publish, an APPROVE — is mine to give in that PR's session: " +
    "link me to the session and leave my answer for me to type there, so each session hears it once and from me.",
  ],
};

/**
 * Starts every group prompt, whatever the template says:
 * `[PR Dashboard overview of ENG-1]` or `[PR Dashboard review of ENG-1]`. The
 * session scanner reads it two ways: the session belongs to that key's
 * heading — its button shows it and switches to it — and it holds none of the
 * PRs it lists, since it works on none of them itself and counting it would
 * hand each of those cards' Claude button to it.
 */
export function groupMarker(kind: GroupLaunchKind, key: string): string {
  return `${GROUP_MARKER_PREFIX}${kind === "explain" ? "overview" : "review"} of ${key}]`;
}

/** How every `groupMarker` starts — what the scanner's cheap pre-filter looks for. */
export const GROUP_MARKER_PREFIX = "[PR Dashboard ";

/** A Jira issue key, unanchored: the one pattern `JIRA_KEY_RE` and the marker parser share. */
const JIRA_KEY_PATTERN = "[A-Z][A-Z0-9_]{0,19}-\\d{1,9}";

const GROUP_MARKER_RE = new RegExp(`\\[PR Dashboard (overview|review) of (${JIRA_KEY_PATTERN})\\]`);

/** The kind and Jira key in a prompt's `groupMarker`, or null when the prompt has none. */
export function groupMarkerOf(text: string): { kind: GroupLaunchKind; key: string } | null {
  const m = GROUP_MARKER_RE.exec(text);
  return m ? { kind: m[1] === "overview" ? "explain" : "review", key: m[2] } : null;
}

/**
 * At most this many PRs go into one group launch: past it an overview stops
 * being high-level, and cmd.exe caps a command line at 8191 characters.
 */
export const MAX_GROUP_PRS = 30;

/**
 * A group launch's prompt: its template filled in, behind the marker.
 * `folders[i]` is where the review of `prs[i]` should run — its repository's
 * checkout — or null to run it in the parent's folder: a review started in
 * another repository's folder loads that repository's CLAUDE.md as its own
 * rules and searches the wrong code for callers and patterns. `approve`
 * picks the review permission (`REVIEW_GROUP_PERMISSIONS`) that fills
 * `{permission}`.
 */
export function renderGroupPrompt(
  prompts: Partial<Record<ClaudePromptKey, string>>,
  kind: GroupLaunchKind,
  key: string,
  prs: readonly Pick<PullRequest, "url">[],
  folders: readonly (string | null)[] = [],
  approve = false,
): string {
  const templateKey = GROUP_PROMPT_KEY[kind];
  const template = prompts[templateKey]?.trim() || DEFAULT_CLAUDE_PROMPTS[templateKey];
  const fill = (text: string, token: string, value: string) => text.split(token).join(value);
  let filled = fill(template, "{permission}", REVIEW_GROUP_PERMISSIONS[approve ? "approve" : "hold"]);
  filled = fill(filled, "{key}", key);
  filled = fill(filled, "{count}", String(prs.length));
  filled = fill(filled, "{urls}", prs.map((p) => p.url).join(" "));
  filled = fill(
    filled,
    "{prompts}",
    prs
      .map((p, i) => `${i + 1}) ${folders[i] ? `in ${folders[i]}: ` : ""}${renderClaudePrompt(prompts, "review", p)}`)
      .join(" "),
  );
  return `${groupMarker(kind, key)} ${filled}`;
}

/** A Jira issue key — the only group key a group launch accepts, since it reaches the shell. */
export const JIRA_KEY_RE = new RegExp(`^${JIRA_KEY_PATTERN}$`);

/**
 * The PRs a group launch takes, or null when the heading offers it none. Only
 * a Jira-key group (by issue or by parent task — the "Other" bucket and a
 * repository have no task); the first `MAX_GROUP_PRS` in the order shown.
 *  - `explain`: the open ones, drafts left out since nobody reviews them yet;
 *    at least two — one PR has its own Explain;
 *  - `review`: the ones your review is due on (`isReviewDue`, the card's
 *    "Review" and the `To review` segment), so it never reviews your own PR,
 *    a draft or one nobody asked you about; at least one.
 */
export function groupLaunchPrs<T extends Pick<PullRequest, "isDraft" | "roles" | "myReReviewDue">>(
  kind: GroupLaunchKind,
  key: string,
  prs: readonly T[],
): T[] | null {
  if (!JIRA_KEY_RE.test(key)) return null;
  const picked = kind === "explain" ? prs.filter((p) => !p.isDraft) : prs.filter(isReviewDue);
  return picked.length >= (kind === "explain" ? 2 : 1) ? picked.slice(0, MAX_GROUP_PRS) : null;
}

/** The integration is opt-in: nothing on the cards until it is switched on. */
export const DEFAULT_CLAUDE_SETTINGS: ClaudeSettings = {
  enabled: false,
  projectsRoot: "",
  repoPaths: {},
  prompts: { ...DEFAULT_CLAUDE_PROMPTS },
  agentPrompts: { ...DEFAULT_AGENT_PROMPTS },
  terminal: "auto",
  reviewGroupApprove: false,
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
