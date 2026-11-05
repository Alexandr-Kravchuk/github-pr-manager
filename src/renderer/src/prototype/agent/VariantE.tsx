/**
 * PROTOTYPE — variant E, "Board as its own view": the kanban of variant C, but
 * as a fourth display variant in the header's view switch, next to Roomy /
 * Cozy / Compact. The dashboard is untouched in those three; Board lays the
 * same filtered PRs out in columns by what the agent is doing with them.
 */
import { useContext, useState, type DragEvent, type ReactNode } from "react";

import type { PullRequest } from "../../../../shared/types";
import { cn, relativeTime } from "../../format";
import type { AgentMode, AgentRow, AgentState } from "./agent-model";
import { elapsed, liveLine } from "./agent-runs";
import {
  ActionButtons,
  ActivityList,
  BTN,
  CompanionContext,
  Detail,
  prLabel,
  Resolved,
  ScenarioChip,
  StateDot,
  type VariantProps,
} from "./agent-ui";

export const NAME = "Board as its own view";

const MODES: { key: AgentMode; label: string }[] = [
  { key: "on", label: "On" },
  { key: "shadow", label: "Shadow" },
  { key: "paused", label: "Paused" },
];

const PARALLEL_LIMIT = 2;
const DRAG_TYPE = "application/x-prd-pr";

export function VariantE(props: VariantProps) {
  if (!props.boardView) return <>{props.renderList(props.prs)}</>;
  return <Board {...props} />;
}

function Board({ agent, prs }: VariantProps) {
  const [showLog, setShowLog] = useState(false);
  const [idleOpen, setIdleOpen] = useState(false);
  const [dropOn, setDropOn] = useState(false);
  const byNumber = new Map(prs.map((p) => [p.number, p]));

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropOn(false);
    const pr = byNumber.get(Number(e.dataTransfer.getData(DRAG_TYPE)));
    if (pr) agent.enqueue(pr);
  };

  const columns: { state: AgentState; label: string; rows: AgentRow[]; hint: string; limit?: number }[] = [
    { state: "queued", label: "Queued", rows: agent.queued, hint: "Drop an idle PR here to hand it to the agent" },
    { state: "working", label: "Working", rows: agent.working, hint: "Nothing running", limit: PARALLEL_LIMIT },
    { state: "needsYou", label: "Needs you", rows: [...agent.needsYou, ...agent.snoozed], hint: "Nothing waits for you" },
    { state: "done", label: "Done today", rows: agent.done, hint: "Nothing finished yet" },
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
        <span className="text-xs text-fg-muted">Runs today 9 of 30</span>
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

      <div className="flex items-start gap-3 overflow-x-auto pb-2">
        {/* Idle: every PR the agent has nothing for. Folded by default — it is
            most of the list, and the board is about what the agent is doing. */}
        {idleOpen ? (
          <Column
            label="Idle"
            count={agent.idle.length}
            dot="queued"
            className="min-w-[11rem] flex-1 basis-0 border-dashed"
            onHeaderClick={() => setIdleOpen(false)}
            headerHint="Fold"
          >
            {agent.idle.map((pr) => (
              <IdleCard key={pr.id} pr={pr} onQueue={() => agent.enqueue(pr)} />
            ))}
          </Column>
        ) : (
          <button
            type="button"
            onClick={() => setIdleOpen(true)}
            title="Show the PRs the agent has nothing for"
            className="flex w-10 shrink-0 flex-col items-center gap-2 self-stretch rounded-lg border border-dashed border-line-strong bg-elevated/30 py-3 text-xs text-fg-muted hover:bg-elevated/60"
          >
            <span className="rounded-full border border-line-strong px-1.5 tabular-nums">{agent.idle.length}</span>
            <span className="[writing-mode:vertical-rl]">Idle — open to hand PRs to the agent</span>
          </button>
        )}

        {columns.map((c) => (
          <Column
            key={c.state}
            label={c.label}
            count={c.rows.length}
            limit={c.limit}
            dot={c.state}
            className={cn(
              "min-w-[11rem] flex-1 basis-0",
              c.state === "needsYou" && "border-amber-500/50 bg-amber-500/[0.05]",
              c.state === "queued" && dropOn && "border-sky-500 bg-sky-500/10",
            )}
            dropProps={
              c.state === "queued"
                ? {
                    onDragOver: (e: DragEvent) => {
                      if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                        e.preventDefault();
                        setDropOn(true);
                      }
                    },
                    onDragLeave: () => setDropOn(false),
                    onDrop,
                  }
                : undefined
            }
          >
            {c.rows.length === 0 ? (
              <div className="px-1 py-4 text-center text-xs text-fg-faint">{c.hint}</div>
            ) : (
              c.rows.map((row) => <RunCard key={row.pr.id} row={row} agent={agent} />)
            )}
          </Column>
        ))}
      </div>
    </>
  );
}

function Column({
  label,
  count,
  limit,
  dot,
  className,
  children,
  dropProps,
  onHeaderClick,
  headerHint,
}: {
  label: string;
  count: number;
  limit?: number;
  dot: AgentState;
  className?: string;
  children: ReactNode;
  dropProps?: {
    onDragOver: (e: DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent) => void;
  };
  onHeaderClick?: () => void;
  headerHint?: string;
}) {
  return (
    <section {...dropProps} className={cn("flex flex-col self-stretch rounded-lg border border-line bg-elevated/40", className)}>
      <header className="flex items-center gap-2 px-3 py-2">
        <StateDot state={dot} />
        <h3 className="text-sm font-semibold text-fg-secondary">{label}</h3>
        <span
          className="rounded-full border border-line-strong px-1.5 text-xs tabular-nums text-fg-muted"
          title={limit ? `${count} running, at most ${limit} at a time` : undefined}
        >
          {limit ? `${count} / ${limit}` : count}
        </span>
        <span className="flex-1" />
        {onHeaderClick && (
          <button type="button" onClick={onHeaderClick} className="text-xs text-fg-subtle hover:text-fg">
            {headerHint}
          </button>
        )}
      </header>
      <div className="flex flex-1 flex-col gap-2 px-2 pb-2">{children}</div>
    </section>
  );
}

function RunCard({ row, agent }: { row: AgentRow; agent: VariantProps["agent"] }) {
  const { item, pr } = row;
  const asks = item.state === "needsYou" || item.state === "error";
  const [open, setOpen] = useState(asks);
  const openCompanion = useContext(CompanionContext);
  if (item.state === "working" && item.run) {
    const run = item.run;
    return (
      <article className="rounded-md border border-sky-500/40 bg-surface p-2.5 shadow-sm">
        <button type="button" onClick={() => openCompanion(pr.number)} className="block w-full text-left">
          <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
            {prLabel(pr)}
            <span className="flex-1" />
            <span className="tabular-nums">{run.paused ? "paused" : elapsed(run)}</span>
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm font-medium text-fg">{pr.title}</div>
          <div className="mt-1.5 flex gap-0.5" aria-hidden>
            {run.steps.map((s, i) => (
              <span
                key={s.label}
                className={cn("h-1 flex-1 rounded-full", i < run.stepIdx ? "bg-emerald-500" : i === run.stepIdx ? "bg-sky-500" : "bg-line-strong")}
              />
            ))}
          </div>
          <div className="mt-1 text-xs font-medium text-fg-secondary">
            {run.steps[run.stepIdx]?.label}{" "}
            <span className="tabular-nums font-normal text-fg-subtle">
              ({run.stepIdx + 1}/{run.steps.length})
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle" title={liveLine(run)}>
            {liveLine(run)}
          </div>
        </button>
        <button type="button" onClick={() => openCompanion(pr.number)} className={cn(BTN, "mt-2 py-0.5")}>
          Watch live
        </button>
      </article>
    );
  }
  return (
    <article
      className={cn(
        "rounded-md border bg-surface p-2.5 shadow-sm",
        item.state === "error" ? "border-red-500/60" : "border-line",
        item.snoozed && "opacity-60",
      )}
    >
      <button type="button" onClick={() => setOpen((v) => !v)} className="block w-full text-left">
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
      </button>
      {open && (
        <>
          <Resolved item={item} />
          <Detail item={item} numbered={item.scenario === "brief"} />
          {item.actions.length > 0 && (
            <div className="mt-2">
              <ActionButtons row={row} agent={agent} onLater={() => agent.later(pr.number)} />
            </div>
          )}
          <div className="mt-2 border-t border-line pt-1.5">
            <ActivityList agent={agent} prNumber={pr.number} />
          </div>
        </>
      )}
    </article>
  );
}

/** Why the agent has nothing for this PR — so Idle reads as a reason, not a void. */
function idleReason(pr: PullRequest): string {
  if (pr.isDraft) return "Draft — the agent skips drafts";
  if (pr.roles.includes("author")) return pr.awaitingReview ? "Waiting for reviewers" : "Yours, nothing blocks it";
  if (pr.viewerApproved) return "You approved it";
  return "No trigger since the last snapshot";
}

function IdleCard({ pr, onQueue }: { pr: PullRequest; onQueue: () => void }) {
  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, String(pr.number));
        e.dataTransfer.effectAllowed = "move";
      }}
      className="cursor-grab rounded-md border border-line bg-surface p-2.5 active:cursor-grabbing"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
        {prLabel(pr)}
        <span className="flex-1" />
        {relativeTime(pr.updatedAt)}
      </div>
      <div className="mt-0.5 line-clamp-2 text-sm font-medium text-fg">{pr.title}</div>
      <div className="mt-1 text-xs text-fg-subtle">{idleReason(pr)}</div>
      <button type="button" onClick={onQueue} className={cn(BTN, "mt-2 py-0.5")}>
        Hand to agent →
      </button>
    </article>
  );
}
