import { Fragment, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

import { jiraBrowseUrl, stripLeadingIssueKey } from "../../../shared/issue-key";
import { prSignal, type PrSignal } from "../../../shared/pr-filter";
import {
  TABLE_COLUMNS,
  ageDays,
  approvalTally,
  clampColumnWidth,
  defaultColumnRem,
  type ColumnWidths,
  repoShortName,
  reviewRank,
  tableMinWidthRem,
  type TableColumnKey,
  type TableSort,
} from "../../../shared/pr-table";
import type { PullRequest, ReviewerState } from "../../../shared/types";
import { cn, relativeTime } from "../format";
import { ClaudeButton } from "./ClaudeButton";
import { StackBadge } from "./StackBadge";
import { ClaudeEnabledContext } from "./claude-context";

/**
 * The Cozy variant: one flat, sortable table instead of cards.
 *
 * Flat on purpose — a table per group would only ever sort inside its own group,
 * so "which PR has been open the longest" (the question a sortable Age column
 * exists to answer) could not be asked. `App.tsx` therefore skips grouping while
 * this mode is on and disables the Group-by control.
 *
 * The ordering itself is not here: which column means what, and what a header
 * click does, live in `shared/pr-table.ts` so they are unit-tested without a
 * DOM. This file only renders the rows and draws the arrow on the active header.
 */
interface Props {
  prs: PullRequest[];
  sort: TableSort;
  onSort: (key: TableColumnKey) => void;
  /**
   * Dragged column widths in rem. A column missing from the map has its
   * default width; for the Pull-request column that default is elastic — it
   * absorbs whatever width the window has left over.
   */
  columnWidths: ColumnWidths;
  /** Called with the whole new map; a column reset by double-click is dropped from it. */
  onColumnWidthsChange: (widths: ColumnWidths) => void;
  onOpen: (pr: PullRequest) => void;
  onMarkSeen: (pr: PullRequest) => void;
  onToggleIgnore: (pr: PullRequest) => void;
  trackComments: boolean;
  jiraBaseUrl?: string | null;
}

/** Dot color per accent — the card's left stripe, shrunk into its own column. */
const SIGNAL_DOT: Record<PrSignal, string> = {
  blocked: "bg-red-500",
  myReview: "bg-violet-500",
  attention: "bg-amber-500",
  waiting: "bg-line-strong",
  approved: "bg-emerald-500",
  idle: "bg-line-strong",
};

const SIGNAL_TITLE: Record<PrSignal, string> = {
  blocked: "Blocked on you — failing CI, a change request, conflicts or unresolved comments",
  myReview: "Your review is what it is waiting for",
  attention: "New activity, checks still running, or waiting for a lower PR of its stack",
  waiting: "Waiting for someone else's review",
  approved: "Approved and green",
  idle: "Nothing pending",
};

/** The ring around a reviewer's avatar — their state at a glance. */
const REVIEWER_RING: Record<ReviewerState, string> = {
  approved: "ring-emerald-500",
  changes_requested: "ring-red-500",
  pending: "ring-line-strong",
};

/** Avatars shown before the rest collapse into "+N". */
const MAX_REVIEWER_AVATARS = 5;

/**
 * Per-column padding and alignment. Widths are NOT here — they come from the
 * dragged widths or each column's default in `shared/pr-table.ts` via the
 * `<colgroup>` below, so the numbers that define the layout and the number that
 * stops the table shrinking (`tableMinWidthRem`) can't disagree.
 * `overflow-hidden` everywhere: a column dragged narrower than its content must
 * clip it, not paint over its neighbour.
 */
const COLUMN_CLASS: Record<TableColumnKey, string> = {
  signal: "overflow-hidden px-1 text-center",
  repo: "overflow-hidden px-2",
  pr: "overflow-hidden px-2",
  author: "overflow-hidden px-2 text-center",
  reviewers: "overflow-hidden px-2",
  review: "overflow-hidden px-2",
  ci: "overflow-hidden px-2",
  comments: "overflow-hidden px-2 text-right",
  age: "overflow-hidden px-2 text-right",
  updated: "overflow-hidden px-2 text-right",
  actions: "overflow-hidden px-2 text-right",
};

/**
 * The Actions column is pinned to the right edge of the scroll box: copy,
 * ignore and Claude stay reachable however far the table is scrolled sideways.
 * `sticky` needs an opaque background (set per cell) or the scrolled cells show
 * through, and the left shadow marks where the pinned part begins.
 */
const ACTIONS_STICKY = "sticky right-0 z-[1] shadow-[-6px_0_6px_-6px_rgba(0,0,0,0.35)]";

/** One rem in CSS pixels, so a pointer delta can be stored as rem. */
function remToPx(): number {
  const size = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

/** Breathing room below the table's scroll area, in px. */
const SCROLLER_BOTTOM_GAP = 12;

/**
 * The shortest the scroll box may be, in px — about two rows.
 *
 * It must stay SMALL. A floor taller than the space actually left under the
 * table puts the box's bottom edge, and with it the horizontal scrollbar, back
 * below the window — the exact failure this box exists to fix. On a window so
 * short that even this doesn't fit, the page scrolls as it used to.
 */
const SCROLLER_MIN_HEIGHT = 64;

/**
 * Keeps the table's scroll box exactly as tall as the space left under it, so
 * the box ends at the bottom of the window.
 *
 * That is what makes the horizontal scrollbar visible at all: a scrollbar sits
 * at the bottom edge of ITS OWN element, so while the page did the scrolling
 * and the table was taller than the window, the bar lived below the fold and a
 * table clipped on the right looked simply complete. Bounding the box moves the
 * scrolling inside it and pins the bar to the bottom of the screen.
 *
 * Measured rather than computed from a `calc(100vh - Xrem)`: what sits above the
 * table is the header plus a filter row that wraps to a second line on a narrow
 * window, so any constant would be wrong at exactly the widths where the
 * horizontal scrollbar matters most.
 */
function useScrollerHeight(ref: React.RefObject<HTMLElement | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);

  const measure = useCallback(() => {
    const top = ref.current?.getBoundingClientRect().top;
    if (top === undefined) return;
    const next = Math.max(SCROLLER_MIN_HEIGHT, window.innerHeight - top - SCROLLER_BOTTOM_GAP);
    // Sub-pixel tolerance: a fractional difference re-rendering forever is the
    // one way a measure-then-set-state pair can fail to settle.
    setHeight((prev) => (prev !== null && Math.abs(prev - next) < 1 ? prev : next));
  }, [ref]);

  // After EVERY commit, not behind a dependency list: what sits above the table
  // changes height on its own — the filter row wraps to a second line as chips
  // come and go, per-host error banners appear — and each of those is a render.
  // A `ResizeObserver` on the page was tried first and is WRONG here: the page's
  // height includes this box, so the observer sees its own effect and feeds back
  // into itself, and Chromium then drops notifications — which left the box the
  // stale height it had before a window resize, with its scrollbar below the
  // window again. Setting the same number is a no-op for React, so this settles
  // after one extra pass.
  useLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return height;
}

export function PrTable({
  prs,
  sort,
  onSort,
  columnWidths,
  onColumnWidthsChange,
  onOpen,
  onMarkSeen,
  onToggleIgnore,
  trackComments,
  jiraBaseUrl = null,
}: Props) {
  const dragRef = useRef<{ key: TableColumnKey; startX: number; startRem: number; rem: number } | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollerHeight = useScrollerHeight(scrollerRef);

  const setWidth = useCallback(
    (key: TableColumnKey, rem: number | null) => {
      const next = { ...columnWidths };
      if (rem === null) delete next[key];
      else next[key] = rem;
      onColumnWidthsChange(next);
    },
    [columnWidths, onColumnWidthsChange],
  );

  // The grip's own header cell is measured at drag start rather than read from
  // `columnWidths`: an undragged column — the elastic PR one above all — has
  // only the width it happens to have on screen, and starting anywhere else
  // would make the column jump under the cursor on the first pixel of movement.
  const headerRem = (grip: HTMLElement): number =>
    (grip.parentElement?.offsetWidth ?? 0) / remToPx();

  const beginResize = useCallback((key: TableColumnKey, event: React.PointerEvent<HTMLElement>) => {
    // Without this the browser starts a text selection instead, and the drag
    // paints the whole header blue. It also suppresses the focus a pointerdown
    // would normally give the grip, hence the explicit `focus()` — otherwise the
    // arrow keys below do nothing right after a drag, which is exactly when
    // someone reaches for them to nudge the edge a couple of rem.
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    dragRef.current = {
      key,
      startX: event.clientX,
      startRem: headerRem(event.currentTarget),
      rem: remToPx(),
    };
    // Pointer capture keeps the moves coming after the cursor leaves the 5px
    // grip — which it does immediately, since the column follows the cursor.
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const continueResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      setWidth(drag.key, clampColumnWidth(drag.startRem + (event.clientX - drag.startX) / drag.rem));
    },
    [setWidth],
  );

  const endResize = useCallback((event: React.PointerEvent<HTMLElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  // Arrow keys move the edge too: the grip is a 5px target, and a resize that
  // only exists for a mouse is a resize half the users can't reach.
  const keyResize = useCallback(
    (key: TableColumnKey, event: React.KeyboardEvent<HTMLElement>) => {
      const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const current = columnWidths[key] ?? headerRem(event.currentTarget);
      setWidth(key, clampColumnWidth(current + step));
    },
    [columnWidths, setWidth],
  );

  const claudeEnabled = useContext(ClaudeEnabledContext);
  // A dragged PR column has an exact width, so the window's slack needs the
  // trailing filler column instead.
  const prFixed = columnWidths.pr !== undefined;

  return (
    // Three things hold the layout together. `table-fixed` + the `<colgroup>`
    // pin each column at its declared width, so a long title truncates instead
    // of pushing the numeric columns aside; the table's `min-width` — the sum of
    // those widths, dragged or default — is what keeps them from being squeezed on a narrow window, since
    // a fixed-layout table ignores a `min-width` set on the cells; and
    // `.table-scroll` (a styled, non-overlay scrollbar — macOS's own fades out
    // seconds after the last scroll) scrolls the table inside a box bounded by
    // the window, so the horizontal bar is on screen whenever columns are
    // clipped rather than below the fold where nothing said they were missing.
    <div
      ref={scrollerRef}
      className="table-scroll"
      style={scrollerHeight === null ? undefined : { maxHeight: `${scrollerHeight}px` }}
    >
      <table
        className="w-full table-fixed border-collapse text-sm"
        style={{
          minWidth: `${tableMinWidthRem(columnWidths, claudeEnabled)}rem`,
        }}
      >
        <colgroup>
          {TABLE_COLUMNS.map((col) => (
            <Fragment key={col.key}>
            {/* With every column fixed, the leftover width of a wide window has
                to land somewhere; an auto-width filler takes all of it, where
                otherwise the browser would hand each column a proportional share
                and quietly widen the one just dragged to an exact size. It sits
                BEFORE Actions so the buttons stay at the right edge. */}
            {col.key === "actions" && prFixed && <col />}
            <col
              // Until it is dragged, the PR column carries no width at all: it
              // then absorbs the slack on a wide window, where a declared width
              // would instead be spread proportionally over all the columns and
              // grow the numeric ones nobody needs wider. Once dragged it gets
              // its exact width and the filler column below takes the slack.
              style={
                col.key === "pr" && columnWidths.pr === undefined
                  ? undefined
                  : { width: `${columnWidths[col.key] ?? defaultColumnRem(col.key, claudeEnabled)}rem` }
              }
            />
            </Fragment>
          ))}
        </colgroup>
        {/* Sticky inside the scroll box: the rows move under the headers, so the
            column you sorted by — and its arrow — stay in sight. It needs its
            own background or the rows show through, and `shadow` draws the rule
            that a scrolled `border-b` leaves behind. */}
        <thead className="sticky top-0 z-[2] bg-canvas shadow-[0_1px_0_0_var(--line-strong)]">
          <tr className="text-left text-xs uppercase tracking-wide text-fg-muted">
            {TABLE_COLUMNS.map((col) => {
              const active = col.sortable && sort.key === col.key;
              return (
                <Fragment key={col.key}>
                {col.key === "actions" && prFixed && <th aria-hidden />}
                <th
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={cn(
                    "relative py-1.5 font-medium",
                    COLUMN_CLASS[col.key],
                    col.key === "actions" && cn(ACTIONS_STICKY, "bg-canvas"),
                  )}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort(col.key)}
                      title={`${col.title} — click to sort`}
                      className={cn(
                        "inline-flex max-w-full items-center gap-1 rounded hover:text-fg-secondary",
                        // A label-less header (the signal dot) fills its cell:
                        // otherwise the button is zero-wide whenever its arrow
                        // isn't drawn, and the column can't be sorted at all.
                        !col.label && "w-full justify-center",
                        active && "text-fg-secondary",
                      )}
                    >
                      {col.label ? (
                        <span className="truncate">{col.label}</span>
                      ) : (
                        // Stands in for the label while another column is sorted.
                        !active && <span aria-hidden className="inline-block h-2 w-2 rounded-full border border-current" />
                      )}
                      {/* The arrow is drawn only on the active column: a per-header
                          placeholder arrow reads as "sorted by this" on every column. */}
                      {active && (
                        <span aria-hidden className="text-[10px] leading-none">
                          {sort.dir === "asc" ? "▲" : "▼"}
                        </span>
                      )}
                    </button>
                  ) : col.label ? (
                    <span className="block truncate normal-case" title={col.title}>
                      {col.label}
                    </span>
                  ) : (
                    <span className="sr-only">{col.title}</span>
                  )}
                  {/* The one place that undoes every drag at once; per column,
                      double-clicking its grip does the same. Shown only while
                      something was dragged, so it never sits there doing nothing. */}
                  {col.key === "actions" && Object.keys(columnWidths).length > 0 && (
                    <button
                      type="button"
                      onClick={() => onColumnWidthsChange({})}
                      title="Reset all column widths"
                      className="rounded px-1.5 py-0.5 normal-case tracking-normal text-fg-muted hover:bg-elevated hover:text-fg"
                    >
                      ↺ Reset widths
                    </button>
                  )}
                  {/* Every column has a grip on its right edge. */}
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize the ${col.label || col.key} column (double-click to reset)`}
                    tabIndex={0}
                    title="Drag to resize · double-click to reset"
                    onPointerDown={(e) => beginResize(col.key, e)}
                    onPointerMove={continueResize}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    onDoubleClick={() => setWidth(col.key, null)}
                    onKeyDown={(e) => keyResize(col.key, e)}
                    className="absolute right-0 top-0 z-[1] h-full w-1.5 cursor-col-resize touch-none rounded bg-transparent transition-colors hover:bg-sky-500/50 focus-visible:bg-sky-500/50 focus-visible:outline-none"
                  />
                </th>
                </Fragment>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {prs.map((pr) => (
            <Row
              key={pr.id}
              pr={pr}
              filler={prFixed}
              onOpen={onOpen}
              onMarkSeen={onMarkSeen}
              onToggleIgnore={onToggleIgnore}
              trackComments={trackComments}
              jiraBaseUrl={jiraBaseUrl}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  pr,
  filler,
  onOpen,
  onMarkSeen,
  onToggleIgnore,
  trackComments,
  jiraBaseUrl,
}: {
  pr: PullRequest;
  /** Render the trailing slack-absorbing cell (only once the PR column is fixed). */
  filler: boolean;
  onOpen: (pr: PullRequest) => void;
  onMarkSeen: (pr: PullRequest) => void;
  onToggleIgnore: (pr: PullRequest) => void;
  trackComments: boolean;
  jiraBaseUrl: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const copyUrl = useCallback(() => {
    window.api
      .copyText(pr.url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [pr.url]);

  const signal = prSignal(pr, { trackComments });
  const jiraUrl = jiraBrowseUrl(jiraBaseUrl, pr.issueKey);
  // Same rule as the card: the key is dropped from the title only when the
  // badge next to it actually carries it.
  const title = jiraUrl ? stripLeadingIssueKey(pr.title, pr.issueKey) : pr.title;
  const age = ageDays(pr.createdAt, Date.now());
  const ageWarn = !pr.isDraft && !pr.hasHumanApproval && age >= 3;

  return (
    <tr
      className={cn(
        // Opaque hover colour (elevated at 50% over the canvas, mixed rather
        // than alpha) so the sticky Actions cell can repeat it exactly without
        // the scrolled cells showing through.
        "group border-b border-line align-middle hover:bg-[color-mix(in_srgb,var(--elevated)_50%,var(--canvas))]",
        pr.isIgnored && "opacity-60 hover:opacity-100",
      )}
    >
      <td className={cn("py-1.5", COLUMN_CLASS.signal)}>
        <span
          title={SIGNAL_TITLE[signal]}
          className={cn("inline-block h-2 w-2 rounded-full", SIGNAL_DOT[signal])}
        />
      </td>

      <td className={cn("py-1.5", COLUMN_CLASS.repo)}>
        <span className="block truncate text-xs text-fg-subtle" title={`${pr.hostLabel} · ${pr.repo}`}>
          {repoShortName(pr.repo)}
        </span>
      </td>

      <td className={cn("py-1.5", COLUMN_CLASS.pr)}>
        <div className="flex min-w-0 items-center gap-1.5">
          {/* Fixed widths for the number and the Jira key so every title starts
              at the same x — a 3-digit number next to a 4-digit one otherwise
              shifts the title by a character. The number never truncates: it
              is the PR's identity. */}
          <span className="w-[3.25rem] shrink-0 text-sm font-semibold tabular-nums text-fg-secondary">
            #{pr.number}
          </span>
          <StackBadge pr={pr} />
          {pr.returnedToMe && (
            <span title="New changes since you last looked" className="shrink-0 text-violet-600 dark:text-violet-300">
              ↩
            </span>
          )}
          {pr.isDraft && (
            <span className="shrink-0 rounded bg-elevated px-1 text-[10px] text-fg-muted">Draft</span>
          )}
          {pr.isIgnored && (
            <span className="shrink-0 rounded bg-elevated px-1 text-[10px] text-fg-muted">Ignored</span>
          )}
          {pr.hasConflicts && pr.roles.includes("author") && (
            <span
              title="GitHub reports a merge conflict with the base branch"
              className="shrink-0 text-red-600 dark:text-red-300"
            >
              ⚠
            </span>
          )}
          {jiraUrl && (
            <button
              type="button"
              onClick={() => window.api.openExternal(jiraUrl).catch(() => {})}
              title={`Open ${pr.issueKey} in Jira`}
              className="w-[5.25rem] shrink-0 rounded border border-indigo-500/40 bg-indigo-500/15 px-1 text-center text-[10px] font-medium text-indigo-700 hover:bg-indigo-500/25 dark:text-indigo-300"
            >
              {pr.issueKey}
            </button>
          )}
          <button
            type="button"
            onClick={() => onOpen(pr)}
            title={pr.title}
            className="min-w-0 flex-1 truncate text-left font-medium text-fg hover:text-sky-600 hover:underline dark:hover:text-sky-300"
          >
            {title}
          </button>
        </div>
      </td>

      <td className={cn("py-1.5", COLUMN_CLASS.author)}>
        {pr.author ? (
          // Avatar only — the login is on hover, like the Reviewers column.
          <img
            src={pr.author.avatarUrl}
            alt={pr.author.login}
            title={pr.author.login}
            width={18}
            height={18}
            className="rounded-full"
          />
        ) : (
          <span className="text-xs text-fg-faint">—</span>
        )}
      </td>

      <td className={cn("py-1.5", COLUMN_CLASS.reviewers)}>
        <ReviewersCell pr={pr} />
      </td>

      <td className={cn("py-1.5 text-xs", COLUMN_CLASS.review)}>
        <ReviewCell pr={pr} />
      </td>

      <td className={cn("py-1.5 text-xs tabular-nums", COLUMN_CLASS.ci)}>
        <CiCell pr={pr} />
      </td>

      <td className={cn("py-1.5 text-xs tabular-nums", COLUMN_CLASS.comments)}>
        {pr.unresolvedThreads > 0 ? (
          <span className="text-orange-600 dark:text-orange-300" title={`${pr.unresolvedThreads} unresolved thread(s)`}>
            {pr.unresolvedThreads}
          </span>
        ) : (
          <span className="text-fg-faint">0</span>
        )}
        {pr.hasNewActivity && (
          <span title="New comments since you last looked" className="ml-1 text-amber-600 dark:text-amber-300">
            ✦
          </span>
        )}
      </td>

      <td className={cn("py-1.5 text-xs tabular-nums", COLUMN_CLASS.age)}>
        <span
          title={`Opened ${new Date(pr.createdAt).toLocaleString()}`}
          className={ageWarn ? "text-amber-700 dark:text-amber-300" : "text-fg-muted"}
        >
          {age}d
        </span>
      </td>

      <td className={cn("py-1.5 text-xs text-fg-muted", COLUMN_CLASS.updated)}>
        <span title={new Date(pr.updatedAt).toLocaleString()}>{relativeTime(pr.updatedAt)}</span>
      </td>

      {filler && <td aria-hidden />}

      <td className={cn("py-1.5", COLUMN_CLASS.actions, ACTIONS_STICKY, "bg-canvas group-hover:bg-[color-mix(in_srgb,var(--elevated)_50%,var(--canvas))]")}>
        <span className="inline-flex items-center justify-end gap-0.5">
          {pr.hasNewActivity && (
            <button
              type="button"
              onClick={() => onMarkSeen(pr)}
              title="Mark as seen"
              aria-label="Mark as seen"
              className="rounded p-0.5 text-xs text-fg-muted hover:bg-elevated hover:text-fg"
            >
              ✓
            </button>
          )}
          <button
            type="button"
            onClick={copyUrl}
            title={copied ? "Copied" : "Copy PR link"}
            aria-label="Copy PR link"
            className={cn(
              "rounded p-0.5 hover:bg-elevated",
              copied ? "text-emerald-600 dark:text-emerald-400" : "text-fg-faint hover:text-fg-secondary",
            )}
          >
            <RowIcon kind={copied ? "check" : "copy"} />
          </button>
          <button
            type="button"
            onClick={() => onToggleIgnore(pr)}
            title={pr.isIgnored ? "Un-ignore (show on the dashboard)" : "Ignore (hide from the dashboard)"}
            aria-label={pr.isIgnored ? "Un-ignore PR" : "Ignore PR"}
            className={cn(
              "rounded p-0.5 hover:bg-elevated",
              pr.isIgnored ? "text-sky-600 dark:text-sky-400" : "text-fg-faint hover:text-fg-secondary",
            )}
          >
            <RowIcon kind={pr.isIgnored ? "eye" : "eye-off"} />
          </button>
          {/* Last, so it sits on the row's right edge where the eye lands. */}
          <ClaudeButton pr={pr} trackComments={trackComments} compact className="ml-1" />
        </span>
      </td>
    </tr>
  );
}

/**
 * Requested reviewers as overlapping avatars, each ringed in its state's color;
 * past {@link MAX_REVIEWER_AVATARS} the rest collapse into "+N". Logins and
 * states are on hover, since a face alone doesn't say who or what.
 */
function ReviewersCell({ pr }: { pr: PullRequest }) {
  if (pr.reviewers.length === 0) return <span className="text-xs text-fg-faint">—</span>;
  const shown = pr.reviewers.slice(0, MAX_REVIEWER_AVATARS);
  const rest = pr.reviewers.length - shown.length;
  return (
    <span
      className="flex items-center -space-x-1"
      title={pr.reviewers.map((r) => `${r.login}: ${r.reviewState.replace("_", " ")}`).join("\n")}
    >
      {shown.map((r) => (
        <img
          key={r.login}
          src={r.avatarUrl}
          alt={r.login}
          width={18}
          height={18}
          className={cn("shrink-0 rounded-full ring-2", REVIEWER_RING[r.reviewState])}
        />
      ))}
      {rest > 0 && <span className="pl-2 text-xs text-fg-muted">+{rest}</span>}
    </span>
  );
}

/**
 * The review cell: the blocking states get a word, everything else gets the
 * approval tally the column sorts by, so the number on screen is the number
 * being ordered.
 */
function ReviewCell({ pr }: { pr: PullRequest }) {
  const rank = reviewRank(pr);
  const tally = approvalTally(pr);
  if (rank === 0) {
    return (
      <span className="text-red-700 dark:text-red-300" title="Changes requested">
        ✗ Changes
      </span>
    );
  }
  if (rank === 1) {
    return (
      <span className="text-fg-muted" title="Nobody has reviewed it yet">
        No reviews
      </span>
    );
  }
  if (!tally) {
    // Approved (or commented) with no reviewer left on the request list.
    return (
      <span className={pr.hasHumanApproval ? "text-emerald-700 dark:text-emerald-300" : "text-fg-muted"}>
        {pr.hasHumanApproval ? "✓ Approved" : "In review"}
      </span>
    );
  }
  const done = tally.approved === tally.total;
  return (
    <span
      className={done ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}
      title={pr.reviewers.map((r) => `${r.login}: ${r.reviewState.replace("_", " ")}`).join("\n")}
    >
      {done ? "✓ " : ""}
      {tally.approved}/{tally.total}
    </span>
  );
}

function CiCell({ pr }: { pr: PullRequest }) {
  if (pr.failingChecks.length > 0) {
    return (
      <span
        className="text-red-700 dark:text-red-300"
        title={`Failing: ${pr.failingChecks.map((c) => c.name).join(", ")}`}
      >
        ✗ {pr.failingChecks.length}
      </span>
    );
  }
  if (pr.pendingChecks.length > 0) {
    return (
      <span
        className="text-amber-700 dark:text-amber-300"
        title={`Running: ${pr.pendingChecks.map((c) => c.name).join(", ")}`}
      >
        ● {pr.pendingChecks.length}
      </span>
    );
  }
  if (pr.checks.length === 0) {
    return (
      <span className="text-fg-faint" title="No checks on the latest commit">
        —
      </span>
    );
  }
  return (
    <span className="text-emerald-700 dark:text-emerald-400" title={`${pr.checks.length} check(s), none failing`}>
      ✓ {pr.checks.filter((c) => c.state === "success").length}
    </span>
  );
}

function RowIcon({ kind }: { kind: "copy" | "check" | "eye" | "eye-off" }) {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {kind === "copy" && (
        <>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>
      )}
      {kind === "check" && <polyline points="20 6 9 17 4 12" />}
      {kind === "eye" && (
        <>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
      {kind === "eye-off" && (
        <>
          <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </>
      )}
    </svg>
  );
}
