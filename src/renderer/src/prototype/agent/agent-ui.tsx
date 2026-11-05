/**
 * PROTOTYPE — throwaway, see AgentPrototype.tsx. Small pieces every layout
 * draws the same way (a state dot, the action buttons, the card status line),
 * so the variants differ in structure, not in how a button looks.
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

import type { PullRequest } from "../../../../shared/types";
import { cn } from "../../format";
import { SCENARIO_LABEL, STATE_LABEL, type AgentItem, type AgentProto, type AgentRow, type AgentState } from "./agent-model";
import { liveLine } from "./agent-runs";

/** PrCard renders this under the card when a prototype provides it. */
export const AgentSlotContext = createContext<((pr: PullRequest) => ReactNode) | null>(null);

/** Opens the agent's side panel, scrolled to one PR's run when given. */
export const CompanionContext = createContext<(prNumber?: number) => void>(() => {});

export const STATE_DOT: Record<AgentState, string> = {
  queued: "bg-zinc-400 dark:bg-zinc-500",
  working: "bg-sky-500",
  needsYou: "bg-amber-500",
  done: "bg-emerald-500",
  error: "bg-red-500",
};

export const STATE_TEXT: Record<AgentState, string> = {
  queued: "text-fg-subtle",
  working: "text-sky-700 dark:text-sky-300",
  needsYou: "text-amber-700 dark:text-amber-300",
  done: "text-emerald-700 dark:text-emerald-300",
  error: "text-red-700 dark:text-red-300",
};

const SCENARIO_GLYPH: Record<AgentItem["scenario"], string> = {
  review: "◎",
  brief: "☰",
  rereview: "↺",
  merge: "⑂",
  drive: "▲",
};

export function StateDot({ state, className }: { state: AgentState; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", STATE_DOT[state], className)} />;
}

export function ScenarioGlyph({ item, className }: { item: AgentItem; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-sm",
        item.state === "error"
          ? "bg-red-500/15 text-red-700 dark:text-red-300"
          : item.scenario === "merge"
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : item.shadow
              ? "bg-elevated text-fg-muted"
              : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      {SCENARIO_GLYPH[item.scenario]}
    </span>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded border border-line-strong px-1.5 py-px text-[11px] text-fg-muted", className)}>
      {children}
    </span>
  );
}

export function ScenarioChip({ item }: { item: AgentItem }) {
  return (
    <>
      <Chip>{SCENARIO_LABEL[item.scenario]}</Chip>
      {item.shadow && <Chip className="border-dashed">shadow</Chip>}
    </>
  );
}

// `cn` is a plain join, so a tone must not sit next to the neutral fill: on
// stylesheet order `bg-surface` would win and leave white text on white.
const BTN_BASE = "inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium";
export const BTN = `${BTN_BASE} border-line-strong bg-surface text-fg-secondary hover:bg-elevated`;
const TONE = {
  primary: `${BTN_BASE} border-sky-600 bg-sky-600 text-white hover:bg-sky-700 dark:border-sky-500`,
  merge: `${BTN_BASE} border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 dark:border-emerald-500`,
};
function btn(tone?: keyof typeof TONE): string {
  return tone ? TONE[tone] : BTN;
}

/** The item's actions; `onLater` adds a Later button for anything that asks you. */
export function ActionButtons({
  row,
  agent,
  onLater,
  size = "sm",
  showKeys = false,
}: {
  row: AgentRow;
  agent: AgentProto;
  onLater?: () => void;
  size?: "sm" | "lg";
  showKeys?: boolean;
}) {
  const { item } = row;
  const big = size === "lg" ? "px-3.5 py-1.5 text-sm" : "";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {item.actions.map((a, i) => (
        <button
          key={a.id}
          type="button"
          title={a.result || a.next ? undefined : "Prototype: would open it"}
          onClick={(e) => {
            e.stopPropagation();
            agent.take(item.prNumber, a.id);
          }}
          className={cn(btn(a.tone), big)}
        >
          {a.label}
          {showKeys && i === 0 && <Kbd>↵</Kbd>}
        </button>
      ))}
      {onLater && (item.state === "needsYou" || item.state === "error") && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onLater();
          }}
          className={cn(BTN, big)}
        >
          Later
          {showKeys && <Kbd>L</Kbd>}
        </button>
      )}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="ml-1 rounded border border-current/30 px-1 font-mono text-[10px] leading-4 opacity-80">{children}</kbd>
  );
}

/** The exact action, in mono — what a click will really do. */
export function Resolved({ item }: { item: AgentItem }) {
  if (!item.resolved) return null;
  return <div className="mt-1 font-mono text-[11px] text-fg-subtle">{item.resolved}</div>;
}

export function Detail({ item, numbered }: { item: AgentItem; numbered?: boolean }) {
  if (!item.detail?.length) return null;
  return (
    <ul
      className={cn(
        "mt-2 space-y-0.5 border-l-2 pl-2.5 text-xs text-fg-muted",
        item.scenario === "brief" ? "border-amber-500/60" : "border-line-strong",
      )}
    >
      {item.detail.map((d, i) => (
        <li key={i}>
          {numbered ? `${i + 1}. ` : "· "}
          {d}
        </li>
      ))}
    </ul>
  );
}

export function prLabel(pr: PullRequest): string {
  return `${pr.repo.split("/")[1] ?? pr.repo} #${pr.number}`;
}

/** One line at the bottom of a PR card: what the agent is doing with it. */
export function AgentStatusLine({ item, agent, pr }: { item: AgentItem; agent: AgentProto; pr: PullRequest }) {
  const first = item.actions[0];
  const openCompanion = useContext(CompanionContext);
  const live = item.state === "working" && item.run;
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-line pt-2 text-xs">
      <StateDot state={item.state} />
      <span className={cn("shrink-0 font-medium", STATE_TEXT[item.state])}>
        {item.shadow ? "Would act" : STATE_LABEL[item.state]}
      </span>
      {live && item.run ? (
        <span className="min-w-0 flex-1 truncate text-fg-muted" title={liveLine(item.run)}>
          {item.run.steps[item.run.stepIdx]?.label}
          <span className="tabular-nums text-fg-subtle">
            {" "}
            ({item.run.stepIdx + 1}/{item.run.steps.length})
          </span>
          <span className="font-mono text-[11px] text-fg-subtle"> · {liveLine(item.run)}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-fg-muted" title={item.headline}>
          {item.headline}
          {item.meta && <span className="text-fg-subtle"> · {item.meta}</span>}
        </span>
      )}
      {live && (
        <button type="button" onClick={() => openCompanion(pr.number)} className={cn(BTN, "py-0.5")}>
          Watch
        </button>
      )}
      {!live && first && (
        <button
          type="button"
          onClick={() => agent.take(pr.number, first.id)}
          className={cn(btn(first.tone), "py-0.5")}
        >
          {first.label}
        </button>
      )}
    </div>
  );
}

export function ActivityList({ agent, prNumber }: { agent: AgentProto; prNumber?: number }) {
  const entries = prNumber === undefined ? agent.activity : agent.activity.filter((e) => e.prNumber === prNumber);
  if (entries.length === 0) return <div className="text-xs text-fg-subtle">No agent activity yet.</div>;
  return (
    <ol className="space-y-1">
      {entries.map((e) => (
        <li key={e.id} className="flex gap-2 text-xs">
          <span className="w-10 shrink-0 tabular-nums text-fg-subtle">{e.at}</span>
          {prNumber === undefined && <span className="w-10 shrink-0 tabular-nums text-fg-subtle">#{e.prNumber}</span>}
          <span className={e.byYou ? "text-fg" : "text-fg-muted"}>
            {e.byYou && <span className="font-medium">You · </span>}
            {e.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Single-key shortcuts for a list, off while typing in a field. */
export function useKeys(map: Record<string, () => void>) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable='true']") || t.isContentEditable)) return;
      const fn = ref.current[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export interface VariantProps {
  agent: AgentProto;
  prs: PullRequest[];
  renderList: (prs: PullRequest[]) => ReactNode;
  /** Variant E: the header's view switch has the Board segment on. */
  boardView?: boolean;
}
