import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_AGENT_PROMPTS } from "../../shared/agent-defaults";
import { isBigPr, mergeBlocker, planJobs, renderAgentPrompt, type AgentJob, type AgentScenario } from "../../shared/agent-policy";
import { describePlan, gitBashPath, summarizePlan } from "../../shared/agent-publish";
import { describeToolUse, type RunProgress } from "../../shared/agent-stream";
import { AGENT_CLOSED, todayKey } from "../../shared/agent-view";
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
import { chooseMergeMethod, mergeArgs } from "./merge";
import { mountUserSkills, readInstalledPlugins, resolveSkillRefs, type InstalledPlugin } from "./plugins";
import { ghError, prepareRunFolder, publishPlan, readPlan, runFolderRoots, runGh, type GhRunner, type RunFolder } from "./publish";
import { hookCommand, startRun, writeGuardFile, writeRunSettings, type RunHandle, type Spawner } from "./runner";
import { openStore, type AgentItemRecord, type AgentStore } from "./store";
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
  /** Your own skills folder (~/.claude/skills) — the ones a prompt names are mounted for the run. */
  userSkillsDir?: string;
  /** Something you may want to hear about; main checks the notification settings. */
  notify?: (notice: AgentNotice) => void;
  plugins?: () => InstalledPlugin[];
  git?: GitRunner;
  spawner?: Spawner;
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
  stop(): void;
}

/** How many recent things a run keeps for the companion's plan-and-log view. */
const RECENT_MAX = 40;

// The same local day the Board's "Done today" uses.
const localDay = todayKey;

/** The kind of session a scenario runs as — what the guard and the tool list go by. */
export function runKindOf(scenario: AgentScenario): AgentRunKind {
  return scenario === "brief" ? "brief" : scenario === "afterMerge" ? "afterMerge" : "review";
}

/** The rules every agent session gets on top of its prompt. */
export function agentRules(scenario: AgentScenario, mode: "shadow" | "on", folder: Pick<RunFolder, "wrapperPath" | "outDir"> | null = null): string {
  const plan =
    "You run unattended as the user's PR agent. First write your plan as a task list with TaskCreate — one short task per step — and keep it current with TaskUpdate as you go, so the user can follow along. (A skill that runs as a Workflow shows its own phases; then no task list is needed.)";
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
  if (folder) {
    // Forward slashes: the session passes these paths through Git Bash on Windows.
    const out = folder.outDir.replace(/\\/g, "/");
    const later = mode === "shadow" ? " once the user approves it" : " right after this session";
    return (
      `${plan} Publishing goes through the app: run the review with dryRun: false and publishCommand: "${gitBashPath(folder.wrapperPath)}". ` +
      `That wrapper is the app's own — it records each write for the user and posts nothing; the app publishes what it recorded${later}. ` +
      `Write every file the wrapper takes (the review JSON, a comment JSON, a reply's text) under ${out}/ and pass that absolute path — nothing else is writable — and never call gh api for a write. ` +
      `${jira} End with a short summary of what you prepared. ${never}`
    );
  }
  return `${plan} This is a dry run: post NOTHING to GitHub; if your skill has a dry-run mode (dryRun: true), use it. ${jira} End with exactly what you would post — the summary, every inline comment with its file and line, and whether you would approve — as your final message. ${never}`;
}

function promptFor(scenario: AgentScenario, claude: ClaudeSettings): string {
  if (scenario === "brief") return claude.agentPrompts.triage || DEFAULT_AGENT_PROMPTS.triage;
  if (scenario === "afterMerge") return claude.agentPrompts.afterMerge || DEFAULT_AGENT_PROMPTS.afterMerge;
  return claude.prompts.review || DEFAULT_CLAUDE_PROMPTS.review;
}

/** The head commit an item was keyed on ("<id>|<scenario>|<head>…"). */
function keyHead(key: string): string | null {
  const h = key.split("|")[2];
  return h && h !== "-" ? h : null;
}

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
}

export function createAgent(deps: AgentDeps): Agent {
  const now = deps.now ?? (() => new Date());
  const git = deps.git ?? runGit;
  const plugins = deps.plugins ?? (() => readInstalledPlugins());
  const store: AgentStore = openStore(deps.dir, localDay(now()));
  const running = new Map<string, Running>();
  let idle: Record<string, string> = {};
  let heldUntil: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  // A run that was in flight when the app closed did not finish: say so.
  for (const item of store.data.items) {
    if (item.state === "working") {
      item.state = "needsYou";
      item.headline = "Interrupted — the app closed while it ran";
      item.finishedAt = now().toISOString();
      if (store.data.ledger[item.key]?.state === "started") store.data.ledger[item.key].state = "failed";
    }
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
  const gh = deps.gh ?? runGh;
  /** Merge offers whose click is being carried out — a snapshot in between must not close them. */
  const merging = new Set<string>();
  const announce = (item: AgentItemRecord, kind: AgentNotice["kind"]) => {
    try {
      deps.notify?.({ kind, item: { ...item } });
    } catch {
      // A notification is best-effort.
    }
  };
  /** The PR as the dashboard last saw it (merged ones drop out of the snapshot; their after-merge run still needs a name). */
  const snapshotPr = (prId: string) => deps.getSnapshot()?.pullRequests.find((p) => p.id === prId) ?? null;

  function newItem(job: Pick<AgentJob, "key" | "prId" | "prNumber" | "repo" | "url" | "scenario" | "mode">, pr: PullRequest, headline: string): AgentItemRecord {
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
    };
    store.data.items.push(item);
    store.log({ at: stamp(), prNumber: job.prNumber, repo: job.repo, scenario: job.scenario, runId: item.runId, event: "queued", headOid: pr.headOid });
    return item;
  }

  function onSnapshot(snapshot: DashboardResponse): void {
    const s = settings();
    if (!s?.enabled) {
      idle = Object.fromEntries(snapshot.pullRequests.map((p) => [p.id, "The agent is off"]));
      return;
    }
    const own = new Set(store.data.items.filter((i) => i.state === "working" && i.sessionId).map((i) => i.sessionId!));
    const sessions = deps.getSessions().filter((x) => !own.has(x.id));
    const plan = planJobs(snapshot.pullRequests, s, { hasOwnSession: (pr) => sessionsForPr(pr, sessions).length > 0 });
    idle = Object.fromEntries(plan.idle);
    const byId = new Map(snapshot.pullRequests.map((p) => [p.id, p]));
    const wanted = new Set(plan.jobs.map((j) => j.key));
    let dirty = false;
    for (const job of plan.jobs) {
      if (store.data.ledger[job.key]) continue;
      if (store.data.items.some((i) => i.key === job.key && (i.state === "queued" || i.state === "working"))) continue;
      newItem(job, byId.get(job.prId)!, job.scenario === "brief" ? "Queued: a brief (too big to review on its own)" : "Queued: review");
      dirty = true;
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
    if (dirty) {
      void store.save();
      changed();
    }
    tick();
  }

  async function run(item: AgentItemRecord, pr: PullRequest | null, all: Settings): Promise<void> {
    const s = all.agent;
    const fail = (headline: string, error?: string) => {
      item.state = "error";
      item.headline = headline;
      item.error = error;
      item.finishedAt = stamp();
      // Recorded even when the run never started, or every tick would queue the
      // same PR again; a new head commit is a new key and gets another try.
      store.data.ledger[item.key] = { state: "failed", at: item.finishedAt, runId: item.runId };
      store.log({ at: item.finishedAt, prNumber: item.prNumber, repo: item.repo, scenario: item.scenario, runId: item.runId, event: "failed", detail: error ?? headline });
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
    if (item.scenario !== "afterMerge") {
      if (!pr) return;
      checkout = deps.findCheckout(pr, all.claude);
      if (!checkout) return fail(`No checkout of ${pr.repo} — set its folder in Settings › Claude`);
      remote = remoteFor(checkout, pr);
      if (!remote) return fail(`No remote of ${checkout} points at ${pr.repo}`);
    }

    store.data.ledger[item.key] = { state: "started", at: stamp(), runId: item.runId };
    store.data.runsToday += 1;
    item.state = "working";
    item.startedAt = stamp();
    item.headline = item.scenario === "brief" ? "Writing a brief" : item.scenario === "afterMerge" ? "Checking Jira (dry run)" : "Reviewing";
    item.checkout = checkout ?? undefined;
    void store.save();
    changed();

    let dir: string;
    if (pr && checkout && remote) {
      try {
        dir = await prepareWorktree(git, { checkout, remote, base: worktreeBase(s.worktreeDir, checkout), pr });
      } catch (e) {
        return fail("Could not check out the PR", (e as Error).message);
      }
      item.worktree = dir;
    } else {
      dir = path.join(runDir, "cwd");
      fs.mkdirSync(dir, { recursive: true });
    }

    // A review's publish step goes through the app's wrapper; without a usable
    // folder for it the review runs as a plain dry run (text only).
    const folder =
      kind === "review" && deps.captureScript
        ? prepareRunFolder(runFolderRoots(checkout ? worktreeBase(s.worktreeDir, checkout) : null), item.runId, { repo: item.repo, number: item.prNumber }, deps.execPath, deps.captureScript)
        : null;
    if (folder) item.runFolder = folder.runDir;

    const fromPlugins = resolveSkillRefs(renderAgentPrompt(promptFor(item.scenario, all.claude), "", item.url), plugins());
    const mine = mountUserSkills(fromPlugins.prompt, plugins(), path.join(runDir, "user-skills"), deps.userSkillsDir);
    const pluginDirs = [...fromPlugins.pluginDirs, ...mine.pluginDirs];
    const settingsFile = path.join(runDir, "settings.json");
    const guardFile = path.join(runDir, "guard.json");
    // A skill's Workflow may run its script from the plugins this run mounted — never one from the PR.
    writeGuardFile(guardFile, { ...(folder ? { wrapperPath: folder.wrapperPath, outDir: folder.outDir } : {}), workflowDirs: pluginDirs });
    writeRunSettings(settingsFile, hookCommand(deps.execPath, deps.hookScript, kind, item.url, guardFile));
    const sessionId = randomUUID();
    item.sessionId = sessionId;
    store.log({ at: stamp(), prNumber: item.prNumber, repo: item.repo, scenario: item.scenario, runId: item.runId, event: "started", headOid: pr?.headOid ?? keyHead(item.key) ?? undefined, sessionId });

    // The wrapper's own rule, and Write — which the guard holds to the payload folder.
    const allowedTools = [...s.permissions.tools[kind], ...(folder ? [`Bash(${gitBashPath(folder.wrapperPath)} *)`, "Write"] : [])];
    // Read-only runs may read the plugins' folders (a skill's Workflow reads its script from there); a run that edits never gets them.
    const addDirs = [...(folder ? [folder.outDir] : []), ...pluginDirs];

    const entry: Running = { handle: null as unknown as RunHandle, progress: null as unknown as RunProgress, recent: [], paused: false, takeOver: false };
    const handle = startRun(
      {
        cwd: dir,
        sessionId,
        kind,
        prompt: mine.prompt,
        appendSystemPrompt: agentRules(item.scenario, item.mode, folder),
        allowedTools,
        pluginDirs,
        addDirs,
        model: s.model,
        effort: s.effort,
        settingsFile,
        timeoutMs: s.limits.maxMinutes * 60_000,
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
    void store.save();
    changed();

    const outcome = await handle.done;
    running.delete(item.runId);
    const result = outcome.progress.result;
    item.finishedAt = stamp();
    let publishNow = false;
    if (entry.takeOver) {
      item.state = "needsYou";
      item.headline = "You took it over in your terminal";
      store.data.ledger[item.key].state = "failed";
      if (deps.openResume) {
        await deps.openResume(dir, sessionId).catch((e) => {
          item.headline = `Could not open your terminal: ${(e as Error).message}`;
        });
      }
    } else if (outcome.stopped) {
      item.state = "needsYou";
      item.headline = "Stopped by you";
      store.data.ledger[item.key].state = "failed";
    } else if (outcome.timedOut) {
      item.state = "needsYou";
      item.headline = `Stopped after ${s.limits.maxMinutes} min`;
      store.data.ledger[item.key].state = "failed";
    } else if (result && !result.isError && result.subtype === "success") {
      item.state = "needsYou";
      item.output = result.text;
      store.data.ledger[item.key].state = "prepared";
      const steps = folder ? readPlan(folder.runDir) : [];
      if (item.scenario === "brief") {
        item.headline = "Brief ready";
      } else if (item.scenario === "afterMerge") {
        item.headline = "Jira dry run ready — apply it in a session";
      } else if (steps.length > 0) {
        item.plan = summarizePlan(steps);
        item.headline = `Would post: ${describePlan(item.plan)}`;
        publishNow = item.mode === "on";
      } else {
        item.headline = folder ? "Review ready — nothing to post" : "Review ready — it waits for your OK before posting";
      }
    } else {
      // `fail` saves, logs and tells; the rest of this function only cleans up.
      fail("The run failed", result?.text || outcome.stderr.trim().split("\n").slice(-3).join(" ") || `exit ${outcome.exitCode}`);
    }
    // `fail` changes the state behind TypeScript's back; read it afresh.
    const ended = item.state as AgentItem["state"];
    if (ended !== "error") {
      store.log({ at: item.finishedAt, prNumber: item.prNumber, repo: item.repo, scenario: item.scenario, runId: item.runId, event: ended, sessionId, detail: item.headline });
    }
    // Only a result you still have to look at keeps its worktree (to continue the session in it).
    if (ended !== "needsYou") await dropWorktree(item);
    void store.save();
    changed();
    if (publishNow) {
      // On: the app posts what the review prepared, with the same checks as your Publish.
      await publishItem(item, all, false);
    } else if (item.state === "needsYou") {
      announce(item, "needsYou");
    }
    tick();
  }

  async function dropWorktree(item: AgentItemRecord): Promise<void> {
    if (item.worktree && item.checkout) await removeWorktree(git, item.checkout, item.worktree).catch(() => {});
    item.worktree = undefined;
  }

  /** Closes an item a newer one replaced; it leaves the Board without a "Done today" card. */
  async function closeAs(item: AgentItemRecord, headline: string): Promise<void> {
    item.state = "done";
    item.headline = headline;
    item.later = false;
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
   * Posts what a review prepared — on your Publish (`byYou`) or, in On, right
   * after the run. The PR is read again first: a new push since the review
   * stops it (the review would talk about code that isn't the head), as does
   * a PR that was merged or closed.
   */
  async function publishItem(item: AgentItemRecord, all: Settings, byYou: boolean): Promise<AgentActionResult> {
    const refuse = (error: string): AgentActionResult => {
      item.state = "needsYou";
      item.headline = `Not published — ${error}`;
      void store.save();
      changed();
      announce(item, "failed");
      return { ok: false, error };
    };
    if (!item.runFolder || !item.plan) return { ok: false, error: "Nothing prepared to publish." };
    if (item.published) return { ok: false, error: "It is published already." };
    const read = await fresh(item, snapshotPr(item.prId)?.roles ?? ["reviewer"]);
    if (!read.ok) return refuse(read.error);
    const { pr, state, viewer } = read.fresh;
    if (state !== "OPEN") return refuse(`the PR was ${state.toLowerCase()} since`);
    const head = item.plan.commitId ?? keyHead(item.key);
    if (head && pr.headOid && pr.headOid !== head) return refuse("there are new commits since this review — run it again");
    const me = viewer?.toLowerCase();
    const holdApprove =
      all.agent.scenarios.review.holdApproveOnChangeRequest && pr.reviewers.some((r) => r.reviewState === "changes_requested" && r.login.toLowerCase() !== me);
    item.headline = "Publishing…";
    changed();
    const out = await publishPlan(item.runFolder, item.url, { repo: item.repo, number: item.prNumber, signature: all.agent.policy.signature, holdApprove }, gh);
    if (!out.ok) {
      store.log({ at: stamp(), prNumber: item.prNumber, repo: item.repo, scenario: item.scenario, runId: item.runId, event: "publish-failed", detail: out.error });
      return refuse(`stopped after ${out.posted} of ${out.total}: ${out.error}`);
    }
    item.published = true;
    item.state = "done";
    const held = holdApprove && item.plan.event === "APPROVE";
    item.headline = held ? `Published: ${describePlan({ ...item.plan, event: "COMMENT" })} (approve held)` : `Published: ${describePlan(item.plan)}`;
    item.finishedAt = stamp();
    item.later = false;
    store.data.ledger[item.key] = { state: "published", at: item.finishedAt, runId: item.runId };
    if (byYou && item.mode === "shadow") store.data.acceptedUnchanged += 1;
    store.log({ at: item.finishedAt, prNumber: item.prNumber, repo: item.repo, scenario: item.scenario, runId: item.runId, event: "published", headOid: head ?? undefined, sessionId: item.sessionId, detail: describePlan(item.plan) });
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
      item.headline = `Merging (${method})…`;
      changed();
      const r = await gh(mergeArgs(item.url, method, head, s.scenarios.merge.deleteBranch));
      if (r.code !== 0) {
        item.headline = `GitHub refused the merge — ${ghError(r)}`;
        void store.save();
        changed();
        return { ok: false, error: ghError(r) };
      }
      const queued = /merge queue/i.test(`${r.stdout}\n${r.stderr}`);
      item.state = "done";
      item.mergeMethod = method;
      item.headline = queued ? "Added to the merge queue" : `Merged (${method})${s.scenarios.merge.deleteBranch ? ", branch deleted" : ""}`;
      item.finishedAt = stamp();
      store.data.ledger[item.key] = { state: "published", at: item.finishedAt, runId: item.runId };
      store.log({ at: item.finishedAt, prNumber: item.prNumber, repo: item.repo, scenario: "merge", runId: item.runId, event: queued ? "queued-to-merge" : "merged", headOid: head, detail: method });
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

  function tick(): void {
    if (stopped) return;
    const all = loadAll();
    const s = all?.agent;
    if (!all || !s?.enabled) return;
    const day = localDay(now());
    if (store.data.day !== day) {
      store.data.day = day;
      store.data.runsToday = 0;
      store.prune(s.policy.logRetentionDays, now().getTime());
    }
    if (heldUntil !== null && now().getTime() < heldUntil) return;
    heldUntil = null;
    const snapshot = deps.getSnapshot();
    const byId = new Map((snapshot?.pullRequests ?? []).map((p) => [p.id, p]));
    const queued = store.data.items.filter((i) => i.state === "queued").sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    for (const item of queued) {
      // Counted by state, not by `running`: a run is "working" from its first
      // synchronous step, before its worktree exists and its process starts.
      const busy = store.data.items.filter((i) => i.state === "working").length;
      if (busy >= s.limits.parallel || store.data.runsToday >= s.limits.perDay) break;
      // A merged PR has left the snapshot; its Jira dry run goes by the item alone.
      const pr = byId.get(item.prId) ?? null;
      if (!pr && item.scenario !== "afterMerge") continue;
      const held = hostHeld(snapshot, item.hostLabel);
      if (held) {
        item.headline = `Queued — ${held}`;
        continue;
      }
      // One run per PR at a time.
      if (store.data.items.some((i) => i.prId === item.prId && i.state === "working")) continue;
      void run(item, pr, all).catch((e) => console.warn(`[agent] run failed: ${(e as Error).message}`));
    }
  }

  /** Puts a PR in the queue on your say-so; its key is its own, so the ledger of the automatic one doesn't stop it. */
  function enqueueAsked(pr: PullRequest, s: AgentSettings, scenario: AgentScenario): AgentActionResult {
    if (store.data.items.some((i) => i.prId === pr.id && (i.state === "queued" || i.state === "working"))) {
      return { ok: false, error: "The agent is already on this PR." };
    }
    const key = `${pr.id}|${scenario}|${pr.headOid ?? "-"}|asked`;
    delete store.data.ledger[key];
    newItem(
      { key, prId: pr.id, prNumber: pr.number, repo: pr.repo, url: pr.url, scenario, mode: scenario === "brief" ? "on" : s.scenarios.review.mode === "on" ? "on" : "shadow" },
      pr,
      `Queued: ${scenario === "brief" ? "a brief" : "review"} (asked by you)`,
    );
    void store.save();
    changed();
    tick();
    return { ok: true };
  }

  async function act(action: AgentAction): Promise<AgentActionResult> {
    const all = loadAll();
    if (!all?.agent.enabled) return { ok: false, error: "The agent is off — switch it on in Settings › Agent." };
    const snapshot = deps.getSnapshot();
    if (action.type === "enqueue") {
      const pr = snapshot?.pullRequests.find((p) => p.id === action.prId);
      if (!pr) return { ok: false, error: "That PR is not on the dashboard any more." };
      if (!pr.roles.includes("reviewer") && !pr.roles.includes("reviewed")) {
        return { ok: false, error: "On your own PRs the agent can't help yet — that comes with driving PRs to green." };
      }
      const brief = isBigPr(pr, all.agent);
      return enqueueAsked(pr, all.agent, brief ? "brief" : "review");
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
        r.handle.interrupt();
        r.paused = true;
        item.headline = "Paused";
        break;
      }
      case "resume": {
        if (!r || !r.paused) return { ok: false, error: "Nothing to resume." };
        r.handle.resume();
        r.paused = false;
        item.headline = item.scenario === "brief" ? "Writing a brief" : "Reviewing";
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
        if (item.state !== "needsYou" || item.scenario !== "review") return { ok: false, error: "Only a prepared review can be published." };
        return publishItem(item, all, true);
      }
      case "merge": {
        if (item.scenario !== "merge" || item.state !== "needsYou") return { ok: false, error: "There is nothing to merge here." };
        if (merging.has(item.runId)) return { ok: false, error: "It is being merged already." };
        return mergeItem(item, all, action.method);
      }
      case "skip": {
        if (r) return { ok: false, error: "Stop the run first." };
        await closeAs(item, AGENT_CLOSED.dismissed);
        return { ok: true };
      }
      case "later": {
        if (item.state !== "needsYou" && item.state !== "error") return { ok: false, error: "Only a result can wait for later." };
        item.later = !item.later;
        break;
      }
      case "retry": {
        if (r || item.state === "queued") return { ok: false, error: "It is already running." };
        const pr = snapshot?.pullRequests.find((p) => p.id === item.prId);
        if (!pr) return { ok: false, error: "That PR is not on the dashboard any more." };
        // The old result goes only once the new run is in the queue: a refusal
        // (the agent is already on the PR) leaves it where it was.
        const queued = enqueueAsked(pr, all.agent, item.scenario);
        if (queued.ok) await closeAs(item, AGENT_CLOSED.rerun);
        return queued;
      }
      case "reviewAnyway": {
        if (item.scenario !== "brief") return { ok: false, error: "Only a brief can be turned into a review." };
        const pr = snapshot?.pullRequests.find((p) => p.id === item.prId);
        if (!pr) return { ok: false, error: "That PR is not on the dashboard any more." };
        const queued = enqueueAsked(pr, all.agent, "review");
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
        acceptedUnchanged: store.data.acceptedUnchanged,
        suggestOn: s?.scenarios.review.mode === "shadow" && store.data.acceptedUnchanged >= s.limits.promoteAfter,
      };
    },
    ownSessionIds: () => new Set(store.data.items.filter((i) => i.state === "working" && i.sessionId).map((i) => i.sessionId!)),
    isActive: () => settings()?.enabled ?? false,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const r of running.values()) r.handle.stop();
    },
  };
}

export { describeToolUse };
