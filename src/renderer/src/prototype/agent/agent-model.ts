/**
 * PROTOTYPE — throwaway, see AgentPrototype.tsx. The agent's state shared by
 * the layouts: one fixed set of runs keyed to the `?buddy=agent` dev-mock PRs,
 * held in memory, with runs that really move — a timer walks each one through
 * its scripted plan (agent-runs.ts) so the companion has something live to
 * show. Nothing here reaches main, GitHub or Claude.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PullRequest } from "../../../../shared/types";
import { advanceRun, logEntry, startRun, type Run } from "./agent-runs";

export type AgentState = "queued" | "working" | "needsYou" | "done" | "error";
export type Scenario = "review" | "brief" | "rereview" | "merge" | "drive";

export interface AgentAction {
  id: string;
  label: string;
  tone?: "primary" | "merge";
  /** The activity line once you take it; the item is then done. */
  result?: string;
  /** Moves the item to another state instead of finishing it. */
  next?: Partial<Pick<AgentItem, "state" | "headline" | "meta" | "actions">>;
}

export interface AgentItem {
  prNumber: number;
  scenario: Scenario;
  state: AgentState;
  /** The agent would do this but waits for you (the scenario is in shadow mode). */
  shadow?: boolean;
  /** Why the agent stopped, or what it is doing — one line. */
  headline: string;
  /** The exact thing the primary action does. */
  resolved?: string;
  /** Decisions for you (brief) or evidence (judge). */
  detail?: string[];
  meta?: string;
  actions: AgentAction[];
  snoozed?: boolean;
  /** The live run behind a `working` item (kept after it finishes, for its log). */
  run?: Run;
  /** How far the seeded runs already are when the page opens. */
  seed?: { stepIdx: number; actIdx: number; ageMs: number };
}

export interface ActivityEntry {
  id: number;
  at: string;
  prNumber: number;
  text: string;
  byYou?: boolean;
}

export interface AgentRow {
  item: AgentItem;
  pr: PullRequest;
}

export const SCENARIO_LABEL: Record<Scenario, string> = {
  review: "Review",
  brief: "Big PR brief",
  rereview: "Re-review",
  merge: "Merge",
  drive: "Drive to green",
};

export const STATE_LABEL: Record<AgentState, string> = {
  queued: "Queued",
  working: "Working",
  needsYou: "Needs you",
  done: "Done",
  error: "Error",
};

/** What a running item says it is doing — the verb the companion chip leads with. */
export const WORKING_HEADLINE: Record<Scenario, string> = {
  review: "Reviewing with /creatio-code-review",
  drive: "Driving to green",
  merge: "Re-checking the merge conditions",
  rereview: "Judging the author's replies",
  brief: "Writing a brief with your explain prompt",
};

export const PARALLEL_LIMIT = 2;
const TICK_MS = 1800;

const INITIAL_ITEMS: AgentItem[] = [
  {
    prNumber: 911,
    scenario: "review",
    state: "working",
    headline: WORKING_HEADLINE.review,
    seed: { stepIdx: 3, actIdx: 1, ageMs: 3 * 60_000 },
    actions: [],
  },
  {
    prNumber: 142,
    scenario: "drive",
    state: "working",
    headline: WORKING_HEADLINE.drive,
    meta: "attempt 1 of 2",
    seed: { stepIdx: 2, actIdx: 0, ageMs: 6 * 60_000 },
    actions: [],
  },
  {
    prNumber: 88,
    scenario: "review",
    state: "queued",
    headline: "Starts when a slot frees (2 runs at a time)",
    actions: [],
  },
  {
    prNumber: 44,
    scenario: "review",
    state: "done",
    headline: "Review posted: no findings, approved",
    meta: "14:02",
    actions: [{ id: "continue", label: "Continue in session" }],
  },
  {
    prNumber: 118,
    scenario: "review",
    state: "error",
    headline: "No checkout of acme/clio-knowledge in C:\\Projects",
    resolved: "set the folder → queue the review again",
    actions: [
      {
        id: "folder",
        label: "Set folder",
        tone: "primary",
        next: { state: "queued", headline: "Review queued after the folder was set", actions: [] },
      },
      { id: "skip", label: "Skip this repo", result: "Skipped: acme/clio-knowledge left to you" },
    ],
  },
  {
    prNumber: 137,
    scenario: "merge",
    state: "needsYou",
    headline: "Ready to merge: 1 approval, CI green, 0 open threads",
    resolved: "squash into main @ a1b2c3d → delete branch → Jira dry run",
    actions: [
      { id: "squash", label: "Squash and merge", tone: "merge", result: "You merged #137 (squash); Jira dry run queued" },
      { id: "merge", label: "Merge commit", result: "You merged #137 (merge commit); Jira dry run queued" },
    ],
  },
  {
    prNumber: 139,
    scenario: "drive",
    state: "needsYou",
    headline: "1 review comment the agent won't change on its own",
    resolved: "post the drafted reply in «Use CSS-only theming»",
    detail: [
      "/validate-and-fix-review-comments: 2 confirmed and fixed in 3f2a1c9, 1 rejected",
      "Draft: «The theme must survive a reload; CSS alone can't persist the choice, so the setting stays in localStorage.»",
    ],
    actions: [
      { id: "post", label: "Post reply", tone: "primary", result: "You posted the reply on #139" },
      { id: "thread", label: "Open thread" },
    ],
  },
  {
    prNumber: 929,
    scenario: "rereview",
    state: "needsYou",
    shadow: true,
    headline: "Author says «fixed» in 1 of 3 threads, but head e4f5a6b still drops the prefix",
    resolved: "SchemaColumn.cs:142 → reply in «Keep the static prefix»; resolve the other 2",
    detail: [
      "«Keep the static prefix» — claims fixed, isn't: reply with the line",
      "«Null check on rename» — fixed in e4f5a6b: resolve",
      "«Naming» — author disagrees, the judge is convinced: resolve",
    ],
    actions: [
      { id: "post", label: "Post reply and resolve", tone: "primary", result: "Agent replied on 1 thread and resolved 2 (#929)" },
      { id: "edit", label: "Edit first" },
    ],
  },
  {
    prNumber: 912,
    scenario: "brief",
    state: "needsYou",
    headline: "Too big for auto-review: 1 240 lines, 31 files · 3 decisions for you",
    detail: [
      "Чи прийнятний ретрай без ліміту часу на всю операцію?",
      "Змінено публічний контракт sync-schemas — це погоджено?",
      "Чи потрібен feature toggle для нового retry-бюджету?",
    ],
    actions: [
      {
        id: "review",
        label: "Review anyway",
        tone: "primary",
        next: { state: "working", headline: WORKING_HEADLINE.review, meta: undefined, actions: [] },
      },
      { id: "brief", label: "Full brief" },
    ],
  },
];

const INITIAL_ACTIVITY: ActivityEntry[] = [
  { id: 6, at: "14:02", prNumber: 44, text: "Review posted: no findings, approved" },
  { id: 5, at: "13:48", prNumber: 139, text: "Drive: fixed 2 comments, pushed 3f2a1c9" },
  { id: 4, at: "13:40", prNumber: 929, text: "Judge checked 3 author replies (shadow)" },
  { id: 3, at: "13:15", prNumber: 912, text: "Brief written with your explain prompt" },
  { id: 2, at: "12:55", prNumber: 118, text: "Failed: no checkout found" },
  { id: 1, at: "12:30", prNumber: 137, text: "Merge conditions met, waiting for you" },
];

/** Needs-you order: what blocks the agent first, quick wins next, long reads last. */
const NEEDS_RANK: Record<Scenario, number> = { merge: 1, drive: 2, rereview: 3, brief: 4, review: 5 };

function now(): string {
  return new Date().toTimeString().slice(0, 5);
}

export type AgentMode = "on" | "shadow" | "paused";

export interface AgentEvent {
  n: number;
  prNumber: number;
  text: string;
}

export interface AgentProto {
  byNumber: Map<number, AgentItem>;
  prByNumber: Map<number, PullRequest>;
  needsYou: AgentRow[];
  snoozed: AgentRow[];
  working: AgentRow[];
  queued: AgentRow[];
  done: AgentRow[];
  idle: PullRequest[];
  activity: ActivityEntry[];
  /** The last run that finished — what the header chip flashes. */
  lastEvent: AgentEvent | null;
  shadowAccepted: number;
  shadowPromoted: boolean;
  mode: AgentMode;
  setMode: (m: AgentMode) => void;
  take: (prNumber: number, actionId: string) => void;
  later: (prNumber: number) => void;
  /** Hands a PR the agent wasn't working on to it — the Board's drag from Idle. */
  enqueue: (pr: PullRequest) => void;
  pauseRun: (prNumber: number) => void;
  stopRun: (prNumber: number) => void;
  takeOver: (prNumber: number) => void;
  hint: (prNumber: number, text: string) => void;
  unsnoozeAll: () => void;
  promoteShadow: () => void;
}

/** The agent state over the PRs currently on screen — filters still apply. */
export function useAgentProto(prs: PullRequest[]): AgentProto {
  const prsRef = useRef(prs);
  prsRef.current = prs;
  const findPr = (n: number) => prsRef.current.find((p) => p.number === n);

  const [items, setItems] = useState<AgentItem[]>(() =>
    INITIAL_ITEMS.map((i) => (i.state === "working" ? { ...i, run: startRun(i.scenario, findPr(i.prNumber), i.seed) } : i)),
  );
  const [activity, setActivity] = useState<ActivityEntry[]>(INITIAL_ACTIVITY);
  const [lastEvent, setLastEvent] = useState<AgentEvent | null>(null);
  const [shadowAccepted, setShadowAccepted] = useState(11);
  const [shadowPromoted, setShadowPromoted] = useState(false);
  const [mode, setMode] = useState<AgentMode>("on");
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const feed = useCallback((prNumber: number, text: string, byYou = false) => {
    setActivity((cur) => [{ id: Date.now() + Math.random(), at: now(), prNumber, text, byYou }, ...cur]);
  }, []);

  const patch = useCallback((prNumber: number, fn: (i: AgentItem) => AgentItem) => {
    setItems((cur) => cur.map((i) => (i.prNumber === prNumber ? fn(i) : i)));
  }, []);

  // The clock that moves the runs. Only while something can move, so an idle
  // agent costs nothing; it is a state update, not a CSS animation.
  const canMove = mode !== "paused" && items.some((i) => (i.state === "working" && !i.run?.paused) || i.state === "queued");
  useEffect(() => {
    if (!canMove) return;
    const id = window.setInterval(() => {
      const finished: AgentItem[] = [];
      const started: AgentItem[] = [];
      let next = itemsRef.current.map((i): AgentItem => {
        if (i.state !== "working") return i;
        if (!i.run) return { ...i, run: startRun(i.scenario, findPr(i.prNumber)) };
        if (i.run.paused) return i;
        const { run, done } = advanceRun(i.run);
        if (!done) return { ...i, run };
        const out: AgentItem = {
          ...i,
          ...run.outcome,
          run: { ...run, log: [...run.log, logEntry("result", run.outcome.headline, run.steps.length - 1)] },
          meta: now(),
          snoozed: false,
        };
        finished.push(out);
        return out;
      });
      let busy = next.filter((i) => i.state === "working").length;
      next = next.map((i): AgentItem => {
        if (i.state !== "queued" || busy >= PARALLEL_LIMIT) return i;
        busy++;
        const s: AgentItem = {
          ...i,
          state: "working",
          headline: WORKING_HEADLINE[i.scenario],
          meta: undefined,
          run: startRun(i.scenario, findPr(i.prNumber)),
        };
        started.push(s);
        return s;
      });
      itemsRef.current = next;
      setItems(next);
      for (const f of finished) feed(f.prNumber, f.headline);
      for (const s of started) feed(s.prNumber, `Started: ${s.headline}`);
      const last = finished[finished.length - 1];
      if (last) setLastEvent((e) => ({ n: (e?.n ?? 0) + 1, prNumber: last.prNumber, text: last.headline }));
    }, TICK_MS);
    return () => window.clearInterval(id);
    // findPr reads a ref; feed is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canMove, feed]);

  const take = useCallback(
    (prNumber: number, actionId: string) => {
      const item = itemsRef.current.find((i) => i.prNumber === prNumber);
      if (!item) return;
      if (actionId === "resume") {
        patch(prNumber, (i) => ({
          ...i,
          state: "working",
          headline: WORKING_HEADLINE[i.scenario],
          actions: [],
          run: i.run && { ...i.run, paused: false, log: [...i.run.log, logEntry("you", "Resumed", i.run.stepIdx)] },
        }));
        feed(prNumber, "Resumed the run", true);
        return;
      }
      if (actionId === "takeover") {
        takeOverImpl(prNumber);
        return;
      }
      const action = item.actions.find((a) => a.id === actionId);
      if (!action || (!action.result && !action.next)) return;
      patch(prNumber, (i) =>
        action.next
          ? { ...i, ...action.next, resolved: undefined, detail: undefined, shadow: false, snoozed: false, run: undefined }
          : {
              ...i,
              state: "done",
              headline: action.result ?? i.headline,
              meta: now(),
              resolved: undefined,
              detail: undefined,
              shadow: false,
              snoozed: false,
              actions: [],
            },
      );
      feed(prNumber, action.result ?? `${action.label}: ${action.next?.headline ?? ""}`, true);
      if (item.shadow) setShadowAccepted((n) => n + 1);
    },
    // takeOverImpl only touches stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch, feed],
  );

  function takeOverImpl(prNumber: number) {
    const sid = itemsRef.current.find((i) => i.prNumber === prNumber)?.run?.sessionId ?? "…";
    patch(prNumber, (i) => ({
      ...i,
      state: "done",
      headline: "You took over in the terminal",
      meta: now(),
      actions: [],
      run: i.run && {
        ...i.run,
        paused: true,
        log: [...i.run.log, logEntry("result", `Stopped; would open \`claude --resume ${sid}\` in your terminal`, i.run.stepIdx)],
      },
    }));
    feed(prNumber, "You took over the session in the terminal", true);
  }

  const takeOver = useCallback((prNumber: number) => takeOverImpl(prNumber),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch, feed]);

  const pauseRun = useCallback(
    (prNumber: number) => {
      patch(prNumber, (i) =>
        i.run
          ? { ...i, run: { ...i.run, paused: !i.run.paused, log: [...i.run.log, logEntry("you", i.run.paused ? "Resumed" : "Paused", i.run.stepIdx)] } }
          : i,
      );
    },
    [patch],
  );

  const stopRun = useCallback(
    (prNumber: number) => {
      patch(prNumber, (i) => {
        if (!i.run) return i;
        const step = i.run.steps[i.run.stepIdx]?.label ?? "the last step";
        return {
          ...i,
          state: "needsYou",
          headline: `Stopped by you at «${step}»`,
          actions: [
            { id: "resume", label: "Resume", tone: "primary" },
            { id: "takeover", label: "Take over in terminal" },
          ],
          run: { ...i.run, paused: true, log: [...i.run.log, logEntry("you", "Stopped", i.run.stepIdx)] },
        };
      });
      feed(prNumber, "Stopped the run", true);
    },
    [patch, feed],
  );

  const hint = useCallback(
    (prNumber: number, text: string) => {
      patch(prNumber, (i) => {
        if (!i.run) return i;
        const step = i.run.steps[i.run.stepIdx]?.label ?? "the rest of the run";
        return {
          ...i,
          run: {
            ...i.run,
            log: [...i.run.log, logEntry("you", text, i.run.stepIdx), logEntry("think", `Noted — I'll take that into «${step}»`, i.run.stepIdx)],
          },
        };
      });
      feed(prNumber, `Hint: ${text}`, true);
    },
    [patch, feed],
  );

  const later = useCallback((prNumber: number) => patch(prNumber, (i) => ({ ...i, snoozed: true })), [patch]);

  const enqueue = useCallback(
    (pr: PullRequest) => {
      const scenario: Scenario = pr.roles.includes("author")
        ? pr.canBeMerged
          ? "merge"
          : "drive"
        : pr.returnedToMe || pr.myReReviewDue
          ? "rereview"
          : "review";
      setItems((cur) =>
        cur.some((i) => i.prNumber === pr.number)
          ? cur
          : [...cur, { prNumber: pr.number, scenario, state: "queued", headline: `Queued by you: ${SCENARIO_LABEL[scenario]}`, actions: [] }],
      );
      feed(pr.number, `Handed to the agent: ${SCENARIO_LABEL[scenario]}`, true);
    },
    [feed],
  );

  const unsnoozeAll = useCallback(() => setItems((cur) => cur.map((i) => ({ ...i, snoozed: false }))), []);
  const promoteShadow = useCallback(() => setShadowPromoted(true), []);

  return useMemo(() => {
    const byNumber = new Map(items.map((i) => [i.prNumber, i]));
    const prByNumber = new Map(prs.map((p) => [p.number, p]));
    const rows: AgentRow[] = [];
    const idle: PullRequest[] = [];
    for (const pr of prs) {
      const item = byNumber.get(pr.number);
      if (item) rows.push({ item, pr });
      else idle.push(pr);
    }
    const asksYou = (r: AgentRow) => r.item.state === "needsYou" || r.item.state === "error";
    const rank = (r: AgentRow) => (r.item.state === "error" ? 0 : NEEDS_RANK[r.item.scenario]);
    const open = rows.filter(asksYou).sort((a, b) => rank(a) - rank(b));
    return {
      byNumber,
      prByNumber,
      needsYou: open.filter((r) => !r.item.snoozed),
      snoozed: open.filter((r) => r.item.snoozed),
      working: rows.filter((r) => r.item.state === "working"),
      queued: rows.filter((r) => r.item.state === "queued"),
      done: rows.filter((r) => r.item.state === "done"),
      idle,
      activity,
      lastEvent,
      shadowAccepted,
      shadowPromoted,
      mode,
      setMode,
      take,
      later,
      enqueue,
      pauseRun,
      stopRun,
      takeOver,
      hint,
      unsnoozeAll,
      promoteShadow,
    };
  }, [
    items,
    prs,
    activity,
    lastEvent,
    shadowAccepted,
    shadowPromoted,
    mode,
    take,
    later,
    enqueue,
    pauseRun,
    stopRun,
    takeOver,
    hint,
    unsnoozeAll,
    promoteShadow,
  ]);
}
