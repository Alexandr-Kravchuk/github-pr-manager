import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { PullRequest } from "../../../shared/types";
import { cn } from "../format";
import { needsYouSession, needsYouVersion, subscribeNeedsYou, subscribeShown, windowShown } from "../needs-you";
import { ClaudeEnabledContext, ClaudeSessionsContext } from "./claude-context";

/** A PR on the list and the group it sits in (null without grouping). */
export interface ListedPr {
  pr: PullRequest;
  groupKey: string | null;
}

type Place = "above" | "below" | "folded";

/**
 * Pulses an element in size while `on`, paused while the window is hidden or
 * minimized (see needs-you.ts) — the pill and a folded group's count, so they
 * catch the eye like the tiles they stand for. Transform only: a `translate`
 * utility is a property of its own and is not overridden.
 */
export function usePulse(ref: React.RefObject<HTMLElement | null>, on: boolean, scale: number): void {
  const shown = useSyncExternalStore(subscribeShown, windowShown);
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const anim = el.animate(
      [{ transform: "scale(1)" }, { transform: `scale(${scale})` }, { transform: "scale(1)" }],
      { duration: 900, iterations: Infinity, easing: "ease-in-out" },
    );
    if (!shown) anim.pause();
    return () => anim.cancel();
  }, [ref, on, scale, shown]);
}

/** The PRs on the list that ask for you now (see needs-you.ts), in list order. */
export function useNeedsYouPrs(listed: ListedPr[]): ListedPr[] {
  const enabled = useContext(ClaudeEnabledContext);
  const sessions = useContext(ClaudeSessionsContext);
  const version = useSyncExternalStore(subscribeNeedsYou, needsYouVersion);
  return useMemo(
    () => (enabled ? listed.filter((l) => needsYouSession(l.pr, sessions) !== null) : []),
    // `version` is the store's: an answered tile drops out at once.
    [enabled, listed, sessions, version],
  );
}

/** Where a PR's tile is relative to what you can see: on screen (null), off it, or in a folded group. */
function placeOf(prId: string, folded: boolean): Place | null {
  if (folded) return "folded";
  const el = document.querySelector<HTMLElement>(`[data-pr-id="${CSS.escape(prId)}"]`);
  if (!el) return null; // not rendered here (another view): nothing to point at
  const r = el.getBoundingClientRect();
  // The sticky header covers the top of the window.
  const top = document.querySelector("header.sticky")?.getBoundingClientRect().bottom ?? 0;
  if (r.bottom < top + 24) return "above";
  if (r.top > window.innerHeight - 24) return "below";
  return null;
}

/**
 * "✋ N need you ↓" — shown while a tile that asks for you is out of sight:
 * scrolled away, or in a collapsed group. Nothing moves on its own: with
 * several such tiles an automatic scroll would jump between them, so the list
 * stays where you left it and a click on the pill takes you to the nearest
 * one — below first, then above, then a folded group, which it opens.
 */
export function NeedsYouPill({
  waiting,
  collapsed,
  onExpand,
}: {
  waiting: ListedPr[];
  collapsed: ReadonlySet<string>;
  onExpand: (groupKey: string) => void;
}) {
  const [places, setPlaces] = useState<Map<string, Place>>(new Map());
  const [target, setTarget] = useState<string | null>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const hiddenCount = waiting.filter((w) => places.has(w.pr.id)).length;

  // Pulses like the tiles it points at, for as long as it shows.
  usePulse(pill, hiddenCount > 0, 1.12);

  // Measured on scroll and resize (once a frame at most), and after every render.
  useEffect(() => {
    if (waiting.length === 0) {
      setPlaces(new Map());
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = new Map<string, Place>();
      for (const w of waiting) {
        const place = placeOf(w.pr.id, w.groupKey !== null && collapsed.has(w.groupKey));
        if (place) next.set(w.pr.id, place);
      }
      setPlaces((prev) =>
        prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v) ? prev : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [waiting, collapsed]);

  // A folded group opened for the click: scroll once its tiles are rendered.
  useEffect(() => {
    if (!target) return;
    const el = document.querySelector<HTMLElement>(`[data-pr-id="${CSS.escape(target)}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setTarget(null);
    }
  });

  const hidden = waiting.filter((w) => places.has(w.pr.id));
  if (hidden.length === 0) return null;
  const pick =
    hidden.find((w) => places.get(w.pr.id) === "below") ??
    [...hidden].reverse().find((w) => places.get(w.pr.id) === "above") ??
    hidden[0];
  const where = places.get(pick.pr.id);
  const arrow = where === "above" ? "↑" : where === "below" ? "↓" : "▸";
  const go = () => {
    if (where === "folded" && pick.groupKey !== null) onExpand(pick.groupKey);
    setTarget(pick.pr.id);
  };
  const what = hidden.length === 1 ? "1 PR needs you" : `${hidden.length} PRs need you`;
  return (
    <button
      ref={pill}
      type="button"
      onClick={go}
      title={`${what} — a Claude session waits for your answer. Click to show #${pick.pr.number}${where === "folded" ? " (opens its group)" : ""}.`}
      className={cn(
        "fixed bottom-10 left-1/2 z-20 -translate-x-1/2 rounded-full border border-fuchsia-500/70 bg-fuchsia-50 px-3 py-1 text-xs font-medium text-fuchsia-700 shadow-lg",
        "hover:bg-fuchsia-100 dark:bg-fuchsia-950 dark:text-fuchsia-200 dark:hover:bg-fuchsia-900",
      )}
    >
      ✋ {what} {arrow}
    </button>
  );
}
