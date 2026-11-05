/**
 * PROTOTYPE — variant B, "Triage split view" (mail client / Linear triage): one
 * list of every PR ordered by who has to act, and a detail pane for the
 * selected one with the agent's decision and its timeline on that PR.
 */
import { useMemo, useState } from "react";

import type { PullRequest } from "../../../../shared/types";
import { cn } from "../../format";
import { STATE_LABEL, type AgentItem } from "./agent-model";
import {
  ActionButtons,
  ActivityList,
  Detail,
  Kbd,
  prLabel,
  Resolved,
  ScenarioChip,
  StateDot,
  STATE_TEXT,
  useKeys,
  type VariantProps,
} from "./agent-ui";

export const NAME = "Triage split view";

interface Entry {
  pr: PullRequest;
  item: AgentItem | null;
}

export function VariantB({ agent, prs }: VariantProps) {
  const sections = useMemo((): { label: string; entries: Entry[] }[] => {
    const toEntries = (rows: { pr: PullRequest; item: AgentItem }[]): Entry[] =>
      rows.map((r) => ({ pr: r.pr, item: r.item }));
    return [
      { label: "Needs you", entries: toEntries([...agent.needsYou, ...agent.snoozed]) },
      { label: "Agent working", entries: toEntries([...agent.working, ...agent.queued]) },
      { label: "Done by the agent", entries: toEntries(agent.done) },
      { label: "Nothing for the agent", entries: agent.idle.map((pr): Entry => ({ pr, item: null })) },
    ].filter((s) => s.entries.length > 0);
  }, [agent]);
  const flat = useMemo(() => sections.flatMap((s) => s.entries), [sections]);
  const [selId, setSelId] = useState<string | null>(null);
  const index = Math.max(0, flat.findIndex((e) => e.pr.id === selId));
  const current: Entry | undefined = flat[index];
  const move = (d: number) => {
    const next = flat[Math.min(Math.max(index + d, 0), flat.length - 1)];
    if (next) setSelId(next.pr.id);
  };
  useKeys({
    j: () => move(1),
    k: () => move(-1),
    Enter: () => current?.item?.actions[0] && agent.take(current.pr.number, current.item.actions[0].id),
    l: () => current?.item && agent.later(current.pr.number),
  });
  void prs;

  return (
    <div className="grid gap-3 lg:grid-cols-[24rem_minmax(0,1fr)]">
      <div className="max-h-[calc(100vh-13rem)] overflow-y-auto rounded-lg border border-line bg-surface">
        {sections.map((s) => (
          <div key={s.label}>
            <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-line bg-elevated px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              {s.label}
              <span className="font-normal">{s.entries.length}</span>
            </div>
            {s.entries.map((e) => (
              <button
                key={e.pr.id}
                type="button"
                onClick={() => setSelId(e.pr.id)}
                className={cn(
                  "flex w-full items-start gap-2 border-b border-line px-3 py-2 text-left last:border-b-0",
                  e === current ? "bg-sky-500/10" : "hover:bg-elevated/50",
                  e.item?.snoozed && "opacity-60",
                )}
              >
                <StateDot state={e.item?.state ?? "queued"} className={cn("mt-1.5", !e.item && "opacity-0")} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
                    {prLabel(e.pr)}
                    {e.item && <span className={STATE_TEXT[e.item.state]}>{e.item.shadow ? "would act" : STATE_LABEL[e.item.state].toLowerCase()}</span>}
                  </span>
                  <span className="block truncate text-sm font-medium text-fg">{e.pr.title}</span>
                  {e.item && <span className="block truncate text-xs text-fg-muted">{e.item.headline}</span>}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-line bg-surface p-4 lg:sticky lg:top-44 lg:self-start">
        {current ? <DetailPane entry={current} agent={agent} /> : <div className="text-sm text-fg-subtle">No PRs.</div>}
        <div className="mt-4 flex items-center gap-1 border-t border-line pt-2 text-[11px] text-fg-subtle">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> move <Kbd>↵</Kbd> primary action <Kbd>L</Kbd> later
        </div>
      </div>
    </div>
  );
}

function DetailPane({ entry, agent }: { entry: Entry; agent: VariantProps["agent"] }) {
  const { pr, item } = entry;
  const approvals = pr.reviewers.filter((r) => r.reviewState === "approved").length;
  return (
    <div>
      <div className="text-xs text-fg-subtle">
        {pr.repo} #{pr.number} · {pr.author?.login ?? "unknown"} · {pr.roles.join(", ")}
      </div>
      <h2 className="mt-0.5 text-lg font-semibold leading-snug text-fg">{pr.title}</h2>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-fg-muted">
        <span>CI: {pr.ciState}</span>
        <span>Approvals: {approvals}</span>
        <span>Open threads: {pr.unresolvedThreads}</span>
        <span>Comments: {pr.totalComments}</span>
      </div>

      {item ? (
        <div className="mt-4 rounded-md border border-line bg-elevated/30 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <StateDot state={item.state} />
            <span className={cn("text-xs font-semibold", STATE_TEXT[item.state])}>
              {item.shadow ? "Would act" : STATE_LABEL[item.state]}
            </span>
            <ScenarioChip item={item} />
            {item.meta && <span className="text-xs text-fg-subtle">{item.meta}</span>}
          </div>
          <div className="mt-1.5 text-sm text-fg">{item.headline}</div>
          <Resolved item={item} />
          <Detail item={item} numbered={item.scenario === "brief"} />
          {item.actions.length > 0 && (
            <div className="mt-3">
              <ActionButtons row={{ pr, item }} agent={agent} onLater={() => agent.later(pr.number)} size="lg" showKeys />
            </div>
          )}
        </div>
      ) : (
        <div className="mt-4 rounded-md border border-dashed border-line-strong p-3 text-sm text-fg-subtle">
          Nothing for the agent on this PR: no trigger fired since the last snapshot.
        </div>
      )}

      <h3 className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Agent on this PR</h3>
      <ActivityList agent={agent} prNumber={pr.number} />
    </div>
  );
}
