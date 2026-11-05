/**
 * PROTOTYPE — throwaway, see AgentPrototype.tsx. What a run looks like from
 * the inside: the plan the agent follows and the activities it emits, scripted
 * per scenario. In the real feature this comes from `claude -p
 * --output-format stream-json` — the plan from its task list (TodoWrite), the
 * activities from its tool calls — so the shapes here mirror that stream.
 */
import type { PullRequest } from "../../../../shared/types";
import type { AgentAction, AgentItem, Scenario } from "./agent-model";

export type LogKind = "think" | "read" | "bash" | "gh" | "edit" | "agent" | "you" | "result";

export interface RunActivity {
  kind: LogKind;
  text: string;
}

export interface RunStep {
  label: string;
  activities: RunActivity[];
}

export interface RunLogEntry {
  id: number;
  at: string;
  kind: LogKind;
  text: string;
  /** The plan step it was written in. */
  step: number;
}

export interface Run {
  sessionId: string;
  startedAt: number;
  steps: RunStep[];
  stepIdx: number;
  /** Activities of the current step already emitted. */
  actIdx: number;
  log: RunLogEntry[];
  paused: boolean;
  outcome: Pick<AgentItem, "state" | "headline" | "actions"> & Partial<Pick<AgentItem, "resolved" | "detail" | "shadow">>;
}

export const LOG_KIND_LABEL: Record<LogKind, string> = {
  think: "think",
  read: "read",
  bash: "bash",
  gh: "gh",
  edit: "edit",
  agent: "agents",
  you: "you",
  result: "done",
};

const CONTINUE: AgentAction = { id: "continue", label: "Continue in session" };

function reviewScript(pr: PullRequest | undefined, findings: "none" | "minor"): Pick<Run, "steps" | "outcome"> {
  const task = pr?.issueKey ? `${pr.issueKey} «${pr.issueSummary ?? pr.title}»` : "no linked task — the PR title is the spec";
  return {
    steps: [
      {
        label: "Check whether you already reviewed it",
        activities: [{ kind: "gh", text: "gh api …/reviews → nothing of yours after the head commit" }],
      },
      {
        label: "Read the Jira task",
        activities: [
          { kind: "think", text: `Jira: ${task}` },
          { kind: "think", text: "3 acceptance criteria to check the diff against" },
        ],
      },
      {
        label: "Collect the diff and repo guidance",
        activities: [
          { kind: "bash", text: "git diff origin/main...HEAD --stat → 6 files, +180 −42" },
          { kind: "read", text: "AGENTS.md (repository guidance)" },
          { kind: "read", text: "src/tools/deadline.ts (changed)" },
        ],
      },
      {
        label: "Run 5 reviewers in parallel",
        activities: [
          { kind: "agent", text: "bugs · security · performance · tests · quality started" },
          { kind: "agent", text: "security-reviewer: no findings" },
          {
            kind: "agent",
            text: findings === "minor" ? "bug-detector: 1 Minor — the timer is not cleared on early return" : "bug-detector: no findings",
          },
          {
            kind: "agent",
            text: findings === "minor" ? "testing-reviewer: 1 Minor — no test for the timeout path" : "testing-reviewer: no findings",
          },
          { kind: "agent", text: "performance, code-quality: no findings" },
        ],
      },
      {
        label: "Decide",
        activities: [
          {
            kind: "think",
            text: findings === "minor" ? "No Blocker or Major → approve (minor issues)" : "No findings → approve",
          },
        ],
      },
      {
        label: "Publish the review",
        activities: [
          { kind: "gh", text: findings === "minor" ? "Posting 2 inline comments and the summary" : "Posting the summary" },
          { kind: "gh", text: "gh api …/reviews -f event=APPROVE" },
        ],
      },
    ],
    outcome: {
      state: "done",
      headline: findings === "minor" ? "Review posted: 2 Minor, approved" : "Review posted: no findings, approved",
      actions: [CONTINUE],
    },
  };
}

function driveScript(): Pick<Run, "steps" | "outcome"> {
  return {
    steps: [
      {
        label: "Read the failing check",
        activities: [
          { kind: "gh", text: "gh run view --log-failed → CI / unit: 1 failing test" },
          { kind: "think", text: "«backoff respects 403» expects a 60 s wait, gets 0" },
        ],
      },
      { label: "Reproduce it locally", activities: [{ kind: "bash", text: "npm test -- -t backoff → 1 failed" }] },
      {
        label: "Fix",
        activities: [
          { kind: "read", text: "src/shared/github.ts" },
          { kind: "edit", text: "src/shared/github.ts:812 — keep Retry-After on a 403" },
        ],
      },
      {
        label: "Run typecheck and tests",
        activities: [
          { kind: "bash", text: "npm run typecheck → ok" },
          { kind: "bash", text: "npm test → 786 passed" },
        ],
      },
      { label: "Push", activities: [{ kind: "bash", text: "git push → 7c1d2e3 «fix: honor Retry-After on 403»" }] },
      {
        label: "Watch CI",
        activities: [
          { kind: "gh", text: "CI / unit: pending" },
          { kind: "gh", text: "CI / unit: success · CI / lint: success" },
        ],
      },
    ],
    outcome: { state: "done", headline: "CI green after 7c1d2e3 (attempt 1 of 2)", actions: [CONTINUE] },
  };
}

function mergeCheckScript(): Pick<Run, "steps" | "outcome"> {
  return {
    steps: [
      {
        label: "Re-check approvals",
        activities: [
          { kind: "think", text: "Deterministic check, no model call" },
          { kind: "gh", text: "1 approval, on the current head" },
        ],
      },
      { label: "Re-check CI and threads", activities: [{ kind: "gh", text: "all checks green · 0 open threads" }] },
    ],
    outcome: {
      state: "needsYou",
      headline: "Ready to merge: 1 approval, CI green, 0 open threads",
      resolved: "squash into main @ head → delete branch → Jira dry run",
      actions: [
        { id: "squash", label: "Squash and merge", tone: "merge", result: "You merged it (squash); Jira dry run queued" },
        { id: "merge", label: "Merge commit", result: "You merged it (merge commit); Jira dry run queued" },
      ],
    },
  };
}

function rereviewScript(): Pick<Run, "steps" | "outcome"> {
  return {
    steps: [
      { label: "Read your open threads", activities: [{ kind: "gh", text: "2 threads of yours, 2 author replies" }] },
      {
        label: "Judge each reply against the head",
        activities: [
          { kind: "agent", text: "judge: «Cache key» — fixed in the last push" },
          { kind: "agent", text: "judge: «Retry limit» — author disagrees, argument holds" },
        ],
      },
    ],
    outcome: {
      state: "needsYou",
      shadow: true,
      headline: "Both replies hold up — would resolve 2 threads",
      actions: [{ id: "post", label: "Resolve both", tone: "primary", result: "Agent resolved 2 threads" }],
    },
  };
}

function briefScript(): Pick<Run, "steps" | "outcome"> {
  return {
    steps: [
      { label: "Read the diff", activities: [{ kind: "bash", text: "git diff --stat → 31 files, +1 102 −138" }] },
      { label: "Read the Jira task", activities: [{ kind: "think", text: "Jira: the linked task and its parent" }] },
      { label: "Write the brief", activities: [{ kind: "think", text: "Problem · approach · risky parts · decisions for you" }] },
    ],
    outcome: {
      state: "needsYou",
      headline: "Brief ready · 2 decisions for you",
      detail: ["Чи погоджено зміну публічного API?", "Чи потрібен feature toggle?"],
      actions: [{ id: "brief", label: "Full brief" }],
    },
  };
}

export function scriptFor(scenario: Scenario, pr: PullRequest | undefined): Pick<Run, "steps" | "outcome"> {
  switch (scenario) {
    case "review":
      return reviewScript(pr, (pr?.number ?? 0) % 2 === 1 ? "minor" : "none");
    case "drive":
      return driveScript();
    case "merge":
      return mergeCheckScript();
    case "rereview":
      return rereviewScript();
    case "brief":
      return briefScript();
  }
}

function hhmm(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}

let nextLogId = 1;

/** A run that is already `stepIdx` steps in, with the log it would have written by now. */
export function startRun(
  scenario: Scenario,
  pr: PullRequest | undefined,
  progress: { stepIdx: number; actIdx: number; ageMs: number } = { stepIdx: 0, actIdx: 0, ageMs: 0 },
): Run {
  const { steps, outcome } = scriptFor(scenario, pr);
  const startedAt = Date.now() - progress.ageMs;
  const past: (RunActivity & { step: number })[] = [];
  steps.forEach((s, i) => {
    const acts = i < progress.stepIdx ? s.activities : i === progress.stepIdx ? s.activities.slice(0, progress.actIdx) : [];
    past.push(...acts.map((a) => ({ ...a, step: i })));
  });
  const log = past.map((a, i) => ({
    id: nextLogId++,
    at: hhmm(startedAt + (progress.ageMs * (i + 1)) / (past.length + 1)),
    ...a,
  }));
  return {
    sessionId: `${(pr?.number ?? 0).toString(16)}${Math.random().toString(16).slice(2, 8)}`,
    startedAt,
    steps,
    stepIdx: progress.stepIdx,
    actIdx: progress.actIdx,
    log,
    paused: false,
    outcome,
  };
}

export function logEntry(kind: LogKind, text: string, step: number): RunLogEntry {
  return { id: nextLogId++, at: hhmm(Date.now()), kind, text, step };
}

/** One step forward: the next activity, or the next step; `done` once the plan is through. */
export function advanceRun(run: Run): { run: Run; done: boolean } {
  const step = run.steps[run.stepIdx];
  if (!step) return { run, done: true };
  const act = step.activities[run.actIdx];
  if (act) {
    return { run: { ...run, actIdx: run.actIdx + 1, log: [...run.log, logEntry(act.kind, act.text, run.stepIdx)] }, done: false };
  }
  const stepIdx = run.stepIdx + 1;
  return { run: { ...run, stepIdx, actIdx: 0 }, done: stepIdx >= run.steps.length };
}

/** The line that says what the agent is doing this second. */
export function liveLine(run: Run): string {
  return run.log[run.log.length - 1]?.text ?? run.steps[run.stepIdx]?.label ?? "Starting…";
}

export function elapsed(run: Run): string {
  const s = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
