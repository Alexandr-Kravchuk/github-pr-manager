// Long-open ("stale") PRs and what closing one does to its Jira task.
//
// Node-free (see AGENTS.md): the renderer value-imports it for the close
// dialog's suggestions, and the guard test in tests/run-tests.cjs keeps the
// compiled module free of `node:` builtins.

/** How long a PR stays open before it counts as stale, when nothing is set. */
export const DEFAULT_STALE_AFTER_DAYS = 30;
/** The largest threshold the settings accept. 0 switches the feature off. */
export const MAX_STALE_AFTER_DAYS = 365;

const DAY_MS = 864e5;

/**
 * Coerces the `staleAfterDays` setting: a whole number of days in 0–365, where
 * 0 turns the stale badge, chip and close action off. Missing or garbage falls
 * back to the default instead of failing the save.
 */
export function validateStaleAfterDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_STALE_AFTER_DAYS;
  return Math.min(MAX_STALE_AFTER_DAYS, Math.max(0, Math.round(n)));
}

/** Whole days the PR has been open. */
export function openDays(createdAt: string, now: number): number {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/**
 * Whether a PR has been open long enough to offer closing it. Counted from
 * `createdAt`, not `updatedAt`: a PR that someone keeps rebasing or commenting
 * on for two months is still a PR nobody merged in two months.
 */
export function isStalePr(pr: { createdAt: string }, staleAfterDays: number, now: number): boolean {
  if (staleAfterDays <= 0) return false;
  return openDays(pr.createdAt, now) >= staleAfterDays;
}

/**
 * Whether the close action is offered on this PR: it is stale and it is yours.
 * Someone else's PR is theirs to close — and deleting or re-opening the Jira
 * task behind it is a decision about their work, not yours.
 */
export function canCloseStale(pr: { isStale: boolean; roles: readonly string[] }): boolean {
  return pr.isStale && pr.roles.includes("author");
}

/** What happens to the PR's Jira task when the PR is closed. */
export type JiraTaskAction = "keep" | "todo" | "wontDo" | "delete";

export const JIRA_TASK_ACTIONS: readonly JiraTaskAction[] = ["keep", "todo", "wontDo", "delete"];

/** One workflow transition Jira offers on the task right now. */
export interface JiraTransitionOption {
  id: string;
  name: string;
  /** The status the transition leads to. */
  toStatus: string;
  /** That status's category key: "new" (To Do), "indeterminate" (In Progress) or "done". */
  toCategory: string;
  /**
   * The resolutions the transition's screen takes, when it has a resolution
   * field — empty when it has none (Jira then sets one itself, or none at all).
   */
  resolutions: { id: string; name: string }[];
  /** Whether that resolution field must be filled for the transition to go through. */
  resolutionRequired: boolean;
}

/** What the close dialog needs to know about the PR's task. */
export interface JiraTaskInfo {
  key: string;
  summary: string | null;
  status: string;
  statusCategory: string;
  /** How many subtasks a delete would take with it. */
  subtaskCount: number;
  transitions: JiraTransitionOption[];
}

const TODO_NAME = /\bto ?do\b/i;
const TODO_LIKE_NAME = /open|backlog/i;
const WONT_DO_NAME = /won'?t\s*(do|fix)|wont\s*(do|fix)|declin|reject|cancel|abandon|obsolete|not\s*(needed|doing)/i;

/**
 * The transition the dialog preselects for an action, or null when none fits
 * and the user has to pick one. Workflows differ per project, so this only
 * suggests — the dialog always shows every transition Jira offers.
 *
 * - `todo`: a transition into the To Do category, preferring one whose name
 *   says so — "To Do" first, then "Reopen" / "Backlog".
 * - `wontDo`: a transition named like a rejection ("Won't Do", "Declined",
 *   "Cancelled") — by its own name first, then by its target status; failing
 *   that, any transition into Done that can carry a Won't-Do resolution.
 */
export function suggestTransition(
  transitions: readonly JiraTransitionOption[],
  action: JiraTaskAction,
): JiraTransitionOption | null {
  if (action === "todo") {
    const todo = transitions.filter((t) => t.toCategory === "new");
    return (
      todo.find((t) => TODO_NAME.test(t.toStatus) || TODO_NAME.test(t.name)) ??
      todo.find((t) => TODO_LIKE_NAME.test(t.toStatus) || TODO_LIKE_NAME.test(t.name)) ??
      todo[0] ??
      null
    );
  }
  if (action === "wontDo") {
    return (
      transitions.find((t) => WONT_DO_NAME.test(t.name)) ??
      transitions.find((t) => WONT_DO_NAME.test(t.toStatus)) ??
      transitions.find((t) => t.toCategory === "done" && suggestResolution(t.resolutions) !== null) ??
      null
    );
  }
  return null;
}

/** The resolution that reads as "Won't Do", or null when the list has none. */
export function suggestResolution(
  resolutions: readonly { id: string; name: string }[],
): { id: string; name: string } | null {
  return resolutions.find((r) => WONT_DO_NAME.test(r.name)) ?? null;
}

/** The renderer's close request, after `validateCloseStaleOptions`. */
export interface CloseStaleOptions {
  /** Posted on the PR before closing it; empty posts nothing. */
  comment: string;
  jira:
    | { action: "keep" }
    | { action: "todo" | "wontDo"; transitionId: string; resolutionId: string | null }
    | { action: "delete"; deleteSubtasks: boolean };
}

/** How one close went, step by step — a later step can fail after an earlier one landed. */
export interface CloseStaleResult {
  ok: boolean;
  /** Whether the PR itself was closed. */
  prClosed: boolean;
  /** What happened to the task; null when it was left alone. */
  jira: { ok: boolean; message: string } | null;
  /** The first failure, worded for the dialog. */
  error?: string;
}
