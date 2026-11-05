import { useContext, useEffect, useMemo, useState, type DragEvent, type FormEvent, type ReactNode } from "react";

// Node-free (see AGENTS.md): the columns, the day, and the plan's current step.
import { agentSummary, BOARD_LANES, boardColumns, boardLanes, primaryActionLabel, runFor, todayKey, type BoardLane } from "../../../shared/agent-view";
import { currentStep, type RunProgress } from "../../../shared/agent-stream";
import { describePlan, type PublishSummary } from "../../../shared/agent-publish";
import { resultCard, type FindingSeverity, type RunAsk, type RunFinding } from "../../../shared/agent-result";
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

/** An answer is a note to the session, like a hint (main holds it to the same bound). */
const AGENT_ANSWER_MAX = 2_000;

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

export function PrBoard({ prs, onOpen, focus }: { prs: PullRequest[]; onOpen: (pr: PullRequest) => void; focus?: { runId: string | null; n: number } }) {
  const { state, act } = useContext(AgentContext);
  // Asked to show an item: its card, scrolled to and flashing (a finite animation).
  useEffect(() => {
    if (!focus?.runId) return;
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(focus.runId ?? "")}"]`);
      if (!el) return;
      // At once, not smoothly: a smooth scroll can be dropped by a render landing mid-way.
      el.scrollIntoView({ block: "center" });
      el.classList.remove("focus-flash");
      void el.offsetWidth;
      el.classList.add("focus-flash");
      window.setTimeout(() => el.classList.remove("focus-flash"), 3000);
    }, 50);
    return () => window.clearTimeout(t);
  }, [focus?.n, focus?.runId]);
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
  const sum = agentSummary(state);
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
              Running {sum.running} of {state.parallel}
              {sum.pausedRuns > 0 && ` (${sum.pausedRuns} paused)`} · runs today {state.runsToday} of {state.perDay}
            </span>
            {sum.block === "paused" && <span className="font-medium text-amber-700 dark:text-amber-300">Paused — nothing starts, and nothing goes out on its own</span>}
            {sum.block === "quiet" && <span>{sum.blockText} — only what you ask for starts</span>}
            {sum.block === "usage" && <span className="text-amber-700 dark:text-amber-300">Claude&apos;s {sum.blockText?.toLowerCase()}</span>}
            {sum.block === "daily" && (
              <span className="text-amber-700 dark:text-amber-300">
                {sum.blockText} — {sum.queued > 0 ? `${sum.queued} queued wait` : "new runs wait"} until tomorrow (Settings › Agent › Limits)
              </span>
            )}
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
              <span className="text-xs tabular-nums text-fg-muted" title="Queued, working and waiting for you in this lane">
                {busy}
              </span>
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
                      data-run-id={item.runId}
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

              <Column label="Needs you" count={cols.needsYou.filter((i) => !i.later).length} aside={cols.needsYou.some((i) => i.later) ? <span className="text-[11px] text-fg-subtle" title="Put aside with Later — at the end of the column">+{cols.needsYou.filter((i) => i.later).length} later</span> : undefined} dot="needsYou" className="min-w-[15rem] flex-[1.6] basis-0 border-amber-500/50 bg-amber-500/[0.05]">
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
                      {resultCard(item)?.summary && <span className="line-clamp-2 w-full text-[11px] text-fg-subtle">{resultCard(item)?.summary}</span>}
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
    <article data-run-id={item.runId} className="rounded-md border border-line bg-surface p-2.5 shadow-sm">
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
  const { state, openCompanion } = useContext(AgentContext);
  const steps = progress?.steps ?? [];
  const step = progress ? currentStep(progress) : null;
  return (
    <article data-run-id={item.runId} className="rounded-md border border-sky-500/40 bg-surface p-2.5 shadow-sm">
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
        {/* The plan and log live in the popover, which exists only with the header chip. */}
        {state?.headerChip && (
          <button type="button" className={BTN} title="The plan, the log, a note to the agent" onClick={() => openCompanion(item.runId)}>
            Watch
          </button>
        )}
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

const SEVERITY_CHIP: Record<FindingSeverity, string> = {
  blocker: "border-red-500/60 bg-red-500/10 text-red-700 dark:text-red-300",
  major: "border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  minor: "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  note: "border-line-strong text-fg-muted",
};

/** The findings worth a glance: the most severe few, the rest one click away. */
function FindingsList({ findings }: { findings: RunFinding[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? findings : findings.slice(0, 3);
  return (
    <ul className="mt-1.5 space-y-1">
      {shown.map((f, i) => (
        <li key={i} className="flex items-start gap-1.5 text-xs">
          <span className={cn("mt-px shrink-0 rounded border px-1 text-[10px] font-semibold uppercase leading-4", SEVERITY_CHIP[f.severity])}>{f.severity}</span>
          <span className="min-w-0 text-fg-secondary">
            {f.text}
            {f.where && <span className="ml-1 font-mono text-[11px] text-fg-subtle">{f.where}</span>}
          </span>
        </li>
      ))}
      {findings.length > 3 && (
        <li>
          <button type="button" onClick={() => setAll((v) => !v)} className="text-xs text-sky-700 hover:underline dark:text-sky-300">
            {all ? "Fewer" : `+${findings.length - 3} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

/**
 * What the run asks you, with the answers it offers and room for your own.
 * One question: an answer goes at once. Several: pick or write each, then Send.
 * The same session goes on with what you said (`answer`); where the app can't
 * do that (the Jira dry run changes nothing), the question is only shown.
 */
function AsksBox({ item, asks, canAnswer, run }: { item: AgentItem; asks: RunAsk[]; canAnswer: boolean; run: (a: AgentAction) => Promise<void> }) {
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  const single = asks.length === 1;
  const send = async (text: string) => {
    if (!text.trim()) return;
    setSending(true);
    await run({ type: "answer", runId: item.runId, text: text.slice(0, AGENT_ANSWER_MAX) });
    setSending(false);
  };
  const answerOf = (i: number) => typed[i]?.trim() || picked[i] || "";
  const composed = () =>
    asks
      .map((a, i) => (answerOf(i) ? `Q: ${a.question}\nA: ${answerOf(i)}` : null))
      .filter(Boolean)
      .join("\n\n");
  return (
    <div className="mt-2 rounded-md border border-amber-500/50 bg-amber-500/[0.07] p-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">{single ? "It asks you" : `It asks you ${asks.length} things`}</div>
      {asks.map((a, i) => (
        <div key={i} className={cn(i > 0 && "mt-2 border-t border-amber-500/20 pt-2")}>
          <div className="text-xs text-fg">{a.question}</div>
          {a.options.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {a.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  disabled={!canAnswer || sending}
                  aria-pressed={picked[i] === o}
                  onClick={() => (single ? void send(`Q: ${a.question}\nA: ${o}`) : setPicked((p) => ({ ...p, [i]: p[i] === o ? "" : o })))}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-xs font-medium disabled:cursor-default disabled:opacity-60",
                    picked[i] === o ? "border-sky-600 bg-sky-600 text-white" : "border-line-strong bg-surface text-fg-secondary hover:bg-elevated",
                  )}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          {canAnswer && (
            <form
              className="mt-1.5 flex gap-1"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                if (single) void send(`Q: ${a.question}\nA: ${typed[i] ?? ""}`);
              }}
            >
              <input
                value={typed[i] ?? ""}
                onChange={(e) => setTyped((t) => ({ ...t, [i]: e.target.value }))}
                maxLength={1500}
                placeholder={a.options.length > 0 ? "Or your own answer…" : "Your answer…"}
                aria-label={`Answer: ${a.question}`}
                className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs text-fg placeholder:text-fg-faint focus:border-sky-500 focus:outline-none"
              />
              {single && (
                <button type="submit" className={BTN_PRIMARY} disabled={sending || !(typed[i] ?? "").trim()}>
                  {sending ? "Sending…" : "Send"}
                </button>
              )}
            </form>
          )}
        </div>
      ))}
      {canAnswer && !single && (
        <button type="button" className={cn(BTN_PRIMARY, "mt-2")} disabled={sending || !composed()} onClick={() => void send(composed())}>
          {sending ? "Sending…" : "Send answers"}
        </button>
      )}
      <div className="mt-1.5 text-[11px] text-fg-faint">
        {canAnswer ? "The same session goes on with your answer and comes back here." : "Answer it in the session: the dry run changes nothing by itself."}
      </div>
    </div>
  );
}

function NeedsYouCard({ item, onTitle, run }: { item: AgentItem; onTitle: () => void; run: (a: AgentAction) => Promise<void> }) {
  const [open, setOpen] = useState<"plan" | "drive" | "report" | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const primary = primaryActionLabel(item);
  const error = item.state === "error";
  const merge = item.scenario === "merge";
  const drive = item.scenario === "drive" && item.drive && item.drive.commits.length > 0 && !item.pushed ? item.drive : null;
  const plan = item.plan && !item.published && !drive ? item.plan : null;
  const card = resultCard(item);
  const asks = card?.asks ?? [];
  const findings = card?.findings ?? [];
  const canAnswer = item.scenario !== "afterMerge" && Boolean(item.sessionId) && !error;
  const hasSession = Boolean(item.sessionId && (item.worktree || item.scenario === "afterMerge"));
  const toggle = (what: "plan" | "drive" | "report") => setOpen((v) => (v === what ? null : what));
  const doing = async (label: string, action: AgentAction) => {
    setBusy(label);
    await run(action);
    setBusy(null);
  };
  const primaryButton = (label: string, action: AgentAction, busyLabel?: string, title?: string) => (
    <button type="button" className={BTN_PRIMARY} disabled={busy !== null} title={title} onClick={() => void doing(label, action)}>
      {busy === label && busyLabel ? busyLabel : label}
    </button>
  );
  // The full message, when it says more than the summary above it.
  const report = item.output && item.output.trim() !== card?.summary ? item.output : null;
  return (
    <article data-run-id={item.runId} className={cn("rounded-md border bg-surface p-2.5 shadow-sm", error ? "border-red-500/60" : merge ? "border-emerald-500/50" : asks.length > 0 ? "border-amber-500/60" : "border-line", item.later && "opacity-60")}>
      <CardHead item={item} onTitle={onTitle} />
      <div className={cn("mt-1 text-xs", error ? "text-red-700 dark:text-red-300" : "text-fg-muted")}>{item.headline}</div>
      {error && item.error && <div className="mt-0.5 line-clamp-3 font-mono text-[11px] text-fg-subtle" title={item.error}>{item.error}</div>}
      {card?.summary && <p className="mt-1.5 line-clamp-4 text-[13px] leading-snug text-fg">{card.summary}</p>}
      {findings.length > 0 && <FindingsList findings={findings} />}
      {asks.length > 0 && <AsksBox item={item} asks={asks} canAnswer={canAnswer} run={run} />}

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
        {plan && (
          <button type="button" onClick={() => toggle("plan")} aria-expanded={open === "plan"} className="text-xs text-sky-700 hover:underline dark:text-sky-300">
            {open === "plan" ? "Hide what it would post" : `What it would post: ${describePlan(plan)}`}
          </button>
        )}
        {drive && (
          <button type="button" onClick={() => toggle("drive")} aria-expanded={open === "drive"} className="text-xs text-sky-700 hover:underline dark:text-sky-300">
            {open === "drive"
              ? "Hide the commits"
              : `The ${drive.commits.length} commit${drive.commits.length === 1 ? "" : "s"}${item.plan?.replies.length ? ` and ${item.plan.replies.length} repl${item.plan.replies.length === 1 ? "y" : "ies"}` : ""}`}
          </button>
        )}
        {report && (
          <button type="button" onClick={() => toggle("report")} aria-expanded={open === "report"} className="text-xs text-sky-700 hover:underline dark:text-sky-300">
            {open === "report" ? "Hide the report" : item.scenario === "brief" ? "Read the brief" : item.scenario === "afterMerge" ? "The Jira dry run" : "Full report"}
          </button>
        )}
      </div>
      {open === "plan" && plan && <PlanView plan={plan} />}
      {open === "drive" && drive && (
        <>
          <DriveView drive={drive} />
          {item.plan && item.plan.replies.length > 0 && <PlanView plan={item.plan} />}
        </>
      )}
      {open === "report" && report && <div className="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded border border-line bg-elevated/40 p-2 text-xs text-fg-secondary">{report}</div>}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {merge && <MergeButton item={item} run={run} />}
        {primary === "Push" && primaryButton("Push", { type: "push", runId: item.runId }, "Pushing…")}
        {primary === "Publish" && primaryButton("Publish", { type: "publish", runId: item.runId }, "Publishing…")}
        {primary === "Resume" && primaryButton("Resume", { type: "resumeSession", runId: item.runId }, undefined, "The same session goes on where it stopped, in the same worktree")}
        {primary === "Run again" && primaryButton("Run again", { type: "retry", runId: item.runId })}
        {primary === "Review anyway" && primaryButton("Review anyway", { type: "reviewAnyway", runId: item.runId })}
        {primary === "Apply in session" && primaryButton("Apply in session", { type: "continue", runId: item.runId }, undefined, "Opens the session in your terminal, where it asks before every change")}
        {primary === "Done" && primaryButton("Done", { type: "ack", runId: item.runId }, undefined, "Nothing left for you here: it moves to Done today")}
        <button type="button" className={BTN} onClick={() => void run({ type: "later", runId: item.runId })}>
          {item.later ? "Bring back" : "Later"}
        </button>
        <button type="button" className={BTN} aria-expanded={more} aria-label="More actions" title="More actions" onClick={() => setMore((v) => !v)}>
          ⋯
        </button>
      </div>
      {more && (
        <div className="mt-1.5 flex flex-wrap gap-1.5 rounded-md border border-line bg-elevated/40 p-1.5">
          {hasSession && primary !== "Apply in session" && (
            <button
              type="button"
              className={BTN}
              title={plan ? "Open the session in your terminal to change the review before it goes out" : "Open the session in your terminal"}
              onClick={() => void run({ type: "continue", runId: item.runId })}
            >
              {plan ? "Edit first" : "Continue in session"}
            </button>
          )}
          {!merge && item.scenario !== "afterMerge" && primary !== "Run again" && (
            <button type="button" className={BTN} title="Start over with a new session" onClick={() => void run({ type: "retry", runId: item.runId })}>
              Run again
            </button>
          )}
          {!merge && primary !== "Done" && (
            <button type="button" className={BTN} title="Nothing more to do: it moves to Done today" onClick={() => void run({ type: "ack", runId: item.runId })}>
              Done
            </button>
          )}
          <button type="button" className={BTN} title="Drop it; it won't show in Done today" onClick={() => void run({ type: "skip", runId: item.runId })}>
            Dismiss
          </button>
        </div>
      )}
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
