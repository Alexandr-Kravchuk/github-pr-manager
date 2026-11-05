import { useContext } from "react";

// Node-free (see AGENTS.md): which item a PR's card shows, and its run.
import { itemForPr, runFor, todayKey } from "../../../shared/agent-view";
import { currentStep } from "../../../shared/agent-stream";
import type { AgentItem, PullRequest } from "../../../shared/types";
import { cn } from "../format";
import { AgentContext } from "./agent-context";

// The agent's status where the PR already is: a line under a Roomy card, a
// cell in the Cozy table, a glyph on a Compact tile. All three read the same
// item (`itemForPr`), so the views can't disagree about what the agent does.

export const AGENT_STATE_DOT: Record<AgentItem["state"], string> = {
  queued: "bg-zinc-400 dark:bg-zinc-500",
  working: "bg-sky-500",
  needsYou: "bg-amber-500",
  error: "bg-red-500",
  done: "bg-emerald-500",
};

export const AGENT_STATE_TEXT: Record<AgentItem["state"], string> = {
  queued: "Queued",
  working: "Working",
  needsYou: "Needs you",
  error: "Error",
  done: "Done",
};

const STATE_TONE: Record<AgentItem["state"], string> = {
  queued: "text-fg-subtle",
  working: "text-sky-700 dark:text-sky-300",
  needsYou: "text-amber-700 dark:text-amber-300",
  error: "text-red-700 dark:text-red-300",
  done: "text-emerald-700 dark:text-emerald-300",
};

/** The PR's item and, while it runs, what it is doing right now. */
export function useAgentItem(pr: Pick<PullRequest, "id">): { item: AgentItem | null; live: string | null } {
  const { state } = useContext(AgentContext);
  if (!state?.enabled) return { item: null, live: null };
  const item = itemForPr(state.items, pr.id, todayKey(new Date()));
  if (!item) return { item: null, live: null };
  const run = item.state === "working" ? runFor(state, item.runId) : null;
  const step = run ? currentStep(run.progress) : null;
  const live = run ? [step?.subject, run.progress.activity].filter(Boolean).join(" · ") || null : null;
  return { item, live };
}

/** The line under a Roomy card. Nothing at all while the agent has nothing on this PR. */
export function AgentStatusLine({ pr }: { pr: PullRequest }) {
  const { item, live } = useAgentItem(pr);
  const { openCompanion } = useContext(AgentContext);
  if (!item) return null;
  const text = live ?? item.headline;
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-line pt-2 text-xs">
      <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", AGENT_STATE_DOT[item.state])} />
      <span className={cn("shrink-0 font-medium", STATE_TONE[item.state])}>
        {item.state !== "needsYou"
          ? AGENT_STATE_TEXT[item.state]
          : item.scenario === "merge"
            ? "Ready to merge"
            : item.scenario === "drive" && item.drive?.commits.length && !item.pushed
              ? "Would push"
              : item.plan && !item.published
                ? "Would post"
                : AGENT_STATE_TEXT[item.state]}
      </span>
      <span className="min-w-0 flex-1 truncate text-fg-muted" title={text}>
        {text}
      </span>
      {(item.state === "working" || item.state === "needsYou" || item.state === "error") && (
        <button
          type="button"
          onClick={() => openCompanion(item.state === "working" ? item.runId : undefined)}
          className="shrink-0 rounded-md border border-line-strong px-2 py-0.5 text-xs text-fg-secondary hover:bg-elevated"
        >
          {item.state === "working" ? "Watch" : "Open"}
        </button>
      )}
    </div>
  );
}

/** The Cozy table's Agent cell. */
export function AgentCell({ pr }: { pr: PullRequest }) {
  const { item, live } = useAgentItem(pr);
  if (!item) return <span className="text-xs text-fg-faint">—</span>;
  const text = live ?? item.headline;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs" title={`${AGENT_STATE_TEXT[item.state]} — ${text}`}>
      <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", AGENT_STATE_DOT[item.state])} />
      <span className="truncate text-fg-muted">{text}</span>
    </span>
  );
}

/** A Compact tile's glyph: the state as a dot, the words in its title. */
export function AgentGlyph({ pr }: { pr: PullRequest }) {
  const { item, live } = useAgentItem(pr);
  if (!item) return null;
  return (
    <span
      role="img"
      aria-label={`Agent: ${AGENT_STATE_TEXT[item.state]}`}
      title={`Agent — ${AGENT_STATE_TEXT[item.state]}: ${live ?? item.headline}`}
      className={cn("inline-block size-2 shrink-0 rounded-full ring-2 ring-surface", AGENT_STATE_DOT[item.state])}
    />
  );
}
