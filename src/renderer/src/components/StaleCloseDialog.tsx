import { useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

// Node-free, like pr-filter.ts — value-imported for the suggestions.
import {
  canCloseStale,
  openDays,
  suggestResolution,
  suggestTransition,
  type CloseStaleOptions,
  type CloseStaleResult,
  type JiraTaskAction,
  type JiraTaskInfo,
} from "../../../shared/stale";
import type { PullRequest } from "../../../shared/types";
import { cn } from "../format";
import { StaleCloseContext } from "./stale-close-context";

const ACTION_LABEL: Record<JiraTaskAction, string> = {
  keep: "Leave the task as it is",
  todo: "Move the task back to To Do",
  wontDo: "Close the task as Won't Do",
  delete: "Delete the task",
};

type TaskState =
  | { state: "none"; reason: string }
  | { state: "loading" }
  | { state: "ready"; task: JiraTaskInfo }
  | { state: "error"; error: string };

/**
 * The one control the views put on a stale PR of yours: a small "close" button
 * that opens the dialog. Renders nothing for any other PR, and outside the
 * provider — so a view can drop it in unconditionally.
 */
export function StaleCloseButton({
  pr,
  iconOnly = false,
  className,
}: {
  pr: PullRequest;
  /** Just the glyph — for the tile's glyph row and the table's action cell. */
  iconOnly?: boolean;
  className?: string;
}) {
  const open = useContext(StaleCloseContext);
  if (!open || !canCloseStale(pr)) return null;
  const days = openDays(pr.createdAt, Date.now());
  return (
    <button
      type="button"
      onClick={() => open(pr)}
      title={`Open for ${days} days — close this PR and decide what happens to its Jira task`}
      aria-label="Close stale PR"
      className={cn(
        iconOnly
          ? "shrink-0 rounded px-0.5 text-stone-600 hover:bg-elevated dark:text-stone-300"
          : "inline-flex shrink-0 items-center gap-1 rounded-md border border-stone-500/40 bg-stone-500/15 px-1.5 py-0.5 text-xs font-medium text-stone-700 hover:bg-stone-500/25 dark:text-stone-300",
        className,
      )}
    >
      {iconOnly ? "🕸" : "🕸 Close…"}
    </button>
  );
}

/**
 * Close a long-open PR of yours, and in the same step move its Jira task back to
 * To Do, close it as Won't Do, or delete it. Workflows differ per project, so
 * the transitions come from Jira itself (`getStaleJiraTask`) and the dialog only
 * preselects the one that reads like the chosen action. Everything that reaches
 * GitHub or Jira is re-derived in main from the PR id.
 */
export function StaleCloseDialog({
  pr,
  jiraConfigured,
  onDismiss,
}: {
  pr: PullRequest;
  /** Whether a Jira site and token are set up at all. */
  jiraConfigured: boolean;
  onDismiss: () => void;
}) {
  const days = openDays(pr.createdAt, Date.now());
  const [comment, setComment] = useState(
    `Closing this PR: it has been open for ${days} days without being merged.`,
  );
  const [action, setAction] = useState<JiraTaskAction>("keep");
  const [transitionId, setTransitionId] = useState("");
  const [resolutionId, setResolutionId] = useState("");
  const [confirmKey, setConfirmKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloseStaleResult | null>(null);
  const [task, setTask] = useState<TaskState>(() =>
    !pr.issueKey
      ? { state: "none", reason: "No Jira key in this PR's title or branch." }
      : !jiraConfigured
        ? { state: "none", reason: "Jira isn't set up — add it in Settings → Integrations to manage the task too." }
        : { state: "loading" },
  );

  useEffect(() => {
    if (task.state !== "loading") return;
    let cancelled = false;
    window.api
      .getStaleJiraTask(pr.id)
      .then((r) => {
        if (cancelled) return;
        setTask(r.ok ? { state: "ready", task: r.task } : { state: "error", error: r.error });
      })
      .catch((e: unknown) => {
        if (!cancelled) setTask({ state: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
    // Loaded once per dialog; `task` moves off "loading" right after.
  }, [pr.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onDismiss]);

  const info = task.state === "ready" ? task.task : null;
  const transition = info?.transitions.find((t) => t.id === transitionId) ?? null;

  const chooseAction = (next: JiraTaskAction) => {
    setAction(next);
    setConfirmKey("");
    if (!info || (next !== "todo" && next !== "wontDo")) return;
    const suggested = suggestTransition(info.transitions, next);
    setTransitionId(suggested?.id ?? "");
    setResolutionId(next === "wontDo" && suggested ? (suggestResolution(suggested.resolutions)?.id ?? "") : "");
  };

  const chooseTransition = (id: string) => {
    setTransitionId(id);
    const t = info?.transitions.find((x) => x.id === id);
    setResolutionId(t && action === "wontDo" ? (suggestResolution(t.resolutions)?.id ?? "") : "");
  };

  const blocker = useMemo((): string | null => {
    if (action === "keep") return null;
    if (!info) return "The Jira task couldn't be loaded.";
    if (action === "delete") return confirmKey.trim().toUpperCase() === info.key ? null : `Type ${info.key} to confirm.`;
    if (!transition) return "Pick a transition.";
    if (transition.resolutionRequired && !resolutionId) return "Pick a resolution.";
    return null;
  }, [action, info, confirmKey, transition, resolutionId]);

  const submit = () => {
    if (blocker || busy) return;
    let jira: CloseStaleOptions["jira"];
    if (action === "keep") jira = { action: "keep" };
    else if (action === "delete") jira = { action: "delete", deleteSubtasks: (info?.subtaskCount ?? 0) > 0 };
    else jira = { action, transitionId, resolutionId: resolutionId || null };
    setBusy(true);
    window.api
      .closeStalePr(pr.id, { comment, jira })
      .then((r) => {
        if (r.ok) onDismiss();
        else setResult(r);
      })
      .catch((e: unknown) =>
        setResult({ ok: false, prClosed: false, jira: null, error: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => setBusy(false));
  };

  // After the PR closed, only the task can still be wrong: nothing left to submit.
  const done = result?.prClosed === true;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onDismiss();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="stale-close-title"
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-line bg-surface p-5 text-sm text-fg shadow-xl"
      >
        <h2 id="stale-close-title" className="mb-1 text-base font-semibold">
          Close stale PR
        </h2>
        <p className="mb-4 text-xs text-fg-muted">
          {pr.repo} #{pr.number} · {pr.title} — open for {days} days
        </p>

        <label className="mb-1 block text-xs font-medium text-fg-secondary" htmlFor="stale-close-comment">
          Comment on the PR (optional)
        </label>
        <textarea
          id="stale-close-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          disabled={busy || done}
          rows={3}
          className="mb-4 w-full rounded-md border border-line-strong bg-canvas px-2 py-1.5 text-sm"
        />

        <fieldset className="mb-4" disabled={busy || done}>
          <legend className="mb-1 text-xs font-medium text-fg-secondary">
            Jira task{pr.issueKey ? ` ${pr.issueKey}` : ""}
            {info && (
              <span className="font-normal text-fg-muted">
                {" "}
                · now {info.status}
                {info.summary ? ` · ${info.summary}` : ""}
              </span>
            )}
          </legend>
          {task.state === "none" && <p className="text-xs text-fg-muted">{task.reason}</p>}
          {task.state === "loading" && <p className="text-xs text-fg-muted">Loading the task from Jira…</p>}
          {task.state === "error" && (
            <p className="text-xs text-red-600 dark:text-red-400">Couldn't load the task: {task.error}</p>
          )}
          {info &&
            (["keep", "todo", "wontDo", "delete"] as const).map((a) => (
              <label key={a} className="flex items-center gap-2 py-0.5">
                <input
                  type="radio"
                  name="stale-close-action"
                  checked={action === a}
                  onChange={() => chooseAction(a)}
                />
                <span className={cn(a === "delete" && "text-red-700 dark:text-red-300")}>{ACTION_LABEL[a]}</span>
              </label>
            ))}

          {info && (action === "todo" || action === "wontDo") && (
            <div className="mt-2 space-y-2 pl-6">
              <label className="block text-xs text-fg-muted">
                Transition
                <select
                  value={transitionId}
                  onChange={(e) => chooseTransition(e.target.value)}
                  className="mt-0.5 block w-full rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg"
                >
                  <option value="">Choose…</option>
                  {info.transitions.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name === t.toStatus ? t.name : `${t.name} → ${t.toStatus}`}
                    </option>
                  ))}
                </select>
              </label>
              {info.transitions.length === 0 && (
                <p className="text-xs text-fg-muted">Jira offers no transitions on this task for your account.</p>
              )}
              {transition && transition.resolutions.length > 0 && (
                <label className="block text-xs text-fg-muted">
                  Resolution{transition.resolutionRequired ? "" : " (optional)"}
                  <select
                    value={resolutionId}
                    onChange={(e) => setResolutionId(e.target.value)}
                    className="mt-0.5 block w-full rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg"
                  >
                    <option value="">{transition.resolutionRequired ? "Choose…" : "None"}</option>
                    {transition.resolutions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          {info && action === "delete" && (
            <div className="mt-2 pl-6">
              <p className="mb-1 text-xs text-red-700 dark:text-red-300">
                Deleting can't be undone
                {info.subtaskCount > 0
                  ? ` — its ${info.subtaskCount} subtask${info.subtaskCount === 1 ? "" : "s"} will be deleted too`
                  : ""}
                . Type {info.key} to confirm.
              </p>
              <input
                value={confirmKey}
                onChange={(e) => setConfirmKey(e.target.value)}
                placeholder={info.key}
                className="w-full rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm"
              />
            </div>
          )}
        </fieldset>

        {result?.error && (
          <p className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-300">
            {result.error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          {blocker && !done && <span className="mr-auto text-xs text-fg-subtle">{blocker}</span>}
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="rounded-md border border-line-strong px-3 py-1 text-sm hover:bg-elevated"
          >
            {done ? "Done" : "Cancel"}
          </button>
          {!done && (
            <button
              type="button"
              onClick={submit}
              disabled={busy || blocker !== null}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium text-white disabled:opacity-50",
                action === "delete" ? "bg-red-600 hover:bg-red-700" : "bg-sky-600 hover:bg-sky-700",
              )}
            >
              {busy ? "Closing…" : action === "keep" ? "Close PR" : `Close PR and ${action === "delete" ? "delete" : "update"} task`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
