import { useContext, useMemo, useState, type DragEvent, type ReactNode } from "react";

// Node-free (see AGENTS.md): the columns, the day, and the plan's current step.
import { boardColumns, primaryActionLabel, runFor, todayKey } from "../../../shared/agent-view";
import { currentStep, type RunProgress } from "../../../shared/agent-stream";
import type { AgentAction, AgentItem, PullRequest } from "../../../shared/types";
import { cn, relativeTime } from "../format";
import { AgentContext } from "./agent-context";
import { AGENT_STATE_DOT } from "./AgentStatus";

// The Board: the dashboard's filtered PRs laid out by what the PR agent is
// doing with them — Idle → Queued → Working → Needs you → Done today. The same
// PRs as the other views (every filter applies); the columns are its order, so
// Sort and Group-by are off while it is on.

const DRAG_TYPE = "application/x-prd-pr";
const BTN = "inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-elevated";
const BTN_PRIMARY = "inline-flex items-center gap-1 rounded-md border border-sky-600 bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700";

function shortRepo(repo: string): string {
  return repo.split("/")[1] ?? repo;
}

export function PrBoard({
  prs,
  allPrIds,
  onOpen,
}: {
  prs: PullRequest[];
  allPrIds: ReadonlySet<string>;
  onOpen: (pr: PullRequest) => void;
}) {
  const { state, act } = useContext(AgentContext);
  const [idleOpen, setIdleOpen] = useState(false);
  const [dropOn, setDropOn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const byId = useMemo(() => new Map(prs.map((p) => [p.id, p])), [prs]);

  if (!state) {
    return <div className="rounded-lg border border-line bg-surface/40 p-8 text-center text-sm text-fg-subtle">The PR agent isn&apos;t available here.</div>;
  }
  const cols = boardColumns(prs, allPrIds, state, todayKey(new Date()));
  const run = async (action: AgentAction) => {
    const res = await act(action);
    setNotice(res.ok ? null : res.error);
  };
  const openItem = (item: AgentItem) => {
    const pr = byId.get(item.prId);
    if (pr) onOpen(pr);
    else window.api.openExternal(item.url).catch(() => {});
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropOn(false);
    const prId = e.dataTransfer.getData(DRAG_TYPE);
    if (prId) void run({ type: "enqueue", prId });
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg-muted">
        <span className="text-sm font-semibold text-fg">PR agent</span>
        {state.enabled ? (
          <>
            <span>
              Runs today {state.runsToday} of {state.perDay}
            </span>
            {state.heldUntil && <span className="text-amber-700 dark:text-amber-300">Claude&apos;s usage limit — new runs wait until {new Date(state.heldUntil).toLocaleTimeString()}</span>}
          </>
        ) : (
          <span>Off — switch it on in Settings › Agent.</span>
        )}
        {notice && (
          <span className="ml-auto text-red-700 dark:text-red-300" role="alert">
            {notice}
          </span>
        )}
      </div>

      <div className="flex items-start gap-3 overflow-x-auto pb-2">
        {idleOpen ? (
          <Column label="Idle" count={cols.idle.length} dot="queued" className="min-w-[11rem] flex-1 basis-0 border-dashed" aside={<button type="button" onClick={() => setIdleOpen(false)} className="text-xs text-fg-subtle hover:text-fg">Fold</button>}>
            {cols.idle.length === 0 ? (
              <Empty>Every PR has the agent&apos;s attention.</Empty>
            ) : (
              cols.idle.map(({ pr, reason }) => <IdleCard key={pr.id} pr={pr} reason={reason} onOpen={onOpen} onQueue={state.enabled ? () => void run({ type: "enqueue", prId: pr.id }) : undefined} />)
            )}
          </Column>
        ) : (
          <button
            type="button"
            onClick={() => setIdleOpen(true)}
            title="Show the PRs the agent has nothing for"
            className="flex w-10 shrink-0 flex-col items-center gap-2 self-stretch rounded-lg border border-dashed border-line-strong bg-elevated/30 py-3 text-xs text-fg-muted hover:bg-elevated/60"
          >
            <span className="rounded-full border border-line-strong px-1.5 tabular-nums">{cols.idle.length}</span>
            <span className="[writing-mode:vertical-rl]">Idle — open to hand PRs to the agent</span>
          </button>
        )}

        <Column
          label="Queued"
          count={cols.queued.length}
          dot="queued"
          className={cn("min-w-[11rem] flex-1 basis-0", dropOn && "border-sky-500 bg-sky-500/10")}
          dropProps={{
            onDragOver: (e) => {
              if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                e.preventDefault();
                setDropOn(true);
              }
            },
            onDragLeave: () => setDropOn(false),
            onDrop,
          }}
        >
          {cols.queued.length === 0 ? (
            <Empty>{state.enabled ? "Drop an idle PR here to hand it to the agent" : "Nothing queued"}</Empty>
          ) : (
            cols.queued.map((item) => (
              <ItemCard key={item.runId} item={item} onTitle={() => openItem(item)}>
                <button type="button" className={BTN} onClick={() => void run({ type: "skip", runId: item.runId })}>
                  Skip
                </button>
              </ItemCard>
            ))
          )}
        </Column>

        <Column label="Working" count={cols.working.length} limit={state.parallel} dot="working" className="min-w-[11rem] flex-1 basis-0">
          {cols.working.length === 0 ? (
            <Empty>Nothing running</Empty>
          ) : (
            cols.working.map((item) => {
              const r = runFor(state, item.runId);
              return <WorkingCard key={item.runId} item={item} progress={r?.progress ?? null} paused={r?.paused ?? false} onTitle={() => openItem(item)} run={run} />;
            })
          )}
        </Column>

        <Column label="Needs you" count={cols.needsYou.filter((i) => !i.later).length} dot="needsYou" className="min-w-[11rem] flex-1 basis-0 border-amber-500/50 bg-amber-500/[0.05]">
          {cols.needsYou.length === 0 ? (
            <Empty>Nothing waits for you</Empty>
          ) : (
            cols.needsYou.map((item) => <NeedsYouCard key={item.runId} item={item} onTitle={() => openItem(item)} run={run} />)
          )}
        </Column>

        <Column label="Done today" count={cols.done.length} dot="done" className="min-w-[11rem] flex-1 basis-0">
          {cols.done.length === 0 ? (
            <Empty>Nothing finished yet</Empty>
          ) : (
            cols.done.map((item) => (
              <ItemCard key={item.runId} item={item} onTitle={() => openItem(item)}>
                {item.finishedAt && <span className="text-[11px] text-fg-subtle">{relativeTime(item.finishedAt)}</span>}
              </ItemCard>
            ))
          )}
        </Column>
      </div>
    </div>
  );
}

function Column({
  label,
  count,
  limit,
  dot,
  className,
  aside,
  dropProps,
  children,
}: {
  label: string;
  count: number;
  limit?: number;
  dot: AgentItem["state"];
  className?: string;
  aside?: ReactNode;
  dropProps?: { onDragOver: (e: DragEvent) => void; onDragLeave: () => void; onDrop: (e: DragEvent) => void };
  children: ReactNode;
}) {
  return (
    <section {...dropProps} aria-label={label} className={cn("flex flex-col self-stretch rounded-lg border border-line bg-elevated/40", className)}>
      <header className="flex items-center gap-2 px-3 py-2">
        <span aria-hidden className={cn("inline-block size-2 rounded-full", AGENT_STATE_DOT[dot])} />
        <h3 className="text-sm font-semibold text-fg-secondary">{label}</h3>
        <span className="rounded-full border border-line-strong px-1.5 text-xs tabular-nums text-fg-muted" title={limit ? `${count} running, at most ${limit} at a time` : undefined}>
          {limit ? `${count} / ${limit}` : count}
        </span>
        <span className="flex-1" />
        {aside}
      </header>
      <div className="flex flex-1 flex-col gap-2 px-2 pb-2">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-1 py-4 text-center text-xs text-fg-faint">{children}</div>;
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded border border-line-strong px-1.5 py-px text-[11px] text-fg-muted">{children}</span>;
}

function CardHead({ item, onTitle }: { item: AgentItem; onTitle: () => void }) {
  return (
    <>
      <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
        <span className="truncate">
          {shortRepo(item.repo)} #{item.prNumber}
        </span>
        <span className="flex-1" />
        <Chip>{item.scenario === "brief" ? "Brief" : "Review"}</Chip>
        {item.mode === "shadow" && item.scenario === "review" && <Chip>shadow</Chip>}
      </div>
      <button type="button" onClick={onTitle} className="mt-0.5 line-clamp-2 text-left text-sm font-medium text-fg hover:text-sky-600 hover:underline dark:hover:text-sky-300">
        {item.title}
      </button>
    </>
  );
}

function ItemCard({ item, onTitle, children }: { item: AgentItem; onTitle: () => void; children?: ReactNode }) {
  return (
    <article className="rounded-md border border-line bg-surface p-2.5 shadow-sm">
      <CardHead item={item} onTitle={onTitle} />
      <div className="mt-1 text-xs text-fg-muted">{item.headline}</div>
      {children && <div className="mt-2 flex flex-wrap items-center gap-1.5">{children}</div>}
    </article>
  );
}

function WorkingCard({
  item,
  progress,
  paused,
  onTitle,
  run,
}: {
  item: AgentItem;
  progress: RunProgress | null;
  paused: boolean;
  onTitle: () => void;
  run: (a: AgentAction) => Promise<void>;
}) {
  const { openCompanion } = useContext(AgentContext);
  const steps = progress?.steps ?? [];
  const step = progress ? currentStep(progress) : null;
  return (
    <article className="rounded-md border border-sky-500/40 bg-surface p-2.5 shadow-sm">
      <CardHead item={item} onTitle={onTitle} />
      {steps.length > 0 && (
        <div className="mt-1.5 flex gap-0.5" aria-hidden>
          {steps.map((s) => (
            <span
              key={s.id}
              className={cn(
                "h-1 flex-1 rounded-full",
                s.status === "completed" ? "bg-emerald-500" : s.status === "in_progress" ? (paused ? "bg-amber-500" : "bg-sky-500") : "bg-line-strong",
              )}
            />
          ))}
        </div>
      )}
      <div className="mt-1 text-xs font-medium text-fg-secondary">{paused ? "Paused" : (step?.subject ?? item.headline)}</div>
      {progress?.activity && (
        <div className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle" title={progress.activity}>
          {progress.activity}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" className={BTN} onClick={() => openCompanion(item.runId)}>
          Watch
        </button>
        <button type="button" className={BTN} onClick={() => void run({ type: paused ? "resume" : "pause", runId: item.runId })}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button type="button" className={BTN} onClick={() => void run({ type: "stop", runId: item.runId })}>
          Stop
        </button>
      </div>
    </article>
  );
}

function NeedsYouCard({ item, onTitle, run }: { item: AgentItem; onTitle: () => void; run: (a: AgentAction) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const primary = primaryActionLabel(item);
  const error = item.state === "error";
  return (
    <article className={cn("rounded-md border bg-surface p-2.5 shadow-sm", error ? "border-red-500/60" : "border-line", item.later && "opacity-60")}>
      <CardHead item={item} onTitle={onTitle} />
      <div className={cn("mt-1 text-xs", error ? "text-red-700 dark:text-red-300" : "text-fg-secondary")}>{item.headline}</div>
      {error && item.error && <div className="mt-0.5 line-clamp-3 font-mono text-[11px] text-fg-subtle" title={item.error}>{item.error}</div>}
      {item.output && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-1 text-xs text-sky-700 hover:underline dark:text-sky-300">
            {open ? "Hide" : item.scenario === "brief" ? "Read the brief" : "See what it would post"}
          </button>
          {open && <div className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap rounded border border-line bg-elevated/40 p-2 text-xs text-fg-secondary">{item.output}</div>}
        </>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {primary === "Run again" && (
          <button type="button" className={BTN_PRIMARY} onClick={() => void run({ type: "retry", runId: item.runId })}>
            Run again
          </button>
        )}
        {primary === "Review anyway" && (
          <button type="button" className={BTN_PRIMARY} onClick={() => void run({ type: "reviewAnyway", runId: item.runId })}>
            Review anyway
          </button>
        )}
        {item.sessionId && item.worktree && (
          <button type="button" className={primary === "Continue in session" ? BTN_PRIMARY : BTN} onClick={() => void run({ type: "continue", runId: item.runId })}>
            Continue in session
          </button>
        )}
        {!error && (
          <button type="button" className={BTN} onClick={() => void run({ type: "retry", runId: item.runId })}>
            Run again
          </button>
        )}
        <button type="button" className={BTN} onClick={() => void run({ type: "later", runId: item.runId })}>
          {item.later ? "Bring back" : "Later"}
        </button>
        <button type="button" className={BTN} onClick={() => void run({ type: "skip", runId: item.runId })}>
          Dismiss
        </button>
      </div>
      {item.mode === "shadow" && item.scenario === "review" && !error && (
        <div className="mt-1.5 text-[11px] text-fg-faint">Shadow: nothing was posted. Publishing comes in the next update.</div>
      )}
    </article>
  );
}

function IdleCard({ pr, reason, onOpen, onQueue }: { pr: PullRequest; reason: string; onOpen: (pr: PullRequest) => void; onQueue?: () => void }) {
  const canHand = onQueue && (pr.roles.includes("reviewer") || pr.roles.includes("reviewed"));
  return (
    <article
      draggable={Boolean(canHand)}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, pr.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn("rounded-md border border-line bg-surface p-2.5", canHand && "cursor-grab active:cursor-grabbing")}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
        <span className="truncate">
          {shortRepo(pr.repo)} #{pr.number}
        </span>
        <span className="flex-1" />
        {relativeTime(pr.updatedAt)}
      </div>
      <button type="button" onClick={() => onOpen(pr)} className="mt-0.5 line-clamp-2 text-left text-sm font-medium text-fg hover:text-sky-600 hover:underline dark:hover:text-sky-300">
        {pr.title}
      </button>
      <div className="mt-1 text-xs text-fg-subtle">{reason}</div>
      {canHand && (
        <button type="button" onClick={onQueue} className={cn(BTN, "mt-2 py-0.5")}>
          Hand to agent →
        </button>
      )}
    </article>
  );
}
