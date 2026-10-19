import { useCallback, useContext, useState } from "react";

import type { PullRequest } from "../../../shared/types";
// Node-free, like pr-filter.ts — value-imported for the tooltip only. The main
// process picks the kind again from its own copy of the PR before launching.
import {
  CLAUDE_BUTTON_TEXT,
  CLAUDE_LAUNCH_LABEL,
  pickClaudeLaunch,
  type ClaudeLaunchKind,
} from "../../../shared/claude-launch";
import { cn } from "../format";
import { ClaudeEnabledContext } from "./claude-context";


/** "Start a Claude session on this PR" — renders nothing while the integration is off. */
export function ClaudeButton({
  pr,
  trackComments,
  compact = false,
  className,
}: {
  pr: PullRequest;
  trackComments: boolean;
  /** Smaller text for the table row and the tile. */
  compact?: boolean;
  className?: string;
}) {
  const enabled = useContext(ClaudeEnabledContext);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const launch = useCallback(() => {
    setState("busy");
    window.api
      .launchClaude(pr.id)
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
  }, [pr.id]);

  if (!enabled) return null;
  const kind = pickClaudeLaunch(pr, { trackComments });
  const label = `Start Claude in the repo folder to ${CLAUDE_LAUNCH_LABEL[kind]}`;
  return (
    <button
      type="button"
      onClick={launch}
      disabled={state === "busy"}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border font-medium transition-colors disabled:opacity-50",
        compact ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
        state === "done" ? KIND_CLASS.done : KIND_CLASS[kind],
        className,
      )}
    >
      <ClaudeMark size={compact ? 12 : 14} />
      {state === "done" ? "Started" : CLAUDE_BUTTON_TEXT[kind]}
    </button>
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
