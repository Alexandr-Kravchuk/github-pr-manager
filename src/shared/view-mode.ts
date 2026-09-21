/**
 * Which shape the PR list is rendered in — the macOS-Finder-style switch in the
 * header row.
 *
 *  - `roomy`   — the original full cards (`PrCard`), one per PR. The default:
 *                everything a PR carries is on screen without a hover.
 *  - `cozy`    — a flat table sorted by any column (`PrTable`). Deliberately
 *                flat: a per-group table would sort inside each group only, so
 *                "who is the oldest PR overall" — the question a sortable column
 *                is for — could not be answered. Grouping is therefore disabled
 *                while `cozy` is on, and so is the sort dropdown: the column
 *                headers are the sort control there.
 *  - `compact` — the same cards as `roomy` but small (`PrTile`), for fitting
 *                many PRs on a small screen. Only the signals that need no
 *                reading survive (accent, CI, unresolved count, age); the rest
 *                moves into the tile's `title`.
 *
 * Its own module, free of `node:` builtins, because the renderer value-imports
 * it — see the carve-out rule in AGENTS.md and the guard test in
 * `tests/run-tests.cjs`. The point of putting the mode here rather than as a
 * union inside `App.tsx` is `isViewMode`: the persisted preference is read back
 * from `localStorage`, so the validation has to exist somewhere, and here it is
 * unit-testable without a DOM.
 */

/** The three display variants, in the order the switch renders them. */
export const VIEW_MODES = ["roomy", "cozy", "compact"] as const;

export type ViewMode = (typeof VIEW_MODES)[number];

/** The mode a fresh install starts in — the original card layout. */
export const DEFAULT_VIEW_MODE: ViewMode = "roomy";

/**
 * Tooltip / `aria-label` per segment. The switch itself is icon-only (that is
 * what makes it fit the header's middle gap), so this text is the only place
 * the mode is named — it has to say what the mode does, not just repeat the
 * name.
 */
export const VIEW_MODE_TITLES: Record<ViewMode, string> = {
  roomy: "Roomy — full cards",
  cozy: "Cozy — sortable table",
  compact: "Compact — small tiles",
};

/** Narrows an unknown (a persisted preference) to a `ViewMode`. */
export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === "string" && (VIEW_MODES as readonly string[]).includes(value);
}

/**
 * Whether this mode renders group headings. Only `cozy` doesn't — its table is
 * flat so a column sort orders the whole list. The caller uses this for two
 * things at once (skip the grouping pass, disable the Group-by control), which
 * is why it is one predicate rather than two comparisons against `"cozy"`
 * spelled out at each site.
 */
export function supportsGrouping(mode: ViewMode): boolean {
  return mode !== "cozy";
}

/**
 * Whether the header's sort dropdown applies in this mode. False for `cozy`,
 * where the column headers own the ordering — two controls for one ordering,
 * one of them silently losing, is worse than one disabled control that says why.
 */
export function usesListSort(mode: ViewMode): boolean {
  return mode !== "cozy";
}
