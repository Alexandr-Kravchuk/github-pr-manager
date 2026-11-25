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

/** One of Claude's subscription windows: the fraction of it used (may pass 1) and when it resets (Unix seconds). */
export interface UsageWindow {
  utilization: number;
  resetsAt: number;
}

/**
 * A `rate_limit_event`'s `rate_limit_info`, as Claude Code (2.1.270) sends it
 * in stream-json: `status` "allowed" / "allowed_warning" / "rejected" and
 * `resetsAt` of the window that limits now (`rateLimitType`), plus
 * `unifiedWindows` — the session (`five_hour`) and weekly (`seven_day`)
 * windows, each `{ utilization, resetsAt }`, read from the API's
 * `anthropic-ratelimit-unified-*` headers on every reply and sent whenever
 * a window's rounded percentage moves. Absent for an API key (no
 * subscription), and before the first reply that carries them.
 */
export interface UsageReading {
  status: string;
  resetsAt: number | null;
  /** The window `status` and `resetsAt` are about: "five_hour", "seven_day", "seven_day_opus", … */
  type?: string;
  /** The session and weekly windows; an older Claude Code's top-level `utilization` fills the limiting one. */
  windows?: { fiveHour?: UsageWindow; sevenDay?: UsageWindow };
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
  /**
   * The latest Claude usage-limit reading: the scheduler holds runs back once
   * it says "rejected", or once a window is past the agent's cap (`usageHold`).
   */
  rateLimit: UsageReading | null;
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
    return { ...p, rateLimit: readUsage(ev.rate_limit_info) };
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

function readWindow(v: unknown): UsageWindow | undefined {
  if (!isObj(v)) return undefined;
  const { utilization, resetsAt } = v;
  return typeof utilization === "number" && Number.isFinite(utilization) && typeof resetsAt === "number" && Number.isFinite(resetsAt)
    ? { utilization, resetsAt }
    : undefined;
}

/** A `rate_limit_info` held to its shapes; unknown fields are dropped. */
export function readUsage(info: Obj): UsageReading {
  const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt : null;
  const type = str(info.rateLimitType);
  const unified = isObj(info.unifiedWindows) ? info.unifiedWindows : null;
  let fiveHour = unified ? readWindow(unified.five_hour) : undefined;
  let sevenDay = unified ? readWindow(unified.seven_day) : undefined;
  // An older Claude Code: only the limiting window's share, at the top level.
  if (!fiveHour && !sevenDay && resetsAt !== null && typeof info.utilization === "number" && Number.isFinite(info.utilization)) {
    if (type === "five_hour") fiveHour = { utilization: info.utilization, resetsAt };
    if (type === "seven_day") sevenDay = { utilization: info.utilization, resetsAt };
  }
  return {
    status: str(info.status) || "unknown",
    resetsAt,
    ...(type ? { type } : {}),
    ...(fiveHour || sevenDay ? { windows: { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) } } : {}),
  };
}

/** Why the queue waits for Claude's usage, and until when (ms). */
export interface UsageHold {
  until: number;
  why: string;
  /** Set when the agent's cap, not the limit itself, holds: the window's share in percent — a cap raised past it lets go. */
  usage?: number;
}

/** Claude Code's own names for its windows, as its limit messages say them. */
const LIMIT_NAMES: Record<string, string> = {
  five_hour: "session limit",
  seven_day: "weekly limit",
  seven_day_opus: "Opus limit",
  seven_day_sonnet: "Sonnet limit",
  seven_day_overage_included: "Fable limit",
  overage: "usage credit limit",
};

/**
 * Whether a usage reading holds the scheduler's queue, until when and why;
 * null to go on.
 * - "rejected": the limit is reached — until it resets.
 * - A session or weekly window at or past `capPercent` of it (0 is off) —
 *   until that window resets, so what is left of it stays yours. With both
 *   past the cap, the later reset. A window whose reset has passed is spent
 *   history, not a hold.
 * "allowed_warning" alone holds nothing: Claude Code sends it once a window
 * passes a threshold of its own (75% of the seven-day window, say), and
 * holding on that stopped every run for days of usage still left.
 */
export function usageHold(rateLimit: UsageReading | null, capPercent: number, nowMs: number): UsageHold | null {
  if (!rateLimit) return null;
  if (rateLimit.status === "rejected" && rateLimit.resetsAt) {
    return { until: rateLimit.resetsAt * 1000, why: `Claude's ${LIMIT_NAMES[rateLimit.type ?? ""] ?? "usage limit"} reached` };
  }
  if (!(capPercent > 0)) return null;
  let hold: UsageHold | null = null;
  const windows: Array<[string, UsageWindow | undefined]> = [
    ["session", rateLimit.windows?.fiveHour],
    ["weekly", rateLimit.windows?.sevenDay],
  ];
  for (const [name, w] of windows) {
    if (!w) continue;
    const until = w.resetsAt * 1000;
    // Percent to one decimal: 0.8 × 100 is 80.00000000000001, 0.29 × 100 is 28.999999999999996.
    const usage = Math.round(w.utilization * 1000) / 10;
    if (until <= nowMs || usage < capPercent) continue;
    if (!hold || until > hold.until) hold = { until, why: `Claude's ${name} usage at ${Math.round(usage)}% (agent cap ${capPercent}%)`, usage };
  }
  return hold;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Claude Code's line when a request is refused for the subscription's limit,
 * as its result's text: "You've hit your session limit · resets 9:50pm
 * (Europe/Kyiv)"; a reset more than a day away is "… · resets Nov 28, 10am
 * (Europe/Kyiv)", with the year when it isn't this one ("Jan 2, 2027,
 * 9am"). The clock is in the named time zone (Claude Code's own, the
 * machine's), minutes left out on the hour.
 */
const LIMIT_LINE =
  /(?:You['’]ve hit your ([^·\n]+?)|You['’]re (out of usage credits))\s*·[^\n]*?\bresets\s+(?:([A-Za-z]{3})\s+(\d{1,2}),\s+(?:(\d{4}),\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([^)\n]+)\))?/i;

/** The wall clock in `timeZone` (the machine's own when absent) at `ms`. */
function wallClock(ms: number, timeZone: string | undefined): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  if (!timeZone) {
    const t = new Date(ms);
    return { y: t.getFullYear(), mo: t.getMonth() + 1, d: t.getDate(), h: t.getHours(), mi: t.getMinutes(), s: t.getSeconds() };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second") };
}

/** The instant (ms) a wall clock in `timeZone` shows; the machine's own zone when absent. */
function fromWallClock(y: number, mo: number, d: number, h: number, mi: number, timeZone: string | undefined): number {
  if (!timeZone) return new Date(y, mo - 1, d, h, mi).getTime();
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  // The zone's offset at a guess, then at the answer: once more across a DST change.
  let t = wanted;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(t, timeZone);
    t += wanted - Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  }
  return t;
}

/** A time zone Intl knows, or undefined (the machine's own then). */
function knownZone(name: string | undefined): string | undefined {
  if (!name) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return undefined;
  }
}

/**
 * When the limit in Claude Code's limit line resets, and which limit it is;
 * null for any other text, or a limit line with no reset in it. A time with
 * no date is the next time the clock shows it.
 */
export function limitResetFromText(text: string, now: Date): UsageHold | null {
  const m = LIMIT_LINE.exec(text);
  if (!m) return null;
  const [, limit, credits, monthName, dayText, yearText, hourText, minuteText, ampm, zoneName] = m;
  const zone = knownZone(zoneName?.trim());
  const hour12 = Number(hourText);
  if (hour12 < 1 || hour12 > 12) return null;
  const h = (hour12 % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  const mi = minuteText ? Number(minuteText) : 0;
  if (mi > 59) return null;
  const nowMs = now.getTime();
  const today = wallClock(nowMs, zone);
  let until: number;
  if (monthName) {
    const mo = MONTHS.indexOf(monthName.toLowerCase()) + 1;
    const d = Number(dayText);
    if (mo === 0 || d < 1 || d > 31) return null;
    until = fromWallClock(yearText ? Number(yearText) : today.y, mo, d, h, mi, zone);
    // "Jan 2" read in late December, from a Claude Code that left the year out.
    if (!yearText && until < nowMs - 86_400_000) until = fromWallClock(today.y + 1, mo, d, h, mi, zone);
  } else {
    until = fromWallClock(today.y, today.mo, today.d, h, mi, zone);
    if (until <= nowMs) until = fromWallClock(today.y, today.mo, today.d + 1, h, mi, zone);
  }
  if (!Number.isFinite(until)) return null;
  return { until, why: credits ? "Out of Claude usage credits" : `Claude's ${limit.trim()} reached` };
}

/** The current step: the one in progress, else the first not done. */
export function currentStep(p: Pick<RunProgress, "steps">): PlanStep | null {
  return p.steps.find((s) => s.status === "in_progress") ?? p.steps.find((s) => s.status !== "completed") ?? null;
}
