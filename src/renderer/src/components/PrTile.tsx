import { useCallback, useState } from "react";

import { prSignal, type PrSignal } from "../../../shared/pr-filter";
import { ageDays, approvalTally, primaryRole, reviewRank } from "../../../shared/pr-table";
import type { PullRequest } from "../../../shared/types";
import { cn, relativeTime } from "../format";

/**
 * The Compact tile: the same information architecture as `PrCard` shrunk to
 * about a quarter of its height, so a small screen shows many PRs at once.
 *
 * What survives is only what needs no reading — the accent stripe, the CI glyph,
 * the unresolved-thread count, the age and the author's avatar. Everything the
 * card spells out in pills (role, review decision, reviewers, per-check names)
 * moves into the tile's `title`, which is why that tooltip is assembled rather
 * than left to the browser: at this size the hover IS the detail view.
 *
 * The two actions the card puts on every row — copy link, ignore — stay
 * reachable here but appear on hover, in the corner: at four to six tiles per
 * row they would otherwise cost more width than the title.
 */
interface Props {
  pr: PullRequest;
  onOpen: (pr: PullRequest) => void;
  onToggleIgnore: (pr: PullRequest) => void;
  /** Hide the repo name (redundant inside a per-repo group). */
  hideRepo?: boolean;
  /** Mirrors the `trackComments` setting — see `prSignal`. */
  trackComments: boolean;
}

const ACCENT: Record<PrSignal, string> = {
  blocked: "border-l-red-500",
  myReview: "border-l-violet-500",
  waiting: "border-l-line-strong",
  attention: "border-l-amber-500",
  approved: "border-l-emerald-500",
  idle: "border-l-line-strong",
};

const ROLE_TEXT = {
  author: "You are the author",
  reviewer: "Your review is requested",
  reviewed: "You already reviewed it",
} as const;

/**
 * The role, as one letter in the glyph row. A letter rather than an icon
 * because the three roles have no conventional symbols, and the row is read
 * next to the avatar: "A" against your own face is unambiguous where a generic
 * badge would not be. The full sentence is in `title`.
 */
const ROLE_GLYPH = { author: "A", reviewer: "R", reviewed: "✓" } as const;
const ROLE_GLYPH_CLASS = {
  author: "bg-sky-500/20 text-sky-700 dark:text-sky-300",
  reviewer: "bg-violet-500/20 text-violet-700 dark:text-violet-300",
  reviewed: "bg-slate-500/20 text-fg-muted",
} as const;

/**
 * The hover detail. Built as one string of lines because a tile has room for
 * roughly a title and four glyphs — everything else about the PR has to be
 * here or it is not in Compact at all.
 */
function tileTooltip(pr: PullRequest, now: number): string {
  const role = primaryRole(pr);
  const tally = approvalTally(pr);
  const lines = [
    `${pr.hostLabel} · ${pr.repo} #${pr.number}`,
    pr.title,
    pr.author ? `Author: ${pr.author.login}` : null,
    role ? ROLE_TEXT[role] : null,
    pr.isDraft ? "Draft" : null,
    pr.hasConflicts ? "Merge conflict" : null,
    tally ? `Approvals: ${tally.approved}/${tally.total}` : "No reviewers requested",
    pr.failingChecks.length > 0
      ? `CI failing: ${pr.failingChecks.map((c) => c.name).join(", ")}`
      : pr.pendingChecks.length > 0
        ? `CI running: ${pr.pendingChecks.length}`
        : pr.checks.length === 0
          ? "No checks"
          : "CI passing",
    pr.unresolvedThreads > 0 ? `${pr.unresolvedThreads} unresolved thread(s)` : null,
    `Opened ${ageDays(pr.createdAt, now)}d ago · updated ${relativeTime(pr.updatedAt)}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export function PrTile({ pr, onOpen, onToggleIgnore, hideRepo = false, trackComments }: Props) {
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

  const age = ageDays(pr.createdAt, Date.now());
  const failing = pr.failingChecks.length;
  const pending = pr.pendingChecks.length;
  const role = primaryRole(pr);

  return (
    <div
      title={tileTooltip(pr, Date.now())}
      className={cn(
        "group relative rounded-md border border-line border-l-[3px] bg-surface/60 px-2 py-1.5 transition-colors hover:bg-surface",
        ACCENT[prSignal(pr, { trackComments })],
        pr.isIgnored && "opacity-60 hover:opacity-100",
      )}
    >
      {/* Line 1 — where it lives and how old it is. */}
      <div className="flex items-center gap-1 text-[11px] leading-none text-fg-subtle">
        {hideRepo ? (
          <span className="text-fg-faint">#{pr.number}</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate">{pr.repo}</span>
            <span className="shrink-0 text-fg-faint">#{pr.number}</span>
          </span>
        )}
        {pr.isDraft && <span className="shrink-0 rounded bg-elevated px-1 text-fg-muted">D</span>}
        {pr.isIgnored && <span className="shrink-0 rounded bg-elevated px-1 text-fg-muted">I</span>}
        <span className="ml-auto shrink-0 tabular-nums text-fg-faint">{age}d</span>
      </div>

      {/* Line 2 — the title. Click opens the PR and marks it as seen.
          Exactly two lines, then an ellipsis — `line-clamp-2` and NOT `block`:
          the clamp works by `display: -webkit-box`, so a `block` next to it wins
          on stylesheet order and the title runs on for as many lines as it
          needs, making the tiles in a row different heights. */}
      <button
        type="button"
        onClick={() => onOpen(pr)}
        className="mt-1 line-clamp-2 w-full text-left text-[13px] font-medium leading-snug text-fg hover:text-sky-600 dark:hover:text-sky-300"
      >
        {pr.title}
      </button>

      {/* Line 3 — the glyph row. The tile's width was mostly empty between the
          avatar and the CI mark, so the signals that were tooltip-only fill it:
          your role, where the review stands, and the two "act on this" markers.
          Each carries its own `title`, since a glyph row is only readable once
          you can ask what a glyph means. */}
      <div className="mt-1.5 flex items-center gap-1 text-[11px] leading-none">
        {pr.author && (
          <img
            src={pr.author.avatarUrl}
            alt=""
            width={16}
            height={16}
            title={`Author: ${pr.author.login}`}
            className="shrink-0 rounded-full"
          />
        )}
        {role && (
          <span
            title={ROLE_TEXT[role]}
            className={cn(
              "inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded font-semibold",
              ROLE_GLYPH_CLASS[role],
            )}
          >
            {ROLE_GLYPH[role]}
          </span>
        )}
        <ReviewGlyph pr={pr} />
        {pr.returnedToMe && (
          <span
            title="New changes since you last looked — back in your court"
            className="shrink-0 font-medium text-violet-600 dark:text-violet-300"
          >
            ↩
          </span>
        )}
        {!pr.baseIsDefaultBranch && (
          <span
            title={`Stacked on ${pr.baseRefName}, not on the default branch`}
            className="shrink-0 text-emerald-600 dark:text-emerald-400"
          >
            ↳
          </span>
        )}
        {pr.hasNewActivity && (
          <span
            title="New comments since you last looked"
            className="shrink-0 font-medium text-amber-600 dark:text-amber-300"
          >
            ✦
          </span>
        )}
        {pr.hasConflicts && pr.roles.includes("author") && (
          <span
            title="Merge conflict with the base branch"
            className="shrink-0 font-medium text-red-600 dark:text-red-300"
          >
            ⚠
          </span>
        )}
        {pr.unresolvedThreads > 0 && (
          <span
            title={`${pr.unresolvedThreads} unresolved thread(s)`}
            className="shrink-0 tabular-nums text-orange-600 dark:text-orange-300"
          >
            💬{pr.unresolvedThreads}
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums">
          {failing > 0 ? (
            <span
              title={`CI failing: ${pr.failingChecks.map((c) => c.name).join(", ")}`}
              className="font-medium text-red-600 dark:text-red-300"
            >
              ✗{failing}
            </span>
          ) : pending > 0 ? (
            <span title={`${pending} check(s) still running`} className="text-amber-600 dark:text-amber-300">
              ●{pending}
            </span>
          ) : pr.checks.length === 0 ? (
            <span title="No checks on the latest commit" className="text-fg-faint">
              –
            </span>
          ) : (
            <span title="CI passing" className="text-emerald-600 dark:text-emerald-400">
              ✓
            </span>
          )}
        </span>
      </div>

      {/* Hover-only actions, in the corner so they cost no layout width. */}
      <div className="absolute right-1 top-1 hidden items-center gap-0.5 rounded bg-surface/90 px-0.5 group-hover:flex">
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
          <MiniCopyIcon done={copied} />
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
          <MiniEyeIcon off={!pr.isIgnored} />
        </button>
      </div>
    </div>
  );
}

/**
 * Where the review stands, in as little width as it can be said: a red ✗ for a
 * standing change request, a hollow ○ for "nobody has looked", otherwise the
 * approvals-out-of-reviewers tally the Cozy table's Review column shows. Green
 * only when every requested reviewer has approved — a half-approved PR reading
 * green is the one wrong answer this glyph could give.
 */
function ReviewGlyph({ pr }: { pr: PullRequest }) {
  const rank = reviewRank(pr);
  if (rank === 0) {
    return (
      <span title="Changes requested" className="shrink-0 font-medium text-red-600 dark:text-red-300">
        ✗
      </span>
    );
  }
  if (rank === 1) {
    return (
      <span title="Nobody has reviewed it yet" className="shrink-0 text-fg-faint">
        ○
      </span>
    );
  }
  const tally = approvalTally(pr);
  if (!tally) {
    return pr.hasHumanApproval ? (
      <span title="Approved" className="shrink-0 text-emerald-600 dark:text-emerald-400">
        ✓
      </span>
    ) : null;
  }
  const done = tally.approved === tally.total;
  return (
    <span
      title={pr.reviewers.map((r) => `${r.login}: ${r.reviewState.replace("_", " ")}`).join("\n")}
      className={cn(
        "shrink-0 tabular-nums",
        done ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-300",
      )}
    >
      {tally.approved}/{tally.total}
    </span>
  );
}

function MiniCopyIcon({ done }: { done: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {done ? (
        <polyline points="20 6 9 17 4 12" />
      ) : (
        <>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>
      )}
    </svg>
  );
}

function MiniEyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {off ? (
        <>
          <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </>
      ) : (
        <>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}
