/**
 * PROTOTYPE — throwaway, see AgentPrototype.tsx. The agent as a light,
 * native companion:
 *  - in the header, a segmented progress ring around the agent's face — one
 *    segment per step of its plan (the stage-cycle diagram, reduced to a
 *    glyph) — and two short lines: what it is doing, and the current step;
 *  - on click, a small popover hung under it, like a native menu: the run as a
 *    big ring, the step in plain words, one live line, a field to tell the
 *    agent something, and two controls. The plan and the log stay folded.
 * Nothing animates for long: the step that just started blinks once.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { cn } from "../../format";
import type { AgentEvent, AgentProto, AgentRow, Scenario } from "./agent-model";
import { elapsed, liveLine, type Run } from "./agent-runs";
import { prLabel } from "./agent-ui";

const VERB: Record<Scenario, string> = {
  review: "Reviewing",
  drive: "Fixing",
  merge: "Checking",
  rereview: "Re-checking",
  brief: "Briefing",
};

/** The point on a circle at `deg` degrees, 0 being 12 o'clock. */
function polar(c: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(rad), c + r * Math.sin(rad)];
}

function arc(c: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(c, r, from);
  const [x2, y2] = polar(c, r, to);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

/** A ring cut into one segment per plan step: done green, current blue (amber when paused), rest grey. */
export function StepRing({
  run,
  size,
  stroke,
  children,
}: {
  run: Run | undefined;
  size: number;
  stroke: number;
  children?: ReactNode;
}) {
  const total = run?.steps.length ?? 1;
  const c = size / 2;
  const r = c - stroke / 2 - 0.5;
  const gap = total > 1 ? Math.min(14, 120 / total) : 0;
  const span = 360 / total;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="absolute inset-0">
        {total === 1 && !run ? (
          <circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} className="stroke-line-strong" />
        ) : (
          Array.from({ length: total }, (_, i) => {
            const state = !run ? "pending" : i < run.stepIdx ? "done" : i === run.stepIdx ? "current" : "pending";
            return (
              <path
                key={state === "current" ? `cur-${i}` : i}
                d={arc(c, r, i * span + gap / 2, (i + 1) * span - gap / 2)}
                fill="none"
                strokeWidth={stroke}
                strokeLinecap="round"
                className={cn(
                  state === "done" && "stroke-emerald-500",
                  state === "current" && (run?.paused ? "stroke-amber-500" : "stroke-sky-500 live-beat"),
                  state === "pending" && "stroke-line-strong",
                )}
              />
            );
          })
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
      className={cn(
        "inline-flex items-center justify-center rounded-full",
        tone === "working" ? "text-sky-600 dark:text-sky-400" : tone === "paused" ? "text-amber-600" : "text-fg-faint",
      )}
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

function toneOf(run: Run | undefined): "working" | "paused" | "idle" {
  return !run ? "idle" : run.paused ? "paused" : "working";
}

/** The header chip. Two short lines; the ring says how far, the badge how many wait for you. */
export function AgentPresence({
  agent,
  open,
  focus,
  onToggle,
  onClose,
  onFocus,
}: {
  agent: AgentProto;
  open: boolean;
  focus: number | null;
  onToggle: () => void;
  onClose: () => void;
  onFocus: (prNumber: number) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const first = agent.working[0];
  const run = first?.item.run;
  const [flash, setFlash] = useState<AgentEvent | null>(null);
  useEffect(() => {
    if (!agent.lastEvent) return;
    setFlash(agent.lastEvent);
    const t = window.setTimeout(() => setFlash(null), 5000);
    return () => window.clearTimeout(t);
  }, [agent.lastEvent]);
  const waiting = agent.needsYou.length;

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label="Agent"
        className={cn(
          "group flex min-w-0 max-w-[22rem] items-center gap-2 rounded-xl py-0.5 pl-0.5 pr-2.5 text-left transition-colors",
          open ? "bg-elevated" : "hover:bg-elevated/70",
        )}
      >
        <span className="relative">
          <StepRing run={run} size={30} stroke={3}>
            <Face size={22} tone={toneOf(run)} />
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
            {first ? `${VERB[first.item.scenario]} #${first.pr.number}` : agent.mode === "paused" ? "Agent paused" : "Agent"}
            {agent.working.length > 1 && <span className="font-normal text-fg-subtle"> +{agent.working.length - 1}</span>}
          </span>
          {flash ? (
            <span key={flash.n} className="live-beat block truncate text-[11px] text-emerald-700 dark:text-emerald-300">
              ✓ {flash.text}
            </span>
          ) : (
            <span className="block truncate text-[11px] text-fg-subtle">
              {run ? run.steps[run.stepIdx]?.label : waiting > 0 ? `${waiting} wait for you` : "Nothing to do"}
            </span>
          )}
        </span>
      </button>
      {open && <CompanionPopover anchor={ref} agent={agent} focus={focus} onClose={onClose} onFocus={onFocus} />}
    </>
  );
}

const POPOVER_W = 360;

/** Hung under the chip, kept inside the window; follows it, closes on Escape or a click outside. */
function useAnchorStyle(anchor: RefObject<HTMLElement | null>) {
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

function CompanionPopover({
  anchor,
  agent,
  focus,
  onClose,
  onFocus,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  agent: AgentProto;
  focus: number | null;
  onClose: () => void;
  onFocus: (prNumber: number) => void;
}) {
  const pos = useAnchorStyle(anchor);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  const hero: AgentRow | undefined = agent.working.find((r) => r.pr.number === focus) ?? agent.working[0];
  const others = agent.working.filter((r) => r !== hero);
  if (!pos) return null;

  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label="Agent"
      style={{ position: "fixed", top: pos.top, left: pos.left, width: POPOVER_W }}
      className="z-50 overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_12px_40px_rgb(0_0_0/0.18),0_2px_6px_rgb(0_0_0/0.08)]"
    >
      {hero?.item.run ? <HeroRun row={hero} run={hero.item.run} agent={agent} /> : <Idle agent={agent} />}

      {(others.length > 0 || agent.queued.length > 0) && (
        <div className="border-t border-line px-3 py-2">
          {others.map((r) => (
            <button
              key={r.pr.id}
              type="button"
              onClick={() => onFocus(r.pr.number)}
              className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-xs hover:bg-elevated/70"
            >
              <StepRing run={r.item.run} size={18} stroke={2.5} />
              <span className="shrink-0 font-medium text-fg-secondary">{prLabel(r.pr)}</span>
              <span className="min-w-0 flex-1 truncate text-fg-subtle">{r.item.run?.steps[r.item.run.stepIdx]?.label}</span>
            </button>
          ))}
          {agent.queued.length > 0 && (
            <div className="px-1 py-1 text-[11px] text-fg-subtle">
              Next: {agent.queued.map((r) => `#${r.pr.number}`).join(", ")}
            </div>
          )}
        </div>
      )}

      {agent.needsYou.length > 0 && (
        <div className="flex items-center gap-2 border-t border-line bg-amber-500/[0.06] px-4 py-2 text-xs">
          <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
          <span className="text-fg-secondary">
            {agent.needsYou.length} decision{agent.needsYou.length > 1 ? "s" : ""} wait for you
          </span>
          <span className="flex-1" />
          <span className="text-fg-subtle">on the Board</span>
        </div>
      )}
    </div>,
    document.body,
  );
}

function Idle({ agent }: { agent: AgentProto }) {
  return (
    <div className="flex items-center gap-3 px-4 py-4">
      <StepRing run={undefined} size={56} stroke={4}>
        <Face size={40} tone="idle" />
      </StepRing>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-fg">{agent.mode === "paused" ? "Paused" : "Nothing running"}</div>
        <div className="text-xs text-fg-subtle">
          {agent.mode === "paused" ? "Switch it on from the Board to continue." : "It starts on its own when a PR needs it."}
        </div>
      </div>
    </div>
  );
}

function HeroRun({ row, run, agent }: { row: AgentRow; run: Run; agent: AgentProto }) {
  const { pr, item } = row;
  const step = run.steps[run.stepIdx];
  const subTotal = step?.activities.length ?? 0;
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const [hint, setHint] = useState("");
  const [hintError, setHintError] = useState(false);
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!hint.trim()) {
      setHintError(true);
      return;
    }
    agent.hint(pr.number, hint.trim());
    setHint("");
  };

  return (
    <div>
      <div className="flex gap-3 px-4 pb-3 pt-4">
        <StepRing run={run} size={60} stroke={4.5}>
          <span className="flex flex-col items-center leading-none">
            <Face size={26} tone={toneOf(run)} />
            <span className="mt-0.5 text-[10px] font-semibold tabular-nums text-fg-muted">
              {run.stepIdx + 1}/{run.steps.length}
            </span>
          </span>
        </StepRing>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-[11px] text-fg-subtle">
            <span className="truncate">{prLabel(pr)}</span>
            <span className="flex-1" />
            <span className="tabular-nums">{run.paused ? "paused" : elapsed(run)}</span>
          </div>
          <div className="truncate text-sm font-semibold text-fg" title={pr.title}>
            {pr.title}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span key={run.stepIdx} className="live-beat truncate text-xs font-medium text-sky-700 dark:text-sky-300">
              {step?.label ?? "Finishing"}
            </span>
            {subTotal > 1 && (
              <span className="flex shrink-0 gap-0.5" aria-label={`${run.actIdx} of ${subTotal} done in this step`}>
                {Array.from({ length: subTotal }, (_, i) => (
                  <span key={i} className={cn("size-1.5 rounded-full", i < run.actIdx ? "bg-sky-500" : "bg-line-strong")} />
                ))}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle" title={liveLine(run)}>
            {liveLine(run)}
          </div>
        </div>
      </div>

      <form onSubmit={send} className="flex items-center gap-1.5 px-3 pb-3">
        <input
          value={hint}
          onChange={(e) => {
            setHint(e.target.value);
            setHintError(false);
          }}
          placeholder={`Tell the agent about #${pr.number}…`}
          aria-invalid={hintError}
          className={cn(
            "min-w-0 flex-1 rounded-full border bg-elevated/50 px-3 py-1.5 text-xs text-fg placeholder:text-fg-faint focus:bg-surface focus:outline-none",
            hintError ? "border-red-500" : "border-transparent focus:border-sky-600",
          )}
        />
        <IconButton label={run.paused ? "Resume" : "Pause"} onClick={() => agent.pauseRun(pr.number)}>
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
              <MenuItem
                onClick={() => {
                  setMenu(false);
                  agent.takeOver(pr.number);
                }}
              >
                Take over in terminal
              </MenuItem>
              <MenuItem
                danger
                onClick={() => {
                  setMenu(false);
                  agent.stopRun(pr.number);
                }}
              >
                Stop this run
              </MenuItem>
            </div>
          )}
        </span>
      </form>
      {hintError && <div className="-mt-2 px-5 pb-2 text-[11px] text-red-700 dark:text-red-300">Write something first.</div>}

      {details && (
        <div className="border-t border-line px-4 py-3">
          <ol className="relative ml-1.5 space-y-2 border-l border-line-strong pl-4">
            {run.steps.map((s, i) => {
              const state = i < run.stepIdx ? "done" : i === run.stepIdx ? "current" : "pending";
              return (
                <li key={s.label} className="relative text-xs">
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -left-[1.3rem] top-0.5 size-2.5 rounded-full ring-2 ring-surface",
                      state === "done" ? "bg-emerald-500" : state === "current" ? "bg-sky-500" : "bg-line-strong",
                    )}
                  />
                  <span className={cn(state === "current" ? "font-semibold text-fg" : state === "done" ? "text-fg-muted" : "text-fg-faint")}>
                    {s.label}
                  </span>
                  {state !== "pending" && (
                    <div className="mt-0.5 space-y-0.5 font-mono text-[10.5px] text-fg-subtle">
                      {run.log
                        .filter((e) => e.step === i)
                        .slice(-3)
                        .map((e) => (
                          <div key={e.id} className="truncate" title={e.text}>
                            {e.kind === "you" ? "you: " : ""}
                            {e.text}
                          </div>
                        ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="mt-2 font-mono text-[10px] text-fg-faint">
            {item.headline} · session {run.sessionId}
          </div>
        </div>
      )}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] text-fg-muted hover:bg-elevated hover:text-fg"
    >
      {children}
    </button>
  );
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "block w-full px-3 py-1.5 text-left hover:bg-elevated",
        danger ? "text-red-700 dark:text-red-300" : "text-fg-secondary",
      )}
    >
      {children}
    </button>
  );
}
