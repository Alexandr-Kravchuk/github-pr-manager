// What an agent session is doing, folded out of `claude -p --output-format
// stream-json` events. Pure and Node-free: the runner feeds it every line, the
// companion renders the result, and the tests replay events recorded from a
// real session (Claude Code 2.1.270) without spawning anything.
//
// The plan comes from the task-list tools: `TaskCreate` ({subject}) answered by
// a tool_result "Task #N created successfully: …", then `TaskUpdate`
// ({taskId, status}). Older Claude Code versions used `TodoWrite` ({todos}) —
// read too, so a downgrade doesn't blank the ring.

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  id: string;
  subject: string;
  status: PlanStatus;
}

export interface RunResult {
  /** "success", "error_during_execution", "error_max_turns", … */
  subtype: string;
  isError: boolean;
  /** The session's final message — for a shadow review, the review it would post. */
  text: string;
  /** Tool calls the permission rules refused. */
  denials: number;
  /** The refused tools by name, once each — what to look at when a run couldn't do its job. */
  deniedTools?: string[];
  /** What Claude reports for the session so far — for the agent's log. */
  turns?: number;
  costUsd?: number;
  durationMs?: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface RunProgress {
  sessionId: string | null;
  steps: PlanStep[];
  /** TaskCreate calls still waiting for their tool_result (which carries the task id). */
  pendingCreates: Array<{ toolUseId: string; subject: string }>;
  /** What the agent is doing this second, one line. */
  activity: string | null;
  /** The latest thing it said. */
  lastText: string | null;
  toolCalls: number;
  /** The latest Claude usage-limit reading: the scheduler holds runs back once it says "rejected" (`usageHoldUntil`). */
  rateLimit: { status: string; resetsAt: number | null } | null;
  /**
   * Background tasks the session is still running — a skill's Workflow runs
   * as one. A result while one runs is not the end: the session gets the
   * task's notification and answers again, so stdin stays open for hints.
   */
  backgroundTasks: number;
  /** The latest result; with a background workflow there are several, and the last one is the run's. */
  result: RunResult | null;
}

export function initialProgress(): RunProgress {
  return {
    sessionId: null,
    steps: [],
    pendingCreates: [],
    activity: null,
    lastText: null,
    toolCalls: 0,
    rateLimit: null,
    backgroundTasks: 0,
    result: null,
  };
}

/**
 * A Workflow's phases as plan steps, from its `task_progress` report: a phase
 * with an agent still running is in progress, a phase before the latest one
 * that has agents is done. A skill that runs as a workflow (the review does)
 * keeps no task list of its own, and its phases — Context, Review, Synthesize,
 * Publish — are the steps worth showing anyway.
 */
export function workflowSteps(progress: unknown): PlanStep[] | null {
  if (!Array.isArray(progress)) return null;
  const phases = progress.filter((x): x is Obj => isObj(x) && x.type === "workflow_phase" && typeof x.index === "number");
  if (phases.length === 0) return null;
  const agents = progress.filter((x): x is Obj => isObj(x) && x.type === "workflow_agent" && typeof x.phaseIndex === "number");
  const latest = agents.reduce((m, a) => Math.max(m, a.phaseIndex as number), 0);
  return phases.map((ph) => {
    const index = ph.index as number;
    const own = agents.filter((a) => a.phaseIndex === index);
    const busy = own.some((a) => a.state !== "done" && a.state !== "failed" && a.state !== "cancelled");
    const status: PlanStatus = busy ? "in_progress" : own.length > 0 && (index < latest || own.every((a) => a.state === "done")) ? "completed" : "pending";
    return { id: `wf-${index}`, subject: str(ph.title) || `Phase ${index}`, status };
  });
}

/** One stream-json line, or null when it isn't one. */
export function parseStreamLine(line: string): unknown {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function shorten(text: string, max = 120): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** The live line for a tool call; null for the ones that are noise (the plan tools, tool loading). */
export function describeToolUse(name: string, input: unknown): string | null {
  const i = isObj(input) ? input : {};
  switch (name) {
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
    case "TodoWrite":
    case "ToolSearch":
      return null;
    case "Read":
      return `Reading ${baseName(str(i.file_path))}`;
    case "Grep":
      return `Searching for “${shorten(str(i.pattern), 60)}”`;
    case "Glob":
      return `Listing ${shorten(str(i.pattern), 60)}`;
    case "Edit":
    case "Write":
    case "MultiEdit":
      return `Editing ${baseName(str(i.file_path))}`;
    case "Bash":
      return `$ ${shorten(str(i.command), 100)}`;
    case "Skill":
      return `Using the ${str(i.skill) || "skill"} skill`;
    case "Agent":
      return `Agent: ${shorten(str(i.description) || str(i.prompt), 80)}`;
    case "Workflow":
      return `Running the ${str(i.name) || baseName(str(i.scriptPath)).replace(/(\.workflow)?\.js$/, "") || "skill's"} workflow`;
    default:
      return name.startsWith("mcp__") ? `Asking ${name.split("__")[1] ?? "a tool"}` : name;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (isObj(c) ? str(c.text) : "")).join("\n");
  return "";
}

function setStatus(steps: PlanStep[], id: string, status: PlanStatus): PlanStep[] {
  return steps.map((s) => (s.id === id ? { ...s, status } : s));
}

function isStatus(v: unknown): v is PlanStatus {
  return v === "pending" || v === "in_progress" || v === "completed";
}

/** Folds one stream-json event into the progress. Unknown events leave it as it was. */
export function applyStreamEvent(p: RunProgress, ev: unknown): RunProgress {
  if (!isObj(ev)) return p;
  const type = str(ev.type);

  if (type === "system" && str(ev.subtype) === "init") {
    return { ...p, sessionId: str(ev.session_id) || p.sessionId };
  }

  if (type === "system" && str(ev.subtype) === "background_tasks_changed" && Array.isArray(ev.tasks)) {
    return { ...p, backgroundTasks: ev.tasks.length };
  }

  if (type === "system" && str(ev.subtype) === "task_progress") {
    const steps = workflowSteps(ev.workflow_progress);
    const description = str(ev.description);
    if (!steps && !description) return p;
    return { ...p, steps: steps ?? p.steps, activity: description ? shorten(description, 100) : p.activity };
  }

  if (type === "rate_limit_event" && isObj(ev.rate_limit_info)) {
    const info = ev.rate_limit_info;
    return {
      ...p,
      rateLimit: { status: str(info.status) || "unknown", resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : null },
    };
  }

  if (type === "assistant" && isObj(ev.message) && Array.isArray(ev.message.content)) {
    let next = p;
    for (const c of ev.message.content) {
      if (!isObj(c)) continue;
      if (c.type === "text" && str(c.text).trim()) next = { ...next, lastText: str(c.text) };
      if (c.type !== "tool_use") continue;
      const name = str(c.name);
      const input = isObj(c.input) ? c.input : {};
      next = { ...next, toolCalls: next.toolCalls + 1 };
      if (name === "TaskCreate" && str(input.subject)) {
        next = { ...next, pendingCreates: [...next.pendingCreates, { toolUseId: str(c.id), subject: str(input.subject) }] };
      } else if (name === "TaskUpdate" && isStatus(input.status)) {
        next = { ...next, steps: setStatus(next.steps, String(input.taskId ?? ""), input.status) };
      } else if (name === "TodoWrite" && Array.isArray(input.todos)) {
        const steps = input.todos
          .filter(isObj)
          .map((t, n) => ({ id: String(n + 1), subject: str(t.content), status: isStatus(t.status) ? t.status : "pending" }));
        next = { ...next, steps };
      }
      const line = describeToolUse(name, input);
      if (line) next = { ...next, activity: line };
    }
    return next;
  }

  if (type === "user" && isObj(ev.message) && Array.isArray(ev.message.content)) {
    let next = p;
    for (const c of ev.message.content) {
      if (!isObj(c) || c.type !== "tool_result") continue;
      const pending = next.pendingCreates.find((x) => x.toolUseId === str(c.tool_use_id));
      if (!pending) continue;
      const m = /Task #(\d+) created/.exec(resultText(c.content));
      next = {
        ...next,
        pendingCreates: next.pendingCreates.filter((x) => x !== pending),
        steps: m ? [...next.steps, { id: m[1], subject: pending.subject, status: "pending" }] : next.steps,
      };
    }
    return next;
  }

  if (type === "result") {
    const denied = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
    const deniedTools = [...new Set(denied.map((d) => (isObj(d) ? str(d.tool_name) : "")).filter(Boolean))];
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const usage = isObj(ev.usage) ? ev.usage : null;
    const turns = num(ev.num_turns);
    const costUsd = num(ev.total_cost_usd);
    const durationMs = num(ev.duration_ms);
    return {
      ...p,
      sessionId: str(ev.session_id) || p.sessionId,
      result: {
        subtype: str(ev.subtype) || "unknown",
        isError: ev.is_error === true,
        text: str(ev.result),
        denials: denied.length,
        ...(deniedTools.length > 0 ? { deniedTools } : {}),
        ...(turns !== undefined ? { turns } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(usage
          ? {
              tokens: {
                input: num(usage.input_tokens) ?? 0,
                output: num(usage.output_tokens) ?? 0,
                cacheRead: num(usage.cache_read_input_tokens) ?? 0,
                cacheWrite: num(usage.cache_creation_input_tokens) ?? 0,
              },
            }
          : {}),
      },
    };
  }

  return p;
}

/** The current step: the one in progress, else the first not done. */
/**
 * Until when (ms) the scheduler holds its queue for a usage-limit reading, or
 * null to go on. Only "rejected" — the limit is reached — holds: Claude Code
 * also sends "allowed_warning" once a window passes a threshold (75% of the
 * seven-day window, say), and holding on that stopped every run for days of
 * usage still left.
 */
export function usageHoldUntil(rateLimit: RunProgress["rateLimit"]): number | null {
  if (!rateLimit || rateLimit.status !== "rejected" || !rateLimit.resetsAt) return null;
  return rateLimit.resetsAt * 1000;
}

export function currentStep(p: Pick<RunProgress, "steps">): PlanStep | null {
  return p.steps.find((s) => s.status === "in_progress") ?? p.steps.find((s) => s.status !== "completed") ?? null;
}
