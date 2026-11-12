import { useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";

// Node-free (see AGENTS.md): the Board in plain words, the queue, the summary line.
import { explainBoard, type BoardChoice, type BoardEntry, type BoardOwner } from "../../../shared/agent-explain";
import { agentSummary, queueOrder, todayKey } from "../../../shared/agent-view";
// Node-free too: a held write is worded once, for the card and the publish refusal alike.
import { heldLabel, type HeldWrite, type PublishSummary } from "../../../shared/agent-publish";
import type { FindingSeverity, RunAsk, RunFinding } from "../../../shared/agent-result";
import type { AgentAction, AgentItem, AgentState, MergeMethod, PullRequest } from "../../../shared/types";
import { cn, relativeTime } from "../format";
import { AgentContext } from "./agent-context";
import { AgentDiagrams } from "./AgentDiagrams";

// The Board: what needs you first, then what doesn't. One sentence says how
// much is yours; then every decision as an open card — what happened, what to
// read, what to do, what the button does, what comes next — readiest first;
// then, in rows that ask nothing of you, what the agent is doing, what waits
// on others and what is done today. The words come from `agent-explain.ts`,
// where each PR stands from `stageColumns` (which the chip and the tray read
// too). It follows the dashboard's filters and says how many prepared moves
// they hide; its order is its own, so Sort and Group-by are off while it is on.

/** An answer is a note to the session, like a hint (main holds it to the same bound). */
const AGENT_ANSWER_MAX = 2_000;

const BTN = "inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-elevated disabled:opacity-60";
const BTN_PRIMARY = "inline-flex items-center gap-1 rounded-md border border-sky-600 bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-60";
const BTN_BIG = "inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60";
const LINK = "text-xs text-sky-700 hover:underline dark:text-sky-300";

const OWNER_TONE: Record<BoardOwner, { dot: string; text: string }> = {
  you: { dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-300" },
  agent: { dot: "bg-sky-500", text: "text-sky-700 dark:text-sky-300" },
  others: { dot: "bg-violet-500", text: "text-violet-700 dark:text-violet-300" },
  done: { dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
};

type Run = (a: AgentAction) => Promise<boolean>;

function shortRepo(repo: string): string {
  return repo.split("/")[1] ?? repo;
}

function openUrl(url: string): void {
  window.api.openExternal(url).catch(() => {});
}

export function PrBoard({
  prs,
  all,
  onOpen,
  focus,
  onClearFilters,
}: {
  /** The PRs the dashboard's filters let through. */
  prs: PullRequest[];
  /** Every PR in the snapshot — to tell a filtered-out PR from one that left the dashboard. */
  all: PullRequest[];
  onOpen: (pr: PullRequest) => void;
  focus?: { runId: string | null; n: number };
  onClearFilters?: () => void;
}) {
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
  // A refusal, with the PR it is about: shown on that PR's open card, where
  // the click was — at the top it read as a click that did nothing.
  const [notice, setNotice] = useState<{ text: string; prId: string | null } | null>(null);

  if (!state) {
    return <div className="rounded-lg border border-line bg-surface/40 p-8 text-center text-sm text-fg-subtle">The PR agent isn&apos;t available here.</div>;
  }
  const { entries, earlier, hiddenReady } = explainBoard(prs, all, state, { today: todayKey(new Date()), idle: state.idle, orchestrated: state.orchestrated });
  const first = queueOrder(state.items.filter((i) => i.state === "queued"))[0]?.runId ?? null;
  const run: Run = async (action) => {
    const res = await act(action);
    const prId = "prId" in action ? action.prId : "runId" in action ? (state.items.find((i) => i.runId === action.runId)?.prId ?? null) : null;
    setNotice(res.ok ? null : { text: res.error, prId });
    // An approval given again changes GitHub's state, not an item: read it again so the card moves now.
    if (res.ok && action.type === "approveAgain") void window.api.refresh().catch(() => {});
    return res.ok;
  };
  const open = (e: BoardEntry) => (e.pr ? onOpen(e.pr) : openUrl(e.url));
  const yours = entries.filter((e) => e.owner === "you");
  const agent = entries.filter((e) => e.owner === "agent");
  const others = entries.filter((e) => e.owner === "others");
  const done = entries.filter((e) => e.owner === "done");

  return (
    <div className="mx-auto max-w-4xl space-y-7 pb-10">
      <Overview
        state={state}
        yours={yours.length}
        agent={agent}
        others={others.length}
        done={done.length}
        earlier={earlier}
        hiddenReady={hiddenReady}
        onClearFilters={onClearFilters}
        notice={notice && !yours.some((e) => e.prId === notice.prId) ? notice.text : null}
        run={run}
      />

      {yours.length > 0 && (
        <section aria-label="Your turn" className="space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Your turn</h2>
          {yours.map((e, i) => (
            <Decision key={e.prId} e={e} n={i + 1} run={run} onOpen={() => open(e)} notice={notice?.prId === e.prId ? notice.text : null} />
          ))}
        </section>
      )}

      <StatusSection title="The agent is on it" hint="nothing to do — the result comes up in Your turn" list={agent} state={state} first={first} run={run} onOpen={open} />
      <StatusSection title="Waiting on others" hint="nothing to do — the agent picks it up again when they answer" list={others} state={state} first={first} run={run} onOpen={open} />
      <StatusSection
        title="Done today"
        hint=""
        list={done}
        state={state}
        first={first}
        run={run}
        onOpen={open}
        aside={earlier > 0 ? <span className="text-xs font-normal text-fg-subtle" title="Your approvals from earlier days: their PRs wait on others now">+{earlier} approved earlier</span> : null}
      />
    </div>
  );
}

/** The one sentence of what you owe, what the rest is doing, and the agent's own state. */
function Overview({
  state,
  yours,
  agent,
  others,
  done,
  earlier,
  hiddenReady,
  onClearFilters,
  notice,
  run,
}: {
  state: AgentState;
  yours: number;
  agent: BoardEntry[];
  others: number;
  done: number;
  earlier: number;
  hiddenReady: number;
  onClearFilters?: () => void;
  notice: string | null;
  run: Run;
}) {
  const sum = agentSummary(state);
  const working = agent.filter((e) => e.item?.state === "working").length;
  const inLine = agent.filter((e) => e.item?.state === "queued").length;
  const sdlc = agent.length - working - inLine;
  const rest = [
    working > 0 && `the agent is working on ${working}`,
    inLine > 0 && `${inLine} in line`,
    sdlc > 0 && `${sdlc} with an SDLC run`,
    others > 0 && `${others} ${others === 1 ? "waits" : "wait"} on others`,
    (done > 0 || earlier > 0) && `${done} done today`,
  ].filter(Boolean) as string[];
  return (
    <header className="rounded-xl border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className={cn("text-xl font-semibold", yours > 0 ? "text-fg" : "text-fg-secondary")}>
            {yours === 0 ? "Nothing needs you right now." : `${yours} ${yours === 1 ? "thing needs" : "things need"} you.`}
          </div>
          <div className="mt-1 text-sm text-fg-muted">{rest.length > 0 ? `${rest.join(" · ").replace(/^./, (c) => c.toUpperCase())}.` : "The agent has nothing in hand."}</div>
        </div>
        {state.enabled && (
          <button type="button" className={BTN} onClick={() => void run({ type: state.paused ? "resumeAgent" : "pauseAgent" })} title={state.paused ? "Let the agent start runs again" : "Nothing starts, and nothing goes out on its own, until you resume"}>
            {state.paused ? "Resume agent" : "Pause agent"}
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-subtle">
        {!state.enabled ? (
          <span>The agent is off — the Board still shows whose move each PR is; switch it on in Settings › Agent.</span>
        ) : (
          <>
            {yours > 0 && <span>Nothing in Your turn has gone out: it goes out only when you press its button.</span>}
            {sum.block === "paused" && <span className="font-medium text-amber-700 dark:text-amber-300">Paused — nothing starts, and nothing goes out on its own.</span>}
            {sum.block === "quiet" && <span className="text-amber-700 dark:text-amber-300">{sum.blockText} — only what you ask for starts.</span>}
            {sum.block === "usage" && <span className="text-amber-700 dark:text-amber-300">Claude&apos;s {sum.blockText?.toLowerCase()} — runs wait.</span>}
            {sum.block === "daily" && (
              <span className="text-amber-700 dark:text-amber-300">
                {sum.blockText} — {sum.queued > 0 ? `${sum.queued} in line wait` : "new runs wait"} until tomorrow (Settings › Agent › Limits).
              </span>
            )}
            <span>
              Runs today {state.runsToday} of {state.perDay}.
            </span>
            {state.suggestOn && <span className="text-emerald-700 dark:text-emerald-300">You sent {state.acceptedUnchanged} reviews exactly as drafted — reviews can go On in Settings › Agent.</span>}
          </>
        )}
        {hiddenReady > 0 && (
          <span className="text-amber-700 dark:text-amber-300">
            {hiddenReady} more for you {hiddenReady === 1 ? "is" : "are"} hidden by the filters
            {onClearFilters && (
              <>
                {" · "}
                <button type="button" className="font-medium underline" onClick={onClearFilters}>
                  Clear filters
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {notice && (
        <div role="alert" className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-800 dark:text-red-200">
          {notice}
        </div>
      )}
    </header>
  );
}

/** A decision, open: what happened, what to read, your move with what each button does, and what comes next. */
function Decision({ e, n, run, onOpen, notice }: { e: BoardEntry; n: number; run: Run; onOpen: () => void; notice: string | null }) {
  const item = e.item;
  const primary = e.choices.find((c) => c.primary) ?? null;
  const rest = e.choices.filter((c) => c !== primary);
  const kind = e.stage.action?.kind ?? null;
  return (
    <article data-run-id={item?.runId} data-pr-id={e.prId} className={cn("overflow-hidden rounded-xl border bg-surface shadow-tile", kind === "fix" ? "border-red-500/50" : "border-amber-500/50")}>
      <div className={cn("flex items-center gap-2 border-b border-line px-4 py-1.5 text-xs text-fg-muted", kind === "fix" ? "bg-red-500/[0.06]" : "bg-amber-500/[0.06]")}>
        <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white", kind === "fix" ? "bg-red-500" : "bg-amber-500")}>{n}</span>
        <span className="shrink-0 rounded border border-line-strong px-1.5 py-px">{e.laneLabel}</span>
        <span className="truncate">
          {shortRepo(e.repo)} #{e.number}
          {e.pr?.issueKey ? ` · ${e.pr.issueKey}` : ""}
        </span>
        <span className="flex-1" />
        <span className="shrink-0" title={`Here since ${new Date(e.since).toLocaleString()}`}>
          {relativeTime(e.since)}
        </span>
      </div>
      <div className="space-y-4 px-4 py-3">
        <button type="button" onClick={onOpen} className="text-left text-base font-semibold text-fg hover:text-sky-700 hover:underline dark:hover:text-sky-300">
          {e.title}
        </button>
        <Row label="What happened">
          <p className="text-sm text-fg">{e.now}</p>
        </Row>
        <ReadThis e={e} run={run} />
        <Row label="Your move">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">{e.ask}</p>
          {(kind === "decide" || (item?.needsRerun && kind === "push")) && item && e.read.asks.length > 0 && (
            <YourCall item={item} asks={e.read.asks} canAnswer={Boolean(item.sessionId) && !item.needsRerun} run={run} />
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {primary && <ChoiceButton choice={primary} item={item} run={run} big />}
            {rest.map((c) => (
              <ChoiceButton key={c.label} choice={c} item={item} run={run} big />
            ))}
          </div>
          {notice && (
            <div role="alert" className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-800 dark:text-red-200">
              {notice}
            </div>
          )}
          {primary && (
            <p className="mt-2 text-xs text-fg-muted">
              <span className="font-medium text-fg-secondary">{primary.label}:</span> {primary.does}
            </p>
          )}
        </Row>
        {e.next && (
          <Row label="Then">
            <p className="text-sm text-fg-muted">{e.next}</p>
          </Row>
        )}
      </div>
    </article>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[7.5rem_1fr] sm:gap-3">
      <div className="pt-0.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** What to read before deciding: the summary and findings first, then what goes out, the commits, the brief, what went wrong. */
function ReadThis({ e, run }: { e: BoardEntry; run: Run }) {
  const [full, setFull] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const item = e.item;
  const r = e.read;
  const kind = e.stage.action?.kind ?? null;
  const plan = r.plan;
  const sends = kind === "send" && plan;
  const commits = (kind === "push" || kind === "decide") && item?.drive && item.drive.commits.length > 0;
  // A question on your PR with nothing to push: the answers it drafted, which "as they are" sends.
  const answers = kind === "decide" && !commits && item?.scenario === "drive" && plan && plan.replies.length > 0;
  const brief = kind === "draftReview";
  const report = (brief || kind === "fix") && r.report;
  const any = r.summary || r.findings.length > 0 || sends || commits || answers || r.error || r.questions.length > 0 || report || r.brief || item?.diagrams;
  if (!any) return null;
  return (
    <Row label="Read this">
      <div className="space-y-2">
        {sends && plan.escalations.length > 0 && item && <Disputes item={item} plan={plan} run={run} />}
        {sends && (plan.held?.length ?? 0) > 0 && <HeldBack held={plan.held ?? []} />}
        {r.error && <pre className="whitespace-pre-wrap rounded-md bg-red-500/10 p-2 font-mono text-[11px] text-red-800 dark:text-red-200">{r.error}</pre>}
        {r.summary && <p className="whitespace-pre-wrap text-sm leading-snug text-fg-secondary">{r.summary}</p>}
        {r.findings.length > 0 && <FindingsList findings={r.findings} />}
        {r.questions.length > 0 && (
          <div className="rounded-md border border-line bg-elevated/40 p-2 text-xs">
            <div className="font-medium text-fg">Questions for the author</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-fg-secondary">
              {r.questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
            <div className="mt-1 text-[11px] text-fg-faint">Draft a review puts them in it, as comments.</div>
          </div>
        )}
        {(sends || answers) && plan && (
          <div>
            <div className="text-xs font-medium text-fg">What goes out on GitHub</div>
            <PlanView plan={plan} />
          </div>
        )}
        {commits && item?.drive && (
          <div>
            <div className="text-xs font-medium text-fg">{item.needsRerun ? "What it committed — never pushed; the new run makes it again" : "What gets pushed"}</div>
            <DriveView drive={item.drive} />
            {item.plan && item.plan.replies.length > 0 && <PlanView plan={item.plan} />}
          </div>
        )}
        {report && (
          <div>
            <button type="button" onClick={() => setFull((v) => !v)} aria-expanded={full} className={LINK}>
              {full ? "Hide the full report" : brief ? "▸ Read the whole brief" : "▸ The full report"}
            </button>
            {full && <div className="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded border border-line bg-elevated/40 p-2 text-xs text-fg-secondary">{report}</div>}
          </div>
        )}
        {r.brief && (
          <div>
            <button type="button" onClick={() => setBriefOpen((v) => !v)} aria-expanded={briefOpen} className={LINK}>
              {briefOpen ? "Hide the brief" : "▸ The brief it wrote first"}
            </button>
            {briefOpen && <div className="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded border border-line bg-elevated/40 p-2 text-xs text-fg-secondary">{r.brief}</div>}
          </div>
        )}
        {item?.diagrams && <AgentDiagrams diagrams={item.diagrams} posts={Boolean(sends && plan.diagrams)} />}
      </div>
    </Row>
  );
}

/** A button that does what its card says it does: the merge with its method, the rest with their action or link. */
function ChoiceButton({ choice, item, run, big = false }: { choice: BoardChoice; item: AgentItem | null; run: Run; big?: boolean }) {
  const [busy, setBusy] = useState(false);
  if (choice.control === "merge" && item) return <MergeButton item={item} run={run} big={big} />;
  const press = async () => {
    if (choice.url && !choice.act) return openUrl(choice.url);
    if (!choice.act) return;
    setBusy(true);
    await run(choice.act);
    setBusy(false);
  };
  return (
    <button
      type="button"
      title={choice.does}
      disabled={busy}
      onClick={() => void press()}
      className={big ? cn(BTN_BIG, choice.primary ? "border-sky-600 bg-sky-600 text-white hover:bg-sky-700" : "border-line-strong bg-surface text-fg-secondary hover:bg-elevated") : choice.primary ? BTN_PRIMARY : BTN}
    >
      {busy ? "…" : choice.label}
    </button>
  );
}

/** Rows that ask nothing of you: who holds the PR and what it is doing, with what comes next and what you could do one click away. */
function StatusSection({
  title,
  hint,
  list,
  state,
  first,
  run,
  onOpen,
  aside,
}: {
  title: string;
  hint: string;
  list: BoardEntry[];
  state: AgentState;
  first: string | null;
  run: Run;
  onOpen: (e: BoardEntry) => void;
  aside?: ReactNode;
}) {
  if (list.length === 0 && !aside) return null;
  return (
    <section aria-label={title}>
      <h2 className="flex flex-wrap items-baseline gap-x-2 px-1 text-sm font-semibold text-fg">
        {title}
        <span className="text-xs font-normal text-fg-subtle">{list.length}</span>
        {hint && <span className="text-xs font-normal text-fg-subtle">· {hint}</span>}
        {aside && <span className="ml-auto">{aside}</span>}
      </h2>
      {list.length > 0 && (
        <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {list.map((e) => (
            <StatusRow key={e.prId} e={e} state={state} first={first} run={run} onOpen={() => onOpen(e)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusRow({ e, state, first, run, onOpen }: { e: BoardEntry; state: AgentState; first: string | null; run: Run; onOpen: () => void }) {
  const { openCompanion } = useContext(AgentContext);
  const [more, setMore] = useState(false);
  const tone = OWNER_TONE[e.owner];
  const item = e.item;
  const who =
    e.owner === "agent"
      ? item?.state === "queued"
        ? `In line${e.place ? ` · ${e.place}` : ""}`
        : item?.state === "working"
          ? "The agent"
          : e.stage.sdlc
            ? "SDLC run"
            : "The agent"
      : e.owner === "others"
        ? (e.waitingOn ?? "Others")
        : "Done";
  // The row's own extras: watch a run, move one up the line.
  const extra: BoardChoice[] = [];
  if (item?.state === "working" && state.headerChip) extra.push({ label: "Watch", does: "The plan, the log, and a note to the agent.", act: undefined });
  if (item?.state === "queued" && first && first !== item.runId) extra.push({ label: "Run it next", does: "Puts it at the front of the line.", act: { type: "moveQueued", runId: item.runId, before: first } });
  const choices = [...extra, ...e.choices];
  return (
    <li data-run-id={item?.runId} data-pr-id={e.prId} className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", tone.dot)} />
        <span className={cn("w-24 shrink-0 truncate text-xs font-medium", tone.text)} title={who}>
          {who}
        </span>
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-sm text-fg hover:underline" title={e.title}>
          <span className="text-fg-subtle">#{e.number}</span> {e.title}
        </button>
        <span className="hidden shrink-0 text-[11px] text-fg-subtle sm:inline">{e.laneLabel}</span>
        <span className="shrink-0 text-xs text-fg-subtle" title={new Date(e.since).toLocaleString()}>
          {relativeTime(e.since)}
        </span>
        {(choices.length > 0 || e.next) && (
          <button type="button" aria-expanded={more} onClick={() => setMore((v) => !v)} className="shrink-0 text-xs text-sky-700 hover:underline dark:text-sky-300">
            {more ? "Less" : "More"}
          </button>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-[8.25rem] text-xs text-fg-muted max-sm:pl-5">
        <span className="min-w-0">{e.now}</span>
        {e.progress && e.progress.total > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex h-1 w-24 gap-px overflow-hidden rounded-full" aria-hidden>
              {Array.from({ length: e.progress.total }, (_, i) => (
                <span key={i} className={cn("h-full flex-1", i < e.progress!.done ? "bg-emerald-500" : i === e.progress!.done ? "bg-sky-500" : "bg-line-strong")} />
              ))}
            </span>
            <span className="text-sky-700 dark:text-sky-300">{e.progress.step}</span>
          </span>
        )}
        {!e.progress && item?.state === "working" && <span className="text-sky-700 dark:text-sky-300">{item.headline}</span>}
      </div>
      {more && (
        <div className="mt-2 space-y-2 pl-[8.25rem] max-sm:pl-5">
          {e.next && <p className="text-xs text-fg-subtle">Then: {e.next}</p>}
          {e.progress?.activity && <p className="truncate font-mono text-[11px] text-fg-subtle">{e.progress.activity}</p>}
          {choices.length > 0 && (
            <ul className="space-y-1.5">
              {choices.map((c) => (
                <li key={c.label} className="flex flex-wrap items-center gap-2">
                  {c.label === "Watch" && item ? (
                    <button type="button" className={BTN} onClick={() => openCompanion(item.runId)} title={c.does}>
                      Watch
                    </button>
                  ) : (
                    <ChoiceButton choice={c} item={item} run={run} />
                  )}
                  <span className="text-[11px] text-fg-subtle">{c.does}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
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

function MergeButton({ item, run, big = false }: { item: AgentItem; run: Run; big?: boolean }) {
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
      <button type="button" className={big ? cn(BTN_BIG, "border-sky-600 bg-sky-600 text-white hover:bg-sky-700") : BTN_PRIMARY} disabled={busy} onClick={() => void merge()}>
        {busy ? "Merging…" : "Merge"}
      </button>
      {allowed.length > 1 && (
        <select
          aria-label="Merge method"
          value={method ?? ""}
          onChange={(e) => setMethod(e.target.value as MergeMethod)}
          className={cn("rounded-md border border-line-strong bg-surface px-1.5 text-fg-secondary", big ? "py-1.5 text-sm" : "py-1 text-xs")}
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

/** One line of a comment, without its markdown: enough to know what it says. */
function gist(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What the review wanted to write in threads a colleague opened. A review
 * answers and resolves only in threads you opened, so these stay out of what
 * Approve sends; each links to its thread, where you can answer yourself.
 */
function HeldBack({ held }: { held: HeldWrite[] }) {
  return (
    <div className="mt-2 rounded-md border border-amber-500/50 bg-amber-500/[0.07] p-2 text-xs">
      <div className="font-medium text-amber-800 dark:text-amber-300">Not sent — {held.length === 1 ? "it lands" : "they land"} in a colleague&apos;s thread</div>
      {held.map((h, i) => (
        <div key={h.replyTo ?? h.threadId ?? i} className="mt-1.5">
          <div className="text-fg-subtle">
            {heldLabel(h).replace(/^./, (c) => c.toUpperCase())}
            {h.url && (
              <button type="button" onClick={() => openUrl(h.url!)} className={cn(LINK, "ml-1.5")}>
                open it ↗
              </button>
            )}
          </div>
          {h.body && <div className="mt-0.5 whitespace-pre-wrap text-fg-secondary">{h.body}</div>}
        </div>
      ))}
      <div className="mt-1.5 text-[11px] text-fg-faint">A review answers and resolves only in threads you opened. The rest goes out without these; answer there yourself if it is worth saying.</div>
    </div>
  );
}

/**
 * The threads where the author pushed back on your comment: keep it (the
 * thread stays open) or drop it (a short "fair point" and the thread is
 * resolved) — applied when the review is sent, no new session. Undecided
 * counts as keep: nothing changes that you didn't choose.
 */
function Disputes({ item, plan, run }: { item: AgentItem; plan: PublishSummary; run: Run }) {
  const pick = (replyTo: number, choice: "keep" | "drop") => void run({ type: "dispute", runId: item.runId, replyTo, choice });
  const opt = (on: boolean) =>
    cn("rounded-md border px-2 py-0.5 text-xs font-medium", on ? "border-sky-600 bg-sky-600 text-white" : "border-line-strong bg-surface text-fg-secondary hover:bg-elevated");
  return (
    <div className="mt-2 rounded-md border border-amber-500/50 bg-amber-500/[0.07] p-2 text-xs">
      <div className="font-medium text-amber-800 dark:text-amber-300">The author pushed back</div>
      {plan.escalations.map((e) => {
        const choice = item.disputes?.[String(e.replyTo)] ?? "keep";
        return (
          <div key={e.replyTo} className="mt-1.5">
            <div className="text-fg-secondary">{gist(e.body)}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              <button type="button" aria-pressed={choice === "keep"} className={opt(choice === "keep")} onClick={() => pick(e.replyTo, "keep")}>
                Keep my comment
              </button>
              <button type="button" aria-pressed={choice === "drop"} className={opt(choice === "drop")} onClick={() => pick(e.replyTo, "drop")}>
                Drop it
              </button>
            </div>
          </div>
        );
      })}
      <div className="mt-1.5 text-[11px] text-fg-faint">Applied when you send: a kept thread stays open; a dropped one gets &ldquo;Fair point — I&apos;m dropping this.&rdquo; and is resolved.</div>
    </div>
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
 * A decision on your own PR that only you can make, with the answers the run offers and room for your own.
 * One question: an answer goes at once. Several: pick or write each, then Send.
 * The same session goes on with what you said (`answer`); where the app can't
 * do that (the Jira dry run changes nothing), the question is only shown.
 */
function YourCall({ item, asks, canAnswer, run }: { item: AgentItem; asks: RunAsk[]; canAnswer: boolean; run: Run }) {
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
      <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">{single ? "Your call" : `Your call — ${asks.length} questions`}</div>
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
        {canAnswer
          ? "The same session goes on with your answer and comes back here."
          : item.needsRerun
            ? "This can't be answered any more — the app restarted since. Run it again: the new run asks this again if it still needs to."
            : "Answer it in the session: the dry run changes nothing by itself."}
      </div>
    </div>
  );
}
