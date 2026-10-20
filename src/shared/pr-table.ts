/**
 * The Cozy table: which columns exist, what each cell's *value* is, and how a
 * click on a header reorders the list.
 *
 * Everything here is pure and free of `node:` builtins — the renderer
 * value-imports it (see the carve-out rule in AGENTS.md and the guard test in
 * `tests/run-tests.cjs`). It lives here rather than inside `PrTable.tsx` for one
 * reason: a column sort is a promise about ordering, and ordering is exactly
 * what a DOM-less test can check. The comparators are also the only place the
 * table's meaning is written down — "worst CI first", "oldest first" — so they
 * must not be re-derived per cell in JSX.
 *
 * Two rules the comparators keep:
 *
 *  - **A column sorts by what its cell shows.** The CI column shows a state, so
 *    it sorts by that state's severity, not by the number of checks; the Age
 *    column shows a number of days, so ascending means the small number first
 *    (the *newest* PR) and the arrow the header draws is never a lie.
 *  - **The tie-break is never flipped.** Direction applies to the chosen column
 *    only; ties fall back to most-recently-updated and then to `id`, so two PRs
 *    that are equal under the active column keep a stable, meaningful order
 *    instead of swapping places between renders.
 */
import { prSignal, type PrSignal } from "./pr-filter";
import type { PullRequest } from "./types";

export type TableColumnKey =
  | "signal"
  | "repo"
  | "pr"
  | "author"
  | "reviewers"
  | "review"
  | "ci"
  | "comments"
  | "age"
  | "updated"
  | "actions";

export type SortDir = "asc" | "desc";

/** The active column sort — persisted with the other view preferences. */
export interface TableSort {
  key: TableColumnKey;
  dir: SortDir;
}

export interface TableColumn {
  key: TableColumnKey;
  /** Header text. Empty for the two icon-only columns (signal, actions). */
  label: string;
  /** Header tooltip — where an abbreviated column says what it means. */
  title: string;
  align: "left" | "right" | "center";
  /** False for `actions` (buttons have no order) and `reviewers` (a set of faces). */
  sortable: boolean;
  /**
   * The direction the FIRST click on this header selects — chosen so the first
   * click always shows the interesting end of the column: the worst CI, the
   * most comments, the oldest PR, the newest activity.
   */
  defaultDir: SortDir;
  /**
   * The narrowest this column may ever get, in rem — enough for its widest
   * ordinary content ("Changes requested" abbreviated to `✗ Changes`, a
   * `12mo ago`, a 3-digit thread count) plus its padding.
   *
   * A `min-width` on a cell is IGNORED by a fixed-layout table, so this number
   * is not applied per cell: {@link TABLE_MIN_WIDTH_REM} sums them and the
   * renderer puts that on the table itself, which is what actually stops any
   * column from being squeezed — past that width the table scrolls horizontally
   * instead of shrinking. Keeping the per-column numbers here rather than as
   * Tailwind classes in the markup is what makes the sum derived instead of a
   * hand-kept constant that drifts the moment a column is added.
   */
  minWidthRem: number;
}

/** The columns, in render order. */
export const TABLE_COLUMNS: readonly TableColumn[] = [
  {
    key: "signal",
    label: "",
    title: "Signal — the same accent the cards use (blocked, your review, attention, waiting, approved)",
    align: "center",
    sortable: true,
    defaultDir: "asc",
    // Just the dot and the header's sort arrow.
    minWidthRem: 2,
  },
  {
    key: "repo",
    label: "Repository",
    title: "Repository without its owner — sorts by repository, then by number",
    align: "left",
    sortable: true,
    defaultDir: "asc",
    // Its own column so every row's number and title start at the same x; a
    // longer name truncates, the full `host · owner/repo` is on hover.
    minWidthRem: 8,
  },
  {
    key: "pr",
    label: "Pull request",
    title: "Number and title — sorts by number",
    align: "left",
    sortable: true,
    defaultDir: "asc",
    // The only elastic column: it takes all the slack on a wide window, and
    // this is the floor below which a row stops being readable at all (number,
    // Jira key and enough of the title to tell two PRs apart).
    minWidthRem: 24,
  },
  {
    key: "author",
    label: "Author",
    title: "Who opened the PR (login on hover) — sorts by login",
    align: "center",
    sortable: true,
    defaultDir: "asc",
    // One avatar and the header word.
    minWidthRem: 5,
  },
  {
    key: "reviewers",
    label: "Reviewers",
    title: "Requested reviewers — the ring is their state: green approved, red changes requested",
    align: "left",
    sortable: false,
    defaultDir: "asc",
    // Five overlapping avatars and a "+N".
    minWidthRem: 7,
  },
  {
    key: "review",
    label: "Review",
    title: "Review state and how many of the requested reviewers have approved",
    align: "left",
    sortable: true,
    defaultDir: "asc",
    // Its widest cell is "No reviews".
    minWidthRem: 7,
  },
  {
    key: "ci",
    label: "CI",
    title: "Worst check state on the latest commit",
    align: "left",
    sortable: true,
    defaultDir: "asc",
    // A glyph and a two-digit count.
    minWidthRem: 4.5,
  },
  {
    key: "comments",
    label: "Threads",
    title: "Unresolved review threads (total comments break the tie)",
    align: "right",
    sortable: true,
    defaultDir: "desc",
    // The header word is wider than any count it holds.
    minWidthRem: 5.5,
  },
  {
    key: "age",
    label: "Age",
    title: "Days since the PR was opened",
    align: "right",
    sortable: true,
    defaultDir: "desc",
    // "365d" plus the sort arrow.
    minWidthRem: 4.5,
  },
  {
    key: "updated",
    label: "Updated",
    title: "Last activity",
    align: "right",
    sortable: true,
    defaultDir: "desc",
    // "just now" / "12mo ago" — the widest relative time `relativeTime` emits.
    minWidthRem: 6.5,
  },
  {
    key: "actions",
    label: "",
    title: "Copy link, start Claude, ignore, mark as seen",
    align: "right",
    sortable: false,
    defaultDir: "asc",
    // Three icon buttons at their widest (mark-as-seen only appears sometimes).
    // The labelled Claude button adds CLAUDE_ACTIONS_EXTRA_REM while it is on.
    minWidthRem: 5,
  },
];

/**
 * The table's initial ordering: the most urgent signal first — the same thing
 * the Roomy list leads with under its default "Needs my action" sort, so
 * switching modes doesn't reshuffle the list under the cursor.
 */
export const DEFAULT_TABLE_SORT: TableSort = { key: "signal", dir: "asc" };

/**
 * The narrowest the whole table may get — the sum of every column's minimum.
 * The renderer puts it on the table as a `min-width`, so a window narrower than
 * this scrolls the table sideways instead of squeezing columns (a fixed-layout
 * table ignores a `min-width` on the cells themselves, which is why the floor
 * has to be enforced once, here, rather than once per column in the markup).
 */
export const TABLE_MIN_WIDTH_REM = TABLE_COLUMNS.reduce((sum, col) => sum + col.minWidthRem, 0);

/**
 * Widths the user dragged, in rem, per column. A column absent from the map has
 * its default width — and for the Pull-request column that default is
 * "elastic": it takes whatever the window has left over.
 */
export type ColumnWidths = Partial<Record<TableColumnKey, number>>;

/**
 * How wide a column may be dragged, in rem. The floor is low on purpose — a
 * dragged width is a deliberate choice, and "just the avatar" or "just the
 * dot" is a legitimate one — but above zero, so no column can vanish. The
 * ceiling only exists to stop a stray drag, or a width persisted on a much
 * larger screen, leaving a table whose other columns are all off to the right.
 */
export const COLUMN_MIN_REM = 2;
export const COLUMN_MAX_REM = 90;

/**
 * Holds a dragged width inside those bounds, and rejects anything that isn't a
 * real width (a corrupt persisted value, a `NaN` from arithmetic on a missing
 * measurement) by answering `null` — the caller's "default width" state, NOT a
 * zero-width column.
 */
export function clampColumnWidth(rem: unknown): number | null {
  if (typeof rem !== "number" || !Number.isFinite(rem)) return null;
  return Math.min(COLUMN_MAX_REM, Math.max(COLUMN_MIN_REM, rem));
}

/**
 * Narrows a persisted value to a width map: unknown columns and bad widths are
 * dropped one by one, so one corrupt entry doesn't throw away the rest.
 */
export function parseColumnWidths(value: unknown): ColumnWidths {
  const out: ColumnWidths = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, rem] of Object.entries(value)) {
    if (!(key in COLUMN_BY_KEY)) continue;
    const clamped = clampColumnWidth(rem);
    if (clamped !== null) out[key as TableColumnKey] = clamped;
  }
  return out;
}

/** Width the labelled Claude button (the spark + "Drive to green", the widest) adds to the actions column. */
export const CLAUDE_ACTIONS_EXTRA_REM = 8;

/** The actions column's width — wider only while the Claude button is shown. */
export function actionsColumnRem(claudeEnabled: boolean): number {
  return COLUMN_BY_KEY.actions.minWidthRem + (claudeEnabled ? CLAUDE_ACTIONS_EXTRA_REM : 0);
}

/** A column's width before anyone drags it — the elastic PR column reports its floor. */
export function defaultColumnRem(key: TableColumnKey, claudeEnabled: boolean): number {
  return key === "actions" ? actionsColumnRem(claudeEnabled) : COLUMN_BY_KEY[key].minWidthRem;
}

/**
 * The table's `min-width`: every column at its dragged width, or its default
 * where it has none. With no widths and no Claude button that is exactly
 * {@link TABLE_MIN_WIDTH_REM}.
 */
export function tableMinWidthRem(widths: ColumnWidths, claudeEnabled: boolean): number {
  return TABLE_COLUMNS.reduce(
    (sum, col) => sum + (widths[col.key] ?? defaultColumnRem(col.key, claudeEnabled)),
    0,
  );
}

const COLUMN_BY_KEY: Record<TableColumnKey, TableColumn> = TABLE_COLUMNS.reduce(
  (acc, col) => {
    acc[col.key] = col;
    return acc;
  },
  {} as Record<TableColumnKey, TableColumn>,
);

/** Narrows an unknown (a persisted preference) to a sort the table can apply. */
export function isTableSort(value: unknown): value is TableSort {
  if (typeof value !== "object" || value === null) return false;
  const { key, dir } = value as { key?: unknown; dir?: unknown };
  if (dir !== "asc" && dir !== "desc") return false;
  if (typeof key !== "string") return false;
  const col = COLUMN_BY_KEY[key as TableColumnKey];
  return Boolean(col?.sortable);
}

/**
 * What a click on a header does: a different column switches to that column's
 * own default direction (not the previous column's — "most comments first"
 * inherited as "oldest first" would be nonsense); the active column flips.
 * Clicking the non-sortable Actions header is a no-op rather than an error.
 */
export function nextTableSort(current: TableSort, key: TableColumnKey): TableSort {
  const col = COLUMN_BY_KEY[key];
  if (!col?.sortable) return current;
  if (current.key !== key) return { key, dir: col.defaultDir };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

/** Accent severity — the order the signal column sorts in (worst first). */
const SIGNAL_RANK: Record<PrSignal, number> = {
  blocked: 0,
  myReview: 1,
  attention: 2,
  waiting: 3,
  approved: 4,
  idle: 5,
};

/**
 * The single role a Compact tile's role letter shows. A PR can carry several (`reviewed` stays
 * on after a re-request adds `reviewer` back), so the most demanding one wins:
 * being the author outranks owing a review, which outranks having reviewed.
 */
export function primaryRole(pr: Pick<PullRequest, "roles">): "author" | "reviewer" | "reviewed" | null {
  if (pr.roles.includes("author")) return "author";
  if (pr.roles.includes("reviewer")) return "reviewer";
  if (pr.roles.includes("reviewed")) return "reviewed";
  return null;
}

/**
 * How many of the PR's reviewers have approved, out of how many are on it —
 * what the Review cell shows next to the decision ("1/2"). Null when nobody is
 * requested, so the cell can print an em dash instead of a meaningless "0/0".
 */
export function approvalTally(
  pr: Pick<PullRequest, "reviewers">,
): { approved: number; total: number } | null {
  if (pr.reviewers.length === 0) return null;
  return {
    approved: pr.reviewers.filter((r) => r.reviewState === "approved").length,
    total: pr.reviewers.length,
  };
}

/**
 * Review-state severity (lowest = most in need of someone's action). Reads the
 * blocking states first, because those are the ones a sort is looking for: a
 * standing change request, then nobody having looked yet, then a partial set of
 * approvals, then done.
 */
export function reviewRank(
  pr: Pick<
    PullRequest,
    "reviewDecision" | "hasUnaddressedChangeRequest" | "hasNoReviews" | "hasHumanApproval" | "reviewers"
  >,
): number {
  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.hasUnaddressedChangeRequest) return 0;
  if (pr.hasNoReviews) return 1;
  if (!pr.hasHumanApproval) return 2;
  const tally = approvalTally(pr);
  // An approval is in — but a reviewer still owed one ranks above a full set.
  if (tally && tally.approved < tally.total) return 3;
  return 4;
}

/**
 * CI severity (lowest = worst), so one click on the header brings the red PRs
 * to the top. "No checks at all" sorts last: it is the absence of a signal, not
 * a good one, and mixing it in with `success` would bury real green PRs.
 */
export function ciRank(pr: Pick<PullRequest, "ciState" | "checks">): number {
  if (pr.checks.length === 0) return 5;
  switch (pr.ciState) {
    case "failure":
      return 0;
    case "pending":
      return 1;
    case "success":
      return 4;
    default:
      return 3;
  }
}

/** Whole days since an ISO timestamp, against a caller-supplied `now`. */
export function ageDays(iso: string, now: number): number {
  return Math.floor((now - new Date(iso).getTime()) / 864e5);
}

/**
 * The repo name without its owner — `Advance-Technologies-Foundation/clio`
 * shows as `clio`. The owner is the long, repeated part, and it is what pushed
 * the name into an ellipsis; the full `owner/repo` stays on hover.
 */
export function repoShortName(repo: string): string {
  const slash = repo.lastIndexOf("/");
  return slash >= 0 ? repo.slice(slash + 1) : repo;
}

/**
 * Compares two PRs by one column, ALWAYS ascending in terms of what the cell
 * shows. Direction is applied by `sortForTable`, so a comparator never has to
 * know which way the header arrow points.
 */
export function compareForColumn(
  a: PullRequest,
  b: PullRequest,
  key: TableColumnKey,
  { trackComments }: { trackComments: boolean },
): number {
  switch (key) {
    case "signal":
      return (
        SIGNAL_RANK[prSignal(a, { trackComments })] - SIGNAL_RANK[prSignal(b, { trackComments })]
      );
    case "repo":
      // Repo first, then number: "all of clio's PRs together, oldest number
      // first" is how the column actually gets used. By the short name the cell
      // shows; the full name only breaks a tie between two owners' repos of the
      // same name.
      return (
        repoShortName(a.repo).localeCompare(repoShortName(b.repo)) ||
        a.repo.localeCompare(b.repo) ||
        a.number - b.number
      );
    case "pr":
      // The number, not the title: nobody looks a title up alphabetically.
      return a.number - b.number;
    case "author":
      // A PR whose author GitHub no longer resolves (deleted account) sorts
      // last either way rather than ahead of every real login.
      return (a.author?.login ?? "￿").localeCompare(b.author?.login ?? "￿");
    case "review":
      return reviewRank(a) - reviewRank(b);
    case "ci":
      return ciRank(a) - ciRank(b);
    case "comments":
      return a.unresolvedThreads - b.unresolvedThreads || a.totalComments - b.totalComments;
    case "age":
      // The cell shows an age in days, so ascending is the smallest age: the
      // newest PR, i.e. the LATEST createdAt.
      return b.createdAt.localeCompare(a.createdAt);
    case "updated":
      return a.updatedAt.localeCompare(b.updatedAt);
    default:
      return 0;
  }
}

/**
 * The table's rows in order. Ties fall back to most-recently-updated and then to
 * the node id — both outside the flipped direction, so equal rows never swap
 * places on a re-render and "reverse the sort" doesn't reverse the tie-break
 * into "least recently updated" for no reason.
 */
export function sortForTable(
  prs: readonly PullRequest[],
  sort: TableSort,
  ctx: { trackComments: boolean },
): PullRequest[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...prs].sort((a, b) => {
    const primary = compareForColumn(a, b, sort.key, ctx);
    if (primary !== 0) return primary * dir;
    return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  });
}
