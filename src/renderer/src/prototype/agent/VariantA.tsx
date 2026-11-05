/**
 * PROTOTYPE — variant A, "Inbox-first": a Needs-you section above the usual
 * PR list. Each row is a whole decision (why the agent stopped, the exact
 * action, one primary button); everything else stays a status line on the card.
 */
import { useState } from "react";

import { cn } from "../../format";
import type { AgentRow } from "./agent-model";
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

export const NAME = "Inbox-first";

export function VariantA({ agent, prs, renderList }: VariantProps) {
  const rows = agent.needsYou;
  const [sel, setSel] = useState(0);
  const [showActivity, setShowActivity] = useState(false);
  const current = rows[Math.min(sel, rows.length - 1)];
  useKeys({
    j: () => setSel((i) => Math.min(i + 1, rows.length - 1)),
    k: () => setSel((i) => Math.max(i - 1, 0)),
    Enter: () => current && current.item.actions[0] && agent.take(current.pr.number, current.item.actions[0].id),
    l: () => current && agent.later(current.pr.number),
  });
  const busy = agent.working.length + agent.queued.length;

  return (
    <>
      <section className="mb-4 overflow-hidden rounded-lg border border-sky-500/50 bg-surface shadow-sm">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-sky-500/10 px-3 py-2">
          <h2 className="text-sm font-semibold text-sky-800 dark:text-sky-200">Needs you · {rows.length}</h2>
          <span className="text-xs text-fg-subtle">
            Agent: {agent.working.length} working · {agent.queued.length} queued
          </span>
          <span className="flex-1" />
          <span className="hidden items-center gap-1 text-[11px] text-fg-subtle md:inline-flex">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> move <Kbd>↵</Kbd> do <Kbd>L</Kbd> later
          </span>
          <button type="button" onClick={() => setShowActivity((v) => !v)} className={cn(BTN, "py-0.5")}>
            Activity {showActivity ? "▴" : "▾"}
          </button>
        </header>

        {showActivity && (
          <div className="max-h-56 overflow-y-auto border-b border-line bg-elevated/40 px-3 py-2">
            <ActivityList agent={agent} />
          </div>
        )}

        {rows.length === 0 ? (
          <div className="px-3 py-4 text-sm text-fg-subtle">
            Nothing needs you.{busy > 0 && ` The agent is on ${busy} PR${busy > 1 ? "s" : ""}; each shows its status on the card.`}
          </div>
        ) : (
          rows.map((row, i) => (
            <InboxRow
              key={row.pr.id}
              row={row}
              selected={row === current}
              onSelect={() => setSel(i)}
              agent={agent}
            />
          ))
        )}

        {agent.snoozed.length > 0 && (
          <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-xs text-fg-subtle">
            Later · {agent.snoozed.length}
            <button type="button" onClick={agent.unsnoozeAll} className="text-sky-700 hover:underline dark:text-sky-300">
              Bring back
            </button>
          </div>
        )}

        <ShadowNudge agent={agent} />
      </section>

      {renderList(prs)}
    </>
  );
}

function InboxRow({
  row,
  selected,
  onSelect,
  agent,
}: {
  row: AgentRow;
  selected: boolean;
  onSelect: () => void;
  agent: VariantProps["agent"];
}) {
  const { item, pr } = row;
  return (
    <div
      onClick={onSelect}
      className={cn(
        "grid cursor-default grid-cols-[1.75rem_minmax(0,1fr)] gap-3 border-b border-line px-3 py-2.5 last:border-b-0",
        selected ? "bg-sky-500/[0.07]" : "hover:bg-elevated/40",
      )}
    >
      <ScenarioGlyph item={item} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs tabular-nums text-fg-subtle">{prLabel(pr)}</span>
          <span className="truncate text-sm font-semibold text-fg">{pr.title}</span>
          <ScenarioChip item={item} />
        </div>
        <div className={cn("mt-0.5 text-sm", item.state === "error" ? "text-red-700 dark:text-red-300" : "text-fg-secondary")}>
          {item.headline}
        </div>
        <Resolved item={item} />
        <Detail item={item} numbered={item.scenario === "brief"} />
        <div className="mt-2">
          <ActionButtons row={row} agent={agent} onLater={() => agent.later(pr.number)} showKeys={selected} />
        </div>
      </div>
    </div>
  );
}

/** Progressive autonomy: a scenario earns "on" by being accepted unchanged in shadow. */
export function ShadowNudge({ agent }: { agent: VariantProps["agent"] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line bg-elevated/30 px-3 py-1.5 text-xs text-fg-muted">
      {agent.shadowPromoted ? (
        <>Re-review replies: on — the agent posts them itself now.</>
      ) : (
        <>
          Shadow · re-review replies: {agent.shadowAccepted} of {agent.shadowAccepted} accepted unchanged
          <span className="flex-1" />
          <button type="button" onClick={agent.promoteShadow} className={cn(BTN, "py-0.5")}>
            Let the agent post these
          </button>
        </>
      )}
    </div>
  );
}
