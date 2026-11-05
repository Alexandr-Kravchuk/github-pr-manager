/**
 * PROTOTYPE — variant C, "Mission control board" (Devin Agent Command Center,
 * GitHub Agent HQ): the agent's runs as a kanban by state, with the agent's
 * own controls on top. Agent-centric: the PR list folds away below the board.
 */
import { useState } from "react";

import { cn } from "../../format";
import type { AgentMode, AgentRow, AgentState } from "./agent-model";
import {
  ActionButtons,
  ActivityList,
  BTN,
  Detail,
  prLabel,
  Resolved,
  ScenarioChip,
  StateDot,
  type VariantProps,
} from "./agent-ui";

export const NAME = "Mission control board";

const MODES: { key: AgentMode; label: string }[] = [
  { key: "on", label: "On" },
  { key: "shadow", label: "Shadow" },
  { key: "paused", label: "Paused" },
];

export function VariantC({ agent, prs, renderList }: VariantProps) {
  const [showList, setShowList] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const columns: { state: AgentState; label: string; rows: AgentRow[]; tint: string }[] = [
    { state: "queued", label: "Queued", rows: agent.queued, tint: "border-t-zinc-400" },
    { state: "working", label: "Working", rows: agent.working, tint: "border-t-sky-500" },
    { state: "needsYou", label: "Needs you", rows: [...agent.needsYou, ...agent.snoozed], tint: "border-t-amber-500" },
    { state: "done", label: "Done today", rows: agent.done, tint: "border-t-emerald-500" },
  ];

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
        <span className="text-sm font-semibold text-fg">PR agent</span>
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-line-strong bg-elevated p-0.5">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => agent.setMode(m.key)}
              className={cn(
                "rounded-md px-2.5 py-0.5 text-xs font-medium",
                agent.mode === m.key ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-fg-muted">Runs today 9 of 30 · parallel {agent.working.length} of 2</span>
        <span className="flex-1" />
        <button type="button" onClick={() => setShowLog((v) => !v)} className={cn(BTN, "py-0.5")}>
          Log {showLog ? "▴" : "▾"}
        </button>
      </div>

      {showLog && (
        <div className="mb-3 max-h-56 overflow-y-auto rounded-lg border border-line bg-surface px-3 py-2">
          <ActivityList agent={agent} />
        </div>
      )}

      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((c) => (
          <div
            key={c.state}
            className={cn("flex min-w-[16rem] flex-1 flex-col rounded-lg border border-t-4 border-line bg-elevated/40", c.tint)}
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <StateDot state={c.state} />
              <span className="text-sm font-semibold text-fg-secondary">{c.label}</span>
              <span className="rounded-full border border-line-strong px-1.5 text-xs text-fg-muted">{c.rows.length}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
              {c.rows.length === 0 && <div className="px-1 py-3 text-center text-xs text-fg-faint">Empty</div>}
              {c.rows.map((row) => (
                <BoardCard key={row.pr.id} row={row} agent={agent} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setShowList((v) => !v)}
        className="my-3 flex w-full items-center gap-2 rounded-md py-2 text-left text-sm font-semibold text-fg-secondary hover:bg-elevated/40"
      >
        {showList ? "▾" : "▸"} All pull requests
        <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs font-normal text-fg-muted">{prs.length}</span>
      </button>
      {showList && renderList(prs)}
    </>
  );
}

function BoardCard({ row, agent }: { row: AgentRow; agent: VariantProps["agent"] }) {
  const { item, pr } = row;
  const [open, setOpen] = useState(item.state === "needsYou" || item.state === "error");
  return (
    <div
      onClick={() => setOpen((v) => !v)}
      className={cn(
        "cursor-default rounded-md border bg-surface p-2.5 shadow-sm",
        item.state === "error" ? "border-red-500/60" : "border-line",
        item.snoozed && "opacity-60",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
        {prLabel(pr)}
        <span className="flex-1" />
        <ScenarioChip item={item} />
      </div>
      <div className="mt-0.5 line-clamp-2 text-sm font-medium text-fg">{pr.title}</div>
      <div className={cn("mt-1 text-xs", item.state === "error" ? "text-red-700 dark:text-red-300" : "text-fg-muted")}>
        {item.headline}
        {item.meta && <span className="text-fg-subtle"> · {item.meta}</span>}
      </div>
      {open && (
        <>
          <Resolved item={item} />
          <Detail item={item} numbered={item.scenario === "brief"} />
          {item.actions.length > 0 && (
            <div className="mt-2">
              <ActionButtons row={row} agent={agent} onLater={() => agent.later(pr.number)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
