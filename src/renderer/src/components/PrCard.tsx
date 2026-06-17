import type { PullRequest, ReviewDecision, Reviewer } from "../../../shared/types";
import { cn, relativeTime } from "../format";
import { CheckBadge } from "./CheckBadge";

interface Props {
  pr: PullRequest;
  onOpen: (pr: PullRequest) => void;
  onMarkSeen: (pr: PullRequest) => void;
  /** Hide the host/repo line (redundant inside a per-repo group). */
  hideRepo?: boolean;
}

/**
 * Left-accent color of the card, by signal priority.
 *  - Red: your PR is blocked and needs your action — failing CI, or a change
 *    request you haven't re-requested review on. Only for PRs you authored.
 *  - Gray (waiting): your PR is awaiting someone else's review and nobody has
 *    approved yet (ball in their court) — nothing required from you, even with
 *    open threads.
 *  - Amber: needs attention (new comments, open threads, CI running).
 *  - Green: at least one human approval, and CI isn't failing or running. A
 *    single human approve is enough — even if other reviewers are still pending,
 *    and even if the PR has no checks at all. We key off an actual approval
 *    rather than `reviewDecision`, which stays null/REVIEW_REQUIRED on repos
 *    without required-review rules.
 */
function accentClass(pr: PullRequest): string {
  const isAuthor = pr.roles.includes("author");

  if (isAuthor && (pr.failingChecks.length > 0 || pr.hasUnaddressedChangeRequest)) {
    return "border-l-red-500";
  }
  if (isAuthor && pr.awaitingReview && !pr.hasNewActivity && !pr.hasHumanApproval) {
    return "border-l-line-strong";
  }
  if (pr.hasNewActivity || pr.unresolvedThreads > 0 || pr.pendingChecks.length > 0) {
    return "border-l-amber-500";
  }
  if (pr.hasHumanApproval && pr.ciState !== "failure" && pr.ciState !== "pending") {
    return "border-l-emerald-500";
  }
  return "border-l-line-strong";
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

const REVIEWER_RING: Record<Reviewer["reviewState"], string> = {
  approved: "ring-emerald-500",
  changes_requested: "ring-red-500",
  pending: "ring-line-strong",
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

export function PrCard({ pr, onOpen, onMarkSeen, hideRepo = false }: Props) {
  const review = reviewLabel(pr.reviewDecision);
  const passingCount = pr.checks.filter((c) => c.state === "success").length;

  return (
    <div
      className={cn(
        "rounded-lg border border-line border-l-4 bg-surface/60 p-4 transition-colors hover:bg-surface",
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
        <div className="mb-2 flex items-center gap-1.5">
          <span className="text-xs text-fg-subtle">Reviewers:</span>
          {pr.reviewers.map((r) => (
            <ReviewerBadge key={r.login} r={r} />
          ))}
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
