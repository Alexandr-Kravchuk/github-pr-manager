/**
 * PROTOTYPE — variant D, "Focus queue" (a human-in-the-loop approval queue):
 * one decision at a time, big and keyboard-first, until the queue is empty;
 * the PR list sits folded below. Built for clearing the morning backlog.
 */
import { useState } from "react";

import { cn } from "../../format";
import {
  ActionButtons,
  ActivityList,
  BTN,
  Detail,
  Kbd,
  prLabel,
  Resolved,
  ScenarioChip,
  ScenarioGlyph,
  useKeys,
  type VariantProps,
} from "./agent-ui";

export const NAME = "Focus queue";

export function VariantD({ agent, prs, renderList }: VariantProps) {
  const queue = agent.needsYou;
  const [idx, setIdx] = useState(0);
  const [showList, setShowList] = useState(false);
  const i = Math.min(idx, Math.max(queue.length - 1, 0));
  const row = queue[i];
  useKeys({
    j: () => setIdx(Math.min(i + 1, queue.length - 1)),
    k: () => setIdx(Math.max(i - 1, 0)),
    Enter: () => row?.item.actions[0] && agent.take(row.pr.number, row.item.actions[0].id),
    l: () => row && agent.later(row.pr.number),
  });
  const handled = agent.activity.filter((e) => e.byYou);

  return (
    <>
      <div className="mx-auto mb-4 max-w-3xl">
        <div className="mb-2 flex items-center gap-2 text-xs text-fg-subtle">
          <span className="font-semibold text-fg-secondary">
            {queue.length > 0 ? `Focus · decision ${i + 1} of ${queue.length}` : "Focus · queue empty"}
          </span>
          <div className="flex flex-1 gap-1">
            {queue.map((q, n) => (
              <button
                key={q.pr.id}
                type="button"
                aria-label={`Go to ${prLabel(q.pr)}`}
                onClick={() => setIdx(n)}
                className={cn("h-1.5 flex-1 rounded-full", n === i ? "bg-sky-500" : "bg-line-strong hover:bg-fg-faint")}
              />
            ))}
          </div>
          <span>
            Agent: {agent.working.length} working · {agent.queued.length} queued
          </span>
        </div>

        {row ? (
          <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <ScenarioGlyph item={row.item} className="size-9 text-base" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
                  {prLabel(row.pr)} · {row.pr.author?.login ?? "unknown"}
                  <ScenarioChip item={row.item} />
                </div>
                <h2 className="mt-0.5 text-lg font-semibold leading-snug text-fg">{row.pr.title}</h2>
              </div>
            </div>
            <p
              className={cn(
                "mt-3 text-base",
                row.item.state === "error" ? "text-red-700 dark:text-red-300" : "text-fg-secondary",
              )}
            >
              {row.item.headline}
            </p>
            <Resolved item={row.item} />
            <Detail item={row.item} numbered={row.item.scenario === "brief"} />
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <ActionButtons row={row} agent={agent} onLater={() => agent.later(row.pr.number)} size="lg" showKeys />
              <span className="flex-1" />
              <button type="button" onClick={() => setIdx(Math.max(i - 1, 0))} className={BTN}>
                ‹ Prev <Kbd>K</Kbd>
              </button>
              <button type="button" onClick={() => setIdx(Math.min(i + 1, queue.length - 1))} className={BTN}>
                Next <Kbd>J</Kbd> ›
              </button>
            </div>
          </div>
        ) : null}

        {row && queue.length > 1 && (
          <div className="mt-3 overflow-hidden rounded-lg border border-line bg-surface">
            <div className="border-b border-line bg-elevated/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              Up next · {queue.length - 1}
            </div>
            {queue.map((q, n) =>
              n === i ? null : (
                <button
                  key={q.pr.id}
                  type="button"
                  onClick={() => setIdx(n)}
                  className="flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-left text-xs last:border-b-0 hover:bg-elevated/50"
                >
                  <span className="w-4 shrink-0 tabular-nums text-fg-subtle">{n + 1}</span>
                  <ScenarioChip item={q.item} />
                  <span className="shrink-0 text-fg-subtle">{prLabel(q.pr)}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-secondary">{q.item.headline}</span>
                </button>
              ),
            )}
          </div>
        )}

        {!row && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-5">
            <h2 className="text-lg font-semibold text-emerald-800 dark:text-emerald-200">All decisions made</h2>
            <p className="mt-1 text-sm text-fg-muted">
              You handled {handled.length} this session.
              {agent.snoozed.length > 0 && ` ${agent.snoozed.length} left for later.`}
            </p>
            {agent.snoozed.length > 0 && (
              <button type="button" onClick={agent.unsnoozeAll} className={cn(BTN, "mt-2")}>
                Bring back the later ones
              </button>
            )}
            <div className="mt-3">
              <ActivityList agent={agent} />
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowList((v) => !v)}
        className="my-2 flex w-full items-center gap-2 rounded-md py-2 text-left text-sm font-semibold text-fg-secondary hover:bg-elevated/40"
      >
        {showList ? "▾" : "▸"} All pull requests
        <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs font-normal text-fg-muted">{prs.length}</span>
      </button>
      {showList && renderList(prs)}
    </>
  );
}
