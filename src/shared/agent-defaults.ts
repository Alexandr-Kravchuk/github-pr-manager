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
    "Bash(gh pr checks *)",
    "Bash(gh run view *)",
    "Bash(git status*)",
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git add *)",
    "Bash(git commit *)",
    "Bash(npm test*)",
    "Bash(npm run *)",
  ],
  afterMerge: ["Read", "Grep", "Glob", "Skill", "ToolSearch", "TaskCreate", "TaskUpdate", "Bash(gh pr view *)", "Bash(gh api *)", "Bash(twg *)"],
};

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
  permissions: { tools: DEFAULT_AGENT_TOOLS, pushOwnBranch: true },
  companion: { headerChip: true, trayState: true },
  notifications: { needsYou: true, failed: true, finished: false },
  policy: { signature: DEFAULT_AGENT_SIGNATURE, logRetentionDays: 30 },
};

/** "HH:MM" on a 24-hour clock. */
export function isClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
