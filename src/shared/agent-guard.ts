import type { AgentRunKind } from "./types";

// The agent's PreToolUse guard: what an agent session may actually run,
// decided outside the model. `--allowedTools` is the first gate, but its rules
// are prefixes the user can edit — `Bash(git diff *)` also matches
// `git diff --output=~/.bashrc`, and a PR's own text can talk the model into
// trying that. This check runs on every tool call through the hook
// (`main/agent/hook.ts`), and nothing in Settings loosens it. Node-free and
// pure, so every rule is unit-tested without starting a session.

export type GuardDecision = { allow: true } | { allow: false; reason: string };

/** Runs that only read: reviews, briefs, re-reviews, the after-merge dry run. */
const READ_ONLY: ReadonlySet<AgentRunKind> = new Set(["review", "brief", "rereview", "afterMerge"]);

/** File tools that change files — never in a read-only run. */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Tools no agent run gets, whatever the list says: network, other shells, agents' own settings. */
const NEVER = new Set(["WebFetch", "WebSearch", "PowerShell", "REPL"]);

/**
 * A command with any of these is refused outright: chaining, pipes,
 * redirection, substitution and line breaks are how a harmless prefix becomes
 * something else. The commands the agent needs never use them.
 */
const SHELL_META = /[;&|<>`\n\r]|\$\(/;

/** `gh` reads the agent may make. Everything that writes goes through the app's publish step instead. */
const GH_READ = /^gh (pr (view|diff|checks)|run view|api)( |$)/;

/** Flags that turn `gh api` into a write. */
const GH_API_WRITE = /(^| )(-X|--method|-f|-F|--field|--raw-field|--input|-H|--header)( |=|$)/;

/**
 * git flags that write a file or run a program even under a reading subcommand:
 * `--output` writes anywhere, `--ext-diff`/`--textconv` run configured programs,
 * `--no-index` reads outside the repository.
 */
const GIT_DANGEROUS = /(^| )(--output|--ext-diff|--textconv|--no-index|--exec-path|--upload-pack|--receive-pack)( |=|$)/;

function deny(reason: string): GuardDecision {
  return { allow: false, reason };
}

/** Collapses runs of whitespace so the patterns above see one space between words. */
function normalize(command: string): string {
  return command.trim().replace(/[ \t]+/g, " ");
}

export function checkBash(kind: AgentRunKind, rawCommand: string): GuardDecision {
  if (SHELL_META.test(rawCommand)) {
    return deny("Shell operators (pipes, redirection, chaining, substitution) are not allowed in agent runs — run one plain command.");
  }
  const command = normalize(rawCommand);
  // `FOO=1 git push` would slip past a check on the first word.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command)) return deny("Commands can't start with environment assignments in agent runs.");
  if (/^git( |$)/.test(command)) {
    // Not even the reading subcommands: `git diff` and `git log -p` run textconv
    // filters by default, and the PR's own .gitattributes picks which files go
    // through them. A read-only run takes the diff from `gh pr diff`.
    if (READ_ONLY.has(kind)) return deny("This run only reads, and git can run configured filters on the PR's files — use gh pr diff / gh pr view.");
    // Global options come before the subcommand: `-C <dir>` moves the repository,
    // `-c` rewrites config (aliases, pagers). With none allowed, the second word
    // IS the subcommand.
    if (/^git -/.test(command)) return deny("git global options (-C, -c, --git-dir, …) are not allowed in agent runs.");
    if (GIT_DANGEROUS.test(command)) return deny("That git flag writes files or runs programs; agent runs can't use it.");
    // Drive (stage 5) does not rely on this alone: its worktree has no push URL,
    // and the app pushes the branch itself after checking the commit.
    if (/^git push( |$)/.test(command)) return deny("Agent runs don't push from the shell — the app pushes your branch itself.");
    return { allow: true };
  }
  if (/^gh /.test(command)) {
    if (!GH_READ.test(command)) return deny("Agent runs read from GitHub only; the app posts the result itself.");
    if (/^gh api( |$)/.test(command) && GH_API_WRITE.test(command)) return deny("gh api is read-only in agent runs (no method, fields, input or headers).");
    return { allow: true };
  }
  if (READ_ONLY.has(kind)) return deny("This run only reads: it doesn't run commands from the PR's repository.");
  return { allow: true };
}

/** The decision for one tool call; `input` is the tool's input as Claude Code reports it. */
export function checkToolUse(kind: AgentRunKind, toolName: string, input: unknown): GuardDecision {
  if (NEVER.has(toolName)) return deny(`${toolName} is not available to agent runs.`);
  if (READ_ONLY.has(kind) && WRITE_TOOLS.has(toolName)) return deny("This run only reads; it can't change files.");
  if (toolName === "Bash") {
    const command = typeof (input as { command?: unknown } | null)?.command === "string" ? (input as { command: string }).command : "";
    if (!command) return deny("An empty command.");
    return checkBash(kind, command);
  }
  return { allow: true };
}

const RUN_KINDS: readonly AgentRunKind[] = ["review", "brief", "rereview", "drive", "afterMerge"];

export function isAgentRunKind(value: unknown): value is AgentRunKind {
  return RUN_KINDS.includes(value as AgentRunKind);
}
