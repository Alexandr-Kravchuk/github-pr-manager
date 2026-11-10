import {
  CLAUDE_LAUNCH_KINDS,
  JIRA_KEY_RE,
  GROUP_LAUNCH_KINDS,
  MAX_GROUP_PRS,
  type GroupLaunchKind,
  type ClaudeLaunchKind,
} from "../shared/claude-launch";
import type { CloseStaleOptions } from "../shared/stale";
import type { AgentAction, JiraStatusMode, SeenInput, ThemePreference } from "../shared/types";

// Validators for values that cross the IPC boundary from the renderer. The
// renderer is trusted, but a compromised/buggy caller must not be able to push
// arbitrary shapes into the main process, so each handler runs its arguments
// through these before use.

/** Coerces the renderer's mark-seen payload into a clean SeenInput[]. */
export function validateSeenItems(value: unknown): SeenInput[] {
  if (!Array.isArray(value)) {
    throw new Error("mark-seen: expected an array of items.");
  }
  return value
    .filter(
      (it): it is SeenInput =>
        typeof it === "object" &&
        it !== null &&
        typeof (it as SeenInput).id === "string" &&
        typeof (it as SeenInput).comments === "number" &&
        typeof (it as SeenInput).updatedAt === "string",
    )
    .map((it) => ({
      id: it.id,
      comments: it.comments,
      updatedAt: it.updatedAt,
      // Optional/nullable — normalize anything non-string to null.
      lastCommitPushedAt:
        typeof it.lastCommitPushedAt === "string" ? it.lastCommitPushedAt : null,
    }));
}

/** Validates the renderer's ignore/un-ignore payload. */
export function validateIgnoredArgs(
  id: unknown,
  ignored: unknown,
): { id: string; ignored: boolean } {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("setIgnored: id must be a non-empty string.");
  }
  if (typeof ignored !== "boolean") {
    throw new Error("setIgnored: ignored must be a boolean.");
  }
  return { id, ignored };
}

/** Ensures a URL is a real http(s) URL before handing it to shell.openExternal. */
export function validateExternalUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("openExternal: url must be a string.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`openExternal: invalid url: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`openExternal: refusing non-http(s) url: ${value}`);
  }
  return value;
}

/** Ensures a renderer-supplied theme is one of the known preferences. */
export function validateThemePreference(value: unknown): ThemePreference {
  if (value === "system" || value === "light" || value === "dark") {
    return value;
  }
  throw new Error(`setTheme: invalid theme preference: ${String(value)}`);
}

/** Ensures a Jira token is a string of sane length. Empty string clears it. */
export function validateJiraToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("setJiraToken: expected a string.");
  }
  if (value.length > 5_000) {
    throw new Error("setJiraToken: token too long.");
  }
  return value.trim();
}

/** Ensures a Jira status mode is one of the known ones; absent means `cached`. */
export function validateJiraStatusMode(value: unknown): JiraStatusMode {
  if (value === undefined || value === "cached") return "cached";
  if (value === "fresh") return value;
  throw new Error(`getJiraStatus: invalid mode: ${String(value)}`);
}

/** Ensures clipboard text is a string of sane length before writing it. */
export function validateClipboardText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("copyText: expected a string.");
  }
  if (value.length > 10_000) {
    throw new Error("copyText: text too long.");
  }
  return value;
}

/**
 * Validates the action the renderer picked from the Claude button's menu:
 * undefined (the button itself — main picks from the PR's state) or one of the
 * fixed kinds. Only the kind crosses over; its prompt comes from Settings.
 */
export function validateClaudeKind(value: unknown): ClaudeLaunchKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (CLAUDE_LAUNCH_KINDS as readonly string[]).includes(value)) {
    return value as ClaudeLaunchKind;
  }
  throw new Error("launchClaude: unknown action.");
}

/** Validates the "… in terminal" flag of a Claude launch: undefined or a boolean. */
export function validateInTerminal(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  throw new Error("launchClaude: expected inTerminal to be a boolean.");
}

/** Validates the PR id the renderer asks to start a Claude session on. */
export function validatePrId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error("launchClaude: expected a PR id.");
  }
  return value;
}

/**
 * Validates a group launch's arguments: the kind, the group's Jira key — it is
 * written into the prompt, so nothing but a key's characters may pass — and 1
 * to `MAX_GROUP_PRS` distinct PR ids. Which of them a launch takes is decided
 * in main (`groupLaunchPrs`), not here.
 */
export function validateGroupLaunchArgs(
  kind: unknown,
  key: unknown,
  ids: unknown,
): { kind: GroupLaunchKind; key: string; ids: string[] } {
  if (typeof kind !== "string" || !(GROUP_LAUNCH_KINDS as readonly string[]).includes(kind)) {
    throw new Error("launchClaudeGroup: unknown action.");
  }
  if (typeof key !== "string" || !JIRA_KEY_RE.test(key)) {
    throw new Error("launchClaudeGroup: expected a Jira issue key.");
  }
  if (!Array.isArray(ids)) throw new Error("launchClaudeGroup: expected a list of PR ids.");
  const unique = [...new Set(ids.map((id) => validatePrId(id)))];
  if (unique.length < 1 || unique.length > MAX_GROUP_PRS) {
    throw new Error(`launchClaudeGroup: expected 1 to ${MAX_GROUP_PRS} PRs.`);
  }
  return { kind: kind as GroupLaunchKind, key, ids: unique };
}

/** Validates the Claude Code session id the renderer asks to switch to. */
export function validateClaudeSessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("focusClaudeSession: expected a session id.");
  }
  return value;
}

/**
 * The renderer's answer to "do these diagrams parse?": the id main minted for
 * the question and one boolean per diagram — never text, so nothing it sends
 * can change what is posted, only hold a diagram back.
 */
export function validateDiagramsChecked(requestId: unknown, results: unknown): { requestId: string; results: boolean[] } {
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error("diagramsChecked: expected the request's id.");
  }
  if (!Array.isArray(results) || results.length > 10 || !results.every((r) => typeof r === "boolean")) {
    throw new Error("diagramsChecked: expected one yes/no per diagram.");
  }
  return { requestId, results: results as boolean[] };
}

const RUN_ACTIONS = ["skip", "retry", "continue", "reviewAnyway", "pause", "resume", "stop", "takeOver", "publish", "push", "reapprove"] as const;
const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A hint is a note to the running session, not a document. */
export const AGENT_HINT_MAX = 2_000;

/**
 * Validates what the renderer asks of the agent. It names a run (a UUID the
 * agent minted) or a PR by id, and a hint carries plain text — never a path,
 * a command or a prompt template: what a run does stays decided in main.
 */
export function validateAgentAction(value: unknown): AgentAction {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  // `before` names a queued run (a UUID the agent minted) or nothing: the end of the queue.
  const before = (): string | null => {
    if (v.before === undefined || v.before === null) return null;
    if (typeof v.before !== "string" || !RUN_ID.test(v.before)) throw new Error("agentAction: expected a run id to queue in front of.");
    return v.before;
  };
  if (v.type === "enqueue") {
    const b = before();
    return { type: "enqueue", prId: validatePrId(v.prId), ...(b ? { before: b } : {}) };
  }
  // What goes out is main's own line on the PR's head: only the PR is named.
  if (v.type === "approveAgain") return { type: "approveAgain", prId: validatePrId(v.prId) };
  // The whole agent: nothing else rides along.
  if (v.type === "pauseAgent" || v.type === "resumeAgent") return { type: v.type };
  if (typeof v.runId !== "string" || !RUN_ID.test(v.runId)) throw new Error("agentAction: expected a run id.");
  if (v.type === "moveQueued") return { type: "moveQueued", runId: v.runId, before: before() };
  if (v.type === "dispute") {
    if (typeof v.replyTo !== "number" || !Number.isInteger(v.replyTo) || v.replyTo <= 0) throw new Error("agentAction: expected a comment id.");
    if (v.choice !== "keep" && v.choice !== "drop") throw new Error("agentAction: a dispute is kept or dropped.");
    return { type: "dispute", runId: v.runId, replyTo: v.replyTo, choice: v.choice };
  }
  if (v.type === "hint" || v.type === "answer") {
    if (typeof v.text !== "string" || !v.text.trim() || v.text.length > AGENT_HINT_MAX) {
      throw new Error(`agentAction: ${v.type === "hint" ? "a hint" : "an answer"} is 1–${AGENT_HINT_MAX} characters.`);
    }
    return { type: v.type, runId: v.runId, text: v.text.trim() };
  }
  if (v.type === "merge") {
    // The method the button's menu picked, if any; main still checks the repository allows it.
    if (v.method === undefined) return { type: "merge", runId: v.runId };
    if (typeof v.method !== "string" || !(MERGE_METHODS as readonly string[]).includes(v.method)) throw new Error("agentAction: unknown merge method.");
    return { type: "merge", runId: v.runId, method: v.method as (typeof MERGE_METHODS)[number] };
  }
  if (typeof v.type === "string" && (RUN_ACTIONS as readonly string[]).includes(v.type)) {
    return { type: v.type as (typeof RUN_ACTIONS)[number], runId: v.runId };
  }
  throw new Error("agentAction: unknown action.");
}

/**
 * Validates the stale-PR close request. Only the choices cross over: the PR,
 * its host and its Jira key are read from main's own snapshot. Transition and
 * resolution ids are Jira's numeric ids, so they cannot reshape a REST path.
 */
export function validateCloseStaleOptions(value: unknown): CloseStaleOptions {
  if (typeof value !== "object" || value === null) throw new Error("closeStalePr: expected options.");
  const obj = value as Record<string, unknown>;
  const comment = typeof obj.comment === "string" ? obj.comment : "";
  if (comment.length > 10_000) throw new Error("closeStalePr: comment too long.");
  const jira = (typeof obj.jira === "object" && obj.jira !== null ? obj.jira : {}) as Record<string, unknown>;
  const numericId = (v: unknown, what: string): string => {
    if (typeof v !== "string" || !/^\d{1,12}$/.test(v)) throw new Error(`closeStalePr: invalid ${what}.`);
    return v;
  };
  switch (jira.action) {
    case undefined:
    case "keep":
      return { comment, jira: { action: "keep" } };
    case "todo":
    case "wontDo":
      return {
        comment,
        jira: {
          action: jira.action,
          transitionId: numericId(jira.transitionId, "transition"),
          resolutionId:
            jira.resolutionId === null || jira.resolutionId === undefined
              ? null
              : numericId(jira.resolutionId, "resolution"),
        },
      };
    case "delete":
      return { comment, jira: { action: "delete", deleteSubtasks: jira.deleteSubtasks === true } };
    default:
      throw new Error("closeStalePr: unknown Jira action.");
  }
}
