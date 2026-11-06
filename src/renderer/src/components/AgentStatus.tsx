import { useContext } from "react";

// Node-free (see AGENTS.md): where the PR stands on the Board, in the Board's words.
import { boardStage, COLUMN_TITLES, inLine, queueOrder, runFor, stageLine, stepLabel, todayKey, workLine, type BoardColumn, type BoardStage } from "../../../shared/agent-view";
import type { AgentItem, PullRequest } from "../../../shared/types";
import { cn } from "../format";
import { AgentContext } from "./agent-context";

// The agent's word on a PR where the PR already is: a line under a Roomy card,
// a cell in the Cozy table, a glyph on a Compact tile. All three read the PR's
// place on the Board (`boardStage`) and say it as its column does — "Your
// move: Send review", "Agent on it: drafting your review · 3/6", "With the
// author" — so no view can disagree with the Board, the chip or the tray.

const COLUMN_DOT: Record<BoardColumn, string> = {
  you: "bg-amber-500",
  agent: "bg-sky-500",
  waiting: "bg-zinc-400 dark:bg-zinc-500",
  done: "bg-emerald-500",
};

const COLUMN_TONE: Record<BoardColumn, string> = {
  you: "text-amber-700 dark:text-amber-300",
  agent: "text-sky-700 dark:text-sky-300",
  waiting: "text-fg-subtle",
  done: "text-emerald-700 dark:text-emerald-300",
};

interface AgentWord {
  stage: BoardStage;
  item: AgentItem;
  /** The column's name in the PR's lane: "Your move", "With the author". */
  column: string;
  /** What it says there: the button and what goes out, the work and its step, the agent's last word. */
  text: string;
  /** Short, for a table cell: the button, the work, else the column. */
  short: string;
  dot: string;
  tone: string;
}

/**
 * The PR on the Board, when the agent has something to say about it — a run
 * on it, a move it prepared, its last word today. Null otherwise, and while
 * the agent is off: a card then carries no agent line at all.
 */
export function useAgentWord(pr: PullRequest): AgentWord | null {
  const { state } = useContext(AgentContext);
  if (!state?.enabled) return null;
  const stage = boardStage(
    pr,
    state.items.filter((i) => i.prId === pr.id),
    { today: todayKey(new Date()), idle: state.idle },
  );
  if (!stage?.item) return null;
  const item = stage.item;
  const column = COLUMN_TITLES[stage.lane][stage.column];
  let text: string;
  let short: string;
  if (stage.column === "agent") {
    const run = item.state === "working" ? runFor(state, item.runId) : null;
    const place = item.state === "queued" ? queueOrder(state.items.filter((i) => i.state === "queued")).findIndex((i) => i.runId === item.runId) + 1 : 0;
    const step = run ? stepLabel(run.progress.steps) : "";
    const where = run?.paused ? "paused" : item.state === "queued" ? inLine(place) : step;
    text = `${workLine(item)}${where ? ` · ${where}` : ""}`;
    short = text;
  } else if (stage.column === "you" && stage.ready && stage.action) {
    const line = stageLine(stage, pr);
    // "Your call: …" already says what the button would.
    text = line.startsWith(stage.action.label) ? line : `${stage.action.label} — ${line}`;
    short = stage.action.label;
  } else {
    text = stage.note ?? stageLine(stage, pr);
    short = column;
  }
  const failed = stage.action?.kind === "fix";
  return {
    stage,
    item,
    column,
    text,
    short,
    dot: failed ? "bg-red-500" : COLUMN_DOT[stage.column],
    tone: failed ? "text-red-700 dark:text-red-300" : COLUMN_TONE[stage.column],
  };
}

/** The line under a Roomy card. Nothing at all while the agent has nothing to say about this PR. */
export function AgentStatusLine({ pr }: { pr: PullRequest }) {
  const word = useAgentWord(pr);
  const { state, openCompanion, focusItem } = useContext(AgentContext);
  if (!word) return null;
  const { item, stage } = word;
  const watch = item.state === "working" && state?.headerChip;
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-line pt-2 text-xs">
      <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", word.dot)} />
      <span className={cn("shrink-0 font-medium", word.tone)}>{word.column}</span>
      <span className="min-w-0 flex-1 truncate text-fg-muted" title={word.text}>
        {word.text}
      </span>
      {(stage.column === "you" || stage.column === "agent") && (
        <button
          type="button"
          // A move waits on the Board, at its card; a run is watched in the popover —
          // or on the Board too, when the header chip (and with it the popover) is off.
          onClick={() => (watch ? openCompanion(item.runId) : focusItem(item.runId))}
          className="shrink-0 rounded-md border border-line-strong px-2 py-0.5 text-xs text-fg-secondary hover:bg-elevated"
        >
          {watch ? "Watch" : "Open"}
        </button>
      )}
    </div>
  );
}

/** The Cozy table's Agent cell. */
export function AgentCell({ pr }: { pr: PullRequest }) {
  const word = useAgentWord(pr);
  if (!word) return <span className="text-xs text-fg-faint">—</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs" title={`${word.column}: ${word.text}`}>
      <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", word.dot)} />
      <span className={cn("truncate", word.stage.column === "you" ? word.tone : "text-fg-muted")}>{word.short}</span>
    </span>
  );
}

/** A Compact tile's glyph: where it stands as a dot, the words in its title. */
export function AgentGlyph({ pr }: { pr: PullRequest }) {
  const word = useAgentWord(pr);
  if (!word) return null;
  return (
    <span
      role="img"
      aria-label={`Agent: ${word.column}`}
      title={`Agent — ${word.column}: ${word.text}`}
      className={cn("inline-block size-2 shrink-0 rounded-full ring-2 ring-surface", word.dot)}
    />
  );
}
