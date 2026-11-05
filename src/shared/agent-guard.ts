import type { AgentRunKind } from "./types";

// The agent's PreToolUse guard: what an agent session may actually run,
// decided outside the model. `--allowedTools` is the first gate, but its rules
// are prefixes the user can edit — `Bash(git diff *)` also matches
// `git diff --output=~/.bashrc`, and a PR's own text can talk the model into
// trying that. This check runs on every tool call through the hook
// (`main/agent/hook.ts`), and nothing in Settings loosens it. Node-free and
// pure, so every rule is unit-tested without starting a session.
//
// Commands are judged by the argv the program will receive, not by their
// text: the command is split the way the shell would split it, and anything
// that would make the shell do more than run one program with literal
// arguments — operators, expansion, globs — refuses it outright. Text checks
// alone let `-XDELETE`, `'-X' POST`, or a PR file named `-XDELETE` matched by
// an unquoted `*` straight through.

export type GuardDecision = { allow: true } | { allow: false; reason: string };

/** The PR a run works on: its `gh` reads are held to it. */
export interface GuardPr {
  url: string;
  /** "owner/name", lower case. */
  repo: string;
  number: number;
}

/** "https://host/owner/name/pull/7" → the PR it names, or null. */
export function guardPrFromUrl(url: string): GuardPr | null {
  const m = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/.exec(url.trim());
  return m ? { url: url.trim().replace(/\/$/, ""), repo: `${m[1]}/${m[2]}`.toLowerCase(), number: Number(m[3]) } : null;
}

/** Runs that only read: reviews, briefs, re-reviews, the after-merge dry run. */
const READ_ONLY: ReadonlySet<AgentRunKind> = new Set(["review", "brief", "rereview", "afterMerge"]);

/** File tools that change files — never in a read-only run. */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Tools no agent run gets, whatever the list says: network, other shells. */
const NEVER = new Set(["WebFetch", "WebSearch", "PowerShell", "REPL"]);

function deny(reason: string): GuardDecision {
  return { allow: false, reason };
}

/**
 * Splits a command into the argv the shell would pass, or explains why the
 * shell would do something else. Single quotes are literal; double quotes
 * allow only \" \\ escapes and refuse `$` and backticks; outside quotes,
 * operators (; & | < > ( )), `$`, backticks, globs (* ? [ ]) and line breaks
 * are refused. A backslash outside quotes takes the next character literally.
 */
export function shellWords(command: string): { words: string[] } | { error: string } {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "\n" || ch === "\r") return { error: "Line breaks are not allowed — run one command." };
    if (ch === " " || ch === "\t") {
      if (inWord) {
        words.push(cur);
        cur = "";
        inWord = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return { error: "Unbalanced quote." };
      cur += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      inWord = true;
      for (;;) {
        if (i >= n) return { error: "Unbalanced quote." };
        const c = command[i];
        if (c === '"') {
          i++;
          break;
        }
        if (c === "$" || c === "`") return { error: "Expansion ($, backticks) is not allowed in agent runs." };
        if (c === "\n" || c === "\r") return { error: "Line breaks are not allowed — run one command." };
        if (c === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) {
          cur += command[i + 1];
          i += 2;
          continue;
        }
        cur += c;
        i++;
      }
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= n) return { error: "A trailing backslash." };
      cur += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (";&|<>()".includes(ch)) return { error: "Shell operators (pipes, redirection, chaining) are not allowed in agent runs — run one plain command." };
    if (ch === "$" || ch === "`") return { error: "Expansion ($, backticks) is not allowed in agent runs." };
    if ("*?[]".includes(ch)) return { error: "Unquoted wildcards are not allowed — they would expand to the PR's own file names." };
    cur += ch;
    inWord = true;
    i++;
  }
  if (inWord) words.push(cur);
  return { words };
}

/**
 * git flags that write a file or run a program even under a reading
 * subcommand, matched as prefixes so `--output=x` counts: `--output` writes
 * anywhere, `--ext-diff`/`--textconv` run configured programs, `--no-index`
 * reads outside the repository, the pack ones run a remote program.
 */
const GIT_DANGEROUS = ["--output", "--ext-diff", "--textconv", "--no-index", "--exec-path", "--upload-pack", "--receive-pack", "--exec"];

/**
 * git subcommands a drive run may use. A list, not "anything but push": an
 * unknown word can be an alias from your git config, and an alias can run a
 * shell command.
 */
const GIT_DRIVE = new Set([
  "status",
  "diff",
  "log",
  "show",
  "add",
  "commit",
  "restore",
  "rm",
  "mv",
  "rev-parse",
  "ls-files",
  "blame",
  "merge-base",
  "fetch",
  "rebase",
  "merge",
  "cherry-pick",
  "stash",
  "branch",
]);

/** `gh api` flags that only shape a read; a value-taking one consumes the next word. */
const GH_API_FLAGS: Record<string, "flag" | "value"> = {
  "--jq": "value",
  "-q": "value",
  "--paginate": "flag",
  "--slurp": "flag",
  "--cache": "value",
  "-i": "flag",
  "--include": "flag",
  "--silent": "flag",
};

function checkGhApi(args: string[], pr: GuardPr | null): GuardDecision {
  let endpoint: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      const [name, attached] = a.startsWith("--") ? [a.split("=")[0], a.includes("=")] : [a.slice(0, 2), a.length > 2];
      const kind = GH_API_FLAGS[name];
      if (!kind) return deny("gh api is read-only in agent runs: only --jq, --paginate, --slurp, --cache, --include and --silent.");
      if (kind === "value" && !attached) i++;
      if (kind === "flag" && attached) return deny("gh api is read-only in agent runs.");
      continue;
    }
    if (endpoint !== null) return deny("gh api takes one endpoint in agent runs.");
    endpoint = a;
  }
  if (!endpoint) return deny("gh api needs an endpoint.");
  if (/^\/?graphql$/i.test(endpoint)) return deny("gh api graphql can write; agent runs read REST endpoints only.");
  // A relative REST path of the run's own repository: no other host (no "://"),
  // no other repository, no {owner} placeholders resolved from a remote.
  if (!/^\/?repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?(\?[A-Za-z0-9._=&%-]*)?$/.test(endpoint)) {
    return deny("Only GitHub REST reads of this PR's repository (repos/owner/name/…) are allowed.");
  }
  if (pr) {
    const repo = endpoint.replace(/^\//, "").split("/").slice(1, 3).join("/").toLowerCase();
    if (repo !== pr.repo) return deny(`This run reads ${pr.repo} only.`);
  }
  return { allow: true };
}

/** gh pr flags that take a value, so their value isn't read as the PR argument. */
const GH_PR_VALUE_FLAGS = new Set(["--repo", "-R", "--json", "--jq", "-q", "--template", "-t"]);

function checkGhPr(args: string[], pr: GuardPr | null): GuardDecision {
  if (args.some((w) => w === "--web" || w === "-w" || w.startsWith("--hostname"))) return deny("That gh flag is not needed in agent runs.");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      const name = a.split("=")[0];
      const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : GH_PR_VALUE_FLAGS.has(name) ? args[++i] : undefined;
      if ((name === "--repo" || name === "-R") && pr && (value ?? "").toLowerCase() !== pr.repo) {
        return deny(`This run reads ${pr.repo} only.`);
      }
      continue;
    }
    // The positional: this PR's number or URL, nothing else.
    if (pr && a !== String(pr.number) && a.replace(/\/$/, "") !== pr.url) return deny(`This run reads PR #${pr.number} only.`);
  }
  return { allow: true };
}

function checkGh(words: string[], pr: GuardPr | null): GuardDecision {
  const [, group, sub] = words;
  if (group === "api") return checkGhApi(words.slice(2), pr);
  if (group === "pr" && (sub === "view" || sub === "diff" || sub === "checks")) return checkGhPr(words.slice(3), pr);
  if (group === "run" && sub === "view") return checkGhPr(words.slice(3).filter((w) => !/^\d+$/.test(w)), pr);
  return deny("Agent runs read from GitHub only; the app posts the result itself.");
}

function checkGit(kind: AgentRunKind, words: string[]): GuardDecision {
  // Not even the reading subcommands: `git diff` and `git log -p` run textconv
  // filters by default, and the PR's own .gitattributes picks which files go
  // through them. A read-only run takes the diff from `gh pr diff`.
  if (READ_ONLY.has(kind)) return deny("This run only reads, and git can run configured filters on the PR's files — use gh pr diff / gh pr view.");
  const sub = words[1] ?? "";
  // Global options come before the subcommand: `-C <dir>` moves the
  // repository, `-c` rewrites config (aliases, pagers).
  if (sub.startsWith("-")) return deny("git global options (-C, -c, --git-dir, …) are not allowed in agent runs.");
  // Drive (stage 5) does not rely on this alone: its worktree has no push URL,
  // and the app pushes the branch itself after checking the commit.
  if (sub === "push") return deny("Agent runs don't push from the shell — the app pushes your branch itself.");
  if (!GIT_DRIVE.has(sub)) return deny(`git ${sub} is not one of the git commands agent runs may use.`);
  if (words.some((w) => GIT_DANGEROUS.some((f) => w === f || w.startsWith(`${f}=`)))) {
    return deny("That git flag writes files or runs programs; agent runs can't use it.");
  }
  return { allow: true };
}

export function checkBash(kind: AgentRunKind, rawCommand: string, pr: GuardPr | null = null): GuardDecision {
  const split = shellWords(rawCommand);
  if ("error" in split) return deny(split.error);
  const words = split.words;
  if (words.length === 0) return deny("An empty command.");
  // `FOO=1 git push` would slip past a check on the program's name.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return deny("Commands can't start with environment assignments in agent runs.");
  if (words[0] === "git") return checkGit(kind, words);
  if (words[0] === "gh") return checkGh(words, pr);
  if (READ_ONLY.has(kind)) return deny("This run only reads: it doesn't run commands from the PR's repository.");
  return { allow: true };
}

/**
 * The decision for one tool call; `input` is the tool's input as Claude Code
 * reports it, `pr` the PR the run works on (its gh reads are held to it).
 */
export function checkToolUse(kind: AgentRunKind, toolName: string, input: unknown, pr: GuardPr | null = null): GuardDecision {
  if (NEVER.has(toolName)) return deny(`${toolName} is not available to agent runs.`);
  if (READ_ONLY.has(kind) && WRITE_TOOLS.has(toolName)) return deny("This run only reads; it can't change files.");
  if (toolName === "Bash") {
    const command = typeof (input as { command?: unknown } | null)?.command === "string" ? (input as { command: string }).command : "";
    if (!command.trim()) return deny("An empty command.");
    return checkBash(kind, command, pr);
  }
  return { allow: true };
}

const RUN_KINDS: readonly AgentRunKind[] = ["review", "brief", "rereview", "drive", "afterMerge"];

export function isAgentRunKind(value: unknown): value is AgentRunKind {
  return RUN_KINDS.includes(value as AgentRunKind);
}
