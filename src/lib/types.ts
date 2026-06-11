/**
 * Domain types for the pull-request dashboard.
 * Raw GraphQL responses are mapped into these types in `github.ts`.
 */

/** Normalized check (CI) state on top of GitHub's various terms. */
export type CheckState =
  | "success"
  | "failure"
  | "pending"
  | "neutral"
  | "skipped"
  | "unknown";

/** PR-level review decision. */
export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

/** Why this PR shows up on the dashboard. */
export type PrRole = "author" | "reviewer";

/** Configuration of a single GitHub host (github.com or GitHub Enterprise). */
export interface HostConfig {
  /** Human-readable host name for the UI, e.g. "GitHub" or "Creatio GHE". */
  label: string;
  /** Full URL of the GraphQL endpoint, e.g. https://api.github.com/graphql. */
  graphqlUrl: string;
  /**
   * Access token. Supported forms:
   *  - literal:      "ghp_xxx"
   *  - env variable: "env:GITHUB_TOKEN"
   *  - gh CLI:       "gh" (uses `gh auth token --hostname <host>`)
   */
  token: string;
  /** Repositories in "owner/name" form. */
  repos: string[];
}

/** Root application config (config.json). */
export interface AppConfig {
  /** Auto-refresh interval in seconds. */
  pollIntervalSeconds: number;
  hosts: HostConfig[];
}

/** Sanitized config for the client — without tokens. */
export interface PublicConfig {
  pollIntervalSeconds: number;
  hosts: Array<{ label: string; repos: string[] }>;
}

/** State of an individual reviewer on a PR. */
export type ReviewerState = "approved" | "changes_requested" | "pending";

/** An individual reviewer and their current review state. */
export interface Reviewer {
  login: string;
  avatarUrl: string;
  reviewState: ReviewerState;
}

/** A single status/CI check on the PR's latest commit. */
export interface CheckItem {
  name: string;
  /** "check" — GitHub Actions/CheckRun; "status" — commit status (often Sonar etc.). */
  kind: "check" | "status";
  state: CheckState;
  url: string | null;
}

/** The pull-request model consumed by the UI. */
export interface PullRequest {
  /** Global node id — a stable key across refreshes. */
  id: string;
  hostLabel: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  author: { login: string; avatarUrl: string } | null;
  createdAt: string;
  updatedAt: string;
  reviewDecision: ReviewDecision;
  /** The current user's roles on this PR (author / reviewer). */
  roles: PrRole[];

  /** Number of unresolved review threads — "comments to fix". */
  unresolvedThreads: number;
  /** Total number of comments (issue + inline) — basis for new-comment detection. */
  totalComments: number;

  /** All checks (deduplicated by name, worst state wins). */
  checks: CheckItem[];
  /** Subset of checks in the failure state. */
  failingChecks: CheckItem[];
  /** Subset of checks in the pending state. */
  pendingChecks: CheckItem[];
  /** Aggregated CI state (from statusCheckRollup, falling back to checks). */
  ciState: CheckState;

  /** Individual reviewers with their current review state. */
  reviewers: Reviewer[];

  /** A reviewer's review is still pending (GitHub's "yellow dots"). */
  awaitingReview: boolean;
  /**
   * A reviewer requested changes and has NOT been re-requested — i.e. the ball
   * is in the author's court. If the change-requester was re-requested, this is
   * false (we're waiting on them again, not on the author).
   */
  hasUnaddressedChangeRequest: boolean;

  /** true if new comments/activity appeared since the last time it was viewed. */
  hasNewActivity: boolean;
  /** ISO time of the last "mark seen", if any. */
  lastSeenAt: string | null;
  /** Roll-up flag: something needs attention (failing CI / new activity / changes requested). */
  needsAttention: boolean;
}

/** A fetch error for a specific host. */
export interface HostError {
  hostLabel: string;
  message: string;
}

/** GraphQL rate-limit info at request time. */
export interface RateLimitInfo {
  hostLabel: string;
  remaining: number;
  cost: number;
  resetAt: string;
}

/** The full dashboard endpoint response. */
export interface DashboardResponse {
  pullRequests: PullRequest[];
  errors: HostError[];
  rateLimits: RateLimitInfo[];
  fetchedAt: string;
  /** Running build id — lets the client auto-reload after a redeploy. */
  version: string;
}
