import { stackTitle } from "../../../shared/pr-group";
import type { PullRequest } from "../../../shared/types";
import { cn } from "../format";

/** GitHub's stack glyph: three layers. */
function StackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 2 9 5-9 5-9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  );
}

/**
 * The PR's place in a native GitHub stack, "2/2" as GitHub shows it. Amber
 * while a PR below it is still open — GitHub will not merge this one yet —
 * and green on the bottom PR, the one GitHub merges first. Renders nothing
 * outside a stack.
 */
export function StackBadge({ pr, className }: { pr: PullRequest; className?: string }) {
  if (!pr.stack) return null;
  return (
    <span
      title={stackTitle(pr)}
      aria-label={stackTitle(pr)}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-xs font-medium tabular-nums",
        pr.blockedByStack ? "text-amber-600 dark:text-amber-300" : "text-emerald-600 dark:text-emerald-400",
        className,
      )}
    >
      <StackIcon />
      {pr.stack.position}/{pr.stack.size}
    </span>
  );
}
