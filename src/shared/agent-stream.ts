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
  /** The latest Claude usage-limit reading: the scheduler holds runs back while it is not "allowed". */
  rateLimit: { status: string; resetsAt: number | null } | null;
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
    result: null,
  };
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
    return {
      ...p,
      sessionId: str(ev.session_id) || p.sessionId,
      result: {
        subtype: str(ev.subtype) || "unknown",
        isError: ev.is_error === true,
        text: str(ev.result),
        denials: Array.isArray(ev.permission_denials) ? ev.permission_denials.length : 0,
      },
    };
  }

  return p;
}

/** The current step: the one in progress, else the first not done. */
export function currentStep(p: Pick<RunProgress, "steps">): PlanStep | null {
  return p.steps.find((s) => s.status === "in_progress") ?? p.steps.find((s) => s.status !== "completed") ?? null;
}
