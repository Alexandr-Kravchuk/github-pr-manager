import { useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

// Node-free (see AGENTS.md).
import { currentStep, type PlanStep, type RunProgress } from "../../../shared/agent-stream";
import { resultCard } from "../../../shared/agent-result";
import { agentSummary, itemVerb, queueOrder, readyItems, stepLabel } from "../../../shared/agent-view";
import type { AgentItem, AgentRunState } from "../../../shared/types";
import { cn } from "../format";
import { AgentContext } from "./agent-context";

// The agent as a companion: a chip in the header — a ring cut into the steps of
// the current run's plan around the agent's face, a badge with how many
// decisions wait for you, two short lines — and, on a click, a small popover
// hung under it like a native menu: the run, its current step, one live line, a
// field to tell the agent something, pause, and a ⋯ menu for the plan and log,
// taking over and stopping. Nothing animates for long: a new step blinks once
// (`.live-beat`, a finite animation, re-keyed on the step).

function polar(c: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(rad), c + r * Math.sin(rad)];
}

function arc(c: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(c, r, from);
  const [x2, y2] = polar(c, r, to);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

/** A ring cut into one segment per plan step; a run without a plan shows one whole ring. */
function StepRing({ steps, active, paused, size, stroke, children }: { steps: PlanStep[]; active: boolean; paused: boolean; size: number; stroke: number; children?: ReactNode }) {
  const c = size / 2;
  const r = c - stroke / 2 - 0.5;
  const segs: Array<PlanStep["status"]> = steps.length > 0 ? steps.map((s) => s.status) : [active ? "in_progress" : "pending"];
  const total = segs.length;
  const gap = total > 1 ? Math.min(14, 120 / total) : 0;
  const span = 360 / total;
  const currentIdx = segs.indexOf("in_progress");
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="absolute inset-0">
        {total === 1 ? (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            strokeWidth={stroke}
            className={segs[0] === "in_progress" ? (paused ? "stroke-amber-500" : "stroke-sky-500") : segs[0] === "completed" ? "stroke-emerald-500" : "stroke-line-strong"}
          />
        ) : (
          segs.map((status, i) => (
            <path
              key={status === "in_progress" ? `cur-${i}` : i}
              d={arc(c, r, i * span + gap / 2, (i + 1) * span - gap / 2)}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              className={cn(
                status === "completed" && "stroke-emerald-500",
                status === "in_progress" && (paused ? "stroke-amber-500" : "stroke-sky-500 live-beat"),
                status === "pending" && "stroke-line-strong",
                i === currentIdx && "",
              )}
            />
          ))
        )}
      </svg>
      {children}
    </span>
  );
}

function Face({ size, tone }: { size: number; tone: "working" | "paused" | "idle" }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex items-center justify-center", tone === "working" ? "text-sky-600 dark:text-sky-400" : tone === "paused" ? "text-amber-600" : "text-fg-faint")}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 16 16" width={size * 0.62} height={size * 0.62} fill="currentColor">
        <rect x="2.6" y="5.2" width="2.6" height="2.6" rx="1.3" />
        <rect x="10.8" y="5.2" width="2.6" height="2.6" rx="1.3" />
        <rect x="4.6" y="10.6" width="6.8" height="1.4" rx="0.7" />
      </svg>
    </span>
  );
}

function elapsed(since: string | undefined): string {
  if (!since) return "";
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The header chip and its popover. Renders nothing while the agent is off or the chip is switched off. */
export function AgentCompanion({
  open,
  focus,
  onToggle,
  onClose,
  onFocus,
}: {
  open: boolean;
  focus: string | null;
  onToggle: () => void;
  onClose: () => void;
  onFocus: (runId: string) => void;
}) {
  const { state } = useContext(AgentContext);
  const ref = useRef<HTMLButtonElement>(null);
  const [flash, setFlash] = useState<{ n: number; text: string; tone: "ok" | "stop" | "fail" } | null>(null);
  const prevRunning = useRef<string[]>([]);
  // Its own timer: a state push every 250 ms must not keep re-arming it.
  const flashTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
  }, []);

  // A run that just finished flashes its outcome once in the chip.
  useEffect(() => {
    if (!state) return;
    const ids = state.running.map((r) => r.runId);
    const gone = prevRunning.current.filter((id) => !ids.includes(id));
    prevRunning.current = ids;
    const ended = gone.map((id) => state.items.find((i) => i.runId === id)).find(Boolean);
    if (!ended) return;
    const tone = ended.state === "error" ? "fail" : /^(Stopped|Interrupted|You took it over)/.test(ended.headline) ? "stop" : "ok";
    setFlash((f) => ({ n: (f?.n ?? 0) + 1, text: `#${ended.prNumber} ${ended.headline}`, tone }));
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setFlash(null);
    }, 5000);
  }, [state]);

  if (!state?.enabled || !state.headerChip) return null;
  // The same numbers and words the tray and the Board show.
  const sum = agentSummary(state);
  const waiting = sum.readyForYou;
  const first = state.running[0];
  const firstItem = first ? state.items.find((i) => i.runId === first.runId) : undefined;
  const step = first ? currentStep(first.progress) : null;

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label="PR agent"
        className={cn("flex min-w-0 max-w-[22rem] items-center gap-2 rounded-xl py-0.5 pl-0.5 pr-2.5 text-left transition-colors", open ? "bg-elevated" : "hover:bg-elevated/70")}
      >
        <span className="relative">
          <StepRing steps={first?.progress.steps ?? []} active={Boolean(first)} paused={first?.paused ?? false} size={30} stroke={3}>
            <Face size={22} tone={first ? (first.paused ? "paused" : "working") : state.paused ? "paused" : "idle"} />
          </StepRing>
          {waiting > 0 && (
            <span
              title={`${waiting} decision${waiting > 1 ? "s" : ""} wait for you`}
              className="absolute -right-1 -top-1 min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] font-semibold leading-4 text-white ring-2 ring-surface"
            >
              {waiting}
            </span>
          )}
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-xs font-semibold text-fg">
            {firstItem ? `${itemVerb(firstItem)} #${firstItem.prNumber}` : "Agent"}
            {state.running.length > 1 && <span className="font-normal text-fg-subtle"> +{state.running.length - 1}</span>}
          </span>
          {flash ? (
            <span
              key={flash.n}
              className={cn(
                "live-beat block truncate text-[11px]",
                flash.tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : flash.tone === "fail" ? "text-red-700 dark:text-red-300" : "text-fg-muted",
              )}
            >
              {flash.tone === "ok" ? "✓" : flash.tone === "fail" ? "✕" : "■"} {flash.text}
            </span>
          ) : (
            <span className="block truncate text-[11px] text-fg-subtle">
              {first
                ? first.paused
                  ? "Paused"
                  : (step?.subject ?? first.progress.activity ?? "Starting…")
                : state.paused
                  ? "Paused"
                  : sum.queued > 0
                    ? sum.blockText
                      ? `${sum.blockText} · ${sum.queued} queued`
                      : `${sum.queued} queued`
                    : sum.blockText && sum.block !== "daily"
                      ? sum.blockText
                      : waiting > 0
                        ? `${waiting} wait for you`
                        : "Nothing to do"}
            </span>
          )}
        </span>
      </button>
      {open && <CompanionPopover anchor={ref} focus={focus} onClose={onClose} onFocus={onFocus} />}
    </>
  );
}

const POPOVER_W = 360;

function useAnchor(anchor: RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_W - 8)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
    };
  }, [anchor]);
  return pos;
}

function CompanionPopover({ anchor, focus, onClose, onFocus }: { anchor: RefObject<HTMLButtonElement | null>; focus: string | null; onClose: () => void; onFocus: (runId: string) => void }) {
  const { state, act, focusItem } = useContext(AgentContext);
  const [error, setError] = useState<string | null>(null);
  const pos = useAnchor(anchor);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);
  if (!pos || !state) return null;
  const hero = state.running.find((r) => r.runId === focus) ?? state.running[0];
  const heroItem = hero ? state.items.find((i) => i.runId === hero.runId) : undefined;
  const others = state.running.filter((r) => r !== hero);
  // The order the agent runs them in — yours where you set it.
  const queued = queueOrder(state.items.filter((i) => i.state === "queued"));
  const sum = agentSummary(state);
  const waiting = sum.readyForYou;
  // The moves ready for you, oldest first — each one click from its card.
  const waitingItems = readyItems(state.items);
  const go = (runId?: string) => {
    onClose();
    focusItem(runId);
  };

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label="PR agent"
      style={{ position: "fixed", top: pos.top, left: pos.left, width: POPOVER_W }}
      className="z-50 overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_12px_40px_rgb(0_0_0/0.18),0_2px_6px_rgb(0_0_0/0.08)]"
    >
      {hero && heroItem ? (
        <HeroRun run={hero} item={heroItem} />
      ) : (
        <div className="flex items-center gap-3 px-4 py-4">
          <StepRing steps={[]} active={false} paused={state.paused} size={56} stroke={4}>
            <Face size={40} tone={state.paused ? "paused" : "idle"} />
          </StepRing>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-fg">{state.paused ? "Paused" : "Nothing running"}</div>
            <div className="text-xs text-fg-subtle">
              {sum.block === "paused"
                ? "Nothing starts until you resume it."
                : sum.block === "quiet"
                  ? `${sum.blockText} — only what you ask for starts.`
                  : sum.block === "usage"
                    ? `Claude's ${sum.blockText?.toLowerCase()}.`
                    : sum.block === "daily"
                      ? `${sum.blockText} — ${sum.queued > 0 ? `${sum.queued} queued wait` : "new runs wait"} until tomorrow.`
                      : sum.queued > 0
                        ? "The next one starts in a moment."
                        : "It starts on its own when a PR needs it."}
            </div>
          </div>
        </div>
      )}

      {(others.length > 0 || queued.length > 0) && (
        <div className="border-t border-line px-3 py-2">
          {others.map((r) => {
            const it = state.items.find((i) => i.runId === r.runId);
            return (
              <button key={r.runId} type="button" onClick={() => onFocus(r.runId)} className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-xs hover:bg-elevated/70">
                <StepRing steps={r.progress.steps} active paused={r.paused} size={18} stroke={2.5} />
                <span className="shrink-0 font-medium text-fg-secondary">#{it?.prNumber}</span>
                <span className="min-w-0 flex-1 truncate text-fg-subtle">{currentStep(r.progress)?.subject ?? r.progress.activity ?? it?.headline}</span>
              </button>
            );
          })}
          {queued.length > 0 && <div className="px-1 py-1 text-[11px] text-fg-subtle">Next: {queued.map((i) => `#${i.prNumber}`).join(", ")}</div>}
        </div>
      )}

      {waiting > 0 && (
        <div className="border-t border-line bg-amber-500/[0.06] px-3 py-2 text-xs">
          <div className="flex items-center gap-2 px-1">
            <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
            <span className="text-fg-secondary">
              {waiting} decision{waiting > 1 ? "s" : ""} wait for you
            </span>
            <span className="flex-1" />
            <button type="button" onClick={() => go(waitingItems[0]?.runId)} className="text-sky-700 hover:underline dark:text-sky-300">
              Open the Board
            </button>
          </div>
          {waitingItems.slice(0, 3).map((it) => {
            const card = resultCard(it);
            return (
              <button
                key={it.runId}
                type="button"
                onClick={() => go(it.runId)}
                className="mt-1 flex w-full items-baseline gap-2 rounded-md px-1 py-0.5 text-left hover:bg-amber-500/10"
              >
                <span className="shrink-0 font-medium text-fg-secondary">#{it.prNumber}</span>
                <span className="min-w-0 flex-1 truncate text-fg-subtle">{card?.asks[0]?.question ?? card?.summary ?? it.headline}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* The emergency stop: everything holds, nothing goes out on its own. */}
      <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-xs">
        <span className={cn("min-w-0 flex-1 truncate", error ? "text-red-700 dark:text-red-300" : state.paused ? "text-amber-700 dark:text-amber-300" : "text-fg-subtle")} role={error ? "alert" : undefined}>
          {error ??
            (state.paused
              ? "Paused — nothing starts or goes out"
              : state.quietUntil
                ? `Quiet hours until ${state.quietUntil}`
                : `Runs today ${state.runsToday} of ${state.perDay}`)}
        </span>
        <button
          type="button"
          onClick={() =>
            void act({ type: state.paused ? "resumeAgent" : "pauseAgent" }).then((res) => setError(res.ok ? null : res.error))
          }
          className="shrink-0 rounded-md border border-line-strong px-2 py-0.5 font-medium text-fg-secondary hover:bg-elevated"
        >
          {state.paused ? "Resume agent" : "Pause agent"}
        </button>
      </div>
    </div>,
    document.body,
  );
}

function HeroRun({ run, item }: { run: AgentRunState; item: AgentItem }) {
  const { act } = useContext(AgentContext);
  const progress: RunProgress = run.progress;
  const step = currentStep(progress);
  const stepIdx = step ? progress.steps.indexOf(step) : -1;
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const [hint, setHint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!hint.trim()) {
      setError("Write something first.");
      return;
    }
    const res = await act({ type: "hint", runId: run.runId, text: hint.trim() });
    if (res.ok) setHint("");
    setError(res.ok ? null : res.error);
  };
  const call = async (type: "pause" | "resume" | "stop" | "takeOver") => {
    setMenu(false);
    const res = await act({ type, runId: run.runId });
    setError(res.ok ? null : res.error);
  };

  return (
    <div>
      <div className="flex gap-3 px-4 pb-3 pt-4">
        <StepRing steps={progress.steps} active paused={run.paused} size={60} stroke={4.5}>
          <span className="flex flex-col items-center leading-none">
            <Face size={26} tone={run.paused ? "paused" : "working"} />
            {progress.steps.length > 0 && (
              <span className="mt-0.5 text-[10px] font-semibold tabular-nums text-fg-muted">
                {stepLabel(progress.steps)}
              </span>
            )}
          </span>
        </StepRing>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-[11px] text-fg-subtle">
            <span className="truncate">
              {item.repo.split("/")[1] ?? item.repo} #{item.prNumber}
            </span>
            <span className="flex-1" />
            <span className="tabular-nums">{run.paused ? "paused" : elapsed(item.startedAt)}</span>
          </div>
          <div className="truncate text-sm font-semibold text-fg" title={item.title}>
            {item.title}
          </div>
          <div key={stepIdx} className="live-beat mt-1 truncate text-xs font-medium text-sky-700 dark:text-sky-300">
            {run.paused ? "Paused" : (step?.subject ?? item.headline)}
          </div>
          {progress.activity && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle" title={progress.activity}>
              {progress.activity}
            </div>
          )}
        </div>
      </div>

      <form onSubmit={(e) => void send(e)} className="flex items-center gap-1.5 px-3 pb-3">
        <input
          value={hint}
          onChange={(e) => {
            setHint(e.target.value);
            setError(null);
          }}
          placeholder={`Tell the agent about #${item.prNumber}…`}
          aria-invalid={error !== null}
          className={cn(
            "min-w-0 flex-1 rounded-full border bg-elevated/50 px-3 py-1.5 text-xs text-fg placeholder:text-fg-faint focus:bg-surface focus:outline-none",
            error ? "border-red-500" : "border-transparent focus:border-sky-600",
          )}
        />
        <IconButton label={run.paused ? "Resume" : "Pause"} onClick={() => void call(run.paused ? "resume" : "pause")}>
          {run.paused ? "▶" : "❚❚"}
        </IconButton>
        <span className="relative">
          <IconButton label="More" onClick={() => setMenu((v) => !v)}>
            ⋯
          </IconButton>
          {menu && (
            <div className="absolute right-0 top-8 z-10 w-48 overflow-hidden rounded-xl border border-line bg-surface py-1 text-xs shadow-lg">
              <MenuItem
                onClick={() => {
                  setDetails((v) => !v);
                  setMenu(false);
                }}
              >
                {details ? "Hide plan and log" : "Show plan and log"}
              </MenuItem>
              <MenuItem onClick={() => void call("takeOver")}>Take over in terminal</MenuItem>
              <MenuItem danger onClick={() => void call("stop")}>
                Stop this run
              </MenuItem>
            </div>
          )}
        </span>
      </form>
      {error && <div className="-mt-2 px-5 pb-2 text-[11px] text-red-700 dark:text-red-300">{error}</div>}

      {details && (
        <div className="border-t border-line px-4 py-3">
          {progress.steps.length > 0 ? (
            <ol className="relative ml-1.5 space-y-1.5 border-l border-line-strong pl-4">
              {progress.steps.map((s) => (
                <li key={s.id} className="relative text-xs">
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -left-[1.3rem] top-0.5 size-2.5 rounded-full ring-2 ring-surface",
                      s.status === "completed" ? "bg-emerald-500" : s.status === "in_progress" ? "bg-sky-500" : "bg-line-strong",
                    )}
                  />
                  <span className={cn(s.status === "in_progress" ? "font-semibold text-fg" : s.status === "completed" ? "text-fg-muted" : "text-fg-faint")}>{s.subject}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="text-xs text-fg-subtle">This run keeps no plan; its steps are below.</div>
          )}
          {run.recent.length > 0 && (
            <div className="mt-3 max-h-40 space-y-0.5 overflow-y-auto font-mono text-[10.5px] text-fg-subtle">
              {run.recent.map((e, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 tabular-nums text-fg-faint">{new Date(e.at).toTimeString().slice(0, 5)}</span>
                  <span className="min-w-0 truncate" title={e.text}>
                    {e.text}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 font-mono text-[10px] text-fg-faint">session {item.sessionId}</div>
        </div>
      )}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] text-fg-muted hover:bg-elevated hover:text-fg">
      {children}
    </button>
  );
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn("block w-full px-3 py-1.5 text-left hover:bg-elevated", danger ? "text-red-700 dark:text-red-300" : "text-fg-secondary")}>
      {children}
    </button>
  );
}
