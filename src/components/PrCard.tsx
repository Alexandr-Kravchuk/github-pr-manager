import type { PullRequest, ReviewDecision } from "@/lib/types";
import { cn, relativeTime } from "@/lib/format";
import { CheckBadge } from "./CheckBadge";

interface Props {
  pr: PullRequest;
  onOpen: (pr: PullRequest) => void;
  onMarkSeen: (pr: PullRequest) => void;
  /** Hide the host/repo line (redundant inside a per-repo group). */
  hideRepo?: boolean;
}

/** Left-accent color of the card, by signal priority. */
function accentClass(pr: PullRequest): string {
  if (pr.failingChecks.length > 0 || pr.reviewDecision === "CHANGES_REQUESTED") {
    return "border-l-red-500";
  }
  if (pr.hasNewActivity || pr.unresolvedThreads > 0 || pr.pendingChecks.length > 0) {
    return "border-l-amber-500";
  }
  if (pr.ciState === "success" && pr.reviewDecision === "APPROVED") {
    return "border-l-emerald-500";
  }
  return "border-l-zinc-700";
}

function reviewLabel(decision: ReviewDecision): { text: string; cls: string } | null {
  switch (decision) {
    case "APPROVED":
      return { text: "Approved", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" };
    case "CHANGES_REQUESTED":
      return { text: "Changes requested", cls: "bg-red-500/15 text-red-300 border-red-500/40" };
    case "REVIEW_REQUIRED":
      return { text: "Review required", cls: "bg-zinc-600/20 text-zinc-300 border-zinc-600/40" };
    default:
      return null;
  }
}

const pill = "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium";

export function PrCard({ pr, onOpen, onMarkSeen, hideRepo = false }: Props) {
  const review = reviewLabel(pr.reviewDecision);
  const passingCount = pr.checks.filter((c) => c.state === "success").length;

  return (
    <div
      className={cn(
        "rounded-lg border border-zinc-800 border-l-4 bg-zinc-900/60 p-4 transition-colors hover:bg-zinc-900",
        accentClass(pr),
      )}
    >
      {/* Top row: repo/number + updated time */}
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-zinc-500">
        <div className="flex min-w-0 items-center gap-2">
          {hideRepo ? (
            <span className="text-zinc-600">#{pr.number}</span>
          ) : (
            <>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">{pr.hostLabel}</span>
              <span className="truncate" title={pr.repo}>
                {pr.repo} <span className="text-zinc-600">#{pr.number}</span>
              </span>
            </>
          )}
          {pr.isDraft && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">Draft</span>
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
        className="mb-2 block text-left text-[15px] font-semibold leading-snug text-zinc-100 hover:text-sky-300 hover:underline"
      >
        {pr.title}
      </button>

      {/* Meta: author, roles, review decision, comments, new activity */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {pr.author && (
          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
            {/* eslint-disable-next-line @next/next/no-img-element */}
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
          <span className={cn(pill, "border-sky-500/40 bg-sky-500/15 text-sky-300")}>Author</span>
        )}
        {pr.roles.includes("reviewer") && (
          <span className={cn(pill, "border-violet-500/40 bg-violet-500/15 text-violet-300")}>
            Reviewer
          </span>
        )}

        {review && <span className={cn(pill, review.cls)}>{review.text}</span>}

        {pr.unresolvedThreads > 0 && (
          <span className={cn(pill, "border-orange-500/40 bg-orange-500/15 text-orange-300")}>
            💬 {pr.unresolvedThreads} to resolve
          </span>
        )}

        {pr.hasNewActivity && (
          <span className="inline-flex items-center gap-1">
            <span className={cn(pill, "border-amber-400/50 bg-amber-400/20 text-amber-200")}>
              ✦ New comments
            </span>
            <button
              type="button"
              onClick={() => onMarkSeen(pr)}
              title="Mark as seen"
              className="rounded-md border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              ✓
            </button>
          </span>
        )}
      </div>

      {/* CI: failures first, then pending; otherwise a summary */}
      <div className="flex flex-wrap items-center gap-1.5">
        {pr.failingChecks.map((c) => (
          <CheckBadge key={`f-${c.name}`} check={c} />
        ))}
        {pr.pendingChecks.map((c) => (
          <CheckBadge key={`p-${c.name}`} check={c} />
        ))}

        {pr.failingChecks.length === 0 && pr.pendingChecks.length === 0 && (
          <span className="text-xs text-zinc-500">
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
