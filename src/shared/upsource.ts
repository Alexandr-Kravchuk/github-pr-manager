// Upsource (JetBrains code review) reviews as dashboard items.
//
// Node-free (see AGENTS.md): the renderer value-imports `isUpsource` and the
// card helpers. The network side lives in `main/upsource.ts`.
//
// A review is listed as a `PullRequest` with `source: "upsource"`, so grouping
// by Jira key, search, the role and author filters, sorting and the seen-state
// work on it unchanged. Every GitHub-only field gets the neutral value that
// keeps GitHub's signals off: no CI, never mergeable, no conflicts, no stack.
// What the card shows comes from `pr.upsource`.

import { ISSUE_KEY_PATTERN } from "./issue-key";
import type {
  DashboardResponse,
  PrRole,
  PullRequest,
  Reviewer,
  ReviewerState,
  UpsourceParticipant,
  UpsourceParticipantState,
  UpsourceReviewInfo,
} from "./types";

/** The host label Upsource reviews carry — the header's host pill and filter. */
export const UPSOURCE_HOST_LABEL = "Upsource";

/** The reviews the dashboard lists: open ones you wrote or review. */
export const UPSOURCE_REVIEWS_QUERY = "state: open and (author: me or reviewer: me)";

/** Whether the item is an Upsource review rather than a GitHub PR. */
export function isUpsource(pr: Pick<PullRequest, "source">): boolean {
  return pr.source === "upsource";
}

const githubOnlyCache = new WeakMap<DashboardResponse, DashboardResponse>();

/**
 * The snapshot without Upsource reviews — what the PR agent reads. It works
 * through GitHub (checkouts, pushes, reviews posted with `gh`), so a review
 * from Upsource must never reach its plan. Memoized per snapshot, since the
 * agent asks for it on every tick of its own timer.
 */
export function githubOnly(snapshot: DashboardResponse): DashboardResponse {
  if (!snapshot.pullRequests.some(isUpsource)) return snapshot;
  let cached = githubOnlyCache.get(snapshot);
  if (!cached) {
    cached = { ...snapshot, pullRequests: snapshot.pullRequests.filter((p) => !isUpsource(p)) };
    githubOnlyCache.set(snapshot, cached);
  }
  return cached;
}

/** Normalizes the server address to its origin; null when it is not a URL. */
export function normalizeUpsourceBaseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

// --- Upsource RPC shapes (only the fields read here) ------------------------

/** `getReviews` → `result.reviews[]`. Roles: 1 author, 2 reviewer, 3 watcher. */
export interface RawUpsourceReview {
  reviewId: { projectId: string; reviewId: string };
  title: string;
  participants?: Array<{ userId: string; role: number; state: number }>;
  /** 1 open, 2 closed. */
  state: number;
  isUnread?: boolean;
  isReadyToClose?: boolean;
  isRemoved?: boolean;
  createdAt: number;
  createdBy?: string;
  updatedAt: number;
  completionRate?: { completedCount: number; reviewersCount: number; hasConcern: boolean };
  discussionCounter?: { count: number; unresolvedCount: number };
  /** End of the due day, epoch ms. */
  deadline?: number;
}

/** `getUserInfo` → `result.infos[]`. */
export interface RawUpsourceUser {
  userId: string;
  name?: string;
  login?: string;
  avatarUrl?: string;
}

const PARTICIPANT_STATE: Record<number, UpsourceParticipantState> = {
  1: "unread",
  2: "read",
  3: "accepted",
  4: "rejected",
};

const PARTICIPANT_ROLE: Record<number, UpsourceParticipant["role"]> = {
  1: "author",
  2: "reviewer",
  3: "watcher",
};

/** How the shared reviewer ring reads an Upsource state. */
const REVIEWER_STATE: Record<UpsourceParticipantState, ReviewerState> = {
  unread: "pending",
  read: "pending",
  accepted: "approved",
  rejected: "changes_requested",
};

const ISSUE_KEY_RE = new RegExp(`\\b(${ISSUE_KEY_PATTERN})\\b`);

/** The review's own id ("CR-1795") is shaped like a Jira key: never take it for one. */
function issueKeyOf(title: string, reviewId: string): string | null {
  const m = title.match(ISSUE_KEY_RE);
  return m && m[1] !== reviewId ? m[1] : null;
}

/** The review's page on the server. */
export function upsourceReviewUrl(baseUrl: string, projectId: string, reviewId: string): string {
  return `${baseUrl}/${encodeURIComponent(projectId)}/review/${encodeURIComponent(reviewId)}`;
}

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/**
 * Maps the reviews `getReviews` returned into dashboard items. A review you only
 * watch, a closed or removed one, or one without you in it is left out.
 */
export function toUpsourcePrs(
  reviews: RawUpsourceReview[],
  users: ReadonlyMap<string, RawUpsourceUser>,
  myUserId: string,
  baseUrl: string,
): PullRequest[] {
  const out: PullRequest[] = [];
  for (const r of reviews) {
    if (r.state !== 1 || r.isRemoved) continue;
    const participants = (r.participants ?? []).map((p) => ({
      userId: p.userId,
      role: PARTICIPANT_ROLE[p.role] ?? "watcher",
      state: PARTICIPANT_STATE[p.state] ?? "unread",
    }));
    const mine = participants.filter((p) => p.userId === myUserId);
    const myRole: UpsourceReviewInfo["myRole"] | null = mine.some((p) => p.role === "author")
      ? "author"
      : mine.some((p) => p.role === "reviewer")
        ? "reviewer"
        : null;
    if (!myRole) continue;
    const myState = mine.find((p) => p.role === myRole)?.state ?? "unread";

    const person = (userId: string) => {
      const u = users.get(userId);
      return { name: u?.name || u?.login || "Unknown", login: u?.login || u?.name || userId, avatarUrl: u?.avatarUrl ?? "" };
    };
    const authorId = participants.find((p) => p.role === "author")?.userId ?? r.createdBy ?? null;
    const reviewersRaw = participants.filter((p) => p.role === "reviewer");
    const shown: UpsourceParticipant[] = reviewersRaw.map((p) => ({ ...person(p.userId), role: p.role, state: p.state }));

    const accepted = r.completionRate?.completedCount ?? reviewersRaw.filter((p) => p.state === "accepted").length;
    const reviewersCount = r.completionRate?.reviewersCount ?? reviewersRaw.length;
    const hasConcern = r.completionRate?.hasConcern ?? reviewersRaw.some((p) => p.state === "rejected");
    const discussions = r.discussionCounter?.count ?? 0;
    const unresolved = r.discussionCounter?.unresolvedCount ?? 0;
    const isReadyToClose = r.isReadyToClose === true;

    // A reviewer who has given a verdict is `reviewed` — the "Reviewed" segment,
    // like a GitHub review you submitted; until then the review is asked of you.
    const verdict = myState === "accepted" || myState === "rejected";
    const roles: PrRole[] = myRole === "author" ? ["author"] : [verdict ? "reviewed" : "reviewer"];

    const reviewers: Reviewer[] = shown.map((p) => ({
      login: p.login,
      avatarUrl: p.avatarUrl,
      reviewState: REVIEWER_STATE[p.state],
    }));
    const { projectId, reviewId } = r.reviewId;
    const numeric = Number(reviewId.replace(/^\D+/, ""));
    const createdAt = iso(r.createdAt) ?? new Date(0).toISOString();
    const updatedAt = iso(r.updatedAt) ?? createdAt;
    const author = authorId ? person(authorId) : null;

    out.push({
      id: `upsource:${projectId}/${reviewId}`,
      source: "upsource",
      hostLabel: UPSOURCE_HOST_LABEL,
      repo: projectId,
      number: Number.isFinite(numeric) ? numeric : 0,
      title: r.title,
      url: upsourceReviewUrl(baseUrl, projectId, reviewId),
      isDraft: false,
      baseRefName: "",
      baseIsDefaultBranch: true,
      stack: null,
      blockedByStack: false,
      requiredReviewPending: false,
      author: author ? { login: author.login, avatarUrl: author.avatarUrl } : null,
      createdAt,
      updatedAt,
      lastCommitPushedAt: null,
      headRefName: "",
      headOid: null,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      mergeMethods: { suggested: null, allowed: [] },
      isCrossRepository: false,
      authorRepliedAt: null,
      reviewerRepliedAt: null,
      requestedOfMe: myRole === "reviewer",
      issueKey: issueKeyOf(r.title, reviewId),
      issueSummary: null,
      parentKey: null,
      parentSummary: null,
      grandparentKey: null,
      grandparentSummary: null,
      reviewDecision: hasConcern ? "CHANGES_REQUESTED" : isReadyToClose ? "APPROVED" : "REVIEW_REQUIRED",
      roles,
      viewerHasReviewed: verdict,
      viewerApproved: myState === "accepted",
      viewerReviewedAt: null,
      viewerReviewedHead: false,
      viewerReviewedOid: null,
      myReReviewDue: false,
      hasNoReviews: accepted === 0 && !hasConcern,
      isStale: false,
      unresolvedThreads: unresolved,
      unaddressedThreads: unresolved,
      totalComments: discussions,
      checks: [],
      failingChecks: [],
      pendingChecks: [],
      ciState: "neutral",
      reviewers,
      awaitingReview: accepted < reviewersCount && !hasConcern,
      hasUnaddressedChangeRequest: hasConcern,
      hasUnaddressedComments: myRole === "author" && unresolved > 0,
      hasUnaddressedReviewFeedback: false,
      hasHumanApproval: accepted > 0,
      hasConflicts: false,
      isBehindBase: false,
      canBeMerged: false,
      hasNewActivity: false,
      returnedToMe: false,
      lastSeenAt: null,
      needsAttention: false,
      isIgnored: false,
      upsource: {
        projectId,
        reviewId,
        myRole,
        myState,
        accepted,
        reviewersCount,
        hasConcern,
        discussions,
        unresolved,
        deadline: iso(r.deadline),
        isUnread: r.isUnread === true,
        isReadyToClose,
        participants: shown,
      },
    });
  }
  return out;
}

/** Every user id the reviews name — what `getUserInfo` is asked about. */
export function upsourceUserIds(reviews: RawUpsourceReview[]): string[] {
  const ids = new Set<string>();
  for (const r of reviews) {
    for (const p of r.participants ?? []) ids.add(p.userId);
    if (r.createdBy) ids.add(r.createdBy);
  }
  return [...ids];
}

// --- What the card says -----------------------------------------------------

/** Whose move the review is, which picks the card's accent. */
export type UpsourceStage = "your-review" | "concern" | "ready" | "waiting";

export function upsourceStage(info: UpsourceReviewInfo): UpsourceStage {
  if (info.myRole === "reviewer") {
    return info.myState === "accepted" || info.myState === "rejected" ? "waiting" : "your-review";
  }
  if (info.hasConcern || info.unresolved > 0) return "concern";
  if (info.isReadyToClose) return "ready";
  return "waiting";
}

/** Tooltip words for a participant's state. */
export const UPSOURCE_STATE_LABEL: Record<UpsourceParticipantState, string> = {
  unread: "hasn't opened it",
  read: "read it",
  accepted: "accepted",
  rejected: "raised a concern",
};

/** The due date as the card shows it ("Due 20 Nov"), and whether it has passed. */
export function upsourceDue(deadline: string | null, now: number): { text: string; overdue: boolean } | null {
  if (!deadline) return null;
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return null;
  const text = `Due ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  return { text, overdue: d.getTime() < now };
}
