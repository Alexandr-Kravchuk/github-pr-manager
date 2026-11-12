import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_AGENT_PROMPTS } from "../../shared/agent-defaults";
import { driveReasons, isBigPr, jobKey, mergeBlocker, planJobs, renderAgentPrompt, type AgentJob, type AgentScenario } from "../../shared/agent-policy";
import { describePlan, disputeSteps, gitBashPath, readPlanLines, summarizePlan, type PublishStep, type PublishSummary } from "../../shared/agent-publish";
import { describeToolUse, type RunProgress } from "../../shared/agent-stream";
import { goneItems, nothingForYou, supersededBy } from "../../shared/agent-reconcile";
import { answerMessage, parseRunResult, resultRuleFor } from "../../shared/agent-result";
import { AGENT_CLOSED, approvalStands, queueOrder, quietUntil, rankBefore, todayKey } from "../../shared/agent-view";
import { DEFAULT_CLAUDE_PROMPTS } from "../../shared/claude-launch";
import { sessionsForPr } from "../../shared/claude-sessions";
import type { FreshPullRequest } from "../../shared/github";
import type {
  AgentAction,
  AgentActionResult,
  AgentItem,
  AgentRunKind,
  AgentSettings,
  AgentState,
  ClaudeSessionInfo,
  ClaudeSettings,
  DashboardResponse,
  MergeMethod,
  PullRequest,
  Settings,
} from "../../shared/types";
import { builtOn, chooseMergeMethod, mergeArgs } from "./merge";
import { mountUserSkills, readInstalledPlugins, resolveSkillRefs, type InstalledPlugin } from "./plugins";
import {
  ghApiArgs,
  ghError,
  heldWrites,
  planHash,
  prepareRunFolder,
  publishedCount,
  publishPlan,
  readPlanText,
  runFolderRoots,
  runGh,
  threadIdsByFirstComment,
  type GhRunner,
  type RunFolder,
} from "./publish";
import { execFileSync } from "node:child_process";

import { launcherEnv } from "../../shared/claude-launch";
import { collectDrive, gitFingerprint, isPlainBranch, pushArgs, safeGit, snapshotSsh, withNoHooks, withSshSnapshot, type GitPlace } from "./drive";
import { claudeSessionRoots, cutShort, freshHooksDir, hookCommand, sessionGitEnv, spawnClaude, startRun, writeGuardFile, writeRunSettings, type RunHandle, type Spawner } from "./runner";
import { drawDiagrams, existingDiagramUrl, type MermaidChecker } from "./diagrams";
import { approveAgainRequest, checkBaseOnly, checkReapproval, reapproveRequest, reaskRequest } from "./reapprove";
import { STACK_REBASE_HINT, stackLayer, stackRules } from "../../shared/agent-stack";
import { diagramComment, wantsDiagrams } from "../../shared/agent-diagrams";
import { actionArgs, boardNow, clip, diffBoard, diffIdle, diffItems, itemFields, runStats, settingsDiff, type ItemMark } from "./journal";
import { openStore, type AgentItemRecord, type AgentLogEntry, type AgentStore, type BaseOnlyMark, type LedgerEntry, type ReapproveMark } from "./store";
import { describeOrchestratorRun, orchestratorRoots, orchestratorRunFor, type OrchestratorRun } from "./sdlc";
import { prepareWorktree, remoteFor, removeWorktree, runGit, worktreeBase, type GitRunner } from "./worktrees";

// The PR agent's core in the main process. It reads each dashboard snapshot,
// asks the policy which PRs want work, queues them, and runs the queue on its
// own timer — the poller only reports when something changed, while limits,
// quiet spells and finished runs move on time alone.
//
// A review session never posts: its publish step is captured by the app's
// wrapper (`capture.ts`), and the app posts the plan itself (`publish.ts`) — at
// once in On, on your Publish in Shadow. Your PRs that are ready get a Merge
// button, and only your click merges them (`merge.ts`).

/** What the agent tells you about, if Settings › Agent › notifications say so. */
export interface AgentNotice {
  kind: "needsYou" | "failed" | "finished";
  item: AgentItem;
}

export interface AgentDeps {
  /** userData/agent — state, log and per-run settings files. */
  dir: string;
  loadSettings: () => Settings;
  getSnapshot: () => DashboardResponse | null;
  getSessions: () => readonly ClaudeSessionInfo[];
  findCheckout: (pr: PullRequest, claude: ClaudeSettings) => string | null;
  /** The compiled guard hook (dist/main/main/agent/hook.js). */
  hookScript: string;
  /** The binary that runs the hook as Node: the app's own (with ELECTRON_RUN_AS_NODE) or node. */
  execPath: string;
  /** Opens your terminal on an existing session: `claude --resume <id>` in `dir`. */
  openResume?: (dir: string, sessionId: string) => Promise<void>;
  /** The compiled capture script (dist/main/main/agent/capture.js) behind a review's publish wrapper. Without it reviews run as plain dry runs. */
  captureScript?: string;
  /** One PR read again by id before posting or merging; null when it is gone. */
  fetchPr?: (pr: Pick<PullRequest, "id" | "hostLabel" | "roles">) => Promise<FreshPullRequest | null>;
  gh?: GhRunner;
  /** `ssh <args>` → its output; a test stands in for ssh. */
  sshResolve?: (args: string[]) => string;
  /** Your own skills folder (~/.claude/skills) — the ones a prompt names are mounted for the run. */
  userSkillsDir?: string;
  /** Something you may want to hear about; main checks the notification settings. */
  notify?: (notice: AgentNotice) => void;
  plugins?: () => InstalledPlugin[];
  git?: GitRunner;
  spawner?: Spawner;
  /** Parses diagrams in the renderer's mermaid (a flowchart needs a DOM); absent, none is posted. */
  checkMermaid?: MermaidChecker;
  now?: () => Date;
  /** Called whenever what the agent shows changed. */
  onChange?: () => void;
  tickMs?: number;
}

export interface Agent {
  onSnapshot(snapshot: DashboardResponse): void;
  getState(): AgentState;
  act(action: AgentAction): Promise<AgentActionResult>;
  /** Session ids of the agent's own runs — the session detector leaves them out. */
  ownSessionIds(): ReadonlySet<string>;
  /** On: keep polling while the window is hidden (the agent acts on what it sees). */
  isActive(): boolean;
  /**
   * The settings were just saved: plan again now if the agent's changed (the
   * poller reports only when the PRs change), and push the state either way —
   * the header chip and the tray line are settings too.
   */
  refresh(): void;
  stop(): void;
}

/** How many recent things a run keeps for the companion's plan-and-log view. */
const RECENT_MAX = 40;
/** How many times in a row a run whose process was ended under it goes on by itself. */
const CUT_RESUMES = 2;

// The same local day the Board's "Done today" uses.
const localDay = todayKey;

/** The kind of session a scenario runs as — what the guard and the tool list go by. */
export function runKindOf(scenario: AgentScenario): AgentRunKind {
  switch (scenario) {
    case "brief":
    case "afterMerge":
    case "rereview":
    case "drive":
      return scenario;
    default:
      return "review";
  }
}

const REASON_TEXT: Record<string, string> = { ci: "failing CI", conflicts: "conflicts", comments: "review comments", self: "self-review" };

/** "failing CI and review comments" */
export function describeReasons(reasons: readonly string[]): string {
  const words = reasons.map((r) => REASON_TEXT[r] ?? r);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : (words[0] ?? "");
}

function queuedHeadline(job: Pick<AgentJob, "scenario" | "key" | "reasons">): string {
  switch (job.scenario) {
    case "brief":
      return "Queued: a brief first — a big PR; the review follows";
    case "rereview":
      return job.key.includes("|asked@") ? "Queued: re-review — you were asked again" : "Queued: re-review — the author answered";
    case "drive":
      return job.reasons?.includes("self")
        ? "Queued: self-review before reviewers"
        : job.reasons?.length && job.reasons.every((r) => r === "comments")
          ? "Queued: reviewers' comments to check"
          : `Queued: drive — ${describeReasons(job.reasons ?? [])}`;
    default:
      return "Queued: review";
  }
}

function workingHeadline(scenario: AgentScenario): string {
  switch (scenario) {
    case "brief":
      return "Writing a brief";
    case "afterMerge":
      return "Checking Jira (dry run)";
    case "rereview":
      return "Re-reviewing";
    case "drive":
      return "Driving to green";
    default:
      return "Reviewing";
  }
}

/** A running item's line: what it drives for, or what its scenario does. */
function runningHeadline(item: Pick<AgentItem, "scenario" | "reasons">): string {
  if (item.reasons?.includes("self")) return "Self-reviewing before reviewers";
  if (item.reasons?.length && item.reasons.every((r) => r === "comments")) return "Checking reviewers' comments";
  return item.reasons?.length ? `Driving — ${describeReasons(item.reasons)}` : workingHeadline(item.scenario);
}

/**
 * Why a PR the agent would take shows as Idle: it already did, or you said no,
 * for this head — the fallbacks when no run of that head says more
 * (`ledgerIdle`).
 */
const LEDGER_IDLE: Record<LedgerEntry["state"], string> = {
  started: "Running",
  prepared: "The agent already ran on this head",
  published: "Done for this head",
  failed: "Its last run on this head failed",
  dismissed: "You took it out of the queue for this head",
};

/** How long after a failure the agent tries a run it planned once more: long enough for a network or a busy clone to come back. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** The runs a failure is tried again for — not offers, not the Jira dry run after a merge. */
const RETRIED: ReadonlySet<AgentScenario> = new Set(["review", "brief", "rereview", "drive"]);

/** "13:45": a time later today, as a card says it. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The PR's host and "host/owner/name", for gh's GH_HOST and GH_REPO. */
export function ghTarget(prUrl: string, repo: string): Record<string, string> {
  try {
    const host = new URL(prUrl).hostname.toLowerCase();
    return /^[a-z0-9.-]+$/.test(host) && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ? { GH_HOST: host, GH_REPO: `${host}/${repo}` } : {};
  } catch {
    return {};
  }
}

/** The first message of a session Resume picks up again. */
export const RESUME_PROMPT = "The app running you closed while you worked and has started you again. Continue where you stopped and finish the task.";
/** …and of one with a publish wrapper, whose folder the app makes afresh. */
export const RESUME_PROMPT_WRAPPER = `${RESUME_PROMPT} Whatever you recorded through the publish wrapper before is gone: if you had recorded your review, replies or resolves already, record them again — once.`;

/** The rules every agent session gets on top of its prompt. */
/** The rules every agent session gets on top of its prompt — ending with how to close its final message for the card. */
export function agentRules(
  scenario: AgentScenario,
  mode: "shadow" | "on",
  folder: Pick<RunFolder, "wrapperPath" | "outDir"> | null = null,
  pr: RulesPr | null = null,
): string {
  return `${scenarioRules(scenario, mode, folder, pr)} ${resultRuleFor(scenario)}`;
}

/** The PR a session's rules name: its place, a drive's base, why it runs — and, in a GitHub stack, its layer (`stackRules`). */
interface RulesPr {
  repo: string;
  number: number;
  baseRef?: string;
  reasons?: readonly string[];
  stack?: string | null;
}

/** What a run on your own PR is for, on top of the drive rules. */
function driveFocus(reasons: readonly string[]): string {
  if (reasons.includes("self")) {
    return (
      "This is a self-review of the user's own PR, before reviewers see it. Run the review with dryRun: true — it must post nothing, and never call the publish wrapper for it. " +
      "Then validate its findings against the code and fix only the confirmed ones, one commit each. A finding that is a business, product or design decision is not yours to settle: change nothing for it and ask the user in the prd-result block. "
    );
  }
  if (reasons.includes("comments")) {
    return (
      "Reviewers commented on the user's PR. Validate every open comment against the head commit before changing code: fix the confirmed ones (a commit each) and answer in each thread — what you fixed, or why it doesn't hold — through the wrapper. " +
      "A comment that is a business, product or design decision is not yours to settle: change nothing for it, don't argue in the thread, and ask the user in the prd-result block, as a blocker finding. "
    );
  }
  return "";
}

function scenarioRules(
  scenario: AgentScenario,
  mode: "shadow" | "on",
  folder: Pick<RunFolder, "wrapperPath" | "outDir"> | null,
  pr: RulesPr | null,
): string {
  const stack = pr?.stack ?? null;
  const plan =
    "You run unattended as the user's PR agent. First write your plan as a task list with TaskCreate — one short task per step — and keep it current with TaskUpdate as you go, so the user can follow along. (A skill that runs as a Workflow shows its own phases; then no task list is needed.)" +
    (stack ? ` ${stack}` : "");
  const never =
    "Never push, and never try to work around a refused tool call: if something is refused, say what you would have done and continue without it.";
  const jira =
    "Read Jira and Confluence with the twg CLI (for example `twg jira workitem get KEY -o json --output-summary none`) — there is no Atlassian MCP in this session.";
  if (scenario === "brief") {
    return `${plan} Post nothing anywhere. ${jira} End with the brief itself as your final message. ${never}`;
  }
  if (scenario === "afterMerge") {
    return `${plan} This is a dry run: change nothing in Jira or anywhere else — read only, with twg and gh. ${jira} End with the changes you would make and the exact question to ask before making them, as your final message. ${never}`;
  }
  const later = mode === "shadow" ? " once the user approves it" : " right after this session";
  if (scenario === "drive") {
    // Forward slashes: the session passes these paths through Git Bash on Windows.
    const w = folder ? gitBashPath(folder.wrapperPath) : null;
    const out = folder?.outDir.replace(/\\/g, "/");
    const target = pr ? `${pr.repo} ${pr.number}` : "<owner/repo> <number>";
    return (
      `${plan} You work on the user's own PR${pr ? ` (${pr.repo}#${pr.number})` : ""}, in a detached checkout of its head. ` +
      driveFocus(pr?.reasons ?? []) +
      `Commit each fix with git (add, commit) and follow the repository's own conventions — read its CLAUDE.md and AGENTS.md first, since this session doesn't load them on its own — and end every commit message with the trailer "Co-Authored-By: Claude <noreply@anthropic.com>". ` +
      `Never push and never rewrite history (no rebase, no amend of a commit that was already there): the app pushes your commits to the PR's branch as a fast-forward${later}, after checking them. ` +
      // In a stack the layer's rules (in `plan`) say what to do about a conflict instead: nothing — the stack needs a rebase.
      (stack ? "" : `Resolve a conflict by merging the base branch in — it is fetched for you as ${pr?.baseRef ?? "<remote>/<base>"}; this session's git has no network — never by rebasing. `) +
      `CI runs once the app pushes, so don't wait for it. ` +
      (w ? `To answer a reviewer in a thread, write the reply to a file under ${out}/ and run \`${w} reply ${target} <comment-id> <file>\`; the app posts it after the push — or, when you commit nothing, on its own once the user sends it. ` : "") +
      `Find what to fix with gh, which already points at this PR's host and repository: the failing checks with \`gh pr checks ${pr?.number ?? "<number>"}\` and \`gh run view <run-id> --log-failed\`, the review threads with \`gh api repos/${pr?.repo ?? "<owner/repo>"}/pulls/${pr?.number ?? "<number>"}/comments\`. ` +
      `Leave .git, .github, .claude, .husky, .npmrc and git attributes alone. End with what you changed and why. ${never}`
    );
  }
  if (folder) {
    // Forward slashes: the session passes these paths through Git Bash on Windows.
    const out = folder.outDir.replace(/\\/g, "/");
    const w = gitBashPath(folder.wrapperPath);
    const target = pr ? `${pr.repo} ${pr.number}` : "<owner/repo> <number>";
    const threads =
      scenario === "rereview"
        ? `This is a re-review of a PR you reviewed before. After the workflow returns, finish its thread work through the same wrapper — the app checks every call and makes it when it publishes: ` +
          `each thread its result keeps open with reason "review-not-posted" is one it would have closed — if its verdict was "withdrawn" (the author's argument held), first reply in it with one line acknowledging the point (\`${w} reply ${target} <replyTo> <file>\`), then resolve it (\`${w} resolve <thread-id>\`); otherwise just resolve it. ` +
          `Where the author disagreed with a finding (rather than saying it is fixed) and the review keeps it as "still applies", don't argue with your colleague: run \`${w} escalate ${target} <replyTo> <file>\` with one line on what the disagreement is about — the app holds back any reply to that thread and asks the user. `
        : "";
    return (
      `${plan} Publishing goes through the app: run the review with dryRun: false and publishCommand: "${gitBashPath(folder.wrapperPath)}". ` +
      `That wrapper is the app's own — it records each write for the user and posts nothing; the app publishes what it recorded${later}. ` +
      `Write every file the wrapper takes (the review JSON, a comment JSON, a reply's text) under ${out}/ and pass that absolute path — nothing else is writable — and never call gh api for a write. ` +
      threads +
      // The publish check holds such a write back anyway; said here so the session doesn't spend its words on one.
      `Reply and resolve only in threads you opened (their first comment is yours — \`gh api user\` gives your login): never in a thread a colleague opened, even to follow up on it — put that point in the review body instead. The app holds back any reply or resolve in a colleague's thread and shows it to the user. ` +
      `${jira} End with a short summary of what you prepared${scenario === "rereview" ? ", resolved and escalated" : ""}. ${never}`
    );
  }
  return `${plan} This is a dry run: post NOTHING to GitHub; if your skill has a dry-run mode (dryRun: true), use it. ${jira} End with exactly what you would post — the summary, every inline comment with its file and line, and whether you would approve — as your final message. ${never}`;
}

/**
 * The prompt a run starts from. Your PR's runs differ by why they run: a
 * self-review before reviewers, reviewers' comments to check (and fix where
 * they hold), or a drive to green (CI, a conflict — comments with them too).
 */
export function promptFor(item: Pick<AgentItem, "scenario" | "reasons">, claude: ClaudeSettings): string {
  if (item.scenario === "drive") {
    const r = item.reasons ?? [];
    if (r.includes("self")) return claude.agentPrompts.selfReview || DEFAULT_AGENT_PROMPTS.selfReview;
    if (r.length > 0 && r.every((x) => x === "comments")) return claude.agentPrompts.validateComments || DEFAULT_AGENT_PROMPTS.validateComments;
    return claude.prompts.drive || DEFAULT_CLAUDE_PROMPTS.drive;
  }
  return promptForScenario(item.scenario, claude);
}

function promptForScenario(scenario: AgentScenario, claude: ClaudeSettings): string {
  if (scenario === "brief") return claude.agentPrompts.triage || DEFAULT_AGENT_PROMPTS.triage;
  if (scenario === "afterMerge") return claude.agentPrompts.afterMerge || DEFAULT_AGENT_PROMPTS.afterMerge;
  if (scenario === "rereview") return claude.agentPrompts.rereview || DEFAULT_AGENT_PROMPTS.rereview;
  if (scenario === "drive") return claude.prompts.drive || DEFAULT_CLAUDE_PROMPTS.drive;
  return claude.prompts.review || DEFAULT_CLAUDE_PROMPTS.review;
}

/** The head commit an item was keyed on ("<id>|<scenario>|<head>…"). */
function keyHead(key: string): string | null {
  const h = key.split("|")[2];
  return h && h !== "-" ? h : null;
}

/** When a re-review's trigger happened — the time in its key's cursor (`reply@…`, `asked@…`) — or null when none is known. */
function keyCursorTime(key: string): number | null {
  const at = key.split("|")[3]?.split("@")[1];
  const t = at && at !== "-" ? Date.parse(at) : NaN;
  return Number.isNaN(t) ? null : t;
}

/** Why the agent can't work on a PR's code. */
const noCheckoutWhy = (repo: string): string => `No checkout of ${repo} — set its folder in Settings › Claude`;

/** A host to leave alone for now: its last fetch failed, or its GitHub budget is nearly spent. */
export function hostHeld(snapshot: DashboardResponse | null, hostLabel: string): string | null {
  if (!snapshot) return null;
  if (snapshot.errors?.some((e) => e.hostLabel === hostLabel)) return "Host unreachable";
  const rl = snapshot.rateLimits?.find((r) => r.hostLabel === hostLabel);
  if (rl && typeof rl.limit === "number" && rl.limit > 0 && rl.remaining < rl.limit * 0.1) return "Waiting for the GitHub budget";
  return null;
}

interface Running {
  handle: RunHandle;
  progress: RunProgress;
  recent: Array<{ at: string; text: string }>;
  paused: boolean;
  /** Set by "Take over": once stopped, the session opens in your terminal. */
  takeOver: boolean;
  /** Paused by pausing the whole agent — resuming the agent resumes it; one you paused yourself stays paused. */
  byAgentPause: boolean;
  /** Stopped because the agent was switched off. */
  offStop: boolean;
}

/** What starts a session — refused while the agent is off; everything else is your own click and works. */
const STARTS_A_RUN: ReadonlySet<AgentAction["type"]> = new Set(["enqueue", "retry", "reviewAnyway", "answer"]);

export function createAgent(deps: AgentDeps): Agent {
  const now = deps.now ?? (() => new Date());
  const git = deps.git ?? runGit;
  const plugins = deps.plugins ?? (() => readInstalledPlugins());
  /** Set once everything the journal reads exists: the first saves of the constructor come before it. */
  let journalReady = false;
  const store: AgentStore = openStore(deps.dir, localDay(now()), () => {
    if (journalReady) observe();
  });
  const running = new Map<string, Running>();
  let idle: Record<string, string> = {};
  let heldUntil: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  // The journal's last look (`journal.ts`): each item's state as it was on
  // disk — so what the restart below changes is logged as a change — the
  // reasons the agent left PRs alone, what held the queue, and the settings.
  let itemMarks = new Map<string, ItemMark>(
    store.data.items.map((i) => [i.runId, { state: i.state, at: (i.state === "working" ? i.startedAt : i.state === "queued" ? i.queuedAt : i.finishedAt) ?? i.queuedAt }]),
  );
  /** Null until the first plan after a start (or after switching on): that one is the baseline, not a change. */
  let loggedIdle: Record<string, string> | null = null;
  let lastHold: string | null = null;
  /** The Board is logged while the agent is on — off, it writes nothing it would never prune. */
  let boardOn = false;
  {
    const s = (() => {
      try {
        return deps.loadSettings().agent;
      } catch {
        return null;
      }
    })();
    boardOn = s?.enabled === true;
    if (s?.enabled || store.data.items.length > 0) {
      const interrupted = store.data.items.filter((i) => i.state === "working").length;
      store.log({ at: now().toISOString(), kind: "agent", event: "start", data: { enabled: s?.enabled === true, paused: store.data.paused, items: store.data.items.length, interrupted, runsToday: store.data.runsToday } });
    }
  }

  // A run that was in flight when the app closed did not finish: say so now.
  // It goes on by itself once the PRs are known (`recoverInterrupted`).
  for (const item of store.data.items) {
    if (item.state === "working") markInterrupted(item, now().toISOString());
    // A drive's result from before this start: its push and its answer are
    // checked against what the app took in memory before the session
    // (`pushTo`), and that is gone — it can only be run again. Its card says
    // so instead of offering a push or an answer that would be refused.
    else if (item.scenario === "drive" && item.state === "needsYou" && !item.interrupted && !item.pushTo) item.needsRerun = true;
  }
  void store.save();

  const loadAll = (): Settings | null => {
    try {
      return deps.loadSettings();
    } catch {
      return null;
    }
  };
  const settings = (): AgentSettings | null => loadAll()?.agent ?? null;
  const changed = () => deps.onChange?.();
  const stamp = () => now().toISOString();
  const findItem = (runId: string) => store.data.items.find((i) => i.runId === runId);
  /** One of a run's own steps, in the log. */
  const logRun = (item: AgentItemRecord, event: string, extra: Partial<AgentLogEntry> = {}) => store.log({ at: stamp(), kind: "run", event, ...itemFields(item), ...extra });

  /**
   * The journal's look: every item whose state changed, every card that moved
   * on the Board, logged with how long it stood where it was. Runs before each
   * save, and after each plan — where GitHub alone may have moved a card.
   * True when a card moved: the Board's marks are part of the state to save.
   */
  function observe(snapshot: DashboardResponse | null = deps.getSnapshot()): boolean {
    const at = stamp();
    const items = diffItems(itemMarks, store.data.items, at);
    itemMarks = items.marks;
    for (const e of items.entries) store.log(e);
    if (!boardOn || !snapshot) return false;
    const ctx = { today: localDay(now()), idle, orchestrated: sdlcBadges };
    const failed = new Set((snapshot.errors ?? []).map((e) => e.hostLabel));
    const board = diffBoard(store.data.board ?? null, boardNow(snapshot.pullRequests, store.data.items, ctx), at, failed);
    for (const e of board.entries) store.log(e);
    store.data.board = board.marks;
    return board.entries.length > 0;
  }

  /** What holds the queue, logged when it changes: paused, quiet hours, the usage or daily limit, a host's budget. */
  function noteHold(hold: string | null): void {
    if (hold === lastHold) return;
    store.log({ at: stamp(), kind: "plan", event: hold ? "held" : "released", from: lastHold, to: hold });
    lastHold = hold;
  }
  const gh = deps.gh ?? runGh;
  /** Merge offers whose click is being carried out — a snapshot in between must not close them. */
  const merging = new Set<string>();
  /** The quiet-hours end last reported, so entering or leaving them is a change worth a push. */
  let lastQuiet: string | null = null;
  /**
   * The agent settings the last plan was made with. The poller reports a
   * snapshot only when the PRs change, so switching the agent on (or changing
   * what it takes) would otherwise wait for some PR to move. The first plan
   * is the poller's first snapshot, as before.
   */
  let plannedWith: string | null = JSON.stringify(settings());
  /** The agent settings the log last knew: a change is logged path by path, switching on and off by name. */
  let loggedSettings: AgentSettings | null = settings();
  function logSettings(s: AgentSettings | null): void {
    const was = loggedSettings?.enabled === true;
    const on = s?.enabled === true;
    // Edits while the agent is off are logged with switching it on — as one change.
    if (!was && !on) return;
    const changed = settingsDiff(loggedSettings, s);
    loggedSettings = s;
    if (!changed) return;
    store.log({ at: stamp(), kind: "agent", event: was !== on ? (on ? "on" : "off") : "settings", data: { changed } });
  }
  /** Snapshots in a row each live item's PR has been missing from (`goneItems`). */
  const missing = new Map<string, number>();

  /**
   * What no longer needs you closes quietly: the items of a PR that left the
   * dashboard (its worktree goes too when Settings › Agent says so), and a
   * newer run's predecessors (`supersede`).
   */
  function closeGone(snapshot: DashboardResponse, s: AgentSettings | null): void {
    const present = new Set(snapshot.pullRequests.map((p) => p.id));
    const failed = new Set((snapshot.errors ?? []).map((e) => e.hostLabel));
    for (const item of goneItems(store.data.items, present, failed, missing)) {
      if (s && !s.removeWorktree) item.worktree = undefined;
      void closeAs(item, AGENT_CLOSED.offDashboard);
    }
  }

  /** Your PR an SDLC orchestrator run drives: why the agent leaves it alone, or null. */
  function orchestrated(pr: PullRequest, claude: ClaudeSettings | undefined): string | null {
    const run = orchestratorRun(pr, claude);
    return run ? describeOrchestratorRun(run) : null;
  }
  function orchestratorRun(pr: PullRequest, claude: ClaudeSettings | undefined): OrchestratorRun | null {
    if (!claude) return null;
    return orchestratorRunFor(orchestratorRoots(deps.findCheckout(pr, claude), claude), pr.url);
  }
  /** The badges of the last plan: your PRs an SDLC run drives. */
  let sdlcBadges: Record<string, { key: string; stage: string | null }> = {};

  /** A newer run on a PR replaces what waited there in its lane: an older review, an older drive. */
  function supersede(fresh: AgentItemRecord): void {
    for (const old of supersededBy(store.data.items, fresh)) void closeAs(old, AGENT_CLOSED.superseded);
  }
  const announce = (item: AgentItemRecord, kind: AgentNotice["kind"]) => {
    logRun(item, "notice", { detail: kind });
    try {
      deps.notify?.({ kind, item: { ...item } });
    } catch {
      // A notification is best-effort.
    }
  };
  /**
   * A run the app's closing cut short — or whose process was ended under it:
   * held until the PRs are known (the next start, or the next snapshot), which
   * takes it up again.
   */
  function markInterrupted(item: AgentItemRecord, at: string, why = "the app closed while it ran"): void {
    item.state = "needsYou";
    item.headline = `Interrupted — ${why}`;
    item.interrupted = true;
    item.resumeSession = undefined;
    item.finishedAt = at;
    if (store.data.ledger[item.key]?.state === "started") store.data.ledger[item.key].state = "failed";
  }

  function pauseRun(item: AgentItemRecord, r: Running): void {
    r.handle.interrupt();
    r.paused = true;
    r.byAgentPause = true;
    item.headline = "Paused";
  }

  function resumeRun(item: AgentItemRecord, r: Running): void {
    r.handle.resume();
    r.paused = false;
    r.byAgentPause = false;
    item.headline = runningHeadline(item);
  }

  /**
   * Pauses or resumes the agent as a whole — the emergency stop. Paused,
   * nothing new starts, the runs in flight pause at their next safe point
   * (their time limit still runs), and a result that would go out on its own
   * waits for your Publish or Push. Resuming lets go of the runs it paused,
   * not the ones you paused yourself.
   */
  function setPaused(on: boolean): void {
    store.data.paused = on;
    for (const [runId, r] of running) {
      const item = findItem(runId);
      if (!item) continue;
      if (on && !r.paused) pauseRun(item, r);
      else if (!on && r.paused && r.byAgentPause) resumeRun(item, r);
    }
    void store.save();
    changed();
    if (!on) tick();
  }

  /**
   * Runs the app's closing cut short go on by themselves — they are not a
   * decision of yours. A review, a brief or the Jira run picks its session up
   * again where its folder is still there; a drive starts over as a new run
   * (its push is checked against what the app read before any session worked
   * in its folder), as does anything whose session or folder is gone. One
   * whose PR has left the dashboard ends as a note.
   */
  function recoverInterrupted(snapshot: DashboardResponse, s: AgentSettings): void {
    for (const item of store.data.items) {
      if (item.state !== "needsYou" || !item.interrupted) continue;
      const dir = item.worktree ?? (item.scenario === "afterMerge" ? path.join(deps.dir, "runs", item.runId, "cwd") : null);
      // Someone pushed while the app was closed: the session's folder holds the
      // old head, and what it would finish isn't about the PR any more (a review
      // of it couldn't even be sent). What you asked for starts over on the new
      // head; what the agent found itself is the plan's to decide again.
      const now = snapshot.pullRequests.find((p) => p.id === item.prId);
      const was = keyHead(item.key);
      const moved = Boolean(now?.headOid && was && now.headOid !== was);
      if (moved && !item.key.endsWith("|asked")) {
        logRun(item, "not-resumed", { detail: "the PR has a new head", headOid: now?.headOid, data: { was } });
        void closeAs(item, AGENT_CLOSED.superseded);
        continue;
      }
      if (moved) {
        logRun(item, "not-resumed", { detail: "the PR has a new head — asked again on it", headOid: now?.headOid, data: { was } });
        // Your ask goes first: a review or brief the agent queued on its own
        // for the new head would only replace what you asked for.
        if (FRESH_REVIEW.has(item.scenario)) {
          for (const other of store.data.items) {
            if (other.prId === item.prId && other.state === "queued" && FRESH_REVIEW.has(other.scenario) && !other.key.endsWith("|asked")) void closeAs(other, AGENT_CLOSED.superseded);
          }
        }
      }
      const busy = store.data.items.some((i) => i.prId === item.prId && i !== item && (i.state === "queued" || i.state === "working"));
      if (!moved && !busy && item.scenario !== "drive" && item.sessionId && dir && fs.existsSync(dir)) {
        item.state = "queued";
        item.interrupted = undefined;
        item.resumeSession = true;
        item.finishedAt = undefined;
        item.headline = item.cuts ? "Queued: going on — its process was ended" : "Queued: going on — the app closed while it ran";
        logRun(item, "resumed", { detail: item.cuts ? `after it was cut short (${item.cuts} in a row)` : "after a restart" });
        continue;
      }
      const pr = snapshot.pullRequests.find((p) => p.id === item.prId);
      if (busy || !pr || item.scenario === "merge" || item.scenario === "afterMerge") {
        void closeAs(item, item.headline);
        continue;
      }
      const found = item.scenario === "drive" ? driveReasons(pr, s) : undefined;
      const queued = enqueueAsked(pr, s, item.scenario, found && found.length === 0 ? ["self"] : (found ?? item.reasons));
      void closeAs(item, queued.ok ? AGENT_CLOSED.rerun : item.headline);
    }
  }

  /**
   * A review or brief the plan wants on a head you already asked the agent to
   * review or brief — whatever came of it; or a re-review of a head whose
   * re-review you asked for after its trigger (the author's answer, the new
   * request) — that run already saw it. A brief you asked for doesn't stop the
   * review: on a big PR that review is the brief's next step.
   */
  const FRESH_REVIEW: ReadonlySet<AgentScenario> = new Set(["review", "brief"]);
  function askedOfHead(job: Pick<AgentJob, "prId" | "key" | "scenario">): boolean {
    const head = keyHead(job.key);
    const asked = store.data.items.filter((i) => i.prId === job.prId && i.key.endsWith("|asked") && keyHead(i.key) === head);
    if (job.scenario === "review") return asked.some((i) => i.scenario === "review");
    if (FRESH_REVIEW.has(job.scenario)) return asked.some((i) => FRESH_REVIEW.has(i.scenario));
    if (job.scenario !== "rereview") return false;
    const trigger = keyCursorTime(job.key);
    return asked.some((i) => i.scenario === "rereview" && (trigger === null || Date.parse(i.queuedAt) >= trigger));
  }

  /** The closing lines of a run something else replaced or ended: they say nothing of how the head went. */
  const CLOSING_LINES: ReadonlySet<string> = new Set(Object.values(AGENT_CLOSED));

  /**
   * How the head's run went, in its own last line: the ledger's run, or — when
   * that one was only replaced or closed (run again, superseded) — the latest
   * run on the same PR and head that says more.
   */
  function headOutcome(job: Pick<AgentJob, "prId" | "key">, run: AgentItemRecord | undefined): string | null {
    const ended = (i: AgentItemRecord) => i.state !== "queued" && i.state !== "working" && !CLOSING_LINES.has(i.headline);
    if (run && ended(run)) return run.headline;
    const head = keyHead(job.key);
    const last = store.data.items
      .filter((i) => i.prId === job.prId && keyHead(i.key) === head && i.finishedAt && ended(i))
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];
    return last?.headline ?? null;
  }

  /**
   * Why the plan leaves a job to its ledger entry, in what really happened:
   * "Running" only while that run is live — a run that ended in a way the
   * ledger didn't follow (cut short, then replaced) says how it ended instead.
   */
  function ledgerIdle(job: Pick<AgentJob, "prId" | "key">, entry: LedgerEntry): string {
    const run = store.data.items.find((i) => i.runId === entry.runId);
    if (entry.state === "dismissed") return LEDGER_IDLE.dismissed;
    if (entry.state === "started" && run && (run.state === "queued" || run.state === "working")) return LEDGER_IDLE.started;
    const outcome = headOutcome(job, run);
    if (entry.state === "failed" && run?.state === "error") {
      if (run.retryAt) return `Its last run on this head failed (${run.headline}) — it tries again by itself at ${clockTime(run.retryAt)}`;
      return run.retryOf ? `Its run on this head failed twice (${run.headline}) — over to you` : `${LEDGER_IDLE.failed} (${run.headline})`;
    }
    if (!outcome) return LEDGER_IDLE[entry.state === "started" ? "prepared" : entry.state];
    return entry.state === "published" ? `Done for this head — ${outcome}` : `Its last run on this head ended: ${outcome}`;
  }

  /** The failed run of a ledger entry whose one try again is due now, or null. */
  function dueRetry(entry: LedgerEntry): AgentItemRecord | null {
    if (entry.state !== "failed") return null;
    const run = store.data.items.find((i) => i.runId === entry.runId);
    return run?.state === "error" && run.retryAt && Date.parse(run.retryAt) <= now().getTime() ? run : null;
  }

  /** A brief of this head was written — the agent's own or one you asked for: the policy's `briefDone`. */
  function briefDone(pr: Pick<PullRequest, "id" | "headOid">): boolean {
    const key = jobKey(pr, "brief");
    return [key, `${key}|asked`].some((k) => {
      const state = store.data.ledger[k]?.state;
      return state === "prepared" || state === "published";
    });
  }

  /**
   * The brief a big PR's review follows: its questions for the author go into
   * the review's prompt, its text onto the review's card — so what it found
   * stays readable once the review replaces it — and the brief itself closes.
   * Null when no brief of that head waits.
   */
  function takeBrief(prId: string, head: string | null): Pick<AgentItem, "carry" | "brief"> | null {
    const brief = store.data.items
      .filter((i) => i.prId === prId && i.scenario === "brief" && i.state === "needsYou" && keyHead(i.key) === head)
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];
    if (!brief) return null;
    const questions = brief.result?.authorQuestions ?? [];
    void closeAs(brief, AGENT_CLOSED.reviewed);
    return { ...(questions.length > 0 ? { carry: questions } : {}), ...(brief.output?.trim() ? { brief: brief.output } : {}) };
  }

  /** Scenarios that are offers with a button, never a session. */
  const OFFERS: ReadonlySet<AgentScenario> = new Set(["merge", "reapprove", "reask"]);

  /** The PR as the dashboard last saw it (merged ones drop out of the snapshot; their after-merge run still needs a name). */
  const snapshotPr = (prId: string) => deps.getSnapshot()?.pullRequests.find((p) => p.id === prId) ?? null;

  function newItem(job: Pick<AgentJob, "key" | "prId" | "prNumber" | "repo" | "url" | "scenario" | "mode" | "reasons">, pr: PullRequest, headline: string): AgentItemRecord {
    const item: AgentItemRecord = {
      runId: randomUUID(),
      key: job.key,
      prId: job.prId,
      prNumber: job.prNumber,
      repo: job.repo,
      url: job.url,
      title: pr.title,
      hostLabel: pr.hostLabel,
      scenario: job.scenario,
      mode: job.mode,
      state: "queued",
      headline,
      queuedAt: stamp(),
      ...(job.reasons ? { reasons: job.reasons } : {}),
    };
    store.data.items.push(item);
    // An offer (a merge, an approval to give again) is never queued: it waits for your click from the start.
    logRun(item, OFFERS.has(job.scenario) ? "offered" : "queued", {
      headOid: pr.headOid,
      detail: clip(headline),
      data: {
        mode: job.mode,
        ...(job.reasons ? { reasons: job.reasons } : {}),
        asked: job.key.endsWith("|asked"),
        size: { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles },
      },
    });
    return item;
  }

  /**
   * Off means off: runs in flight stop (their results wait for you, with the
   * reason), and nothing they prepared goes out on its own.
   */
  function stopRunsForOff(): void {
    for (const r of running.values()) {
      if (r.offStop) continue;
      r.offStop = true;
      r.handle.stop();
    }
  }

  /** Heads being read for dismissed approvals right now, and those to read again later after a failed read. */
  const reapproveChecks = new Set<string>();
  const reapproveRetry = new Map<string, number>();
  /** Offers being given right now — a second click waits for the first. */
  const reapproving = new Set<string>();

  /** Where a PR's head stands for re-approve / re-ask — the policy's `reapproveState`. */
  function reapproveState(pr: PullRequest, scenario: "reapprove" | "reask"): "unchecked" | "checking" | "same" | "pass" {
    const key = jobKey(pr, scenario);
    if (reapproveChecks.has(key) || (reapproveRetry.get(key) ?? 0) > now().getTime()) return "checking";
    const mark = store.data.reapprove?.[key];
    if (!mark) return "unchecked";
    if (mark.verdict !== "same") return "pass";
    // You turned the offer down: the other rules decide again.
    if (store.data.items.some((i) => i.key === key && i.state === "done" && i.headline === AGENT_CLOSED.dismissed)) return "pass";
    return "same";
  }

  /**
   * Reads the PR's dismissed approvals and diffs for this head (`./reapprove.ts`),
   * writes down what it found, and plans again with it. A failed read is tried
   * again ten minutes later; meanwhile nothing else starts on someone's PR.
   */
  function startReapprovalCheck(job: AgentJob, pr: PullRequest): void {
    // In flight, or failed lately: the plan it ends in must not start it again at once.
    if (reapproveChecks.has(job.key) || (reapproveRetry.get(job.key) ?? 0) > now().getTime()) return;
    reapproveChecks.add(job.key);
    const fields = { prId: pr.id, prNumber: pr.number, repo: pr.repo, scenario: job.scenario, ...(pr.headOid ? { headOid: pr.headOid } : {}) };
    void (async () => {
      try {
        // The push is checked in your clone of the repository: without one, nothing is given again.
        const claude = loadAll()?.claude;
        const checkout = claude ? deps.findCheckout(pr, claude) : null;
        const remote = checkout ? remoteFor(checkout, pr) : null;
        const found = await checkReapproval(
          gh,
          { id: pr.id, url: pr.url, repo: pr.repo, number: pr.number, headOid: pr.headOid },
          job.scenario === "reask" ? "reask" : "reapprove",
          checkout && remote ? { git, checkout, remote } : null,
        );
        if (stopped) return;
        const mark: ReapproveMark = {
          verdict: found.verdict,
          ...(found.logins.length > 0 ? { logins: found.logins } : {}),
          ...(found.oldHead ? { oldHead: found.oldHead } : {}),
          note: found.note,
          at: stamp(),
        };
        store.data.reapprove = { ...(store.data.reapprove ?? {}), [job.key]: mark };
        reapproveRetry.delete(job.key);
        store.log({ at: stamp(), kind: "plan", event: "reapprove-check", ...fields, detail: clip(found.note), data: { verdict: found.verdict, ...(found.logins.length > 0 ? { logins: found.logins } : {}) } });
      } catch (e) {
        reapproveRetry.set(job.key, now().getTime() + 10 * 60_000);
        store.log({ at: stamp(), kind: "plan", event: "reapprove-check", ...fields, detail: clip(`couldn't check: ${(e as Error).message}`), data: { verdict: "error" } });
      } finally {
        reapproveChecks.delete(job.key);
      }
      if (stopped) return;
      void store.save();
      const snapshot = deps.getSnapshot();
      if (snapshot) onSnapshot(snapshot);
      changed();
    })();
  }

  /** The offer for a head found "same" — once; true when it was made now. In On, it is given at once. */
  function offerReapproval(job: AgentJob, pr: PullRequest, mark: ReapproveMark): boolean {
    // Offered, given or turned down already; one that only lapsed comes back.
    if (store.data.items.some((i) => i.key === job.key && !(i.state === "done" && i.headline === AGENT_CLOSED.gone))) return false;
    const logins = mark.logins ?? [];
    const item = newItem(job, pr, job.scenario === "reask" ? `Only the base changed — ask ${logins.join(", ")} again` : "Only the base changed — approve again");
    item.reapproval = { logins, oldHead: mark.oldHead ?? "" };
    item.state = "needsYou";
    item.finishedAt = stamp();
    if (job.mode === "on") void giveAgain(item, false);
    else announce(item, "needsYou");
    return true;
  }

  /**
   * Gives a dismissed approval again (`reapprove`) or asks your reviewers again
   * (`reask`) — on your click, or in On right after the check. The PR is read
   * again first: closed, pushed to since, or already approved / asked, and
   * nothing goes out.
   */
  async function giveAgain(item: AgentItemRecord, byYou: boolean): Promise<AgentActionResult> {
    const all = loadAll();
    const head = keyHead(item.key);
    const r = item.reapproval;
    if (!all || !head || !r?.oldHead) return { ok: false, error: "This offer has nothing to give again." };
    const again = item.scenario === "reapprove";
    reapproving.add(item.runId);
    const refuse = (error: string): AgentActionResult => {
      logRun(item, again ? "not-reapproved" : "not-reasked", { headOid: head, detail: clip(error), data: { byYou } });
      item.headline = `Not ${again ? "approved again" : "asked again"} — ${error}`;
      void store.save();
      changed();
      if (!byYou) announce(item, "failed");
      return { ok: false, error };
    };
    try {
      const read = await fresh(item, snapshotPr(item.prId)?.roles ?? [again ? "reviewed" : "author"]);
      if (!read.ok) return refuse(read.error);
      const { pr, state } = read.fresh;
      if (state !== "OPEN") {
        await closeAs(item, AGENT_CLOSED.gone);
        return { ok: false, error: `The PR was ${state.toLowerCase()} already.` };
      }
      if (pr.headOid !== head) return refuse("there are new commits since — the new head is checked on its own");
      let req;
      let logins: string[] = [];
      if (again) {
        if (pr.viewerApproved) {
          await closeAs(item, "You approved it again yourself");
          return { ok: true };
        }
        req = reapproveRequest(item.repo, item.prNumber, head, r.oldHead, all.agent.policy.signature);
      } else {
        // Not who approved since, or is asked already.
        const settled = new Set(pr.reviewers.filter((x) => x.reviewState !== "changes_requested").map((x) => x.login.toLowerCase()));
        logins = r.logins.filter((l) => !settled.has(l.toLowerCase()));
        if (logins.length === 0) {
          await closeAs(item, "Your reviewers are asked again already");
          return { ok: true };
        }
        req = reaskRequest(item.repo, item.prNumber, logins);
      }
      item.headline = again ? "Approving again…" : "Asking again…";
      changed();
      const res = await gh(ghApiArgs(req, item.url), { input: JSON.stringify(req.body) });
      if (res.code !== 0) return refuse(`GitHub refused it: ${ghError(res)}`);
      item.state = "done";
      item.published = true;
      item.finishedAt = stamp();
      item.headline = again ? `Approved again — only the base changed since ${r.oldHead.slice(0, 7)}` : `Asked ${logins.join(", ")} again — only the base changed`;
      store.data.ledger[item.key] = { state: "published", at: item.finishedAt, runId: item.runId };
      logRun(item, again ? "reapproved" : "reasked", { headOid: head, detail: item.headline, data: { byYou, mode: item.mode, oldHead: r.oldHead, ...(again ? {} : { logins }) } });
      void store.save();
      changed();
      if (!byYou) announce(item, "finished");
      return { ok: true };
    } finally {
      reapproving.delete(item.runId);
    }
  }

  /** PRs being approved again right now — a second click waits for the first. */
  const approvingAgain = new Set<string>();

  /**
   * Your approval again, on your click, on a PR it already stands on: a review
   * requested of you after it keeps the PR listed as asked of you, and only a
   * new review answers that. The PR is read again first — it must still be open,
   * at the head on the card, with your approval standing on that head and
   * nothing from the author since — and what goes out is one line and the
   * signature, on that head. Nothing else: no session, no item.
   */
  async function approveAgain(prId: string, all: Settings): Promise<AgentActionResult> {
    const pr = snapshotPr(prId);
    if (!pr?.headOid) return { ok: false, error: "The PR isn't on the dashboard any more." };
    if (!deps.fetchPr) return { ok: false, error: "The app can't read the PR here." };
    if (approvingAgain.has(prId)) return { ok: false, error: "It is being approved again already." };
    approvingAgain.add(prId);
    try {
      let read: FreshPullRequest | null;
      try {
        read = await deps.fetchPr({ id: pr.id, hostLabel: pr.hostLabel, roles: pr.roles });
      } catch (e) {
        return { ok: false, error: `Couldn't read the PR: ${(e as Error).message}` };
      }
      if (!read) return { ok: false, error: "The PR is gone or out of reach." };
      if (read.state !== "OPEN") return { ok: false, error: `The PR was ${read.state.toLowerCase()} already.` };
      if (read.pr.headOid !== pr.headOid) return { ok: false, error: "There are new commits since — it needs a review, not your approval again." };
      if (!approvalStands(read.pr)) return { ok: false, error: "Your approval no longer stands on this head, or the author answered since — review it again instead." };
      const req = approveAgainRequest(pr.repo, pr.number, pr.headOid, all.agent.policy.signature);
      const res = await gh(ghApiArgs(req, pr.url), { input: JSON.stringify(req.body) });
      if (res.code !== 0) return { ok: false, error: `GitHub refused it: ${ghError(res)}` };
      store.log({ at: stamp(), kind: "run", event: "approved-again", prId: pr.id, prNumber: pr.number, repo: pr.repo, headOid: pr.headOid, detail: "Approved again on your click — the request came after your approval of this head" });
      return { ok: true };
    } finally {
      approvingAgain.delete(prId);
    }
  }

  /** Heads being checked for "only the base changed" right now, and those to check again later after a failed check. */
  const baseOnlyChecks = new Set<string>();
  const baseOnlyRetry = new Map<string, number>();

  /** Where a reviewed PR's pushed head stands — the policy's `baseOnlyState`. */
  function baseOnlyState(pr: PullRequest): "unchecked" | "checking" | "same" | "changed" {
    const key = jobKey(pr, "rereview", "base");
    if (baseOnlyChecks.has(key) || (baseOnlyRetry.get(key) ?? 0) > now().getTime()) return "checking";
    const mark = store.data.baseOnly?.[key];
    // Compared with another review of yours than the latest, or for another base (the PR was retargeted since): look again.
    if (!mark || mark.oldHead !== pr.viewerReviewedOid || mark.baseRefName !== pr.baseRefName) return "unchecked";
    return mark.verdict;
  }

  /**
   * Checks in your clone whether a reviewed PR's new head is the change you
   * reviewed on a new base (`sameChangeOnNewBase`), writes down what it found
   * and plans again with it. No clone: "changed", the re-review runs as it
   * always did. A failed check is tried again ten minutes later.
   */
  function startBaseOnlyCheck(job: AgentJob, pr: PullRequest): void {
    if (baseOnlyChecks.has(job.key) || (baseOnlyRetry.get(job.key) ?? 0) > now().getTime()) return;
    const oldHead = pr.viewerReviewedOid;
    const newHead = pr.headOid;
    if (!oldHead || !newHead) return;
    baseOnlyChecks.add(job.key);
    const fields = { prId: pr.id, prNumber: pr.number, repo: pr.repo, scenario: job.scenario, headOid: newHead };
    void (async () => {
      try {
        const claude = loadAll()?.claude;
        const checkout = claude ? deps.findCheckout(pr, claude) : null;
        const remote = checkout ? remoteFor(checkout, pr) : null;
        const found = await checkBaseOnly(
          gh,
          { id: pr.id, url: pr.url, repo: pr.repo, number: pr.number, headOid: newHead, baseRefName: pr.baseRefName, viewerReviewedAt: pr.viewerReviewedAt, viewerReviewedOid: oldHead },
          checkout && remote ? { git, checkout, remote } : null,
        );
        if (stopped) return;
        const mark: BaseOnlyMark = { verdict: found.verdict, oldHead, baseRefName: found.baseRefName, note: found.note, at: stamp() };
        store.data.baseOnly = { ...(store.data.baseOnly ?? {}), [job.key]: mark };
        baseOnlyRetry.delete(job.key);
        store.log({ at: stamp(), kind: "plan", event: "base-check", ...fields, detail: clip(mark.note), data: { verdict: mark.verdict, oldHead, ...(pr.stack ? { stack: pr.stack.number, layer: pr.stack.position } : {}) } });
      } catch (e) {
        baseOnlyRetry.set(job.key, now().getTime() + 10 * 60_000);
        store.log({ at: stamp(), kind: "plan", event: "base-check", ...fields, detail: clip(`couldn't check: ${(e as Error).message}`), data: { verdict: "error", oldHead } });
      } finally {
        baseOnlyChecks.delete(job.key);
      }
      if (stopped) return;
      void store.save();
      const snapshot = deps.getSnapshot();
      if (snapshot) onSnapshot(snapshot);
      changed();
    })();
  }

  function onSnapshot(snapshot: DashboardResponse): void {
    const s = settings();
    plannedWith = JSON.stringify(s);
    logSettings(s);
    // Housekeeping holds whether the agent is on or off.
    closeGone(snapshot, s);
    if (!s?.enabled) {
      idle = Object.fromEntries(snapshot.pullRequests.map((p) => [p.id, "The agent is off"]));
      sdlcBadges = {};
      stopRunsForOff();
      // Switched on again, the journal starts from where things stand then.
      loggedIdle = null;
      noteHold(null);
      if (boardOn) {
        boardOn = false;
        store.data.board = undefined;
        void store.save();
      }
      return;
    }
    boardOn = true;
    recoverInterrupted(snapshot, s);
    const own = new Set(store.data.items.filter((i) => i.state === "working" && i.sessionId).map((i) => i.sessionId!));
    const sessions = deps.getSessions().filter((x) => !own.has(x.id));
    let dirty = false;
    // Drive attempts start over once CI is green, or once someone else pushed
    // (the head is no longer the one the agent pushed).
    for (const pr of snapshot.pullRequests) {
      const d = store.data.drive[pr.id];
      if (!d) continue;
      const green = driveReasons(pr, s).length === 0;
      const someoneElse = d.agentHead !== undefined && pr.headOid !== null && pr.headOid !== d.agentHead;
      if (green || someoneElse) {
        delete store.data.drive[pr.id];
        dirty = true;
      }
    }
    const claudeSettings = loadAll()?.claude;
    const badges: Record<string, { key: string; stage: string | null }> = {};
    // One look for a clone per repository and plan: the search reads every
    // folder's git config. The SDLC roots likewise, once per clone.
    const clones = new Map<string, string | null>();
    const cloneOf = (pr: PullRequest): string | null => {
      const repoUrl = pr.url.replace(/\/pull\/\d+.*$/, "");
      if (!clones.has(repoUrl)) clones.set(repoUrl, claudeSettings ? deps.findCheckout(pr, claudeSettings) : null);
      return clones.get(repoUrl) ?? null;
    };
    const rootsByClone = new Map<string | null, string[]>();
    const sdlcRun = (pr: PullRequest): OrchestratorRun | null => {
      if (!claudeSettings) return null;
      const clone = cloneOf(pr);
      let roots = rootsByClone.get(clone);
      if (!roots) rootsByClone.set(clone, (roots = orchestratorRoots(clone, claudeSettings)));
      return orchestratorRunFor(roots, pr.url);
    };
    const plan = planJobs(snapshot.pullRequests, s, {
      noCheckout: (pr) => (cloneOf(pr) ? null : noCheckoutWhy(pr.repo)),
      hasOwnSession: (pr) => sessionsForPr(pr, sessions).length > 0,
      driveExhausted: (pr) => {
        const d = store.data.drive[pr.id];
        return d && d.attempts >= s.scenarios.driveCi.maxAttempts ? `Yours — the agent tried ${d.attempts} time${d.attempts === 1 ? "" : "s"}; over to you` : null;
      },
      selfReviewed: (pr) => Boolean(store.data.ledger[jobKey(pr, "drive", "self")]) || (pr.headOid !== null && store.data.pushedHeads[pr.id] === pr.headOid),
      briefDone,
      reapproveState,
      baseOnlyState,
      orchestrated: (pr) => {
        const run = sdlcRun(pr);
        if (!run) return null;
        badges[pr.id] = { key: run.key, stage: run.stage ? run.stage.replace(/_/g, " ") : null };
        return describeOrchestratorRun(run);
      },
    });
    sdlcBadges = badges;
    idle = Object.fromEntries(plan.idle);
    sweepWorktrees();
    const byId = new Map(snapshot.pullRequests.map((p) => [p.id, p]));
    const wanted = new Set(plan.jobs.map((j) => j.key));
    for (const job of plan.jobs) {
      const before = store.data.ledger[job.key];
      // A run of this head failed and its one try again is due: it goes ahead as a new run.
      const retryOf = before ? dueRetry(before) : null;
      if (before && !retryOf) {
        // Shown only while the PR has no live item: then it is Idle, and this says why.
        idle[job.prId] = ledgerIdle(job, before);
        continue;
      }
      if (store.data.items.some((i) => i.key === job.key && (i.state === "queued" || i.state === "working"))) continue;
      // You asked for a review or a brief of this very head: the agent doesn't
      // draft another of it on its own — run after yours, it would replace it.
      if (askedOfHead(job)) {
        idle[job.prId] = "You asked the agent about this head yourself";
        continue;
      }
      if (retryOf) delete store.data.ledger[job.key];
      // A big PR's review follows its brief: closed first, so the review doesn't
      // merely supersede it, and what it found travels with the review.
      const brief = job.scenario === "review" ? takeBrief(job.prId, keyHead(job.key)) : null;
      const headline = brief ? "Queued: review — after its brief" : retryOf ? `Queued: trying again — the last run failed (${retryOf.headline})` : queuedHeadline(job);
      const item = newItem(job, byId.get(job.prId)!, headline);
      if (brief) Object.assign(item, brief);
      if (retryOf) {
        // The failed run's result goes now (`supersede`), and this one is not tried a third time.
        item.retryOf = retryOf.runId;
        retryOf.retryAt = undefined;
      }
      supersede(item);
      dirty = true;
    }
    // A failure the plan no longer points at — a new head, the request gone —
    // won't be tried again: its card stops saying it will.
    for (const item of store.data.items) {
      if (item.state === "error" && item.retryAt && !wanted.has(item.key)) {
        item.retryAt = undefined;
        dirty = true;
      }
    }
    // A queued job the PR no longer wants (you reviewed it, it went away) leaves
    // quietly — unless you asked for it yourself. The Jira dry run after a merge
    // is for a PR the snapshot no longer has, by design.
    for (const item of store.data.items) {
      if (item.state === "queued" && item.scenario !== "afterMerge" && !wanted.has(item.key) && !item.key.endsWith("|asked")) {
        item.state = "done";
        item.headline = AGENT_CLOSED.gone;
        item.finishedAt = stamp();
        dirty = true;
      }
    }
    // Your PRs ready to merge: an offer with a button, once per head commit —
    // a dismissed offer stays dismissed until someone pushes.
    const offered = new Set(plan.merges.map((j) => j.key));
    for (const job of plan.merges) {
      // An offer that only lapsed (CI ran again on the same head) comes back; a dismissed or merged one doesn't.
      if (store.data.items.some((i) => i.key === job.key && !(i.state === "done" && i.headline === AGENT_CLOSED.gone))) continue;
      const pr = byId.get(job.prId)!;
      const item = newItem(job, pr, "Ready to merge");
      item.state = "needsYou";
      item.finishedAt = stamp();
      item.mergeMethods = pr.mergeMethods;
      item.mergeMethod = chooseMergeMethod(pr, s.scenarios.merge.method) ?? undefined;
      if (item.mergeMethod) item.headline = `Ready to merge — ${item.mergeMethod}`;
      announce(item, "needsYou");
      dirty = true;
    }
    for (const item of store.data.items) {
      if (item.scenario === "merge" && item.state === "needsYou" && !offered.has(item.key) && !merging.has(item.runId)) {
        item.state = "done";
        item.headline = AGENT_CLOSED.gone;
        item.finishedAt = stamp();
        dirty = true;
      }
    }
    // Approvals a base-only push dismissed: read once per head, then offered
    // (Shadow) or given again (On). An offer the plan no longer points at — you
    // approved yourself, someone pushed — leaves quietly.
    const reoffered = new Set(plan.reapprovals.map((j) => j.key));
    for (const job of plan.reapprovals) {
      const pr = byId.get(job.prId)!;
      const mark = store.data.reapprove?.[job.key];
      if (!mark) startReapprovalCheck(job, pr);
      else if (mark.verdict === "same" && offerReapproval(job, pr, mark)) dirty = true;
    }
    for (const item of store.data.items) {
      if ((item.scenario === "reapprove" || item.scenario === "reask") && item.state === "needsYou" && !reoffered.has(item.key) && !reapproving.has(item.runId)) {
        item.state = "done";
        item.headline = AGENT_CLOSED.gone;
        item.finishedAt = stamp();
        dirty = true;
      }
    }
    if (store.data.reapprove) {
      for (const key of Object.keys(store.data.reapprove)) {
        if (!byId.has(key.split("|")[0])) {
          delete store.data.reapprove[key];
          dirty = true;
        }
      }
    }
    // Re-reviews after a push alone: checked once per head whether only the base moved under your review.
    for (const job of plan.baseChecks) startBaseOnlyCheck(job, byId.get(job.prId)!);
    if (store.data.baseOnly) {
      for (const key of Object.keys(store.data.baseOnly)) {
        if (!byId.has(key.split("|")[0])) {
          delete store.data.baseOnly[key];
          dirty = true;
        }
      }
    }
    // Why the agent leaves each PR alone, where that changed since the last plan.
    if (loggedIdle) for (const e of diffIdle(loggedIdle, idle, stamp(), byId)) store.log(e);
    loggedIdle = { ...idle };
    // GitHub alone may have moved a card (a review came in, CI went green): the Board's marks are state too.
    if (observe(snapshot)) dirty = true;
    if (dirty) {
      void store.save();
      changed();
    }
    tick();
  }

  async function run(item: AgentItemRecord, pr: PullRequest | null, all: Settings): Promise<void> {
    const s = all.agent;
    /** How the session went, once it has ended — on the run's end line, failed or not. */
    let endStats: Record<string, unknown> | undefined;
    const fail = (headline: string, error?: string) => {
      item.state = "error";
      item.headline = headline;
      item.error = error;
      item.finishedAt = stamp();
      // Tried once more by itself a while later — most failures are the network
      // or a clone busy for a moment. Not your own ask (yours to repeat), not a
      // run that is a try again already, not one cut short again and again.
      if (RETRIED.has(item.scenario) && !item.key.endsWith("|asked") && !item.retryOf && !headline.startsWith("Cut short")) {
        item.retryAt = new Date(now().getTime() + RETRY_AFTER_MS).toISOString();
      }
      // Recorded even when the run never started, or every tick would queue the
      // same PR again; a new head commit is a new key and gets another try.
      store.data.ledger[item.key] = { state: "failed", at: item.finishedAt, runId: item.runId };
      logRun(item, "failed", {
        detail: clip(error ? `${headline}: ${error}` : headline, 1500),
        ...(item.sessionId ? { sessionId: item.sessionId } : {}),
        ...(endStats ? { ...(typeof endStats.ms === "number" ? { ms: endStats.ms } : {}), data: endStats } : {}),
      });
      void store.save();
      changed();
      announce(item, "failed");
    };
    const kind = runKindOf(item.scenario);
    const runDir = path.join(deps.dir, "runs", item.runId);

    // Where the session works: a worktree of the PR's head for a review or a
    // brief; an empty folder for the Jira dry run, which needs no code.
    let checkout: string | null = null;
    let remote: string | null = null;
    // Resume: the same session again, in the folder it worked in.
    const resume = item.resumeSession === true && item.sessionId ? item.sessionId : null;
    const resumeDir = resume ? (item.worktree ?? (item.scenario === "afterMerge" ? path.join(runDir, "cwd") : null)) : null;
    if (resume && (!resumeDir || !fs.existsSync(resumeDir))) {
      item.resumeSession = undefined;
      return fail("Can't resume — its folder is gone; run it again");
    }
    if (item.scenario !== "afterMerge" && !resume) {
      if (!pr) return;
      checkout = deps.findCheckout(pr, all.claude);
      if (!checkout) return fail(noCheckoutWhy(pr.repo));
      remote = remoteFor(checkout, pr);
      if (!remote) return fail(`No remote of ${checkout} points at ${pr.repo}`);
    }

    store.data.ledger[item.key] = { state: "started", at: stamp(), runId: item.runId };
    store.data.runsToday += 1;
    item.state = "working";
    item.startedAt = stamp();
    item.headline = runningHeadline(item);
    item.resumeSession = undefined;
    // What an earlier run of this item showed (Resume, an answer) gives way to this run's.
    for (const k of ["output", "result", "plan", "planHash", "planEdited", "drive", "error", "published", "pushed", "interrupted"] as const) delete item[k];
    const answer = item.answer;
    item.answer = undefined;
    if (!resume) item.checkout = checkout ?? undefined;
    void store.save();
    changed();

    let dir: string;
    if (resume && resumeDir) {
      // A drive never resumes (see `act`), so no push needs preparing here.
      dir = resumeDir;
      checkout = item.checkout ?? null;
    } else if (pr && checkout && remote) {
      try {
        dir = await prepareWorktree(git, { checkout, remote, base: worktreeBase(s.worktreeDir, checkout), pr, runId: item.runId });
      } catch (e) {
        return fail("Could not check out the PR", (e as Error).message);
      }
      item.worktree = dir;
      if (kind === "drive") {
        // Before the session: the base branch fetched (the session's git has no
        // network), and what a push will need — the remote's URL now, and a
        // fingerprint of what git would run code from.
        try {
          // Hooks off here too: a fetch runs reference-transaction.
          const clone = checkout;
          const [url, commonDir, worktreeGitDir] = await withNoHooks(async (h) => {
            if (isPlainBranch(pr.baseRefName)) {
              await git([...safeGit(h), "fetch", "--no-tags", remote, `+refs/heads/${pr.baseRefName}:refs/remotes/${remote}/${pr.baseRefName}`], clone).catch(() => {});
            }
            return [
              (await git([...safeGit(h), "remote", "get-url", "--push", remote], clone)).trim(),
              path.resolve(dir, (await git([...safeGit(h), "rev-parse", "--git-common-dir"], dir)).trim()),
              path.resolve(dir, (await git([...safeGit(h), "rev-parse", "--git-dir"], dir)).trim()),
            ];
          });
          const place: GitPlace = { workTree: dir, gitDir: worktreeGitDir };
          // An SSH remote: your SSH settings resolved now, kept in memory — no file a session could reach.
          const ssh = snapshotSsh(url, deps.sshResolve ?? ((args) => execFileSync("ssh", args, { encoding: "utf8", timeout: 15_000, env: launcherEnv(process.env), stdio: ["ignore", "pipe", "ignore"] })));
          item.pushTo = { url, commonDir, worktreeGitDir, fingerprint: await gitFingerprint(git, place, commonDir, url), ...(ssh !== null ? { sshSnapshot: ssh } : {}) };
        } catch (e) {
          return fail("Could not prepare the drive", (e as Error).message);
        }
      }
    } else {
      dir = path.join(runDir, "cwd");
      fs.mkdirSync(dir, { recursive: true });
    }

    // A review's publish step goes through the app's wrapper; without a usable
    // folder for it the review runs as a plain dry run (text only).
    // A drive answers reviewers through the wrapper too — only that.
    const subs = kind === "drive" ? (["reply"] as const) : undefined;
    // On Resume the folder is made afresh too (the same path — the session
    // knows it): nothing recorded before the app closed is trusted.
    const folder =
      (kind === "review" || kind === "rereview" || kind === "drive") && deps.captureScript
        ? prepareRunFolder(
            runFolderRoots(checkout ? worktreeBase(s.worktreeDir, checkout) : null),
            item.runId,
            { repo: item.repo, number: item.prNumber },
            deps.execPath,
            deps.captureScript,
            subs ? [...subs] : undefined,
          )
        : null;
    if (folder) item.runFolder = folder.runDir;

    const fromPlugins = resolveSkillRefs(renderAgentPrompt(promptFor(item, all.claude), "", item.url), plugins());
    const mine = mountUserSkills(fromPlugins.prompt, plugins(), path.join(runDir, "user-skills"), deps.userSkillsDir);
    const pluginDirs = [...fromPlugins.pluginDirs, ...mine.pluginDirs];
    const settingsFile = path.join(runDir, "settings.json");
    const guardFile = path.join(runDir, "guard.json");
    const hooksDir = freshHooksDir(runDir);
    const sessionId = resume ?? randomUUID();
    writeGuardFile(guardFile, {
      ...(folder ? { wrapperPath: folder.wrapperPath, outDir: folder.outDir } : {}),
      ...(subs ? { subs: [...subs] } : {}),
      // Relative paths mean the run's folder; a drive changes files there only.
      workDir: dir,
      // The read tools read the run's own folders and nothing else — not your
      // home folder, gh's or ssh's keys, this app's settings.
      readDirs: [dir, ...(folder ? [folder.outDir] : []), ...pluginDirs],
      sessionId,
      sessionRoots: claudeSessionRoots(launcherEnv(process.env)),
      // A skill's Workflow may run its script from the plugins this run mounted — never one from the PR.
      workflowDirs: pluginDirs,
    });
    writeRunSettings(settingsFile, hookCommand(deps.execPath, deps.hookScript, kind, item.url, guardFile));
    item.sessionId = sessionId;
    logRun(item, resume ? (answer ? "answered" : "resumed") : "started", {
      ...(answer ? { detail: clip(answer) } : {}),
      headOid: pr?.headOid ?? keyHead(item.key) ?? undefined,
      sessionId,
      // Where it ran, so a run can be found again: the folder its transcript is filed under.
      data: {
        cwd: dir,
        mode: item.mode,
        model: s.model,
        effort: s.effort,
        ...(item.reasons ? { reasons: item.reasons } : {}),
        // How long it stood in the queue (a resumed run's queue time is its first run's).
        ...(!resume ? { waitedMs: Math.max(0, Date.parse(item.startedAt ?? stamp()) - Date.parse(item.queuedAt)) } : {}),
      },
    });

    // The wrapper's own rule, and Write — which the guard holds to the payload folder.
    const allowedTools = [...new Set([...s.permissions.tools[kind], ...(folder ? [`Bash(${gitBashPath(folder.wrapperPath)} *)`, "Write"] : [])])];
    // Read-only runs may read the plugins' folders (a skill's Workflow reads its script from there); a run that edits never gets them.
    const addDirs = [...(folder ? [folder.outDir] : []), ...pluginDirs];

    const entry: Running = { handle: null as unknown as RunHandle, progress: null as unknown as RunProgress, recent: [], paused: false, takeOver: false, byAgentPause: false, offStop: false };
    const handle = startRun(
      {
        cwd: dir,
        sessionId,
        ...(resume ? { resume: true } : {}),
        kind,
        prompt: resume
          ? answer
            ? answerMessage(answer, Boolean(folder))
            : folder
              ? RESUME_PROMPT_WRAPPER
              : RESUME_PROMPT
          : item.carry?.length
            ? `${mine.prompt}\n\nA brief of this PR raised these questions for its author — ask the ones that still hold in your review, as comments:\n${item.carry.map((q) => `- ${q}`).join("\n")}`
            : mine.prompt,
        appendSystemPrompt: agentRules(item.scenario, item.mode, folder, {
          repo: item.repo,
          number: item.prNumber,
          ...(kind === "drive" && pr && remote ? { baseRef: `${remote}/${pr.baseRefName}` } : {}),
          ...(item.reasons ? { reasons: item.reasons } : {}),
          stack: pr ? stackRules(pr, item.scenario) : null,
        }),
        allowedTools,
        pluginDirs,
        addDirs,
        model: s.model,
        effort: s.effort,
        settingsFile,
        timeoutMs: s.limits.maxMinutes * 60_000,
        env: {
          // No hook of the repository in any session; and no push from anywhere
          // in a drive session: the app pushes after checking the commits.
          ...sessionGitEnv(hooksDir, kind === "drive"),
          // gh reads this PR's own host and repository. It can't tell them from
          // git in a drive (every remote URL is rewritten there), and without
          // a host it would ask github.com — the wrong place for an Enterprise PR.
          ...ghTarget(item.url, item.repo),
        },
      },
      (progress) => {
        if (progress.activity && progress.activity !== entry.progress?.activity) {
          entry.recent = [...entry.recent, { at: stamp(), text: progress.activity }].slice(-RECENT_MAX);
        }
        entry.progress = progress;
        if (progress.rateLimit && progress.rateLimit.status !== "allowed" && progress.rateLimit.resetsAt) {
          heldUntil = progress.rateLimit.resetsAt * 1000;
        }
        changed();
      },
      deps.spawner,
    );
    entry.handle = handle;
    entry.progress = handle.progress();
    running.set(item.runId, entry);
    // Paused while it was getting ready: it starts paused too.
    if (store.data.paused) pauseRun(item, entry);
    void store.save();
    changed();

    const outcome = await handle.done;
    running.delete(item.runId);
    // The app is closing: `stop` has marked the item interrupted and saved it.
    if (stopped) return;
    const result = outcome.progress.result;
    item.finishedAt = stamp();
    endStats = runStats(item, outcome, item.finishedAt, { takeOver: entry.takeOver, offStop: entry.offStop });
    // Ended under it — a Windows restart, Ctrl+C, a workflow still running —
    // rather than by you, by its time limit, or by finishing.
    const cut = entry.takeOver || entry.offStop || outcome.stopped || outcome.timedOut ? null : cutShort(outcome);
    if (!cut) item.cuts = undefined;
    let publishNow = false;
    let pushNow = false;
    // A finished review or brief gets its diagrams before it reaches you: still
    // "working", its slot stays taken and nothing can be sent without them.
    const finished = !cut && !entry.takeOver && !entry.offStop && !outcome.stopped && !outcome.timedOut && result && !result.isError && result.subtype === "success";
    if (finished && pr && wantsDiagrams(item.scenario, pr, s.diagrams)) {
      item.headline = "Drawing diagrams";
      changed();
      await drawFor(item, pr, result.text, s);
      // The app closed meanwhile: `stop` has written the run down as interrupted.
      if (stopped) return;
    }
    // A run that asks nothing of you — you took it over, stopped it, or it
    // ran out of time or found nothing to post — is a note on its card.
    if (entry.takeOver) {
      item.state = "done";
      item.headline = "You took it over in your terminal";
      store.data.ledger[item.key].state = "failed";
      if (deps.openResume) {
        await deps.openResume(dir, sessionId).catch((e) => {
          item.headline = `Could not open your terminal: ${(e as Error).message}`;
        });
      }
    } else if (entry.offStop) {
      item.state = "done";
      item.headline = "Stopped — the agent was switched off";
      store.data.ledger[item.key].state = "failed";
    } else if (outcome.stopped) {
      item.state = "done";
      item.headline = "Stopped by you";
      store.data.ledger[item.key].state = "failed";
    } else if (outcome.timedOut) {
      item.state = "done";
      item.headline = `Stopped after ${s.limits.maxMinutes} min`;
      store.data.ledger[item.key].state = "failed";
    } else if (cut) {
      // Nothing it said yet is its answer. It goes on by itself, like a run the
      // app's closing cut short — until that has happened too often in a row.
      item.cuts = (item.cuts ?? 0) + 1;
      if (item.cuts > CUT_RESUMES) fail(`Cut short ${item.cuts} times in a row`, `${cut} — run it again once that is sorted out`);
      else markInterrupted(item, item.finishedAt, cut);
    } else if (result && !result.isError && result.subtype === "success") {
      item.state = "needsYou";
      // The card's summary, questions and findings; the rest is the full report.
      const read = parseRunResult(result.text, item.scenario);
      item.output = read.body;
      item.result = read.card;
      store.data.ledger[item.key].state = "prepared";
      // Read once: the summary you are shown and its fingerprint come from the same text.
      const planText = folder ? readPlanText(folder.runDir) : "";
      const steps = readPlanLines(planText);
      if (item.scenario === "brief") {
        item.headline = "Brief ready";
      } else if (item.scenario === "afterMerge") {
        item.headline = "Jira dry run ready — apply it in a session";
      } else if (item.scenario === "drive") {
        const base = keyHead(item.key) ?? pr?.headOid ?? "";
        const place = item.pushTo?.worktreeGitDir ? { workTree: dir, gitDir: item.pushTo.worktreeGitDir } : undefined;
        // Nothing of the repository's is read before it is known unchanged:
        // a config the session altered could make even `git log` start a program.
        const same = place && item.pushTo ? (await gitFingerprint(git, place, item.pushTo.commonDir, item.pushTo.url).catch(() => "")) === item.pushTo.fingerprint : false;
        const read = !same
          ? { error: "the repository's git config, hooks or links changed during the run — the app read nothing from it" }
          : await withNoHooks((h) => collectDrive(git, dir, base, item.reasons ?? [], h, place)).catch((e: Error) => ({ error: e.message }));
        if ("error" in read) {
          fail("Couldn't read the run's commits", read.error);
        } else if (read.drive.commits.length === 0) {
          item.drive = read.drive;
          if (steps.length > 0) {
            // Nothing to fix in the code, yet answers for the reviewers — a
            // decision, a "not a defect": with no push to ride on, they go out
            // by themselves, on your Send (in On right away, unless it asks you
            // something first — the answers may hang on that).
            item.plan = summarizePlan(steps);
            item.planHash = planHash(planText);
            item.headline = `Would post: ${describePlan(item.plan)}`;
            publishNow = item.mode === "on" && (item.result?.asks.length ?? 0) === 0;
          } else {
            item.headline = "No commits — see what it found";
          }
        } else if (!read.fastForward) {
          fail("The run rewrote the branch's history — nothing to push", "The app pushes fast-forwards only; run it again.");
        } else if (read.merges > 0 && pr?.stack) {
          fail("The run made a merge commit in a stacked PR — nothing to push", `A stack merges only with a linear history; ${STACK_REBASE_HINT}.`);
        } else {
          item.drive = read.drive;
          if (steps.length > 0) {
            item.plan = summarizePlan(steps);
            item.planHash = planHash(planText);
          }
          const n = read.drive.commits.length;
          const last = read.drive.commits[n - 1].subject;
          if (!s.permissions.pushOwnBranch) {
            item.headline = `Prepared ${n} commit${n === 1 ? "" : "s"} — pushing is off in Settings › Agent`;
          } else {
            item.headline = `Would push ${n} commit${n === 1 ? "" : "s"}: ${last}`;
            pushNow = item.mode === "on";
          }
        }
      } else if (steps.length > 0) {
        item.plan = await summarizeReview(item, steps);
        item.planHash = planHash(planText);
        item.headline = `Would post: ${describePlan(item.plan)}`;
        // A write held back is yours to answer: On waits for you rather than send the rest past it.
        publishNow = item.mode === "on" && !item.plan.held?.length;
      } else {
        // Nothing captured to post: there's nothing to send — the report says what it found.
        item.state = "done";
        // Your approval already stands on this head: the review had nothing to add to it — say so.
        const current = snapshotPr(item.prId);
        item.headline = current && approvalStands(current) && current.headOid === keyHead(item.key) ? "Already approved on this head — nothing to post" : "Reviewed — nothing to post";
      }
    } else {
      // `fail` saves, logs and tells; the rest of this function only cleans up.
      fail("The run failed", result?.text || outcome.stderr.trim().split("\n").slice(-3).join(" ") || `exit ${outcome.exitCode}`);
    }
    // Nothing to post, nothing asked, nothing major found: no decision is left.
    // Its diagrams go out with the review, as one comment of their own.
    if (item.plan && postsDiagrams(item, s) && item.headline.startsWith("Would post: ")) {
      item.plan.diagrams = item.diagrams!.list.length;
      item.headline = `Would post: ${describePlan(item.plan)}`;
    }
    if ((item.state as AgentItem["state"]) === "needsYou" && !item.interrupted && nothingForYou(item)) item.state = "done";
    // `fail` changes the state behind TypeScript's back; read it afresh.
    const ended = item.state as AgentItem["state"];
    if (ended !== "error") {
      logRun(item, item.interrupted ? "interrupted" : ended, {
        sessionId,
        detail: clip(item.headline),
        ...(typeof endStats.ms === "number" ? { ms: endStats.ms } : {}),
        data: {
          ...endStats,
          // What it prepared: the review it would post, the commits, the questions it left you.
          ...(item.plan ? { plan: describePlan(item.plan), comments: item.plan.comments.length, replies: item.plan.replies.length, escalations: item.plan.escalations.length } : {}),
          ...(item.drive ? { commits: item.drive.commits.length } : {}),
          ...(item.result ? { asks: item.result.asks.length, findings: item.result.findings.length, structured: item.result.structured } : {}),
          ...(publishNow ? { publishNow: true } : {}),
          ...(pushNow ? { pushNow: true } : {}),
        },
      });
    }
    // Only a result you still have to look at keeps its worktree (to continue the session in it) —
    // and a run you took over, whose session goes on in your terminal there.
    if (ended !== "needsYou" && !entry.takeOver) await dropWorktree(item);
    void store.save();
    changed();
    // Paused or off, nothing goes out on its own: it waits for your Publish or Push.
    // Read now, not at the start: the run may have taken half an hour.
    if ((publishNow || pushNow) && (store.data.paused || !settings()?.enabled)) {
      publishNow = false;
      pushNow = false;
      item.headline = `${item.headline} — held: the agent is ${store.data.paused ? "paused" : "off"}`;
    }
    if (publishNow) {
      // On: the app posts what the review prepared, with the same checks as your Publish.
      await publishItem(item, all, false);
    } else if (pushNow) {
      // On: the app pushes the drive's commits, with the same checks as your Push.
      await pushItem(item, all);
    }
    // Planned again at once, not at the next poll: the PR's reason says how
    // this run ended instead of a stale "Running", and what follows starts — a
    // big PR's review takes its brief over, so that review is what comes to
    // you; only a brief no review follows (reviews off, the request gone)
    // waits for you as it is. Not after a run you took over — the plan's
    // worktree sweep could take its folder from under the session your
    // terminal is still opening — nor one cut short, whose recovery is the
    // next plan's (`recoverInterrupted`), nor one the agent's switching off ended.
    if (!stopped && !entry.takeOver && !entry.offStop && !item.interrupted) {
      const snapshot = deps.getSnapshot();
      if (snapshot) onSnapshot(snapshot);
    }
    // Read afresh: the plan may have closed it (a brief its review took over).
    const after = item.state as AgentItem["state"];
    if (publishNow || pushNow) {
      // Their own result says what went out.
    } else if (after === "needsYou" && !item.interrupted) {
      // An interrupted run asks nothing of you: it goes on by itself.
      announce(item, "needsYou");
    } else if (after === "done" && ended === "done" && !entry.takeOver && !entry.offStop && !outcome.stopped) {
      // What you did yourself isn't news to you.
      announce(item, "finished");
    }
    tick();
  }

  /** Worktrees being removed right now — a sweep and a close never race on one. */
  const dropping = new Set<string>();

  /**
   * Removes an item's worktree — unless your session works in it: "Continue in
   * session" resumes the run's session there, and removing a folder under it
   * deletes its files from under you (on Windows the folder itself stays,
   * empty, and git run in it then finds the checkout above it). A folder kept
   * for that, or one something else still holds, keeps `item.worktree`, so the
   * sweep tries again once it is free.
   */
  async function dropWorktree(item: AgentItemRecord): Promise<void> {
    if (!item.worktree || !item.checkout) {
      item.worktree = undefined;
      return;
    }
    if (item.sessionId && deps.getSessions().some((x) => x.id === item.sessionId)) return;
    const dir = item.worktree;
    if (dropping.has(dir)) return;
    dropping.add(dir);
    try {
      await removeWorktree(git, item.checkout, dir);
      item.worktree = undefined;
    } catch {
      // Still in use: left for the next sweep.
    } finally {
      dropping.delete(dir);
    }
  }

  /** Worktrees of finished items that could not go when they finished (a session in them, a lock): tried again. */
  function sweepWorktrees(): void {
    const left = store.data.items.filter((i) => (i.state === "done" || i.state === "error") && i.worktree);
    if (left.length === 0) return;
    void (async () => {
      for (const item of left) await dropWorktree(item);
      void store.save();
    })();
  }
  let lastSweep = 0;

  /** Closes an item a newer one replaced; it leaves the Board without a "Done today" card. */
  async function closeAs(item: AgentItemRecord, headline: string): Promise<void> {
    item.state = "done";
    item.headline = headline;
    item.finishedAt = stamp();
    await dropWorktree(item);
    dropRunFolder(item);
    void store.save();
    changed();
  }

  function dropRunFolder(item: AgentItemRecord): void {
    if (!item.runFolder) return;
    fs.rmSync(item.runFolder, { recursive: true, force: true });
    item.runFolder = undefined;
  }

  /** The PR read again — what posting and merging check against, never the snapshot. */
  async function fresh(item: AgentItemRecord, roles: PullRequest["roles"]): Promise<{ ok: true; fresh: FreshPullRequest } | { ok: false; error: string }> {
    if (!deps.fetchPr) return { ok: false, error: "The app can't read the PR here." };
    try {
      const f = await deps.fetchPr({ id: item.prId, hostLabel: item.hostLabel, roles });
      return f ? { ok: true, fresh: f } : { ok: false, error: "The PR is gone or out of reach." };
    } catch (e) {
      return { ok: false, error: `Couldn't read the PR: ${(e as Error).message}` };
    }
  }

  /**
   * A review's plan as the card shows it, with its replies and resolves in
   * colleagues' threads set aside (`held`): a review answers only in threads
   * you opened, and finding that out on Approve failed the whole publish —
   * the approve with it — over a write you never needed to send. When the PR
   * or your login can't be read now, nothing is set aside here and the check
   * at publish refuses such a write with its reason, as before.
   */
  async function summarizeReview(item: AgentItemRecord, steps: readonly PublishStep[]): Promise<PublishSummary> {
    const plan = summarizePlan(steps);
    if (!steps.some((st) => st.kind === "reply" || st.kind === "resolve")) return plan;
    const read = await fresh(item, snapshotPr(item.prId)?.roles ?? ["reviewer"]);
    if (!read.ok || !read.fresh.viewer) return plan;
    const held = await heldWrites(steps, item.url, item.repo, item.prNumber, read.fresh.viewer, gh).catch(() => []);
    if (held.length === 0) return plan;
    const heldReplies = new Set(held.flatMap((h) => (h.replyTo !== undefined ? [h.replyTo] : [])));
    plan.replies = plan.replies.filter((r) => !heldReplies.has(r.replyTo));
    plan.resolves -= held.filter((h) => h.kind === "resolve").length;
    plan.held = held.map((h) => (h.body !== undefined && h.body.length > 4_000 ? { ...h, body: `${h.body.slice(0, 4_000)}…` } : h));
    return plan;
  }

  /**
   * Posts what a review prepared — on your Publish (`byYou`) or, in On, right
   * after the run. The PR is read again first: a new push since the review
   * stops it (the review would talk about code that isn't the head), as does
   * a PR that was merged or closed.
   */
  /** Draws the PR's diagrams after its review or brief (`./diagrams.ts`) and writes down how it went. */
  async function drawFor(item: AgentItemRecord, pr: PullRequest, text: string, s: AgentSettings): Promise<void> {
    const out = await drawDiagrams(
      {
        url: item.url,
        repo: item.repo,
        number: item.prNumber,
        title: pr.title,
        summary: parseRunResult(text, item.scenario).card.summary,
        model: s.diagrams.model,
        cwd: path.join(deps.dir, "runs", item.runId, "diagrams"),
      },
      { gh, spawner: deps.spawner ?? spawnClaude, ...(deps.checkMermaid ? { check: deps.checkMermaid } : {}) },
    );
    item.diagrams = out.diagrams;
    logRun(item, "diagrams", {
      detail: clip(out.diagrams.note ?? `${out.diagrams.list.length} drawn`),
      ms: out.ms,
      data: {
        count: out.diagrams.list.length,
        checked: out.diagrams.checked,
        ...(out.diagrams.existingUrl ? { existing: out.diagrams.existingUrl } : {}),
        ...(out.costUsd !== undefined ? { costUsd: out.costUsd } : {}),
      },
    });
  }

  /** A review whose diagrams go out with it (Settings › Agent › Diagrams › Post them with the review). */
  function postsDiagrams(item: AgentItemRecord, s: AgentSettings): boolean {
    return item.scenario === "review" && s.diagrams.post && (item.diagrams?.list.length ?? 0) > 0;
  }

  /**
   * The diagrams as the review's last write: rendered in the app's own mermaid
   * first, and only while the PR has no Mermaid diagram yet — another tool, or
   * a colleague, may have posted one since they were drawn.
   */
  async function diagramNote(item: AgentItemRecord, s: AgentSettings): Promise<PublishStep | null> {
    const d = item.diagrams;
    if (!d || !postsDiagrams(item, s)) return null;
    const hold = (why: string): null => {
      logRun(item, "diagrams-held", { detail: why });
      return null;
    };
    if (!d.checked) {
      const ok = deps.checkMermaid ? await deps.checkMermaid(d.list.map((x) => x.source)).catch(() => null) : null;
      if (!ok || ok.length !== d.list.length) return hold("not checked — no window could render them");
      d.list = d.list.filter((_, i) => ok[i]);
      d.checked = true;
      if (d.list.length === 0) return hold("none of them renders");
    }
    const existing = await existingDiagramUrl(gh, item.url, item.repo, item.prNumber);
    if (existing === undefined) return hold("couldn't read the PR's comments to check for a diagram there");
    if (existing) {
      d.existingUrl = existing;
      return hold("the PR has a Mermaid diagram already");
    }
    const body = diagramComment(d.list);
    return body ? { kind: "note", body, label: "diagrams comment" } : null;
  }

  async function publishItem(item: AgentItemRecord, all: Settings, byYou: boolean): Promise<AgentActionResult> {
    const refuse = (error: string): AgentActionResult => {
      logRun(item, "not-published", { detail: clip(error), data: { byYou } });
      item.state = "needsYou";
      item.headline = `Not published — ${error}`;
      void store.save();
      changed();
      announce(item, "failed");
      return { ok: false, error };
    };
    if (!item.runFolder || !item.plan) return { ok: false, error: "Nothing prepared to publish." };
    if (item.published) return { ok: false, error: "It is published already." };
    // A drive here has nothing to push, only its answers to your reviewers (see `act`).
    const drive = item.scenario === "drive";
    const read = await fresh(item, snapshotPr(item.prId)?.roles ?? [drive ? "author" : "reviewer"]);
    if (!read.ok) return refuse(read.error);
    const { pr, state, viewer } = read.fresh;
    if (state !== "OPEN") return refuse(`the PR was ${state.toLowerCase()} since`);
    const head = item.plan.commitId ?? keyHead(item.key);
    if (head && pr.headOid && pr.headOid !== head) return refuse(`there are new commits since this ${drive ? "run" : "review"} — run it again`);
    const me = viewer?.toLowerCase();
    const holdApprove =
      all.agent.scenarios.review.holdApproveOnChangeRequest && pr.reviewers.some((r) => r.reviewState === "changes_requested" && r.login.toLowerCase() !== me);
    item.headline = "Publishing…";
    changed();
    const rr = item.scenario === "rereview" ? all.agent.scenarios.rereview : null;
    // Threads where the author pushed back and you dropped your comment: answered and resolved with the review.
    const dropped = (item.plan.escalations ?? []).filter((e) => item.disputes?.[String(e.replyTo)] === "drop");
    const extra = dropped.length > 0 ? disputeSteps(dropped, item.disputes ?? {}, await threadIdsByFirstComment(item.url, item.repo, item.prNumber, gh)) : [];
    // Last, so a retry finds every earlier write at the same place.
    const note = await diagramNote(item, all.agent);
    if (note) extra.push(note);
    item.plan.diagrams = note ? item.diagrams?.list.length : undefined;
    const out = await publishPlan(
      item.runFolder,
      item.url,
      {
        repo: item.repo,
        number: item.prNumber,
        signature: all.agent.policy.signature,
        holdApprove,
        ...(rr ? { allowResolve: rr.resolve, allowApprove: rr.approve } : {}),
        ...(item.plan.held?.length ? { held: item.plan.held } : {}),
      },
      // A review answers and resolves only in threads you opened; your own PR's
      // drive answers reviewers in theirs and resolves nothing, as after a push.
      { viewer, mine: !drive },
      gh,
      item.planHash,
      extra,
    );
    if (!out.ok && out.changed) {
      // Edited in the session since you saw it: show the new plan, post nothing.
      if (publishedCount(item.runFolder) > 0) return refuse("part of it went out already and the rest changed in the session — run it again");
      const text = readPlanText(item.runFolder);
      item.plan = drive ? summarizePlan(readPlanLines(text)) : await summarizeReview(item, readPlanLines(text));
      if (postsDiagrams(item, all.agent)) item.plan.diagrams = item.diagrams!.list.length;
      item.planHash = planHash(text);
      item.planEdited = true;
      item.state = "needsYou";
      item.headline = `Would post: ${describePlan(item.plan)} — changed in the session, check it again`;
      logRun(item, "not-published", { detail: "the plan changed in the session since it was shown", data: { byYou } });
      void store.save();
      changed();
      return { ok: false, error: "It changed in the session since you saw it — check what it would post now, then Publish." };
    }
    if (!out.ok) {
      return refuse(out.posted > 0 ? `posted ${out.posted} of ${out.total}, then stopped: ${out.error}` : `nothing was posted: ${out.error}`);
    }
    item.published = true;
    item.state = "done";
    const held = holdApprove && item.plan.event === "APPROVE";
    item.headline = held ? `Published: ${describePlan({ ...item.plan, event: "COMMENT" })} (approve held)` : `Published: ${describePlan(item.plan)}`;
    item.finishedAt = stamp();
    store.data.ledger[item.key] = { state: "published", at: item.finishedAt, runId: item.runId };
    // Published as the run prepared it — not after an edit in the session.
    if (byYou && item.mode === "shadow" && !item.planEdited) store.data.acceptedUnchanged += 1;
    logRun(item, "published", {
      headOid: head ?? undefined,
      sessionId: item.sessionId,
      detail: describePlan(item.plan),
      // Who sent it, and whether it went out as prepared: what the Shadow → On hint counts.
      data: { byYou, mode: item.mode, edited: item.planEdited === true, ...(held ? { approveHeld: true } : {}), ...(item.disputes ? { disputes: item.disputes } : {}) },
    });
    await dropWorktree(item);
    void store.save();
    changed();
    announce(item, "finished");
    return { ok: true };
  }

  /**
   * Merges your PR on your click: read again, still ready by the same rules,
   * at the head you were offered — and `--match-head-commit` makes GitHub
   * refuse it if a push lands in between. Then the Jira dry run, if there is a
   * prompt for it.
   */
  /**
   * Pushes a drive's commits to your PR's branch — on your Push, or in On
   * right after the run. Read again first: the branch must still be at the
   * head the run started from (else someone pushed meanwhile), and the
   * commits must sit on top of it, since `git push` without --force sends a
   * fast-forward only. Then the replies the run prepared, if any.
   */
  async function pushItem(item: AgentItemRecord, all: Settings): Promise<AgentActionResult> {
    const refuse = (error: string): AgentActionResult => {
      logRun(item, "not-pushed", { detail: clip(error) });
      item.state = "needsYou";
      item.headline = `Not pushed — ${error}`;
      void store.save();
      changed();
      announce(item, "failed");
      return { ok: false, error };
    };
    if (item.pushed) return { ok: false, error: "It is pushed already." };
    if (!item.drive || item.drive.commits.length === 0) return { ok: false, error: "There is nothing to push." };
    if (!all.agent.permissions.pushOwnBranch) return { ok: false, error: "Pushing is off in Settings › Agent › Permissions." };
    if (!item.worktree || !item.checkout || !fs.existsSync(item.worktree)) return refuse("the run's checkout is gone — run it again");
    if (!item.pushTo?.worktreeGitDir) return refuse("the run didn't record where to push — run it again");
    // Every app git command names the worktree's git folder outright: a
    // rewritten .git file can't send it elsewhere.
    const place: GitPlace = { workTree: item.worktree, gitDir: item.pushTo.worktreeGitDir };
    // What git would read must be what it was before the session.
    const fingerprint = await gitFingerprint(git, place, item.pushTo.commonDir, item.pushTo.url).catch(() => "");
    if (fingerprint !== item.pushTo.fingerprint) {
      return refuse("the repository's git config, hooks or links changed during the run — nothing pushed; look at them before anything else");
    }
    const read = await fresh(item, snapshotPr(item.prId)?.roles ?? ["author"]);
    if (!read.ok) return refuse(read.error);
    const { pr, state, viewer } = read.fresh;
    if (state !== "OPEN") return refuse(`the PR was ${state.toLowerCase()} since`);
    if (pr.isCrossRepository) return refuse("its branch is in a fork");
    if (pr.headOid !== item.drive.base) return refuse("someone pushed to the branch since — run it again on the new head");
    // What is in the checkout now — "Continue in session" may have added
    // commits. A Push sends only what you were shown: anything new goes back
    // on the Board for you to look at first.
    const drive = item.drive;
    const pushTo = item.pushTo;
    const worktree = item.worktree;
    const outcome = await withNoHooks(async (hooksDir): Promise<string | null> => {
      const now = await collectDrive(git, worktree, drive.base, drive.reasons, hooksDir, place).catch((e: Error) => ({ error: e.message }));
      if ("error" in now) return `couldn't read the commits: ${now.error}`;
      if (!now.fastForward) return "the commits rewrite the branch's history — the app pushes fast-forwards only";
      // A stack merges only with a linear history: a merge commit in a layer blocks the whole stack's merge.
      if (now.merges > 0 && pr.stack) return `a merge commit in a stacked PR would break the stack's linear history — ${STACK_REBASE_HINT}`;
      if (now.drive.head !== drive.head) {
        item.drive = now.drive;
        return `there are commits you haven't seen — look at the ${now.drive.commits.length} commits again, then Push`;
      }
      item.headline = "Pushing…";
      changed();
      try {
        await withSshSnapshot(pushTo.sshSnapshot, (sshFile) => git(pushArgs(pushTo.url, drive.head, pr.headRefName, hooksDir, place, sshFile), worktree));
      } catch (e) {
        return `git refused the push: ${(e as Error).message}`;
      }
      return null;
    }).catch((e: Error) => e.message);
    if (outcome) return refuse(outcome);
    const head = drive.head;
    const n = item.drive.commits.length;
    item.pushed = true;
    item.finishedAt = stamp();
    const d = store.data.drive[item.prId] ?? { attempts: 0 };
    store.data.drive[item.prId] = { attempts: d.attempts + 1, agentHead: head };
    // A head the agent pushed is not one to self-review again.
    store.data.pushedHeads[item.prId] = head;
    store.data.ledger[item.key] = { state: "published", at: item.finishedAt, runId: item.runId };
    logRun(item, "pushed", { headOid: head, sessionId: item.sessionId, detail: `${n} commit(s)`, data: { attempt: store.data.drive[item.prId].attempts, mode: item.mode } });
    let headline = `Pushed ${n} commit${n === 1 ? "" : "s"}`;
    // The open layers above a stacked PR are off its new head now: GitHub
    // doesn't rebase them on a push, and the agent never rebases.
    const above = stackLayer(pr)?.above ?? [];
    if (above.length > 0) headline += ` — the ${above.length === 1 ? "layer above (#" + above[0] + ") needs" : `${above.length} layers above (${above.map((x) => `#${x}`).join(", ")}) need`} Rebase stack`;
    // The run's answers to reviewers go out once the code they talk about is on the branch.
    if (item.runFolder && item.plan && item.plan.replies.length > 0) {
      const out = await publishPlan(
        item.runFolder,
        item.url,
        { repo: item.repo, number: item.prNumber, signature: all.agent.policy.signature, holdApprove: false },
        // Your own PR: answering reviewers in their threads is the point; it resolves nothing.
        { viewer, mine: false },
        gh,
        // Only the replies you were shown.
        item.planHash,
      );
      if (!out.ok) {
        item.state = "needsYou";
        item.headline = out.changed
          ? `${headline}; the replies changed in the session since you saw them — none posted, run it again`
          : `${headline}; the replies stopped after ${out.posted} of ${out.total}: ${out.error}`;
        void store.save();
        changed();
        announce(item, "failed");
        return { ok: true };
      }
      headline += `, answered ${out.total} thread${out.total === 1 ? "" : "s"}`;
    }
    item.state = "done";
    item.headline = headline;
    await dropWorktree(item);
    dropRunFolder(item);
    void store.save();
    changed();
    announce(item, "finished");
    return { ok: true };
  }

  async function mergeItem(item: AgentItemRecord, all: Settings, picked?: MergeMethod): Promise<AgentActionResult> {
    const s = all.agent;
    const head = keyHead(item.key);
    if (!head) return { ok: false, error: "This offer has no head commit to merge." };
    merging.add(item.runId);
    try {
      const read = await fresh(item, snapshotPr(item.prId)?.roles ?? ["author"]);
      if (!read.ok) return { ok: false, error: read.error };
      const { pr, state } = read.fresh;
      if (state !== "OPEN") {
        await closeAs(item, AGENT_CLOSED.gone);
        return { ok: false, error: `The PR was ${state.toLowerCase()} already.` };
      }
      if (pr.headOid !== head) return { ok: false, error: "There are new commits since this offer — wait for the next one." };
      const blocker = mergeBlocker(pr, s);
      if (blocker) {
        item.headline = `Not ready any more — ${blocker}`;
        changed();
        return { ok: false, error: blocker };
      }
      const method = chooseMergeMethod(pr, s.scenarios.merge.method, picked);
      if (!method) return { ok: false, error: "The repository allows none of merge, squash and rebase." };
      // Not the branch other open PRs are built on: their base would go with it.
      const dependents = s.scenarios.merge.deleteBranch ? builtOn(pr, deps.getSnapshot()?.pullRequests ?? []) : [];
      const deleteBranch = s.scenarios.merge.deleteBranch && dependents.length === 0;
      item.headline = `Merging (${method})…`;
      changed();
      const r = await gh(mergeArgs(item.url, method, head, deleteBranch));
      if (r.code !== 0) {
        logRun(item, "not-merged", { headOid: head, detail: clip(ghError(r)) });
        item.headline = `GitHub refused the merge — ${ghError(r)}`;
        void store.save();
        changed();
        return { ok: false, error: ghError(r) };
      }
      const queued = /merge queue/i.test(`${r.stdout}\n${r.stderr}`);
      item.state = "done";
      item.mergeMethod = method;
      const kept = dependents.length ? `, branch kept — ${dependents.map((n) => `#${n}`).join(", ")} build${dependents.length === 1 ? "s" : ""} on it` : "";
      item.headline = queued ? "Added to the merge queue" : `Merged (${method})${deleteBranch ? ", branch deleted" : kept}`;
      item.finishedAt = stamp();
      store.data.ledger[item.key] = { state: "published", at: item.finishedAt, runId: item.runId };
      logRun(item, queued ? "queued-to-merge" : "merged", { headOid: head, detail: method });
      if (!queued && all.claude.agentPrompts.afterMerge.trim()) {
        newItem({ key: `${item.prId}|afterMerge|${head}`, prId: item.prId, prNumber: item.prNumber, repo: item.repo, url: item.url, scenario: "afterMerge", mode: "on" }, pr, "Queued: the Jira dry run");
      }
      void store.save();
      changed();
      announce(item, "finished");
      tick();
      return { ok: true };
    } finally {
      merging.delete(item.runId);
    }
  }

  /** Plans again with the last snapshot when the agent's settings changed since the last plan. */
  function replanIfSettingsChanged(all: Settings | null = loadAll()): boolean {
    if (JSON.stringify(all?.agent ?? null) === plannedWith) return false;
    const snapshot = deps.getSnapshot();
    if (!snapshot) return false;
    onSnapshot(snapshot);
    changed();
    return true;
  }

  function tick(): void {
    if (stopped) return;
    // One read of settings.json per tick. A plan ends in a tick of its own.
    const all = loadAll();
    if (replanIfSettingsChanged(all)) return;
    const s = all?.agent;
    if (!all || !s?.enabled) {
      if (!s?.enabled) stopRunsForOff();
      return;
    }
    const day = localDay(now());
    if (store.data.day !== day) {
      store.data.day = day;
      store.data.runsToday = 0;
      store.prune(s.policy.logRetentionDays, now().getTime());
    }
    const quiet = quietUntil(now(), s.limits.quietHours);
    if (quiet !== lastQuiet) {
      lastQuiet = quiet;
      changed();
    }
    // Every ten minutes, whatever else holds: a session you closed frees its folder.
    if (now().getTime() - lastSweep > 600_000) {
      lastSweep = now().getTime();
      sweepWorktrees();
    }
    // Runs the app's closing cut short are sorted out by the next plan first
    // (`recoverInterrupted`): a run queued beside one could otherwise take its PR.
    if (store.data.items.some((i) => i.state === "needsYou" && i.interrupted)) return;
    // Your order first (dragged, or "Run next"), then the oldest.
    const queued = queueOrder(store.data.items.filter((i) => i.state === "queued"));
    // Paused: nothing starts, whoever asked.
    if (store.data.paused) return noteHold(queued.length > 0 ? "paused" : null);
    if (heldUntil !== null && now().getTime() < heldUntil) {
      return noteHold(queued.length > 0 ? `Claude usage limit until ${new Date(heldUntil).toISOString()}` : null);
    }
    heldUntil = null;
    const snapshot = deps.getSnapshot();
    const byId = new Map((snapshot?.pullRequests ?? []).map((p) => [p.id, p]));
    /** Why queued runs wait this tick — a full house of parallel runs is the queue working, not a hold. */
    const holds = new Set<string>();
    for (const item of queued) {
      // Counted by state, not by `running`: a run is "working" from its first
      // synchronous step, before its worktree exists and its process starts.
      const busy = store.data.items.filter((i) => i.state === "working").length;
      if (busy >= s.limits.parallel) break;
      if (store.data.runsToday >= s.limits.perDay) {
        holds.add(`daily limit of ${s.limits.perDay} runs reached`);
        break;
      }
      // A merged PR has left the snapshot; its Jira dry run goes by the item alone.
      const pr = byId.get(item.prId) ?? null;
      if (!pr && item.scenario !== "afterMerge") continue;
      // Quiet hours hold what the agent found itself; what you asked for (or resumed) runs.
      if (quiet && !item.key.endsWith("|asked") && !item.resumeSession) {
        holds.add(`quiet hours until ${quiet}`);
        continue;
      }
      const held = hostHeld(snapshot, item.hostLabel);
      if (held) {
        item.headline = `Queued — ${held}`;
        holds.add(`${item.hostLabel}: ${held}`);
        continue;
      }
      // One run per PR at a time.
      if (store.data.items.some((i) => i.prId === item.prId && i.state === "working")) continue;
      void run(item, pr, all).catch((e) => console.warn(`[agent] run failed: ${(e as Error).message}`));
    }
    noteHold(holds.size > 0 ? [...holds].sort().join("; ") : null);
  }

  /** Puts a PR in the queue on your say-so; its key is its own, so the ledger of the automatic one doesn't stop it. */
  function enqueueAsked(
    pr: PullRequest,
    s: AgentSettings,
    scenario: AgentScenario,
    reasons?: string[],
    before?: string | null,
    from?: Pick<AgentItem, "carry" | "brief">,
  ): AgentActionResult {
    if (store.data.items.some((i) => i.prId === pr.id && (i.state === "queued" || i.state === "working"))) {
      return { ok: false, error: "The agent is already on this PR." };
    }
    // Every run you can ask for works on the PR's code: without a clone it would only fail.
    const claude = loadAll()?.claude;
    if (!claude || !deps.findCheckout(pr, claude)) return { ok: false, error: `${noCheckoutWhy(pr.repo)}.` };
    const key = `${pr.id}|${scenario}|${pr.headOid ?? "-"}|asked`;
    delete store.data.ledger[key];
    // Asked by you: in the scenario's own mode, and never more than Shadow when that is off.
    const on = (m: string) => (m === "on" ? "on" : "shadow");
    const mode =
      scenario === "brief"
        ? "on"
        : scenario === "rereview"
          ? on(s.scenarios.rereview.mode)
          : scenario === "drive"
            ? reasons?.includes("self")
              ? on(s.scenarios.selfReview.mode)
              : s.scenarios.driveCi.mode === "on" && s.scenarios.driveComments.mode === "on"
                ? "on"
                : "shadow"
            : on(s.scenarios.review.mode);
    const what =
      { brief: "a brief", rereview: "re-review", drive: reasons?.includes("self") ? "self-review" : `drive — ${describeReasons(reasons ?? [])}` }[scenario as string] ?? "review";
    const others = store.data.items.filter((i) => i.state === "queued");
    const item = newItem({ key, prId: pr.id, prNumber: pr.number, repo: pr.repo, url: pr.url, scenario, mode, reasons }, pr, `Queued: ${what} (asked by you)`);
    // Dropped in front of a queued run: it takes that place.
    if (before) {
      const rank = rankBefore(others, before);
      if (rank !== undefined) item.rank = rank;
    }
    if (from?.carry?.length) item.carry = from.carry;
    if (from?.brief?.trim()) item.brief = from.brief;
    supersede(item);
    void store.save();
    changed();
    tick();
    return { ok: true };
  }

  /**
   * Something you did — a card's button, a menu, the companion, the tray — and
   * what came of it, in the log: what the agent prepared and what you did with
   * it is what tells whether it helps.
   */
  async function act(action: AgentAction): Promise<AgentActionResult> {
    const started = now().getTime();
    // The item it names, and its state before: a skip or a retry closes it.
    const item = "runId" in action ? findItem(action.runId) : undefined;
    const from = item?.state;
    const record = (res: AgentActionResult) => {
      const pr = "prId" in action ? snapshotPr(action.prId) : null;
      store.log({
        at: stamp(),
        kind: "action",
        event: action.type,
        ...(item ? itemFields(item) : pr ? { prId: pr.id, prNumber: pr.number, repo: pr.repo } : "runId" in action ? { runId: action.runId } : {}),
        ...(item ? { from, to: item.state } : {}),
        ...(res.ok ? {} : { detail: clip(res.error) }),
        ms: Math.max(0, now().getTime() - started),
        data: { ok: res.ok, ...(actionArgs(action as unknown as Record<string, unknown>) ?? {}) },
      });
    };
    try {
      const res = await perform(action);
      record(res);
      return res;
    } catch (e) {
      record({ ok: false, error: (e as Error).message });
      throw e;
    }
  }

  async function perform(action: AgentAction): Promise<AgentActionResult> {
    const all = loadAll();
    if (!all) return { ok: false, error: "The settings can't be read — open Settings to fix them." };
    // Off: nothing new starts; stopping, dismissing, publishing what you saw still work.
    if (!all.agent.enabled && STARTS_A_RUN.has(action.type)) return { ok: false, error: "The agent is off — switch it on in Settings › Agent." };
    const snapshot = deps.getSnapshot();
    if (action.type === "pauseAgent" || action.type === "resumeAgent") {
      setPaused(action.type === "pauseAgent");
      return { ok: true };
    }
    if (action.type === "approveAgain") return approveAgain(action.prId, all);
    if (action.type === "enqueue") {
      const pr = snapshot?.pullRequests.find((p) => p.id === action.prId);
      if (!pr) return { ok: false, error: "That PR is not on the dashboard any more." };
      if (pr.roles.includes("author")) {
        // Left to its orchestrator run, even when you ask: two agents on one branch edit and push over each other.
        const run = orchestrated(pr, all.claude);
        if (run) return { ok: false, error: `Yours — ${run}.` };
        if (pr.isCrossRepository) return { ok: false, error: "Its branch is in a fork — the agent pushes only to branches of the repository itself." };
        // Nothing broken: a self-review of its head, before reviewers see it.
        const reasons = driveReasons(pr, all.agent);
        return enqueueAsked(pr, all.agent, "drive", reasons.length > 0 ? reasons : ["self"], action.before);
      }
      if (!pr.roles.includes("reviewer") && !pr.roles.includes("reviewed")) return { ok: false, error: "The agent works on PRs you review or your own." };
      if (pr.viewerHasReviewed) return enqueueAsked(pr, all.agent, "rereview", undefined, action.before);
      const brief = isBigPr(pr, all.agent);
      return enqueueAsked(pr, all.agent, brief ? "brief" : "review", undefined, action.before);
    }
    const item = findItem(action.runId);
    if (!item) return { ok: false, error: "That run is gone." };
    const r = running.get(item.runId);
    switch (action.type) {
      case "hint": {
        if (!r) return { ok: false, error: "The run is not running." };
        r.handle.hint(action.text);
        r.recent = [...r.recent, { at: stamp(), text: `You: ${action.text}` }].slice(-RECENT_MAX);
        break;
      }
      case "pause": {
        if (!r || r.paused) return { ok: false, error: "Nothing to pause." };
        pauseRun(item, r);
        // Yours: resuming the agent leaves it paused.
        r.byAgentPause = false;
        break;
      }
      case "resume": {
        if (!r || !r.paused) return { ok: false, error: "Nothing to resume." };
        resumeRun(item, r);
        break;
      }
      case "answer": {
        if (r || item.state !== "needsYou") return { ok: false, error: "Only a finished run can be answered." };
        if (item.scenario === "merge") return { ok: false, error: "A merge offer has no session to answer." };
        if (item.scenario === "afterMerge") return { ok: false, error: "The Jira dry run changes nothing — apply it in a session." };
        if (!item.sessionId) return { ok: false, error: "There is no session to answer — run it again." };
        if (!item.worktree || !fs.existsSync(item.worktree)) return { ok: false, error: "Its folder is gone — run it again." };
        // A drive pushes only what the app checked before its first session; after a restart that is gone.
        if (item.scenario === "drive" && !item.pushTo) return { ok: false, error: "Since the app restarted, a drive starts over — run it again, or answer in a session." };
        if (!snapshotPr(item.prId)) return { ok: false, error: "That PR is not on the dashboard any more." };
        if (store.data.items.some((i) => i.prId === item.prId && i !== item && (i.state === "queued" || i.state === "working"))) {
          return { ok: false, error: "The agent is already on this PR." };
        }
        item.state = "queued";
        item.resumeSession = true;
        item.answer = action.text;
        item.headline = "Queued: going on with your answer";
        item.finishedAt = undefined;
        void store.save();
        changed();
        tick();
        return { ok: true };
      }
      case "dispute": {
        if (item.state !== "needsYou" || !item.plan || item.published) return { ok: false, error: "There is no review waiting to be sent here." };
        if (!item.plan.escalations.some((e) => e.replyTo === action.replyTo)) return { ok: false, error: "The author didn't push back on that thread." };
        item.disputes = { ...(item.disputes ?? {}), [String(action.replyTo)]: action.choice };
        break;
      }
      case "stop":
      case "takeOver": {
        if (!r) return { ok: false, error: "The run is not running." };
        r.takeOver = action.type === "takeOver";
        r.handle.stop();
        break;
      }
      case "continue": {
        // A session resumes in the folder it ran in: the PR's worktree, or the
        // Jira dry run's own folder — where "apply it" then runs with your own
        // settings and asks before every change.
        const where = item.worktree ?? (item.scenario === "afterMerge" ? path.join(deps.dir, "runs", item.runId, "cwd") : undefined);
        if (!item.sessionId || !where || !fs.existsSync(where)) {
          return { ok: false, error: "There is no session left to continue." };
        }
        if (!deps.openResume) return { ok: false, error: "Can't open a terminal here." };
        try {
          await deps.openResume(where, item.sessionId);
        } catch (e) {
          return { ok: false, error: `Could not open your terminal: ${(e as Error).message}` };
        }
        return { ok: true };
      }
      case "publish": {
        if (r) return { ok: false, error: "It is still running." };
        // A drive's replies go out with its push; only with nothing to push are they sent by themselves.
        const repliesOnly = item.scenario === "drive" && (item.drive?.commits.length ?? 0) === 0;
        if (item.state !== "needsYou" || (item.scenario !== "review" && item.scenario !== "rereview" && !repliesOnly)) {
          return { ok: false, error: "Only a prepared review, or a drive's replies with nothing to push, can be published." };
        }
        return publishItem(item, all, true);
      }
      case "push": {
        if (r) return { ok: false, error: "It is still running." };
        if (item.state !== "needsYou" || item.scenario !== "drive") return { ok: false, error: "Only a drive's commits can be pushed." };
        return pushItem(item, all);
      }
      case "reapprove": {
        if ((item.scenario !== "reapprove" && item.scenario !== "reask") || item.state !== "needsYou") return { ok: false, error: "There is nothing to give again here." };
        if (reapproving.has(item.runId)) return { ok: false, error: "It is on its way already." };
        return giveAgain(item, true);
      }
      case "merge": {
        if (item.scenario !== "merge" || item.state !== "needsYou") return { ok: false, error: "There is nothing to merge here." };
        if (merging.has(item.runId)) return { ok: false, error: "It is being merged already." };
        return mergeItem(item, all, action.method);
      }
      case "moveQueued": {
        if (item.state !== "queued") return { ok: false, error: "Only a queued PR can be moved — this one has started or finished." };
        if (action.before === item.runId) return { ok: true };
        const rank = rankBefore(
          store.data.items.filter((i) => i.state === "queued" && i !== item),
          action.before,
        );
        if (rank === undefined) delete item.rank;
        else item.rank = rank;
        void store.save();
        changed();
        tick();
        return { ok: true };
      }
      case "skip": {
        if (r) return { ok: false, error: "Stop the run first." };
        // Taken out of the queue before it ran: without a note in the ledger
        // the next snapshot would queue the same head again.
        if (item.state === "queued" && !store.data.ledger[item.key]) {
          store.data.ledger[item.key] = { state: "dismissed", at: stamp(), runId: item.runId };
          idle[item.prId] = LEDGER_IDLE.dismissed;
        }
        await closeAs(item, AGENT_CLOSED.dismissed);
        return { ok: true };
      }
      case "retry": {
        if (r || item.state === "queued") return { ok: false, error: "It is already running." };
        if (item.scenario === "merge") return { ok: false, error: "A merge offer isn't a run — it comes back on its own once the PR is ready." };
        if (item.scenario === "reapprove" || item.scenario === "reask") return { ok: false, error: "An offer to give an approval again isn't a run — it is checked again on the next head." };
        const pr = snapshot?.pullRequests.find((p) => p.id === item.prId);
        if (!pr) return { ok: false, error: "That PR is not on the dashboard any more." };
        // A drive goes again for what the PR needs now, not what it needed then.
        // Nothing broken any more: run again as a self-review.
        const found = item.scenario === "drive" ? driveReasons(pr, all.agent) : undefined;
        const reasons = found && found.length === 0 ? ["self"] : found;
        // The old result goes only once the new run is in the queue: a refusal
        // (the agent is already on the PR) leaves it where it was.
        const queued = enqueueAsked(pr, all.agent, item.scenario, reasons);
        if (queued.ok) await closeAs(item, AGENT_CLOSED.rerun);
        return queued;
      }
      case "reviewAnyway": {
        if (item.scenario !== "brief") return { ok: false, error: "Only a brief can be turned into a review." };
        const pr = snapshot?.pullRequests.find((p) => p.id === item.prId);
        if (!pr) return { ok: false, error: "That PR is not on the dashboard any more." };
        // The brief's questions for the author go into the review it drafts, its text onto the review's card.
        const queued = enqueueAsked(pr, all.agent, "review", undefined, undefined, { carry: item.result?.authorQuestions, brief: item.output });
        if (queued.ok) await closeAs(item, AGENT_CLOSED.reviewed);
        return queued;
      }
    }
    void store.save();
    changed();
    return { ok: true };
  }

  const loop = () => {
    if (stopped) return;
    tick();
    timer = setTimeout(loop, deps.tickMs ?? 5_000);
    timer.unref?.();
  };
  // Everything the journal reads exists from here on: log what the start changed (runs it cut short).
  journalReady = true;
  if (observe()) void store.save();
  loop();

  return {
    onSnapshot,
    act,
    getState: (): AgentState => {
      const s = settings();
      return {
        enabled: s?.enabled ?? false,
        items: store.data.items,
        running: [...running.entries()].map(([runId, r]) => ({ runId, progress: r.progress, recent: r.recent, paused: r.paused })),
        idle,
        runsToday: store.data.runsToday,
        perDay: s?.limits.perDay ?? 0,
        parallel: s?.limits.parallel ?? 0,
        heldUntil: heldUntil !== null ? new Date(heldUntil).toISOString() : null,
        headerChip: s?.companion.headerChip ?? true,
        trayState: s?.companion.trayState ?? true,
        paused: store.data.paused,
        quietUntil: s ? quietUntil(now(), s.limits.quietHours) : null,
        acceptedUnchanged: store.data.acceptedUnchanged,
        suggestOn: s?.scenarios.review.mode === "shadow" && store.data.acceptedUnchanged >= s.limits.promoteAfter,
        orchestrated: sdlcBadges,
      };
    },
    ownSessionIds: () => new Set(store.data.items.filter((i) => i.state === "working" && i.sessionId).map((i) => i.sessionId!)),
    isActive: () => settings()?.enabled ?? false,
    refresh: () => {
      if (stopped) return;
      if (!replanIfSettingsChanged()) changed();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      // What runs now is interrupted by the app's closing, not stopped by you:
      // written down before the processes go, since the app won't wait.
      const at = stamp();
      const cut = store.data.items.filter((i) => i.state === "working");
      for (const item of cut) markInterrupted(item, at);
      if (boardOn || cut.length > 0) store.log({ at, kind: "agent", event: "stop", data: { interrupted: cut.length } });
      store.flush();
      for (const r of running.values()) r.handle.stop();
    },
  };
}

export { describeToolUse };
