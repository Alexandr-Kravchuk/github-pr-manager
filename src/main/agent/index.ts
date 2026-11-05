import { randomUUID } from "node:crypto";
import path from "node:path";

import { planJobs, renderAgentPrompt, type AgentJob, type AgentScenario } from "../../shared/agent-policy";
import type { RunProgress } from "../../shared/agent-stream";
import { DEFAULT_CLAUDE_PROMPTS } from "../../shared/claude-launch";
import { sessionsForPr } from "../../shared/claude-sessions";
import { DEFAULT_AGENT_PROMPTS } from "../../shared/agent-defaults";
import type { AgentSettings, ClaudeSessionInfo, ClaudeSettings, DashboardResponse, PullRequest, Settings } from "../../shared/types";
import { readInstalledPlugins, resolveSkillRefs, type InstalledPlugin } from "./plugins";
import { hookCommand, startRun, writeRunSettings, type RunHandle, type Spawner } from "./runner";
import { openStore, type AgentItemRecord, type AgentStore } from "./store";
import { prepareWorktree, remoteFor, removeWorktree, runGit, worktreeBase, type GitRunner } from "./worktrees";

// The PR agent's core in the main process. It reads each dashboard snapshot,
// asks the policy which PRs want work, queues them, and runs the queue on its
// own timer — the poller only reports when something changed, while limits,
// quiet spells and finished runs move on time alone.
//
// Stage 2 runs reviews and briefs, and only prepares them: whatever a run
// produces waits in "Needs you"; publishing lands in stage 4.

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
  plugins?: () => InstalledPlugin[];
  git?: GitRunner;
  spawner?: Spawner;
  now?: () => Date;
  /** Called whenever what the agent shows changed. */
  onChange?: () => void;
  tickMs?: number;
}

export interface AgentRunView {
  item: AgentItemRecord;
  progress: RunProgress;
}

export interface AgentStateView {
  enabled: boolean;
  running: AgentRunView[];
  items: AgentItemRecord[];
  /** Why each PR on the dashboard is idle, by PR id. */
  idle: Record<string, string>;
  runsToday: number;
  /** Set while Claude's usage limit holds new runs back. */
  heldUntil: string | null;
}

export interface Agent {
  onSnapshot(snapshot: DashboardResponse): void;
  getState(): AgentStateView;
  /** Session ids of the agent's own runs — the session detector leaves them out. */
  ownSessionIds(): ReadonlySet<string>;
  /** On: keep polling while the window is hidden (the agent acts on what it sees). */
  isActive(): boolean;
  stop(): void;
}

const SCENARIO_KIND = { review: "review", brief: "brief" } as const;

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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

export function createAgent(deps: AgentDeps): Agent {
  const now = deps.now ?? (() => new Date());
  const git = deps.git ?? runGit;
  const plugins = deps.plugins ?? (() => readInstalledPlugins());
  const store: AgentStore = openStore(deps.dir, localDay(now()));
  const running = new Map<string, { handle: RunHandle; progress: RunProgress }>();
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

  const settings = (): AgentSettings | null => {
    try {
      return deps.loadSettings().agent;
    } catch {
      return null;
    }
  };
  const changed = () => deps.onChange?.();

  function enqueue(job: AgentJob, pr: PullRequest): void {
    store.data.items.push({
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
      headline: job.scenario === "brief" ? "Queued: a brief (too big to review on its own)" : "Queued: review",
      queuedAt: now().toISOString(),
    });
    store.log({ at: now().toISOString(), prNumber: job.prNumber, repo: job.repo, scenario: job.scenario, runId: "", event: "queued", headOid: pr.headOid });
  }

  function onSnapshot(snapshot: DashboardResponse): void {
    const s = settings();
    if (!s?.enabled) {
      idle = Object.fromEntries(snapshot.pullRequests.map((p) => [p.id, "The agent is off"]));
      return;
    }
    const own = new Set([...store.data.items.filter((i) => i.state === "working").map((i) => i.sessionId ?? "")]);
    const sessions = deps.getSessions().filter((x) => !own.has(x.id));
    const plan = planJobs(snapshot.pullRequests, s, { hasOwnSession: (pr) => sessionsForPr(pr, sessions).length > 0 });
    idle = Object.fromEntries(plan.idle);
    const byId = new Map(snapshot.pullRequests.map((p) => [p.id, p]));
    const wanted = new Set(plan.jobs.map((j) => j.key));
    let dirty = false;
    for (const job of plan.jobs) {
      if (store.data.ledger[job.key]) continue;
      if (store.data.items.some((i) => i.key === job.key && (i.state === "queued" || i.state === "working"))) continue;
      enqueue(job, byId.get(job.prId)!);
      dirty = true;
    }
    // A queued job the PR no longer wants (you reviewed it, it went away) leaves quietly.
    for (const item of store.data.items) {
      if (item.state === "queued" && !wanted.has(item.key)) {
        item.state = "done";
        item.headline = "No longer needed";
        item.finishedAt = now().toISOString();
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
      item.finishedAt = now().toISOString();
      // Recorded even when the run never started, or every tick would queue the
      // same PR again; a new head commit is a new key and gets another try.
      store.data.ledger[item.key] = { state: "failed", at: item.finishedAt, runId: item.runId };
      store.log({ at: item.finishedAt, prNumber: item.prNumber, repo: item.repo, scenario: item.scenario, runId: item.runId, event: "failed", detail: error ?? headline });
    };
    const checkout = deps.findCheckout(pr, all.claude);
    if (!checkout) return fail(`No checkout of ${pr.repo} — set its folder in Settings › Claude`);
    const remote = remoteFor(checkout, pr);
    if (!remote) return fail(`No remote of ${checkout} points at ${pr.repo}`);

    store.data.ledger[item.key] = { state: "started", at: now().toISOString(), runId: item.runId };
    store.data.runsToday += 1;
    item.state = "working";
    item.startedAt = now().toISOString();
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

    const kind = SCENARIO_KIND[item.scenario];
    const resolved = resolveSkillRefs(renderAgentPrompt(promptFor(item.scenario, all.claude), "", item.url), plugins());
    const settingsFile = path.join(deps.dir, "runs", item.runId, "settings.json");
    writeRunSettings(settingsFile, hookCommand(deps.execPath, deps.hookScript, kind));
    const sessionId = randomUUID();
    item.sessionId = sessionId;
    store.log({ at: now().toISOString(), prNumber: item.prNumber, repo: item.repo, scenario: item.scenario, runId: item.runId, event: "started", headOid: pr.headOid, sessionId });

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
        const entry = running.get(item.runId);
        if (entry) entry.progress = progress;
        if (progress.rateLimit && progress.rateLimit.status !== "allowed" && progress.rateLimit.resetsAt) {
          heldUntil = progress.rateLimit.resetsAt * 1000;
        }
        changed();
      },
      deps.spawner,
    );
    running.set(item.runId, { handle, progress: handle.progress() });
    void store.save();
    changed();

    const outcome = await handle.done;
    running.delete(item.runId);
    const result = outcome.progress.result;
    item.finishedAt = now().toISOString();
    if (outcome.stopped) {
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
    if (item.state !== "needsYou" && item.worktree && item.checkout) {
      await removeWorktree(git, item.checkout, item.worktree).catch(() => {});
      item.worktree = undefined;
    }
    void store.save();
    changed();
    tick();
  }

  function tick(): void {
    if (stopped) return;
    const all = (() => {
      try {
        return deps.loadSettings();
      } catch {
        return null;
      }
    })();
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

  const loop = () => {
    if (stopped) return;
    tick();
    timer = setTimeout(loop, deps.tickMs ?? 5_000);
    timer.unref?.();
  };
  loop();

  return {
    onSnapshot,
    getState: () => ({
      enabled: settings()?.enabled ?? false,
      running: [...running.entries()].flatMap(([runId, r]) => {
        const item = store.data.items.find((i) => i.runId === runId);
        return item ? [{ item, progress: r.progress }] : [];
      }),
      items: store.data.items,
      idle,
      runsToday: store.data.runsToday,
      heldUntil: heldUntil !== null ? new Date(heldUntil).toISOString() : null,
    }),
    ownSessionIds: () => new Set(store.data.items.filter((i) => i.state === "working" && i.sessionId).map((i) => i.sessionId!)),
    isActive: () => settings()?.enabled ?? false,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const r of running.values()) r.handle.stop();
    },
  };
}
