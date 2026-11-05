import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_AGENT_PROMPTS } from "../../shared/agent-defaults";
import { isBigPr, planJobs, renderAgentPrompt, type AgentJob, type AgentScenario } from "../../shared/agent-policy";
import { describeToolUse, type RunProgress } from "../../shared/agent-stream";
import { DEFAULT_CLAUDE_PROMPTS } from "../../shared/claude-launch";
import { sessionsForPr } from "../../shared/claude-sessions";
import type {
  AgentAction,
  AgentActionResult,
  AgentSettings,
  AgentState,
  ClaudeSessionInfo,
  ClaudeSettings,
  DashboardResponse,
  PullRequest,
  Settings,
} from "../../shared/types";
import { readInstalledPlugins, resolveSkillRefs, type InstalledPlugin } from "./plugins";
import { hookCommand, startRun, writeRunSettings, type RunHandle, type Spawner } from "./runner";
import { AGENT_CLOSED, todayKey } from "../../shared/agent-view";
import { openStore, type AgentItemRecord, type AgentStore } from "./store";
import { prepareWorktree, remoteFor, removeWorktree, runGit, worktreeBase, type GitRunner } from "./worktrees";

// The PR agent's core in the main process. It reads each dashboard snapshot,
// asks the policy which PRs want work, queues them, and runs the queue on its
// own timer — the poller only reports when something changed, while limits,
// quiet spells and finished runs move on time alone.
//
// Reviews and briefs only prepare for now: whatever a run produces waits in
// "Needs you"; publishing lands in stage 4.

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

/** The rules every agent session gets on top of its prompt. */
export function agentRules(scenario: AgentScenario, mode: "shadow" | "on"): string {
  const plan =
    "You run unattended as the user's PR agent. First write your plan as a task list with TaskCreate — one short task per step — and keep it current with TaskUpdate as you go, so the user can follow along.";
  const never =
    "Never push, and never try to work around a refused tool call: if something is refused, say what you would have done and continue without it.";
  if (scenario === "brief") {
    return `${plan} Post nothing anywhere. End with the brief itself as your final message. ${never}`;
  }
  const dry =
    mode === "shadow"
      ? "This is a dry run: post NOTHING to GitHub — no review, comments, approve, replies or resolves; if your skill has a dry-run mode, use it. End with exactly what you would post — the summary, every inline comment with its file and line, and whether you would approve — as your final message."
      : "Posting is not enabled for agent runs yet: post nothing to GitHub. End with exactly what you would post — the summary, every inline comment with its file and line, and whether you would approve — as your final message.";
  return `${plan} ${dry} ${never}`;
}

function promptFor(scenario: AgentScenario, claude: ClaudeSettings): string {
  return scenario === "brief" ? claude.agentPrompts.triage || DEFAULT_AGENT_PROMPTS.triage : claude.prompts.review || DEFAULT_CLAUDE_PROMPTS.review;
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
    // quietly — unless you asked for it yourself.
    for (const item of store.data.items) {
      if (item.state === "queued" && !wanted.has(item.key) && !item.key.endsWith("|asked")) {
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

  async function run(item: AgentItemRecord, pr: PullRequest, all: Settings): Promise<void> {
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
    };
    const checkout = deps.findCheckout(pr, all.claude);
    if (!checkout) {
      fail(`No checkout of ${pr.repo} — set its folder in Settings › Claude`);
      void store.save();
      changed();
      return;
    }
    const remote = remoteFor(checkout, pr);
    if (!remote) {
      fail(`No remote of ${checkout} points at ${pr.repo}`);
      void store.save();
      changed();
      return;
    }

    store.data.ledger[item.key] = { state: "started", at: stamp(), runId: item.runId };
    store.data.runsToday += 1;
    item.state = "working";
    item.startedAt = stamp();
    item.headline = item.scenario === "brief" ? "Writing a brief" : "Reviewing";
    item.checkout = checkout;
    void store.save();
    changed();

    let dir: string;
    try {
      dir = await prepareWorktree(git, { checkout, remote, base: worktreeBase(s.worktreeDir, checkout), pr });
    } catch (e) {
      fail("Could not check out the PR", (e as Error).message);
      void store.save();
      changed();
      return;
    }
    item.worktree = dir;

    const kind = item.scenario === "brief" ? "brief" : "review";
    const resolved = resolveSkillRefs(renderAgentPrompt(promptFor(item.scenario, all.claude), "", item.url), plugins());
    const settingsFile = path.join(deps.dir, "runs", item.runId, "settings.json");
    writeRunSettings(settingsFile, hookCommand(deps.execPath, deps.hookScript, kind, item.url));
    const sessionId = randomUUID();
    item.sessionId = sessionId;
    store.log({ at: stamp(), prNumber: item.prNumber, repo: item.repo, scenario: item.scenario, runId: item.runId, event: "started", headOid: pr.headOid, sessionId });

    const entry: Running = { handle: null as unknown as RunHandle, progress: null as unknown as RunProgress, recent: [], paused: false, takeOver: false };
    const handle = startRun(
      {
        cwd: dir,
        sessionId,
        kind,
        prompt: resolved.prompt,
        appendSystemPrompt: agentRules(item.scenario, item.mode),
        allowedTools: s.permissions.tools[kind],
        pluginDirs: resolved.pluginDirs,
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
      item.headline = item.scenario === "brief" ? "Brief ready" : "Review ready — it waits for your OK before posting";
      store.data.ledger[item.key].state = "prepared";
    } else {
      fail("The run failed", result?.text || outcome.stderr.trim().split("\n").slice(-3).join(" ") || `exit ${outcome.exitCode}`);
    }
    store.log({ at: item.finishedAt, prNumber: item.prNumber, repo: item.repo, scenario: item.scenario, runId: item.runId, event: item.state, sessionId, detail: item.headline });
    // Only a result you still have to look at keeps its worktree (to continue the session in it).
    if (item.state !== "needsYou") await dropWorktree(item);
    void store.save();
    changed();
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
    void store.save();
    changed();
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
      const pr = byId.get(item.prId);
      if (!pr) continue;
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
        if (!item.sessionId || !item.worktree || !fs.existsSync(item.worktree)) {
          return { ok: false, error: "There is no session left to continue." };
        }
        if (!deps.openResume) return { ok: false, error: "Can't open a terminal here." };
        try {
          await deps.openResume(item.worktree, item.sessionId);
        } catch (e) {
          return { ok: false, error: `Could not open your terminal: ${(e as Error).message}` };
        }
        return { ok: true };
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
