import { useCallback, useContext, useState } from "react";
import { createPortal } from "react-dom";

import type { PullRequest } from "../../../shared/types";
// Node-free, like pr-filter.ts — value-imported for the tooltip and the menu.
// The button itself sends no kind: main picks again from its own copy of the PR.
import {
  CLAUDE_BUTTON_TEXT,
  CLAUDE_LAUNCH_LABEL,
  claudeKindsFor,
  pickClaudeLaunch,
  type ClaudeLaunchKind,
} from "../../../shared/claude-launch";
import { cn } from "../format";
import { useAnchoredMenu } from "./anchored-menu";
import { ClaudeEnabledContext } from "./claude-context";

const MENU_WIDTH_PX = 240;

/**
 * "Start a Claude session on this PR" — a split button. The main part starts
 * the action the PR's state suggests; the arrow opens a menu of every action,
 * so a PR the state calls "Drive to green" can still be closed (or reviewed)
 * on purpose. Renders nothing while the integration is off.
 */
export function ClaudeButton({
  pr,
  trackComments,
  compact = false,
  iconOnly = false,
  className,
}: {
  pr: PullRequest;
  trackComments: boolean;
  /** Smaller text for the table row and the tile. */
  compact?: boolean;
  /** Just the mark, coloured by the action — the tile's glyph row has no room for a label. */
  iconOnly?: boolean;
  className?: string;
}) {
  const enabled = useContext(ClaudeEnabledContext);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const menu = useAnchoredMenu(MENU_WIDTH_PX);
  // Without `kind` main picks from the PR's state, exactly as the button shows.
  const launch = useCallback(
    (kind?: ClaudeLaunchKind) => {
      setState("busy");
      window.api
        .launchClaude(pr.id, kind)
        .then((res) => {
          if (res.ok) {
            setState("done");
            setTimeout(() => setState("idle"), 1500);
          } else {
            setState("idle");
            window.alert(res.error);
          }
        })
        .catch((e: unknown) => {
          setState("idle");
          window.alert((e as Error).message);
        });
    },
    [pr.id],
  );

  if (!enabled) return null;
  const kind = pickClaudeLaunch(pr, { trackComments });
  const label = `Start Claude in the repo folder to ${CLAUDE_LAUNCH_LABEL[kind]}`;
  const tone = state === "done" ? KIND_CLASS.done : KIND_CLASS[kind];
  const segment = cn(
    "inline-flex items-center border font-medium transition-colors disabled:opacity-50",
    iconOnly ? "h-[18px]" : compact ? "py-0.5 text-[11px]" : "py-1 text-xs",
    tone,
  );
  const mainPadding = iconOnly ? "px-1" : compact ? "pl-1.5 pr-1" : "pl-2 pr-1.5";
  return (
    <span className={cn("inline-flex shrink-0 whitespace-nowrap", className)}>
      <button
        type="button"
        onClick={() => launch()}
        disabled={state === "busy"}
        title={iconOnly ? `${CLAUDE_BUTTON_TEXT[kind]} — ${label}` : label}
        aria-label={label}
        className={cn(segment, "flex-1 justify-center gap-1 rounded-l-md", mainPadding)}
      >
        <ClaudeMark size={compact || iconOnly ? 12 : 14} />
        {!iconOnly && (state === "done" ? "Started" : CLAUDE_BUTTON_TEXT[kind])}
      </button>
      <button
        ref={menu.buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          menu.toggle();
        }}
        disabled={state === "busy"}
        title="Choose what Claude does"
        aria-label="Choose what Claude does"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        className={cn(segment, "-ml-px rounded-r-md", compact || iconOnly ? "px-0.5" : "px-1")}
      >
        <ChevronDown size={compact || iconOnly ? 10 : 12} />
      </button>
      {menu.open &&
        createPortal(
          <div
            ref={menu.menuRef}
            role="menu"
            aria-label="Start Claude to"
            style={menu.style}
            className="z-50 overflow-hidden rounded-lg border border-line bg-surface py-1 text-sm shadow-xl"
          >
            {claudeKindsFor(pr).map((k) => (
              <button
                key={k}
                type="button"
                role="menuitem"
                onClick={() => {
                  menu.close();
                  launch(k);
                }}
                title={`Start Claude in the repo folder to ${CLAUDE_LAUNCH_LABEL[k]}`}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated"
              >
                <span className={cn("h-2 w-2 shrink-0 rounded-full", KIND_DOT[k])} aria-hidden />
                <span className={cn("flex-1", k === kind ? "font-semibold text-fg" : "text-fg-secondary")}>
                  {CLAUDE_BUTTON_TEXT[k]}
                </span>
                {k === kind && <span className="text-xs text-fg-subtle">suggested</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** The menu's colour key — the same colour each kind gives the button. */
const KIND_DOT: Record<ClaudeLaunchKind, string> = {
  drive: "bg-red-500",
  review: "bg-violet-500",
  close: "bg-emerald-500",
  explain: "bg-sky-500",
  open: "bg-line-strong",
};

function ChevronDown({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Coloured like the card accent the state comes from, so the button reads with the card. */
const KIND_CLASS: Record<ClaudeLaunchKind | "done", string> = {
  drive:
    "border-red-500/50 bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-300",
  review:
    "border-violet-500/50 bg-violet-500/10 text-violet-700 hover:bg-violet-500/20 dark:text-violet-300",
  close:
    "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300",
  explain: "border-sky-500/50 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300",
  open: "border-line-strong bg-elevated/60 text-fg-secondary hover:bg-elevated",
  done: "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

/**
 * The Claude spark — twelve tapered rays, in Claude's orange whatever the
 * button's colour, so the mark alone says which tool the click starts.
 */
function ClaudeMark({ size }: { size: number }) {
  const rays = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <g fill="#D97757">
        {rays.map((deg, i) => (
          <path
            key={deg}
            // Alternating ray lengths give the hand-drawn burst its uneven edge.
            d={i % 2 === 0 ? "M11 12 L12 1.2 L13 12 Z" : "M11.2 12 L12 3.4 L12.8 12 Z"}
            transform={`rotate(${deg} 12 12)`}
          />
        ))}
        <circle cx="12" cy="12" r="2.2" />
      </g>
    </svg>
  );
}
