import type { AgentPromptKey, AgentRunKind, AgentSettings } from "./types";

// The PR agent's defaults and the bounds of its numbers. Node-free like
// `notify.ts`, because the renderer value-imports it: the Agent tab of Settings
// starts from these defaults and its number fields use the same bounds the
// main process validates with (`validateAgent` in config.ts).

/** {url} is the PR's URL. Only the agent runs these; the Claude button's prompts are separate. */
export const DEFAULT_AGENT_PROMPTS: Record<AgentPromptKey, string> = {
  triage:
    "Explain what {url} changes and why: read the diff and the linked Jira task, then give a short summary — the problem, the approach, the risky parts — and end with the decisions only a human can make. Post nothing.",
  rereview:
    "/creatio-development:creatio-code-review {url} — a re-review: check every reply in my threads against the head commit, answer where a «fixed» isn't, resolve where the reply holds up, and leave design disputes to me.",
  afterMerge: "/twg-jira-resolve-merged-work {url} as a dry run: show what it would change in Jira and change nothing.",
  selfReview:
    "/creatio-development:creatio-code-review {url} — a self-review of my own PR before reviewers see it: run it with dryRun: true and post nothing. Then check its findings with /validate-and-fix-review-comments and fix only the confirmed ones as commits; where a finding is a business or design decision, change nothing and ask me.",
  validateComments:
    "/validate-and-fix-review-comments {url} — check every open reviewer comment on my PR against the head commit: fix the confirmed ones as commits and answer in each thread (what you fixed, or why not); where a comment is a business or product decision, change nothing and ask me.",
};

/**
 * `--allowedTools` rules per kind of run — a starting point the Agent tab lets
 * you edit. These are only the first gate: every Bash call also goes through
 * the agent's PreToolUse guard (`agent-guard.ts`), which the list here cannot
 * loosen. Reviews and briefs read only and run no code from the PR's
 * repository: no `git` at all (its `--output`, `--ext-diff` and `--textconv`
 * write files or run programs), and `gh api` is held to plain GET by the guard.
 * Pushing is never granted here; drive pushes through the guard alone.
 */
export const DEFAULT_AGENT_TOOLS: Record<AgentRunKind, string[]> = {
  review: [
    "Read",
    "Grep",
    "Glob",
    "Skill",
    "Agent",
    "Workflow",
    "ToolSearch",
    "TaskCreate",
    "TaskUpdate",
    "Bash(gh pr view *)",
    "Bash(gh pr diff *)",
    "Bash(gh pr checks *)",
    "Bash(gh api *)",
    "Bash(gh auth status*)",
    "Bash(twg *)",
  ],
  brief: [
    "Read",
    "Grep",
    "Glob",
    "ToolSearch",
    "TaskCreate",
    "TaskUpdate",
    "Bash(gh pr view *)",
    "Bash(gh pr diff *)",
    "Bash(twg *)",
  ],
  rereview: [
    "Read",
    "Grep",
    "Glob",
    "Skill",
    "Agent",
    "Workflow",
    "ToolSearch",
    "TaskCreate",
    "TaskUpdate",
    "Bash(gh pr view *)",
    "Bash(gh pr diff *)",
    "Bash(gh api *)",
  ],
  drive: [
    "Read",
    "Edit",
    "Write",
    "Grep",
    "Glob",
    "Skill",
    "Agent",
    "Workflow",
    "ToolSearch",
    "TaskCreate",
    "TaskUpdate",
    "Bash(gh pr view *)",
    "Bash(gh pr diff *)",
    "Bash(gh pr checks *)",
    "Bash(gh run view *)",
    // The review threads to answer, and anything else of this PR's — reads only (the guard holds them to it).
    "Bash(gh api *)",
    "Bash(git status*)",
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git show *)",
    "Bash(git merge-base *)",
    // A conflict is resolved by merging the base branch in (never by a rebase).
    "Bash(git merge *)",
    "Bash(git add *)",
    "Bash(git commit *)",
    // A self-review reads the PR's Jira task (the review skill stops without its acceptance criteria).
    "Bash(twg *)",
    // No test commands by default: a test runs your repository's code, and the
    // session can edit that code. Add them in Settings › Agent › Permissions if
    // you accept that; CI checks every push either way.
  ],
  afterMerge: ["Read", "Grep", "Glob", "Skill", "ToolSearch", "TaskCreate", "TaskUpdate", "Bash(gh pr view *)", "Bash(gh api *)", "Bash(twg *)"],
};

/**
 * The version of the default tool lists. A saved list is yours and is kept as
 * you left it — but rules added to the defaults later would then never reach
 * it, so each version names what it added, and loading a list saved under an
 * older version adds those rules (once: the list is saved at this version).
 */
export const AGENT_TOOLS_VERSION = 3;
export const AGENT_TOOL_ADDITIONS: ReadonlyArray<{ version: number; add: Partial<Record<AgentRunKind, string[]>> }> = [
  // Drive couldn't merge the base in (a conflict) nor read the threads it answers: every drive ended "No commits".
  { version: 2, add: { drive: ["Bash(gh pr diff *)", "Bash(gh api *)", "Bash(git show *)", "Bash(git merge-base *)", "Bash(git merge *)"] } },
  // The self-review of your own PR runs the review skill, which reads the PR's Jira task.
  { version: 3, add: { drive: ["Bash(twg *)"] } },
];

/** A saved tool list brought up to date: the rules added to the defaults since it was saved, appended. */
export function migrateTools(kind: AgentRunKind, saved: readonly string[], savedVersion: number): string[] {
  const out = [...saved];
  for (const step of AGENT_TOOL_ADDITIONS) {
    if (step.version <= savedVersion) continue;
    for (const rule of step.add[kind] ?? []) if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

export const DEFAULT_AGENT_SIGNATURE = "🤖 Prepared by the PR agent (Claude Code) on my behalf. Reply here — I read every reply.";

/**
 * Bounds of every number the agent takes. Out-of-range values are clamped by
 * the validator and flagged by the Settings field, so the two can't disagree.
 */
export const AGENT_BOUNDS = {
  maxLines: { min: 1, max: 100_000 },
  maxFiles: { min: 1, max: 5_000 },
  maxAttempts: { min: 1, max: 10 },
  parallel: { min: 1, max: 8 },
  perDay: { min: 1, max: 500 },
  maxMinutes: { min: 5, max: 240 },
  promoteAfter: { min: 1, max: 100 },
  logRetentionDays: { min: 1, max: 365 },
  diagramMinLines: { min: 0, max: 100_000 },
} as const;

export type AgentBoundKey = keyof typeof AGENT_BOUNDS;

/**
 * Off until switched on; every scenario that posts starts in shadow, so the
 * first days show what the agent would do before it does any of it.
 */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: false,
  model: "",
  effort: "",
  worktreeDir: "",
  removeWorktree: true,
  repos: [],
  scenarios: {
    review: { mode: "shadow", maxLines: 400, maxFiles: 15, teamRequests: false, drafts: false, holdApproveOnChangeRequest: false },
    brief: { mode: "on" },
    rereview: { mode: "shadow", resolve: true, approve: true },
    merge: {
      mode: "offer",
      requireAllReviewers: true,
      requireThreadsResolved: true,
      requireChecksGreen: true,
      method: "github",
      deleteBranch: true,
    },
    selfReview: { mode: "shadow" },
    driveCi: { mode: "shadow", maxAttempts: 2 },
    driveComments: { mode: "shadow" },
  },
  limits: {
    parallel: 2,
    perDay: 30,
    maxMinutes: 30,
    quietHours: { enabled: false, from: "20:00", to: "08:00" },
    promoteAfter: 10,
  },
  permissions: { tools: DEFAULT_AGENT_TOOLS, toolsVersion: AGENT_TOOLS_VERSION, pushOwnBranch: true },
  // A small PR reads fine without a picture; each diagram is a model run of its own.
  diagrams: { enabled: true, minLines: 100, post: true, model: "sonnet" },
  companion: { headerChip: true, trayState: true },
  notifications: { needsYou: true, failed: true, finished: false },
  policy: { signature: DEFAULT_AGENT_SIGNATURE, logRetentionDays: 30 },
};

/** "HH:MM" on a 24-hour clock. */
export function isClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
