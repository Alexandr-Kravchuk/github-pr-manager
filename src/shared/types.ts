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

/**
 * Why this PR shows up on the dashboard.
 *
 * - `author` — you opened it;
 * - `reviewer` — your review is requested, personally or via one of your teams;
 * - `reviewed` — you already submitted a review on it. GitHub clears the review
 *   request the moment you review, so the PR stops matching
 *   `review-requested:@me`; `reviewed-by:@me` is what keeps it on the dashboard.
 *
 * `reviewed` is a **passive** role: nobody is waiting on you, so on its own it
 * does not make the PR need attention — only its return to your court does (see
 * `applyActivity` in state.ts). A re-request puts `reviewer` back alongside it.
 */
export type PrRole = "author" | "reviewer" | "reviewed";

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

/**
 * Jira connection for parent-task grouping — credential-free, like the rest of
 * settings. The API token is stored separately (encrypted via Electron
 * `safeStorage`), never here. `undefined` means Jira grouping is not set up.
 */
export interface JiraSettings {
  /** Site base URL, e.g. "https://your-org.atlassian.net". */
  baseUrl: string;
  /** Atlassian account email — the username half of the API-token Basic auth. */
  email: string;
}

/** Which PR events raise a desktop notification. Each maps to a group agreed
 *  with the user — see `shared/notify.ts` for the exact transitions. */
export interface NotificationEventToggles {
  /**
   * "Your turn to act": you were requested as a reviewer, or a change was
   * requested / a comment left unanswered on a PR you authored.
   */
  yourTurn: boolean;
  /** CI went red on a PR you authored. */
  ciFailed: boolean;
  /** Good news on a PR you authored: a human approval landed. */
  goodNews: boolean;
}

/**
 * Desktop-notification preferences. Delivery (native window / sound) is
 * independent from *which* events fire: both default on, except `sound`, which
 * is opt-in so the first event doesn't startle. When `native` and `sound` are
 * both on the OS plays its own sound; with `native` off, `sound` falls back to
 * a synthesized beep in the renderer.
 */
export interface NotificationSettings {
  /** Master switch — off silences everything regardless of the toggles below. */
  enabled: boolean;
  /** Show a native OS notification (Notification Center / Action Center). */
  native: boolean;
  /** Play a sound alongside the event. */
  sound: boolean;
  events: NotificationEventToggles;
}

/** Persisted application settings (userData/settings.json) — no tokens. */
export interface Settings {
  /** Auto-refresh interval in seconds. */
  pollIntervalSeconds: number;
  /** Start the app automatically at login (applied only in the packaged app). */
  launchAtLogin: boolean;
  /** Periodically check for and install updates (electron-updater). */
  autoUpdate: boolean;
  /**
   * Closing the window hides it to the tray instead of quitting. The app keeps
   * polling and notifying; Quit lives in the tray menu.
   */
  closeToTray: boolean;
  /** Light/dark appearance, or follow the OS. */
  theme: ThemePreference;
  /**
   * Whether an unread-comment count is kept per PR. Off drops that one channel:
   * `hasNewActivity` never gets set, so the `New comments` chip, the card badge
   * with its `Mark as seen` button, the header stat and the `newOnly` filter all
   * go away, and `returnedToMe` is left with a new push as its only trigger.
   *
   * It also mutes the other two comment-shaped signals that would otherwise
   * still light a card up: a comment awaiting your reply (`hasUnaddressedComments`)
   * and unresolved threads (`unresolvedThreads`) stop turning a card red and
   * stop counting towards `needsAttention` while the setting is off — see
   * `applyActivity` and `prSignal`. They still `notify` (that channel is
   * separate — see `notify.ts`), and they still count as work owed once the
   * setting is back on.
   *
   * Two further consequences worth knowing before changing this: `prSignal`'s
   * `waiting` branch tests `!hasNewActivity`, so your own PR that is awaiting
   * review and picks up a comment keeps the grey `waiting` accent instead of
   * turning amber; and `hashSnapshot` stops hashing `totalComments`, so a comment
   * count that moves on its own no longer pushes a snapshot — but a real new
   * comment also bumps the PR's `updatedAt`, which stays hashed because the card
   * renders it, so comment ticks are NOT silenced.
   *
   * For someone who reads comments in GitHub itself and doesn't want the
   * dashboard to keep a second unread state.
   */
  trackComments: boolean;
  /** Desktop-notification preferences. */
  notifications: NotificationSettings;
  hosts: SettingsHost[];
  /** Optional Jira connection for parent-task grouping (token stored separately). */
  jira?: JiraSettings;
}

/** Jira setup state for the UI, from the main process. */
export interface JiraStatus {
  /** true when baseUrl + email are set AND an encrypted token is stored. */
  configured: boolean;
  /**
   * The configured Jira site origin, or null when none is set. Carried here
   * because the renderer needs it to link a PR's issue key to `/browse/<KEY>`,
   * and `PublicConfig` is about hosts and polling. A site URL is not a secret —
   * the email and the token stay in the main process.
   */
  baseUrl: string | null;
  /** baseUrl + email are set (token may still be missing). */
  hasConfig: boolean;
  /** An encrypted token is stored. */
  hasToken: boolean;
  /** false when the OS keychain / safeStorage is unavailable (can't store a token). */
  encryptionAvailable: boolean;
}

/**
 * Outcome of the last Jira parent-enrichment pass, so the UI can explain why
 * parent grouping is empty instead of failing silently. Absent when Jira is off
 * or there were no issue keys to resolve.
 */
export interface JiraHealth {
  /** "ok" resolved ≥1 parent; "empty" the call succeeded but nothing resolved
   * (token may not see the issues, or none are subtasks); "error" the call failed. */
  state: "ok" | "empty" | "error";
  /** Failure detail for `state: "error"`. */
  message?: string;
  /** Diagnostics: issue keys queried and parents resolved this pass. */
  queried: number;
  resolved: number;
}

/** Sanitized config for the dashboard filters — host labels + repos only. */
export interface PublicConfig {
  pollIntervalSeconds: number;
  hosts: Array<{ label: string; repos: string[] }>;
  /**
   * Mirror of {@link Settings.trackComments} — the renderer needs it to drop the
   * comment-driven chip, badge and header stat, and it is not a secret.
   */
  trackComments: boolean;
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
  /** Name of the base branch this PR targets, e.g. "main" or "feature/x". */
  baseRefName: string;
  /**
   * true when the PR targets the repository's default branch (main/master/
   * trunk/…). false marks a stacked PR (based on another branch) — the card
   * shows a green umbrella for it.
   */
  baseIsDefaultBranch: boolean;
  author: { login: string; avatarUrl: string } | null;
  createdAt: string;
  updatedAt: string;
  /** ISO time the latest commit was pushed — the basis for new-push detection. */
  lastCommitPushedAt: string | null;
  /** Name of the head branch, e.g. "feature/ENG-93374-foo" — used as a fallback issue-key source. */
  headRefName: string;
  /**
   * Issue-tracker key parsed from the title (falling back to the head branch),
   * e.g. "ENG-93374", or null when none is found. Used to group related PRs.
   */
  issueKey: string | null;
  /**
   * Parent issue key resolved from Jira for this PR's {@link issueKey}, e.g. the
   * task "ENG-93367" that "ENG-93374" is a subtask of — null when Jira isn't
   * configured, the key has no parent, or resolution failed. Set by the poller's
   * parent enricher, not by `github.ts`.
   */
  parentKey: string | null;
  /** Summary (title) of {@link parentKey}, for the group heading. */
  parentSummary: string | null;
  reviewDecision: ReviewDecision;
  /** The current user's roles on this PR (author / reviewer / reviewed). */
  roles: PrRole[];
  /**
   * true when the current user has already submitted an opinionated review
   * (approve / request-changes) on this PR. Note: GitHub clears the `reviewer`
   * role once you review, so this is how a reviewed PR is still recognized as
   * "mine" for the returned-to-me signal. Unlike the `reviewed` role — which is
   * why the PR is on the dashboard at all — this keys off the reviews carried on
   * the PR itself, so it is also true for a PR fetched as a re-request.
   */
  viewerHasReviewed: boolean;
  /**
   * true when the current user's latest opinionated review is an approval.
   * Narrower than {@link viewerHasReviewed}, which is equally true after a
   * change request, and unrelated to {@link hasHumanApproval}, which is about
   * anyone. Backs the "Hide my approvals" filter: from your side such a PR is
   * done. Falls back to false on its own when a later review of yours
   * supersedes it, or when branch protection dismisses the approval on a push.
   */
  viewerApproved: boolean;
  /**
   * true when YOUR change request still stands and the author has since acted
   * (pushed a new commit, or replied and left nothing unresolved) — the merge is
   * blocked on your re-review and GitHub will not ask you for it, because
   * submitting a review cleared the request.
   *
   * The mirror of {@link viewerApproved}, and deliberately a STATE rather than a
   * diff: unlike `returnedToMe` it is computed at fetch time from the PR alone
   * and never consults the seen-snapshot, so opening the card cannot clear it.
   * It stays true until you actually re-review — a plain "Comment" review does
   * NOT clear it, since your change request goes on blocking the merge.
   *
   * Shares the `latestOpinionatedReviews(first: 15)` cap with its siblings, but
   * note the failure direction is the opposite of `viewerApproved`'s: past 15
   * distinct opinionated reviewers your own node can fall off the page, this
   * reads false and the PR goes quiet — losing work rather than failing safe.
   */
  myReReviewDue: boolean;
  /**
   * true when nobody has submitted an opinionated review yet — the "nobody has
   * looked at it" pile. Keys off opinionated reviews (approve / request-changes);
   * a plain "Comment" review does not clear it.
   */
  hasNoReviews: boolean;

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

  /**
   * GitHub reports a real merge conflict (`mergeable === "CONFLICTING"`) — the
   * branch cannot merge until the author integrates the base. Only the hard
   * CONFLICTING verdict counts; the transient UNKNOWN that GitHub returns right
   * after a push (while it recomputes mergeability) stays false, so a freshly
   * pushed PR is not flagged as conflicting until GitHub settles. Author-only
   * signal on the card: only the author can resolve their own conflict.
   */
  hasConflicts: boolean;

  /**
   * Roll-up flag: the PR is ready to merge. Composite of GitHub's mergeable
   * signal plus the dashboard's own readiness checks — true when the PR is not a
   * draft, has no merge conflicts (GitHub `mergeable === "MERGEABLE"`), has at
   * least one human approval, has no unaddressed change request, and CI is not
   * failing or still running. GitHub computes `mergeable` asynchronously and may
   * report UNKNOWN right after a push; while it is UNKNOWN this stays false and
   * flips true on a later poll once GitHub settles.
   */
  canBeMerged: boolean;

  /** true if new comments/activity appeared since the last time it was viewed. */
  hasNewActivity: boolean;
  /**
   * true when a PR you've already engaged with (reviewed, or opened from the
   * dashboard) got new comments OR new commits pushed since you last saw it —
   * i.e. the ball is back in your court to re-review. Author's own pushes don't
   * count (never set on a PR you authored). Set in `state.ts`.
   */
  returnedToMe: boolean;
  /** ISO time of the last "mark seen", if any. */
  lastSeenAt: string | null;
  /** Roll-up flag: something needs attention (failing CI / new activity / changes requested). */
  needsAttention: boolean;
  /**
   * true if the user has ignored this PR. Ignored PRs are hidden from the
   * dashboard and excluded from counts / buddy mood, surfacing only when the
   * "Ignored" filter is on. Persisted across relaunches — see `ignored.ts`.
   */
  isIgnored: boolean;
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
  /** Health of the last Jira parent-enrichment pass (absent when Jira is off). */
  jiraHealth?: JiraHealth;
}

/** Data for marking a PR as seen (sent by the renderer from its own copy). */
export interface SeenInput {
  id: string;
  comments: number;
  updatedAt: string;
  /** The latest commit's push time at the moment of viewing (for new-push detection). */
  lastCommitPushedAt: string | null;
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

/** Result of `saveSettings`. `warning` carries a preference that was saved
 *  but could not take effect (today: close-to-tray with no usable tray). */
export type SaveSettingsResult = { ok: true; warning?: string } | { ok: false; error: string };

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
  /** Ignore or un-ignore a PR (hides it from the dashboard when ignored). */
  setIgnored(id: string, ignored: boolean): Promise<void>;
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
  /** Jira setup state (config + stored token presence) for the settings UI and grouping. */
  getJiraStatus(): Promise<JiraStatus>;
  /**
   * Store (or clear, when given an empty string) the Jira API token, encrypted
   * via the OS keychain. Returns whether it was persisted.
   */
  setJiraToken(token: string): Promise<{ ok: boolean; error?: string }>;
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
  /**
   * Subscribe to "play a notification sound" pings from the main process. Sent
   * only when the user wants a sound but has native notifications off (when
   * native is on, the OS plays its own sound). Returns an unsubscribe function.
   */
  onNotifySound(listener: () => void): () => void;
  /** Subscribe to config-error messages. Returns an unsubscribe function. */
  onConfigError(listener: (message: string) => void): () => void;
  /** Subscribe to auto-update progress. Returns an unsubscribe function. */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  /**
   * Subscribe to the menu's "Settings" item (CmdOrCtrl+,). The accelerator lives
   * in the application menu (main process), so the renderer only learns about
   * it through this event. Returns an unsubscribe function.
   */
  onOpenSettings(listener: () => void): () => void;
  /**
   * Subscribe to the menu's "Refresh" item (CmdOrCtrl+R). The renderer runs its
   * own refresh so the loading state stays consistent with the header button.
   * F5 never comes through here — the renderer sees that key directly.
   * Returns an unsubscribe function.
   */
  onRefreshRequest(listener: () => void): () => void;
}

/** Auto-update lifecycle, pushed from main as electron-updater progresses. */
export type UpdateStatus =
  | { state: "downloading"; version: string; percent: number }
  | { state: "downloaded"; version: string };
