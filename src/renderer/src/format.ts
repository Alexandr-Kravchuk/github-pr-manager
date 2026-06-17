/** Client-safe formatting/style helpers (no main-process dependencies). */

import type { CheckState } from "../../shared/types";

/** Joins class names, dropping empties. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Relative time in short form ("5m ago"). */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 45) return "just now";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** Tailwind classes for a badge based on the normalized check state. */
export function checkStateClasses(state: CheckState): string {
  switch (state) {
    case "failure":
      return "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300";
    case "pending":
      return "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "success":
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    default:
      return "border-line-strong bg-elevated text-fg-muted";
  }
}

/** Indicator symbol for a check state. */
export function checkStateIcon(state: CheckState): string {
  switch (state) {
    case "failure":
      return "✗";
    case "pending":
      return "●";
    case "success":
      return "✓";
    case "skipped":
      return "⊘";
    default:
      return "•";
  }
}
