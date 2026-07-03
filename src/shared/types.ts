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

/**
 * A configured GitHub host, with the access token already resolved to a literal
 * (Bearer) value. Built in the main process from a {@link SettingsHost} by
 * resolving the `gh` CLI token for the host — see `config.ts`.
 */
export interface HostConfig {
  /** Human-readable host name for the UI, e.g. "GitHub" or "Creatio GHE". */
  label: string;
  /** Full URL of the GraphQL endpoint, e.g. https://api.github.com/graphql. */
  graphqlUrl: string;
  /** Resolved access token (sent as `Authorization: Bearer <token>`). */
  token: string;
  /** Repositories in "owner/name" form. */
  repos: string[];
}

/**
 * A host as stored in the user's settings file — credential-free. The token is
 * resolved at fetch time via the `gh` CLI from `graphqlUrl`, so it is never
 * persisted to disk.
 */
export interface SettingsHost {
  label: string;
  graphqlUrl: string;
  repos: string[];
}

/**
 * Appearance preference. "system" follows the OS light/dark setting (the
 * default); "light"/"dark" force that theme regardless of the OS. Applied in the
 * main process via `nativeTheme.themeSource`, which drives the renderer's
 * `prefers-color-scheme` and the native window chrome alike.
 */
export type ThemePreference = "system" | "light" | "dark";

/** Persisted application settings (userData/settings.json) — no tokens. */
export interface Settings {
  /** Auto-refresh interval in seconds. */
  pollIntervalSeconds: number;
  /** Start the app automatically at login (applied only in the packaged app). */
  launchAtLogin: boolean;
  /** Periodically check for and install updates (electron-updater). */
  autoUpdate: boolean;
  /** Light/dark appearance, or follow the OS. */
  theme: ThemePreference;
  hosts: SettingsHost[];
}

/** Sanitized config for the dashboard filters — host labels + repos only. */
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
  /**
   * Number of unresolved review threads whose latest comment is NOT by the PR
   * author — i.e. someone left a comment and the author hasn't replied. This is
   * the "comments without an answer" signal: narrower than `unresolvedThreads`
   * (it excludes threads where the author already replied but didn't resolve,
   * and threads the author opened that are now waiting on a reviewer).
   */
  unaddressedThreads: number;
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
  /**
   * A reviewer (human or bot) left a comment the author has not answered — at
   * least one unresolved review thread whose latest comment is not by the
   * author. Marks the PR as needing the author's action even when the review
   * was a plain "Comment" (not a formal "Request changes") and CI is green —
   * the case the change-request/CI signals miss. Author-only on the card.
   */
  hasUnaddressedComments: boolean;
  /**
   * At least one non-bot reviewer's latest review is an approval. This is what
   * marks a PR "good to go" — a single human approve is enough, independent of
   * the host's branch-protection `reviewDecision` (which stays null/REVIEW_REQUIRED
   * on repos without required-review rules, even when someone has approved).
   */
  hasHumanApproval: boolean;

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
  /** When this host's data was last actually fetched from the network (set by the poller). */
  fetchedAt?: string;
}

/** The full dashboard snapshot. */
export interface DashboardResponse {
  pullRequests: PullRequest[];
  errors: HostError[];
  rateLimits: RateLimitInfo[];
  fetchedAt: string;
  /** Running app version (app.getVersion()) — for display/diagnostics. */
  version: string;
}

/** Data for marking a PR as seen (sent by the renderer from its own copy). */
export interface SeenInput {
  id: string;
  comments: number;
  updatedAt: string;
}

// --- IPC result shapes (cross the preload boundary) -------------------------

/** Result of `getDashboard` / `refresh`. */
export type DashboardResult =
  | { ok: true; snapshot: DashboardResponse }
  | { ok: false; kind: "config" | "transient"; error: string };

/** Result of `getConfig`. */
export type ConfigResult =
  | { ok: true; config: PublicConfig }
  | { ok: false; error: string };

/** Result of `saveSettings`. */
export type SaveSettingsResult = { ok: true } | { ok: false; error: string };

/** `gh` CLI availability + per-host authentication, for the settings UI. */
export interface GhStatus {
  /** Whether the `gh` CLI is installed and on PATH. */
  installed: boolean;
  hosts: Array<{ hostname: string; label: string; authenticated: boolean }>;
}

/**
 * The bridge exposed on `window.api` by the preload script. Mirrors the IPC
 * handlers registered in the main process — the single source of truth for the
 * renderer↔main contract.
 */
export interface PrManagerApi {
  /** Cached snapshot for the initial paint (waits for the first poll tick). */
  getDashboard(): Promise<DashboardResult>;
  /** Force an immediate poll and return the fresh snapshot. */
  refresh(): Promise<DashboardResult>;
  /** Sanitized config (poll interval, host labels, repos) for the filter bar. */
  getConfig(): Promise<ConfigResult>;
  /** Mark PRs as seen (clears the NEW badge). */
  markSeen(items: SeenInput[]): Promise<void>;
  /** Open a URL in the system browser. */
  openExternal(url: string): Promise<void>;
  /** Full settings (with graphqlUrl) for the settings screen. */
  getSettings(): Promise<Settings>;
  /** Validate + persist settings; applies immediately. */
  saveSettings(settings: Settings): Promise<SaveSettingsResult>;
  /** Apply an appearance preference immediately and persist it. */
  setTheme(theme: ThemePreference): Promise<void>;
  /** `gh` CLI install + auth status for the configured hosts. */
  getGhStatus(): Promise<GhStatus>;
  /** The running app version. */
  getAppVersion(): Promise<string>;
  /** Copy text (e.g. a PR URL) to the system clipboard. */
  copyText(text: string): Promise<void>;
  /** Returns release info if a new version was installed since last ack, or null. */
  getWhatsNew(): Promise<{ version: string; url: string } | null>;
  /** Acknowledges the current version (hides "What's new"). */
  dismissWhatsNew(): Promise<void>;
  /** Subscribe to live snapshots. Returns an unsubscribe function. */
  onSnapshot(listener: (snapshot: DashboardResponse) => void): () => void;
  /** Subscribe to config-error messages. Returns an unsubscribe function. */
  onConfigError(listener: (message: string) => void): () => void;
}
