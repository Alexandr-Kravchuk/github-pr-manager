import { useCallback, useState } from "react";

import type { PullRequest, ReviewDecision, Reviewer } from "../../../shared/types";
import { cn, relativeTime } from "../format";
import { CheckBadge } from "./CheckBadge";

interface Props {
  pr: PullRequest;
  onOpen: (pr: PullRequest) => void;
  onMarkSeen: (pr: PullRequest) => void;
  /** Ignore (hide) the PR, or un-ignore it when already ignored. */
  onToggleIgnore: (pr: PullRequest) => void;
  /** Hide the host/repo line (redundant inside a per-repo group). */
  hideRepo?: boolean;
}

/** Card signal, in priority order — drives the left accent and the header buddy. */
export type PrSignal = "blocked" | "myReview" | "waiting" | "attention" | "approved" | "idle";

/**
 * Classify a PR by signal priority.
 *  - blocked (red): your PR is blocked and needs your action — failing CI, a
 *    change request you haven't re-requested review on, or a reviewer comment
 *    you haven't answered (an unresolved thread whose last comment isn't yours,
 *    even from a plain "Comment" review with green CI). Only for PRs you authored.
 *  - myReview (violet): a review is being requested of you and you haven't
 *    submitted one yet — your turn to act. The `reviewer` role comes from
 *    GitHub's `review-requested:@me`, so it clears itself once you review.
 *    Also covers a PR that came back to you (`returnedToMe`) after you reviewed
 *    or opened it — GitHub drops the reviewer role once you review, so this is
 *    what keeps a re-review on your radar. Ranked right after your own blocked
 *    PRs so review requests never blend into the rest.
 *  - waiting (gray): your PR is awaiting someone else's review and nobody has
 *    approved yet (ball in their court) — nothing required from you, even with
 *    open threads.
 *  - attention (amber): new comments, open threads, CI running.
 *  - approved (green): at least one human approval, and CI isn't failing or
 *    running. A single human approve is enough — even if other reviewers are
 *    still pending, and even if the PR has no checks at all. We key off an
 *    actual approval rather than `reviewDecision`, which stays
 *    null/REVIEW_REQUIRED on repos without required-review rules.
 */
export function prSignal(pr: PullRequest): PrSignal {
  const isAuthor = pr.roles.includes("author");

  if (
    isAuthor &&
    (pr.failingChecks.length > 0 || pr.hasUnaddressedChangeRequest || pr.hasUnaddressedComments)
  ) {
    return "blocked";
  }
  if (pr.roles.includes("reviewer") || pr.returnedToMe) {
    return "myReview";
  }
  if (isAuthor && pr.awaitingReview && !pr.hasNewActivity && !pr.hasHumanApproval) {
    return "waiting";
  }
  if (pr.hasNewActivity || pr.unresolvedThreads > 0 || pr.pendingChecks.length > 0) {
    return "attention";
  }
  if (pr.hasHumanApproval && pr.ciState !== "failure" && pr.ciState !== "pending") {
    return "approved";
  }
  return "idle";
}

const ACCENT: Record<PrSignal, string> = {
  blocked: "border-l-red-500",
  myReview: "border-l-violet-500",
  waiting: "border-l-line-strong",
  attention: "border-l-amber-500",
  approved: "border-l-emerald-500",
  idle: "border-l-line-strong",
};

function accentClass(pr: PullRequest): string {
  return ACCENT[prSignal(pr)];
}

function reviewLabel(decision: ReviewDecision): { text: string; cls: string } | null {
  switch (decision) {
    case "APPROVED":
      return {
        text: "Approved",
        cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
      };
    case "CHANGES_REQUESTED":
      return {
        text: "Changes requested",
        cls: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40",
      };
    case "REVIEW_REQUIRED":
      return { text: "Review required", cls: "bg-elevated text-fg-muted border-line-strong" };
    default:
      return null;
  }
}

const pill = "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium";

/** Whole days since an ISO timestamp. */
function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
}

const REVIEWER_RING: Record<Reviewer["reviewState"], string> = {
  approved: "ring-emerald-500",
  changes_requested: "ring-red-500",
  pending: "ring-amber-500",
};

function reviewerListLabel(reviewers: Reviewer[]): string {
  if (reviewers.length === 0) return "";
  const logins = reviewers.map((r) => r.login);
  if (logins.length <= 2) return logins.join(", ");
  return `${logins.slice(0, 2).join(", ")} +${logins.length - 2}`;
}

function ReviewerBadge({ r }: { r: Reviewer }) {
  const label = r.reviewState === "approved"
    ? "approved"
    : r.reviewState === "changes_requested"
      ? "changes requested"
      : "pending";
  return r.avatarUrl ? (
    <img
      src={r.avatarUrl}
      alt=""
      width={18}
      height={18}
      title={`${r.login}: ${label}`}
      className={cn("rounded-full ring-2", REVIEWER_RING[r.reviewState])}
    />
  ) : (
    <span
      title={`${r.login}: ${label}`}
      className={cn(
        "inline-flex h-[18px] w-[18px] items-center justify-center rounded-full ring-2 bg-elevated text-[9px] text-fg-muted uppercase",
        REVIEWER_RING[r.reviewState],
      )}
    >
      {r.login[0]}
    </span>
  );
}

/** Green umbrella — marks a stacked PR (base is not the repo's default branch). */
function UmbrellaIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 12a10 10 0 0 0-20 0Z" />
      <path d="M12 12v8a2 2 0 0 0 4 0" />
      <path d="M12 2v1" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Crossed-out eye — "ignore" (hide this PR from the dashboard). */
function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

/** Open eye — "un-ignore" (bring this PR back to the dashboard). */
function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function PrCard({ pr, onOpen, onMarkSeen, onToggleIgnore, hideRepo = false }: Props) {
  const review = reviewLabel(pr.reviewDecision);
  const passingCount = pr.checks.filter((c) => c.state === "success").length;
  const pendingReviewers = pr.reviewers.filter((r) => r.reviewState === "pending");
  const pendingReviewerNames = reviewerListLabel(pendingReviewers);
  // Age badge: flag PRs that have been waiting a while without an approval — the
  // "don't let reviews rot" cue. Suppressed for drafts and already-approved PRs.
  const ageDays = daysSince(pr.createdAt);
  const showAge = !pr.isDraft && !pr.hasHumanApproval && ageDays >= 3;
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

  return (
    <div
      className={cn(
        "rounded-lg border border-line border-l-4 p-4 transition-colors hover:bg-surface bg-surface/60",
        accentClass(pr),
      )}
    >
      {/* Top row: repo/number + updated time */}
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-fg-subtle">
        <div className="flex min-w-0 items-center gap-2">
          {hideRepo ? (
            <span className="text-fg-faint">#{pr.number}</span>
          ) : (
            <>
              <span className="rounded bg-elevated px-1.5 py-0.5 text-fg-muted">{pr.hostLabel}</span>
              <span className="truncate" title={pr.repo}>
                {pr.repo} <span className="text-fg-faint">#{pr.number}</span>
              </span>
            </>
          )}
          {pr.isDraft && (
            <span className="rounded bg-elevated px-1.5 py-0.5 text-fg-muted">Draft</span>
          )}
          {!pr.baseIsDefaultBranch && (
            <span
              title={`Based on ${pr.baseRefName}`}
              aria-label={`Based on branch ${pr.baseRefName}`}
              className="shrink-0 text-emerald-600 dark:text-emerald-400"
            >
              <UmbrellaIcon />
            </span>
          )}
          <button
            type="button"
            onClick={copyUrl}
            title={copied ? "Copied" : "Copy PR link"}
            aria-label="Copy PR link"
            className={cn(
              "shrink-0 rounded p-0.5 hover:bg-elevated",
              copied
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-fg-faint hover:text-fg-secondary",
            )}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          <button
            type="button"
            onClick={() => onToggleIgnore(pr)}
            title={pr.isIgnored ? "Un-ignore (show on the dashboard)" : "Ignore (hide from the dashboard)"}
            aria-label={pr.isIgnored ? "Un-ignore PR" : "Ignore PR"}
            className={cn(
              "shrink-0 rounded p-0.5 hover:bg-elevated",
              pr.isIgnored
                ? "text-sky-600 dark:text-sky-400"
                : "text-fg-faint hover:text-fg-secondary",
            )}
          >
            {pr.isIgnored ? <EyeIcon /> : <EyeOffIcon />}
          </button>
        </div>
        <span className="shrink-0" title={new Date(pr.updatedAt).toLocaleString()}>
          {relativeTime(pr.updatedAt)}
        </span>
      </div>

      {/* Title — clicking opens the PR and marks it as seen */}
      <button
        type="button"
        onClick={() => onOpen(pr)}
        className="mb-2 block text-left text-[15px] font-semibold leading-snug text-fg hover:text-sky-600 hover:underline dark:hover:text-sky-300"
      >
        {pr.title}
      </button>

      {/* Meta: author, roles, review decision, comments, new activity */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {pr.author && (
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
            <img
              src={pr.author.avatarUrl}
              alt=""
              width={18}
              height={18}
              className="rounded-full"
            />
            {pr.author.login}
          </span>
        )}

        {pr.roles.includes("author") && (
          <span className={cn(pill, "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300")}>
            Author
          </span>
        )}
        {pr.roles.includes("reviewer") && (
          <span
            className={cn(
              pill,
              "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300",
            )}
          >
            Reviewer
          </span>
        )}

        {review && <span className={cn(pill, review.cls)}>{review.text}</span>}

        {pr.returnedToMe && (
          <span
            title="New changes since you last looked — back in your court to re-review"
            className={cn(
              pill,
              "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300",
            )}
          >
            ↩ Back to you
          </span>
        )}

        {showAge && (
          <span
            title={`Opened ${ageDays} days ago, still unapproved`}
            className={cn(pill, "border-line-strong bg-elevated text-fg-muted")}
          >
            ⏳ {ageDays}d
          </span>
        )}

        {pr.unresolvedThreads > 0 && (
          <span
            className={cn(
              pill,
              "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-300",
            )}
          >
            💬 {pr.unresolvedThreads} to resolve
          </span>
        )}

        {pr.hasNewActivity && (
          <span className="inline-flex items-center gap-1">
            <span
              className={cn(
                pill,
                "border-amber-400/50 bg-amber-400/20 text-amber-700 dark:text-amber-200",
              )}
            >
              ✦ New comments
            </span>
            <button
              type="button"
              onClick={() => onMarkSeen(pr)}
              title="Mark as seen"
              className="rounded-md border border-line-strong px-1.5 py-0.5 text-xs text-fg-muted hover:bg-elevated hover:text-fg"
            >
              ✓
            </button>
          </span>
        )}
      </div>

      {/* Reviewers */}
      {pr.reviewers.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-fg-subtle">Reviewers:</span>
          {pr.reviewers.map((r) => (
            <ReviewerBadge key={r.login} r={r} />
          ))}
          {pendingReviewers.length > 0 && (
            <span
              className={cn(
                pill,
                "max-w-full border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-200",
              )}
              title={`Waiting for review from: ${pendingReviewers.map((r) => r.login).join(", ")}`}
            >
              Waiting for: <span className="truncate">{pendingReviewerNames}</span>
            </span>
          )}
        </div>
      )}

      {/* CI: failures first, then pending; otherwise a summary */}
      <div className="flex flex-wrap items-center gap-1.5">
        {pr.failingChecks.map((c) => (
          <CheckBadge key={`f-${c.name}`} check={c} />
        ))}
        {pr.pendingChecks.map((c) => (
          <CheckBadge key={`p-${c.name}`} check={c} />
        ))}

        {pr.failingChecks.length === 0 && pr.pendingChecks.length === 0 && (
          <span className="text-xs text-fg-subtle">
            {pr.ciState === "success" && passingCount > 0
              ? `✓ CI passed (${passingCount})`
              : pr.checks.length === 0
                ? "No checks"
                : "CI: no failures"}
          </span>
        )}
      </div>
    </div>
  );
}
