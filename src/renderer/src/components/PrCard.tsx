import { useCallback, useState } from "react";

import type { PullRequest, Reviewer } from "../../../shared/types";
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
  /** 1-based position in the priority queue (shown only in the flat lane view). */
  queuePos?: number;
}

/** Card signal, in priority order — drives the left accent and the header buddy. */
export type PrSignal = "blocked" | "myReview" | "waiting" | "attention" | "approved" | "idle";

/**
 * Classify a PR by signal priority.
 *  - blocked (red): your PR is blocked and needs your action — failing CI, a
 *    change request you haven't re-requested review on, a reviewer comment
 *    you haven't answered (an unresolved thread whose last comment isn't yours,
 *    even from a plain "Comment" review with green CI), or a merge conflict you
 *    must resolve (`hasConflicts`) — the latter blocks merge even when CI is
 *    green and the PR is approved, so it belongs here, not in `approved`. Only
 *    for PRs you authored.
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
 *  - approved (green): at least one human approval, CI isn't failing or
 *    running, and there are no open threads. A single human approve is enough —
 *    even if other reviewers are still pending, and even if the PR has no checks
 *    at all. We key off an actual approval rather than requiring
 *    `reviewDecision === "APPROVED"`, which stays null/REVIEW_REQUIRED on repos
 *    without required-review rules — but we still consult `reviewDecision` as a
 *    disqualifier: a live `CHANGES_REQUESTED` (e.g. a second reviewer whose
 *    change request gates the merge even after being re-requested) keeps the PR
 *    out of green, since it isn't actually mergeable. Ranked
 *    ABOVE attention: an approved, green PR stays green even when it has unread
 *    comments, so opening it (which clears `hasNewActivity`) doesn't flip the
 *    accent from amber to green. Open threads and running CI still demote it,
 *    since those are unfinished work.
 *  - attention (amber): new comments, open threads, CI running.
 */
export function prSignal(pr: PullRequest): PrSignal {
  const isAuthor = pr.roles.includes("author");

  if (
    isAuthor &&
    (pr.failingChecks.length > 0 ||
      pr.hasUnaddressedChangeRequest ||
      pr.hasUnaddressedComments ||
      pr.hasConflicts)
  ) {
    return "blocked";
  }
  if (pr.roles.includes("reviewer") || pr.returnedToMe) {
    return "myReview";
  }
  if (isAuthor && pr.awaitingReview && !pr.hasNewActivity && !pr.hasHumanApproval) {
    return "waiting";
  }
  if (
    pr.hasHumanApproval &&
    pr.reviewDecision !== "CHANGES_REQUESTED" &&
    pr.ciState !== "failure" &&
    pr.ciState !== "pending" &&
    pr.unresolvedThreads === 0
  ) {
    return "approved";
  }
  if (pr.hasNewActivity || pr.unresolvedThreads > 0 || pr.pendingChecks.length > 0) {
    return "attention";
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

/** Tone of the contextual action / queue dot — mirrors the priority-lane colors. */
export type SituationTone = "violet" | "red" | "emerald" | "neutral";

/** Visual weight of the CTA: your move (filled), good-to-go (green), or nothing required (calm). */
export type ActionLevel = "urgent" | "positive" | "calm";

/**
 * The card's single call-to-action: the one most useful next step, plus how
 * loudly to show it. Derived from the same signals that drive the priority
 * lanes, so the CTA on a card always agrees with the lane it sits in. The label
 * carries the specific action ("→ Resolve merge conflict"), so that fact is NOT
 * repeated as a separate status pill (see the card body).
 */
export interface PrSituation {
  actionLabel: string;
  tone: SituationTone;
  level: ActionLevel;
}

export function prSituation(pr: PullRequest): PrSituation {
  const isReviewer = pr.roles.includes("reviewer");

  // Reviewer-side actions take precedence — others may be blocked on you.
  if (isReviewer && pr.lastSeenAt === null) {
    return { actionLabel: "→ Give your review", tone: "violet", level: "urgent" };
  }
  if (pr.returnedToMe) {
    return { actionLabel: "→ Re-review", tone: "violet", level: "urgent" };
  }
  if (isReviewer) {
    return { actionLabel: "→ Review", tone: "violet", level: "calm" };
  }

  const signal = prSignal(pr);
  if (signal === "blocked") {
    const conflict = pr.hasConflicts;
    const failingCi = pr.failingChecks.length > 0;
    let actionLabel: string;
    if (conflict && failingCi) actionLabel = "→ Resolve conflict & fix CI";
    else if (conflict) actionLabel = "→ Resolve merge conflict";
    else if (failingCi) actionLabel = "→ Fix failing CI";
    else if (pr.hasUnaddressedChangeRequest) actionLabel = "→ Address change requests";
    else actionLabel = "→ Address comments";
    return { actionLabel, tone: "red", level: "urgent" };
  }
  if (signal === "approved" || pr.canBeMerged) {
    return { actionLabel: "→ Ready to merge", tone: "emerald", level: "positive" };
  }
  if (signal === "waiting") {
    return { actionLabel: "Waiting on reviewers", tone: "neutral", level: "calm" };
  }
  return { actionLabel: "→ Open PR", tone: "neutral", level: "calm" };
}

/** CTA button classes: filled + colored when it's your move, calm outline otherwise. */
function ctaClasses(s: PrSituation): string {
  if (s.level === "urgent") {
    return s.tone === "red"
      ? "bg-red-600 text-white hover:bg-red-700"
      : "bg-violet-600 text-white hover:bg-violet-700";
  }
  if (s.level === "positive") return "bg-emerald-600 text-white hover:bg-emerald-700";
  return "border border-line-strong bg-elevated text-fg-secondary hover:bg-line-strong/40";
}

/** Queue-dot background per tone (the pulsing urgency marker under the queue number). */
const DOT_BG: Record<SituationTone, string> = {
  violet: "bg-violet-500",
  red: "bg-red-500",
  emerald: "bg-emerald-500",
  neutral: "bg-line-strong",
};

/** Whole days since an ISO timestamp. */
function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
}

const REVIEWER_RING: Record<Reviewer["reviewState"], string> = {
  approved: "ring-emerald-500",
  changes_requested: "ring-red-500",
  pending: "ring-amber-500",
};

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
      width={20}
      height={20}
      title={`${r.login}: ${label}`}
      className={cn("rounded-full ring-2", REVIEWER_RING[r.reviewState])}
    />
  ) : (
    <span
      title={`${r.login}: ${label}`}
      className={cn(
        "inline-flex h-5 w-5 items-center justify-center rounded-full ring-2 bg-elevated text-[9px] text-fg-muted uppercase",
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

/** Ghost outline tag for a role — muted, so it reads even when repo grouping mixes roles. */
const roleTag =
  "inline-flex items-center rounded border border-line-strong px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-fg-muted";

export function PrCard({ pr, onOpen, onMarkSeen, onToggleIgnore, hideRepo = false, queuePos }: Props) {
  const signal = prSignal(pr);
  const situation = prSituation(pr);
  const passingCount = pr.checks.filter((c) => c.state === "success").length;
  // Age badge: flag PRs that have been waiting a while without an approval — the
  // "don't let reviews rot" cue. Suppressed for drafts and already-approved PRs.
  const ageDays = daysSince(pr.createdAt);
  const showAge = !pr.isDraft && !pr.hasHumanApproval && ageDays >= 3;

  // Status pill — only when it says something the CTA doesn't. For a reviewer,
  // "Review" doesn't reveal that changes were already requested, so surface that
  // (neutral). For your own blocked PRs the CTA already names the problem, so no
  // pill (no dedup with the button).
  const isReviewerSide = pr.roles.includes("reviewer") || pr.returnedToMe;
  const statusPill =
    isReviewerSide && pr.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : null;

  // "✓ CI passed (N)" and "✓ Approved" are calm confirmations — useful on a
  // ready/waiting card, pure noise on a blocked one, so suppress them there.
  const showCiPassed =
    signal !== "blocked" && pr.failingChecks.length === 0 && pr.pendingChecks.length === 0;

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
        "flex items-stretch gap-3.5 rounded-xl border border-line border-l-4 bg-surface/60 p-4 transition-colors hover:bg-surface",
        accentClass(pr),
      )}
    >
      {/* Queue position (flat priority view only) + pulsing urgency dot */}
      {queuePos != null && (
        <div className="flex w-7 shrink-0 flex-col items-center gap-1.5 pt-0.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-elevated text-[13px] font-extrabold text-fg-muted">
            {queuePos}
          </span>
          {situation.level === "urgent" && (
            <span className={cn("prd-pulse h-2 w-2 rounded-full", DOT_BG[situation.tone])} aria-hidden />
          )}
        </div>
      )}

      {/* Main content */}
      <div className="min-w-0 flex-1">
        {/* Meta: repo #number · time (no host badge — a host filter covers that) */}
        <div className="mb-1 flex items-center gap-2 text-xs text-fg-subtle">
          {hideRepo ? (
            <span className="text-fg-faint">#{pr.number}</span>
          ) : (
            <span className="truncate" title={pr.repo}>
              {pr.repo} <span className="text-fg-faint">#{pr.number}</span>
            </span>
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
          <span className="shrink-0 text-fg-faint" title={new Date(pr.updatedAt).toLocaleString()}>
            · {relativeTime(pr.updatedAt)}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
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
              {copied ? <CheckIcon /> : <CopyIcon />}
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
              {pr.isIgnored ? <EyeIcon /> : <EyeOffIcon />}
            </button>
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

        {/* Footer: author, role, (conditional) status, muted stats, reviewers, CI */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          {pr.author && (
            <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
              <img src={pr.author.avatarUrl} alt="" width={18} height={18} className="rounded-full" />
              {pr.author.login}
            </span>
          )}

          {pr.roles.includes("author") && <span className={roleTag}>Author</span>}
          {pr.roles.includes("reviewer") && <span className={roleTag}>Reviewer</span>}

          {statusPill && (
            <span className="inline-flex items-center rounded-md border border-line-strong bg-elevated px-2 py-0.5 text-[11px] font-semibold text-fg-muted">
              {statusPill}
            </span>
          )}

          {pr.unresolvedThreads > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
              💬 {pr.unresolvedThreads} unresolved
            </span>
          )}

          {pr.hasNewActivity && (
            <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
              ✦ New comments
              <button
                type="button"
                onClick={() => onMarkSeen(pr)}
                title="Mark as seen"
                className="rounded border border-line-strong px-1 leading-none text-fg-muted hover:bg-elevated hover:text-fg"
              >
                ✓
              </button>
            </span>
          )}

          {showAge && (
            <span
              title={`Opened ${ageDays} days ago, still unapproved`}
              className="inline-flex items-center gap-1 text-xs text-fg-subtle"
            >
              ⏳ {ageDays}d
            </span>
          )}

          {pr.reviewers.length > 0 && (
            <span className="inline-flex items-center gap-1">
              {pr.reviewers.map((r) => (
                <ReviewerBadge key={r.login} r={r} />
              ))}
            </span>
          )}

          {/* CI: failures first (always shown), then pending; the passed/approved
              confirmations only when they aren't noise (see showCiPassed). */}
          {pr.failingChecks.map((c) => (
            <CheckBadge key={`f-${c.name}`} check={c} />
          ))}
          {pr.pendingChecks.map((c) => (
            <CheckBadge key={`p-${c.name}`} check={c} />
          ))}
          {showCiPassed && (
            <span className="text-xs text-fg-subtle">
              {pr.ciState === "success" && passingCount > 0
                ? `✓ CI passed (${passingCount})`
                : pr.checks.length === 0
                  ? "No checks"
                  : "CI: no failures"}
            </span>
          )}
          {signal === "approved" && pr.hasHumanApproval && (
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">✓ Approved</span>
          )}
        </div>
      </div>

      {/* Contextual action — the single most useful next step, vertically
          centered. Opening the PR is what every step boils down to, so it routes
          through onOpen (which also clears the new-comment badge). */}
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={() => onOpen(pr)}
          className={cn(
            "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors",
            ctaClasses(situation),
          )}
        >
          {situation.actionLabel}
        </button>
      </div>
    </div>
  );
}
