import { useContext, useMemo, useState, type DragEvent, type ReactNode } from "react";

// Node-free (see AGENTS.md): the columns, the day, and the plan's current step.
import { BOARD_LANES, boardColumns, boardLanes, primaryActionLabel, runFor, todayKey, type BoardLane } from "../../../shared/agent-view";
import { currentStep, type RunProgress } from "../../../shared/agent-stream";
import { describePlan, type PublishSummary } from "../../../shared/agent-publish";
import type { AgentAction, AgentItem, MergeMethod, PullRequest } from "../../../shared/types";
import { cn, relativeTime } from "../format";
import { AgentContext } from "./agent-context";
import { AGENT_STATE_DOT } from "./AgentStatus";

// The Board: what the PR agent is doing — Idle → Queued → Working → Needs you
// → Done today. The agent's columns hold ALL of its work, whatever the
// dashboard's filters show, so the Board, the header chip and the tray never
// disagree; only Idle (the PRs you might hand it) follows the filters. The
// columns are its order, so Sort and Group-by are off while it is on. The
// queue's order is yours: drag a queued card, or "Run next"; an idle PR
// dropped on a queued card takes that place.

const LANE_TITLE: Record<BoardLane, string> = { mine: "Your PRs", review: "PRs you review" };
const LANE_HINT: Record<BoardLane, string> = {
  mine: "driven to green, merge offers, Jira after a merge",
  review: "reviews, briefs, re-reviews",
};
const LANE_DOT: Record<BoardLane, string> = { mine: "bg-violet-500", review: "bg-sky-500" };

/** An idle PR dragged towards the queue. */
const DRAG_TYPE = "application/x-prd-pr";
/** A queued run dragged to another place in the queue. */
const RUN_DRAG = "application/x-prd-run";
const BTN = "inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-elevated";
const BTN_PRIMARY = "inline-flex items-center gap-1 rounded-md border border-sky-600 bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700";

const SCENARIO_CHIP: Record<AgentItem["scenario"], string> = {
  review: "Review",
  brief: "Brief",
  rereview: "Re-review",
  drive: "Drive",
  merge: "Merge",
  afterMerge: "Jira",
};

function shortRepo(repo: string): string {
  return repo.split("/")[1] ?? repo;
}

export function PrBoard({ prs, onOpen }: { prs: PullRequest[]; onOpen: (pr: PullRequest) => void }) {
  const { state, act } = useContext(AgentContext);
  const [idleOpen, setIdleOpen] = useState(false);
  /** The lane whose queue a drag is over. */
  const [dropOn, setDropOn] = useState<BoardLane | null>(null);
  /** The queued card a drag would land in front of. */
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const byId = useMemo(() => new Map(prs.map((p) => [p.id, p])), [prs]);

  if (!state) {
    return <div className="rounded-lg border border-line bg-surface/40 p-8 text-center text-sm text-fg-subtle">The PR agent isn&apos;t available here.</div>;
  }
  const all = boardColumns(prs, state, todayKey(new Date()));
  const lanes = boardLanes(all);
  // The queue is one queue: a card's place in it, whichever lane shows it.
  const place = new Map(all.queued.map((i, n) => [i.runId, n + 1]));
  const run = async (action: AgentAction) => {
    const res = await act(action);
    setNotice(res.ok ? null : res.error);
  };
  const openItem = (item: AgentItem) => {
    const pr = byId.get(item.prId);
    if (pr) onOpen(pr);
    else window.api.openExternal(item.url).catch(() => {});
  };
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes(RUN_DRAG);
  /** A drop in the queue: in front of `before`, or at the end. */
  const dropAt = (e: DragEvent, before: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDropOn(null);
    setDropBefore(null);
    const runId = e.dataTransfer.getData(RUN_DRAG);
    if (runId) {
      if (runId !== before) void run({ type: "moveQueued", runId, before });
      return;
    }
    const prId = e.dataTransfer.getData(DRAG_TYPE);
    if (prId) void run({ type: "enqueue", prId, before });
  };
  const onDrop = (e: DragEvent) => dropAt(e, null);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg-muted">
        <span className="text-sm font-semibold text-fg">PR agent</span>
        {state.enabled ? (
          <>
            <span>
              Running {all.working.length} of {state.parallel} · runs today {state.runsToday} of {state.perDay}
            </span>
            {state.paused ? (
              <span className="font-medium text-amber-700 dark:text-amber-300">Paused — nothing starts, and nothing goes out on its own</span>
            ) : (
              state.quietUntil && <span>Quiet hours until {state.quietUntil} — only what you ask for starts</span>
            )}
            {state.heldUntil && <span className="text-amber-700 dark:text-amber-300">Claude&apos;s usage limit — new runs wait until {new Date(state.heldUntil).toLocaleTimeString()}</span>}
            {state.suggestOn && (
              <span className="text-emerald-700 dark:text-emerald-300">
                You published {state.acceptedUnchanged} reviews exactly as prepared — reviews can go On in Settings › Agent.
              </span>
            )}
          </>
        ) : (
          <span>Off — switch it on in Settings › Agent.</span>
        )}
        <span className="ml-auto flex items-center gap-3">
          {notice && (
            <span className="text-red-700 dark:text-red-300" role="alert">
              {notice}
            </span>
          )}
          {state.enabled && (
            <button type="button" className={BTN} onClick={() => void run({ type: state.paused ? "resumeAgent" : "pauseAgent" })}>
              {state.paused ? "Resume agent" : "Pause agent"}
            </button>
          )}
        </span>
      </div>

      {BOARD_LANES.map((lane) => {
        const cols = lanes[lane];
        const busy = cols.queued.length + cols.working.length + cols.needsYou.filter((i) => !i.later).length;
        return (
          <section key={lane} aria-label={LANE_TITLE[lane]} className="mb-4">
            <h2 className="mb-2 flex items-baseline gap-2 px-1">
              <span aria-hidden className={cn("inline-block size-2 self-center rounded-full", LANE_DOT[lane])} />
              <span className="text-sm font-semibold text-fg">{LANE_TITLE[lane]}</span>
              <span className="text-xs tabular-nums text-fg-muted">{busy}</span>
              <span className="text-xs text-fg-subtle">— {LANE_HINT[lane]}</span>
            </h2>
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
                className={cn("min-w-[11rem] flex-1 basis-0", dropOn === lane && "border-sky-500 bg-sky-500/10")}
                dropProps={{
                  onDragOver: (e) => {
                    if (accepts(e)) {
                      e.preventDefault();
                      setDropOn(lane);
                      setDropBefore(null);
                    }
                  },
                  onDragLeave: () => setDropOn(null),
                  onDrop,
                }}
              >
                {cols.queued.length === 0 ? (
                  <Empty>{state.enabled ? "Drop an idle PR here to hand it to the agent" : "Nothing queued"}</Empty>
                ) : (
                  cols.queued.map((item) => (
                    <article
                      key={item.runId}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(RUN_DRAG, item.runId);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragOver={(e) => {
                        if (accepts(e)) {
                          e.preventDefault();
                          e.stopPropagation();
                          setDropOn(lane);
                          setDropBefore(item.runId);
                        }
                      }}
                      onDrop={(e) => dropAt(e, item.runId)}
                      className={cn(
                        "cursor-grab rounded-md border border-line bg-surface p-2.5 shadow-sm active:cursor-grabbing",
                        // Where the drop lands: a line above this card.
                        dropOn === lane && dropBefore === item.runId && "border-t-2 border-t-sky-500",
                      )}
                    >
                      <CardHead item={item} onTitle={() => openItem(item)} />
                      <div className="mt-1 text-xs text-fg-muted">{item.headline}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {place.get(item.runId) === 1 ? (
                          <span className="text-[11px] font-medium text-sky-700 dark:text-sky-300">Next up</span>
                        ) : (
                          <>
                            <span className="text-[11px] tabular-nums text-fg-subtle" title="Its place in the agent's one queue — both lanes">
                              {place.get(item.runId)} of {all.queued.length}
                            </span>
                            <button
                              type="button"
                              className={BTN}
                              title="Put it at the front of the queue"
                              onClick={() => void run({ type: "moveQueued", runId: item.runId, before: all.queued[0].runId })}
                            >
                              Run next
                            </button>
                          </>
                        )}
                        <button type="button" className={BTN} title="Take it out of the queue — the agent won't queue it again for this head" onClick={() => void run({ type: "skip", runId: item.runId })}>
                          Skip
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </Column>

              <Column label="Working" count={cols.working.length} dot="working" className="min-w-[11rem] flex-1 basis-0">
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
          </section>
        );
      })}
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
        <Chip>{SCENARIO_CHIP[item.scenario]}</Chip>
        {item.mode === "shadow" && (item.scenario === "review" || item.scenario === "rereview" || item.scenario === "drive") && <Chip>shadow</Chip>}
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

const EVENT_TEXT: Record<NonNullable<PublishSummary["event"]>, string> = {
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request changes",
  COMMENT: "Comment",
};

/** What a review would post, as GitHub would show it: the event, the body, each inline comment, replies and resolves. */
function PlanView({ plan }: { plan: PublishSummary }) {
  return (
    <div className="mt-1 max-h-80 space-y-2 overflow-y-auto rounded border border-line bg-elevated/40 p-2 text-xs text-fg-secondary">
      {plan.event && (
        <div>
          <span
            className={cn(
              "rounded px-1.5 py-px text-[11px] font-semibold",
              plan.event === "APPROVE" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : plan.event === "REQUEST_CHANGES" ? "bg-red-500/15 text-red-700 dark:text-red-300" : "bg-elevated text-fg-muted",
            )}
          >
            {EVENT_TEXT[plan.event]}
          </span>
        </div>
      )}
      {plan.body && <div className="whitespace-pre-wrap">{plan.body}</div>}
      {plan.comments.map((c, i) => (
        <div key={i} className="border-l-2 border-line-strong pl-2">
          <div className="font-mono text-[11px] text-fg-subtle">
            {c.path}
            {c.line !== undefined ? `:${c.line}` : ""}
          </div>
          <div className="whitespace-pre-wrap">{c.body}</div>
        </div>
      ))}
      {plan.replies.map((r, i) => (
        <div key={`r${i}`} className="border-l-2 border-sky-500/50 pl-2">
          <div className="text-[11px] text-fg-subtle">Reply in a thread</div>
          <div className="whitespace-pre-wrap">{r.body}</div>
        </div>
      ))}
      {plan.resolves > 0 && <div className="text-[11px] text-fg-subtle">Resolves {plan.resolves} thread{plan.resolves === 1 ? "" : "s"}.</div>}
      {(plan.escalations ?? []).length > 0 && (
        <div className="space-y-1 rounded border border-amber-500/40 bg-amber-500/[0.06] p-1.5">
          <div className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">Handed back to you — the agent doesn't argue with the author</div>
          {plan.escalations.map((e, i) => (
            <div key={i} className="whitespace-pre-wrap">
              {e.body}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A drive's commits, as the Push button would send them; the patch on demand. */
function DriveView({ drive }: { drive: NonNullable<AgentItem["drive"]> }) {
  const [patch, setPatch] = useState(false);
  return (
    <div className="mt-1 space-y-1.5 rounded border border-line bg-elevated/40 p-2 text-xs text-fg-secondary">
      <ul className="space-y-0.5">
        {drive.commits.map((c) => (
          <li key={c.oid} className="flex gap-2">
            <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{c.oid.slice(0, 7)}</span>
            <span className="min-w-0">{c.subject}</span>
          </li>
        ))}
      </ul>
      {drive.stat && <pre className="overflow-x-auto whitespace-pre font-mono text-[11px] text-fg-subtle">{drive.stat}</pre>}
      {drive.patch && (
        <>
          <button type="button" onClick={() => setPatch((v) => !v)} aria-expanded={patch} className="text-xs text-sky-700 hover:underline dark:text-sky-300">
            {patch ? "Hide the diff" : "Show the diff"}
          </button>
          {patch && <pre className="max-h-80 overflow-auto whitespace-pre font-mono text-[11px]">{drive.patch}</pre>}
        </>
      )}
    </div>
  );
}

function MergeButton({ item, run }: { item: AgentItem; run: (a: AgentAction) => Promise<void> }) {
  const allowed = item.mergeMethods?.allowed ?? [];
  const [method, setMethod] = useState<MergeMethod | undefined>(item.mergeMethod);
  const [busy, setBusy] = useState(false);
  const merge = async () => {
    setBusy(true);
    await run({ type: "merge", runId: item.runId, method });
    setBusy(false);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void merge()}>
        {busy ? "Merging…" : "Merge"}
      </button>
      {allowed.length > 1 && (
        <select
          aria-label="Merge method"
          value={method ?? ""}
          onChange={(e) => setMethod(e.target.value as MergeMethod)}
          className="rounded-md border border-line-strong bg-surface px-1.5 py-1 text-xs text-fg-secondary"
        >
          {allowed.map((m) => (
            <option key={m} value={m}>
              {m}
              {m === item.mergeMethods?.suggested ? " (GitHub's pick)" : ""}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

function NeedsYouCard({ item, onTitle, run }: { item: AgentItem; onTitle: () => void; run: (a: AgentAction) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const primary = primaryActionLabel(item);
  const error = item.state === "error";
  const merge = item.scenario === "merge";
  const drive = item.scenario === "drive" && item.drive && item.drive.commits.length > 0 && !item.pushed ? item.drive : null;
  const plan = item.plan && !item.published && !drive ? item.plan : null;
  const [pushing, setPushing] = useState(false);
  const push = async () => {
    setPushing(true);
    await run({ type: "push", runId: item.runId });
    setPushing(false);
  };
  const publish = async () => {
    setPublishing(true);
    await run({ type: "publish", runId: item.runId });
    setPublishing(false);
  };
  const showText = !plan && !drive && !!item.output;
  return (
    <article className={cn("rounded-md border bg-surface p-2.5 shadow-sm", error ? "border-red-500/60" : merge ? "border-emerald-500/50" : "border-line", item.later && "opacity-60")}>
      <CardHead item={item} onTitle={onTitle} />
      <div className={cn("mt-1 text-xs", error ? "text-red-700 dark:text-red-300" : "text-fg-secondary")}>{item.headline}</div>
      {error && item.error && <div className="mt-0.5 line-clamp-3 font-mono text-[11px] text-fg-subtle" title={item.error}>{item.error}</div>}
      {plan && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-1 text-xs text-sky-700 hover:underline dark:text-sky-300">
            {open ? "Hide" : `See what it would post (${describePlan(plan)})`}
          </button>
          {open && <PlanView plan={plan} />}
        </>
      )}
      {drive && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-1 text-xs text-sky-700 hover:underline dark:text-sky-300">
            {open ? "Hide" : `See the ${drive.commits.length} commit${drive.commits.length === 1 ? "" : "s"}${item.plan?.replies.length ? ` and ${item.plan.replies.length} repl${item.plan.replies.length === 1 ? "y" : "ies"}` : ""}`}
          </button>
          {open && (
            <>
              <DriveView drive={drive} />
              {item.plan && item.plan.replies.length > 0 && <PlanView plan={item.plan} />}
            </>
          )}
        </>
      )}
      {showText && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-1 text-xs text-sky-700 hover:underline dark:text-sky-300">
            {open ? "Hide" : item.scenario === "brief" ? "Read the brief" : item.scenario === "afterMerge" ? "See the Jira dry run" : "See what it found"}
          </button>
          {open && <div className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap rounded border border-line bg-elevated/40 p-2 text-xs text-fg-secondary">{item.output}</div>}
        </>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {merge && <MergeButton item={item} run={run} />}
        {primary === "Push" && (
          <button type="button" className={BTN_PRIMARY} disabled={pushing} onClick={() => void push()}>
            {pushing ? "Pushing…" : "Push"}
          </button>
        )}
        {primary === "Publish" && (
          <button type="button" className={BTN_PRIMARY} disabled={publishing} onClick={() => void publish()}>
            {publishing ? "Publishing…" : "Publish"}
          </button>
        )}
        {primary === "Resume" && (
          <button
            type="button"
            className={BTN_PRIMARY}
            title="The same session goes on where it stopped, in the same worktree"
            onClick={() => void run({ type: "resumeSession", runId: item.runId })}
          >
            Resume
          </button>
        )}
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
        {item.sessionId && (item.worktree || item.scenario === "afterMerge") && (
          <button
            type="button"
            className={primary === "Continue in session" || primary === "Apply in session" ? BTN_PRIMARY : BTN}
            title={plan ? "Open the session in your terminal to change the review before it goes out" : undefined}
            onClick={() => void run({ type: "continue", runId: item.runId })}
          >
            {item.scenario === "afterMerge" ? "Apply in session" : plan ? "Edit first" : "Continue in session"}
          </button>
        )}
        {!error && !merge && item.scenario !== "afterMerge" && primary !== "Run again" && (
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
      {plan && item.mode === "shadow" && <div className="mt-1.5 text-[11px] text-fg-faint">Shadow: nothing is on GitHub until you press Publish. It goes out with the agent&apos;s signature.</div>}
      {merge && <div className="mt-1.5 text-[11px] text-fg-faint">Merges only the commit shown here — GitHub refuses it if anyone pushes first.</div>}
      {item.interrupted && (primary === "Resume" || item.scenario === "drive") && (
        <div className="mt-1.5 text-[11px] text-fg-faint">
          {item.scenario === "drive"
            ? "A drive starts over: its push is checked against what the app read before the session."
            : "Resume picks the session up where it stopped; Run again starts over."}
        </div>
      )}
      {drive && item.mode === "shadow" && (
        <div className="mt-1.5 text-[11px] text-fg-faint">Shadow: nothing is on the branch until you press Push. It goes out as a fast-forward only, and only while nobody else pushed.</div>
      )}
    </article>
  );
}

function IdleCard({ pr, reason, onOpen, onQueue }: { pr: PullRequest; reason: string; onOpen: (pr: PullRequest) => void; onQueue?: () => void }) {
  // Yours too: the agent drives your PR when CI, a conflict or comments need it (it says so if nothing does).
  const canHand = onQueue && (pr.roles.includes("reviewer") || pr.roles.includes("reviewed") || pr.roles.includes("author"));
  return (
    <article
      draggable={Boolean(canHand)}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, pr.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      title={canHand ? "Drag it to the queue — onto a queued card to run it before that one" : undefined}
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
