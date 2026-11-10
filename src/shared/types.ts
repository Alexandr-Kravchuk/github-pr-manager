/**
 * Domain types for the pull-request dashboard.
 * Raw GraphQL responses are mapped into these types in `github.ts`.
 */
import type { CloseStaleOptions, CloseStaleResult, JiraTaskInfo } from "./stale";

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
  /** See {@link SettingsHost.allRepos}. */
  allRepos?: boolean;
  /** See {@link SettingsHost.searchLimit}. */
  searchLimit?: number;
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
  /**
   * Search every repository on the host instead of only `repos`: the searches
   * are all scoped to you (`author:@me`, `review-requested:@me`, …), so without
   * the `repo:` filter they find your PRs wherever they are. Opt-in so an
   * existing host keeps its narrower scope. Absent = false.
   */
  allRepos?: boolean;
  /**
   * How many PRs each search returns (GitHub's `first:`, 1–100). Absent = 25.
   * Each search is capped separately, so the dashboard can show more than this.
   */
  searchLimit?: number;
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
  /**
   * Atlassian account email — the username half of the API-token Basic auth.
   * Only the API-token fallback needs it; the `twg` CLI signs in on its own.
   */
  email?: string;
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

/**
 * "Start a Claude session on this PR" — opt-in. A click opens a terminal in the
 * PR's local checkout and runs `claude` with a prompt picked from the PR's state
 * (see `shared/claude-launch.ts`).
 */
export type ClaudeTerminal = "auto" | "iterm" | "terminal" | "desktop";

export interface ClaudeSettings {
  enabled: boolean;
  /** Folder whose subfolders are searched for a checkout by git remote; "" = ~/Projects. */
  projectsRoot: string;
  /** Explicit checkout per "owner/name" — wins over the search. */
  repoPaths: Record<string, string>;
  /**
   * Prompt template per launch kind; `{url}` is the PR URL. `explainGroup` and
   * `reviewGroup` are the group heading's "Explain all" and "Review all":
   * `{key}`, `{count}`, `{urls}` and, for the review, `{prompts}`.
   */
  prompts: Record<"drive" | "review" | "close" | "explain" | "open" | "explainGroup" | "reviewGroup", string>;
  /**
   * Prompts only the PR agent runs (see `AgentSettings`). Kept apart from
   * `prompts` on purpose: those keys are the Claude button's launch kinds, and a
   * key there would show up in the button's menu and its IPC allow-list.
   */
  agentPrompts: Record<AgentPromptKey, string>;
  /**
   * Where the session opens. `auto` takes iTerm2 when it is installed, else
   * Terminal (macOS; a `cmd` window on Windows). The system's "default
   * terminal" is not consulted: macOS has no such setting a launcher can ask.
   * `desktop` opens the Code tab of Claude Desktop through its
   * `claude://code/new` link instead — on every platform, but the prompt is
   * only prefilled (Enter sends it) and Desktop asks to confirm the folder on
   * every launch. `iterm` / `terminal` fall back to `auto` off macOS.
   */
  terminal: ClaudeTerminal;
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
   * go away.
   *
   * It also mutes the other two comment-shaped signals that would otherwise
   * still light a card up: a comment awaiting your reply (`hasUnaddressedComments`)
   * and unresolved threads (`unresolvedThreads`) stop turning a card red and
   * stop counting towards `needsAttention` while the setting is off — see
   * `applyActivity` and `prSignal`. They still `notify` (that channel is
   * separate — see `notify.ts`), and they still count as work owed once the
   * setting is back on.
   *
   * And it changes WHERE the view comes from: while off, no displayed signal is
   * derived from the stored seen-snapshot. `returnedToMe`'s push term becomes
   * "the author pushed after my last review" ({@link viewerReviewedAt}) instead
   * of "newer than my snapshot", and `markSeen` writes nothing — so opening a PR
   * cannot change the dashboard, and what it shows before the click is already
   * the true state rather than one that corrects itself on a glance. The price,
   * accepted deliberately: a PR where the viewer left only a plain "Comment"
   * review has no review timestamp to measure against and stays quiet, and the
   * `returned_to_me` notification is limited to the same live condition.
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
  /** Claude session launcher (off by default). */
  claude: ClaudeSettings;
  /**
   * Days a PR stays open before it is marked stale and, when it is yours, can
   * be closed together with its Jira task. 0 switches it off. See `shared/stale.ts`.
   */
  staleAfterDays: number;
  /** The PR agent (off by default). */
  agent: AgentSettings;
}

/** The prompts only the PR agent uses, next to the Claude button's ones. */
export type AgentPromptKey = "triage" | "rereview" | "afterMerge" | "selfReview" | "validateComments";

/** Off never runs; shadow does the work and waits for you before posting; on posts and tells you after. */
export type AgentMode = "off" | "shadow" | "on";

/** The kinds of session the agent starts — each has its own tool set. */
export type AgentRunKind = "review" | "brief" | "rereview" | "drive" | "afterMerge";

/** A merge method, in `gh pr merge` terms. */
export type MergeMethod = "merge" | "squash" | "rebase";

/**
 * The PR agent: it works on your PRs in the background with Claude Code.
 * Everything that can be tuned is here (see the Agent tab of Settings); the
 * hard safety rails — merging only on your click, never pushing to anyone
 * else's branch, never skipping permission checks — are deliberately not.
 */
export interface AgentSettings {
  enabled: boolean;
  /** Model for agent runs; "" = Claude Code's default. */
  model: string;
  /** Effort for agent runs; "" = Claude Code's default. */
  effort: "" | "low" | "medium" | "high";
  /** Where each run's git worktree goes; "" = `<checkout>/.claude/worktrees`. */
  worktreeDir: string;
  /** Remove a run's worktree once its PR is merged or closed. */
  removeWorktree: boolean;
  /** "owner/name" the agent may work in; empty = every repository with a checkout. */
  repos: string[];
  scenarios: {
    /** A review requested of you personally, on a PR within the size limit. */
    review: {
      mode: AgentMode;
      maxLines: number;
      maxFiles: number;
      /** Also take requests made of a team you are in (off: they would eat the daily limit). */
      teamRequests: boolean;
      /** Also review drafts (off: a draft is picked up once it is marked ready). */
      drafts: boolean;
      /** Hold the approve while another reviewer's change request is open. */
      holdApproveOnChangeRequest: boolean;
    };
    /** A review requested of you on a PR over the limit: a brief, never posted. */
    brief: { mode: "off" | "on" };
    /** The author replied in your threads. */
    rereview: { mode: AgentMode; resolve: boolean; approve: boolean };
    /** Your PR is ready to merge: offer the Merge button (the agent never merges itself). */
    merge: {
      mode: "off" | "offer";
      requireAllReviewers: boolean;
      requireThreadsResolved: boolean;
      requireChecksGreen: boolean;
      /** "github" takes the repository's own suggestion. */
      method: "github" | MergeMethod;
      deleteBranch: boolean;
    };
    /**
     * Your PR, before reviewers see it: a self-review of each head you push
     * (the review in dry run, its findings validated, the confirmed ones fixed).
     */
    selfReview: { mode: AgentMode };
    /** Your PR fails CI or has a conflict. */
    driveCi: { mode: AgentMode; maxAttempts: number };
    /** Reviewers commented on your PR. */
    driveComments: { mode: AgentMode };
    /**
     * An approval dismissed by a push that only brought in the base branch
     * (`shared/agent-reapprove.ts`): yours on someone's PR is given again; on
     * your PR, the reviewers whose approvals went are asked again.
     */
    reapprove: { mode: AgentMode; askReviewers: boolean };
  };
  limits: {
    parallel: number;
    perDay: number;
    /** A run is stopped (and handed to you) after this many minutes. */
    maxMinutes: number;
    /** No new run starts between `from` and `to` ("HH:MM", may wrap past midnight). */
    quietHours: { enabled: boolean; from: string; to: string };
    /** Suggest switching a scenario from shadow to on after this many results accepted unchanged. */
    promoteAfter: number;
  };
  permissions: {
    /** `--allowedTools` rules per kind of run. */
    tools: Record<AgentRunKind, string[]>;
    /** The defaults' version these lists were saved under (`AGENT_TOOLS_VERSION`): newer default rules are added on load. */
    toolsVersion: number;
    /** Allow pushing to the head branch of your own PR (drive). */
    pushOwnBranch: boolean;
  };
  /**
   * Mermaid diagrams of the change (`shared/agent-diagrams.ts`), drawn by a
   * short model run of their own after a review or a brief, shown on its card.
   */
  diagrams: {
    enabled: boolean;
    /** Only for a PR with at least this many changed lines (additions + deletions). */
    minLines: number;
    /** Post them with the review, as one comment — unless the PR has a Mermaid diagram already. */
    post: boolean;
    /** Model for the drawing run; "" = Claude Code's default. */
    model: string;
  };
  companion: { headerChip: boolean; trayState: boolean };
  notifications: { needsYou: boolean; failed: boolean; finished: boolean };
  policy: {
    /** Appended to everything the agent posts; it cannot be removed, only reworded. */
    signature: string;
    logRetentionDays: number;
  };
}

/** Where Jira data comes from: the `twg` CLI's own sign-in, or the stored API token. */
export type JiraSource = "twg" | "token";

/** State of the Atlassian `twg` CLI, the primary Jira source. */
export interface TwgStatus {
  /**
   * `signed-in`: `twg whoami` answered; `signed-out`: twg is installed but has
   * no usable login; `not-installed`: no `twg` on PATH; `error`: anything else;
   * `checking`: not known yet — `twg whoami` is still running.
   */
  state: "signed-in" | "signed-out" | "not-installed" | "error" | "checking";
  /** Display name of the signed-in account. */
  account?: string;
  /** twg's own message for `signed-out` / `error`. */
  message?: string;
}

/** Whether `getJiraStatus` reuses the last twg status or waits for a new `twg whoami`. */
export type JiraStatusMode = "cached" | "fresh";

/** Jira setup state for the UI, from the main process. */
export interface JiraStatus {
  /**
   * true when the site URL is set AND a source is set up: twg is installed (in
   * any sign-in state), or an API token and the account email are stored. Not
   * "works right now" — see `jiraConfigured`; the `auth` health reports that.
   */
  configured: boolean;
  /** The `twg` CLI, tried before the API token. */
  twg: TwgStatus;
  /** The source that can sign in now — twg signed in, else a token with its email — or null when none can. */
  signInSource: JiraSource | null;
  /**
   * The configured Jira site origin, or null when none is set. Carried here
   * because the renderer needs it to link a PR's issue key to `/browse/<KEY>`,
   * and `PublicConfig` is about hosts and polling. A site URL is not a secret —
   * the email and the token stay in the main process.
   */
  baseUrl: string | null;
  /** The site URL is set (a source may still be missing). */
  hasConfig: boolean;
  /** The account email the API token needs is set. */
  hasEmail: boolean;
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
   * (the account may not see the issues, or none are subtasks); "error" the call
   * failed; "auth" Jira or twg rejected the credentials — see `source`. */
  state: "ok" | "empty" | "error" | "auth";
  /** Failure detail for `state: "error"` / `"auth"`. */
  message?: string;
  /** Which source the pass used, or — for `auth` — which one was rejected. */
  source?: JiraSource;
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
  /** Mirror of `Settings.claude.enabled` — whether cards show the Claude button. */
  claudeEnabled: boolean;
  /** Whether Claude sessions open in Claude Desktop — the only place "Review all" can nest its sessions. */
  claudeDesktop: boolean;
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
/**
 * GitHub's native PR stack (`PullRequest.stack` / `stackEntry`): an ordered
 * chain of PRs, each based on the one below it. GitHub merges only the bottom
 * one — every PR above it reports `mergeStateStatus: CLEAN` all the same, so
 * readiness has to be gated on `position` here rather than on GitHub's verdict.
 */
export interface PrStack {
  /** The stack's number within its repository (the "Stack #1623" GitHub shows). */
  number: number;
  /** 1 is the bottom — closest to the base branch, the only mergeable one. */
  position: number;
  /** How many PRs the stack holds, open ones included whether listed here or not. */
  size: number;
  /** The branch the stack's bottom PR targets — the row under the stack menu. */
  baseRefName: string;
  /** Every PR of the stack GitHub listed (first 10), bottom first. */
  entries: PrStackEntry[];
  /**
   * The open PR at the bottom of the stack — the one this PR waits for. Null on
   * the bottom PR itself, and when the stack's first page did not reach it.
   */
  bottom: { number: number; url: string } | null;
}

/** One PR of a stack, as the stack menu lists it. */
export interface PrStackEntry {
  position: number;
  number: number;
  title: string;
  url: string;
  /** GitHub's PR state: "OPEN" | "MERGED" | "CLOSED". */
  state: string;
}

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
  /**
   * The native GitHub stack this PR belongs to, or null when it is in none —
   * including on a host whose GraphQL schema has no stacks yet.
   */
  stack: PrStack | null;
  /**
   * In a stack and not at its bottom: GitHub refuses to merge it until the PRs
   * below it are merged, whatever its own reviews and checks say.
   */
  blockedByStack: boolean;
  /**
   * Branch protection still demands a review the PR does not have yet — most
   * often a code owner's approval, or more approvals than it got. GitHub says
   * so with `reviewDecision: REVIEW_REQUIRED` together with
   * `mergeStateStatus: BLOCKED`; an approval from someone who does not satisfy
   * the rule leaves both as they are, so `hasHumanApproval` alone cannot tell.
   * `REVIEW_REQUIRED` without `BLOCKED` does not count: nothing gates the merge.
   * Without any human approval it stays false — such a PR is simply awaiting
   * review, and the card keeps its plain "Review required" pill.
   */
  requiredReviewPending: boolean;
  author: { login: string; avatarUrl: string } | null;
  createdAt: string;
  updatedAt: string;
  /** ISO time the latest commit was pushed — the basis for new-push detection. */
  lastCommitPushedAt: string | null;
  /** Name of the head branch, e.g. "feature/ENG-93374-foo" — used as a fallback issue-key source. */
  headRefName: string;
  /**
   * Oid of the head commit, or null when GitHub listed none. The PR agent keys
   * its ledger on it and merges with `--match-head-commit` against it, so a push
   * between the offer and the click is refused by GitHub itself.
   */
  headOid: string | null;
  /** Lines added and removed and files touched — the agent's "big PR" limit reads these. */
  additions: number;
  deletions: number;
  changedFiles: number;
  /**
   * The repository's merge methods: the one GitHub suggests to this viewer and
   * the ones the repository allows (rulesets are not reflected here — a merge
   * they refuse is reported as GitHub's answer).
   */
  mergeMethods: { suggested: MergeMethod | null; allowed: MergeMethod[] };
  /** The head branch lives in a fork: the PR agent never pushes to it. */
  isCrossRepository: boolean;
  /** The latest thread comment by the PR's author, when a thread ends with one (any thread). */
  authorRepliedAt: string | null;
  /** The latest comment by someone else that ends an unresolved thread. */
  reviewerRepliedAt: string | null;
  /**
   * A review is asked of you by name (`review-requested:@me`), as opposed to of
   * a team you are in — both give the `reviewer` role. The agent takes team
   * requests only when told to, so a busy team can't use up its daily limit.
   */
  requestedOfMe: boolean;
  /**
   * Issue-tracker key parsed from the title (falling back to the head branch),
   * e.g. "ENG-93374", or null when none is found. Used to group related PRs.
   */
  issueKey: string | null;
  /**
   * Summary (title) of {@link issueKey} as Jira has it — what the "group by
   * issue" heading shows next to the key, so a cluster reads as the work it is
   * rather than as a number. Null when Jira isn't configured, the key is unknown
   * to it, or resolution failed; the heading then falls back to the bare key.
   * Set by the poller's Jira enricher, not by `github.ts`.
   */
  issueSummary: string | null;
  /**
   * Parent issue key resolved from Jira for this PR's {@link issueKey}, e.g. the
   * task "ENG-93367" that "ENG-93374" is a subtask of — null when Jira isn't
   * configured, the key has no parent, or resolution failed. Set by the poller's
   * parent enricher, not by `github.ts`.
   */
  parentKey: string | null;
  /** Summary (title) of {@link parentKey}, for the group heading. */
  parentSummary: string | null;
  /**
   * The parent of {@link parentKey} when this PR's issue is a subtask — the epic
   * above its task (ENG-104627 → ENG-103702 → ENG-102776). Without it a subtask
   * whose task has no PR of its own clusters under the task and never joins
   * the PRs of the epic's other tasks. Null for a task or epic PR, or when Jira
   * resolved none.
   */
  grandparentKey: string | null;
  /** Summary (title) of {@link grandparentKey}, for the group heading. */
  grandparentSummary: string | null;
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
   * When the current user submitted their latest opinionated review, or null if
   * they never did (including the common "Comment"-only review — see
   * {@link viewerHasReviewed}).
   *
   * Read by `returnedToMe` in `state.ts` to reject a push you have ALREADY
   * reviewed: that flag otherwise compares the push only against the stored
   * snapshot, which goes stale while the app isn't polling, so a push that
   * landed *before* your review still read as "back in your court" and latched
   * the card into Need attention until you opened it.
   */
  viewerReviewedAt: string | null;
  /**
   * true when your latest opinionated review was submitted on the PR's current
   * head commit (matched by oid). Then no push is newer than your review, and
   * `returnedToMe` and `myReReviewDue` ignore the date comparison: the date of
   * the head commit falls back to `committedDate`, which can be later than the
   * review on that same commit.
   */
  viewerReviewedHead: boolean;
  /**
   * The commit your latest opinionated review was submitted on, or null. The PR
   * agent checks a new head against it: the same change on a new base (a stack
   * GitHub rebased after a lower layer merged, the base merged in) needs no
   * re-review.
   */
  viewerReviewedOid: string | null;
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
  /**
   * true when the PR has been open at least `staleAfterDays` (the setting) —
   * the "Stale" chip and, on your own PR, the close action. Set by the poller,
   * not by `github.ts`, because the threshold is a setting.
   */
  isStale: boolean;

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
  /** Human approval body beyond a plain acknowledgement. Conservative intent
   * check; cleared by author EYES on that review after its last edit, or the
   * reviewer's later clean approval. Never cleared by a push,
   * author reply, marking seen, re-request or disabling comment tracking. */
  hasUnaddressedReviewFeedback: boolean;
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
  /** Required base update: strictly GitHub mergeStateStatus === BEHIND. */
  isBehindBase: boolean;

  /**
   * Roll-up flag: the PR is ready to merge. Composite of GitHub's mergeable
   * signal plus the dashboard's own readiness checks — true when the PR is not a
   * draft, has no merge conflicts (GitHub `mergeable === "MERGEABLE"`), has at
   * least one human approval, has no unaddressed change request, and CI is not
   * failing or still running. GitHub computes `mergeable` asynchronously and may
   * report UNKNOWN right after a push; while it is UNKNOWN this stays false and
   * flips true on a later poll once GitHub settles. Never true while
   * `blockedByStack`: GitHub reports such a PR CLEAN yet refuses to merge it.
   * Never true while `requiredReviewPending` either.
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
  /**
   * Set when the host refused for a spent GraphQL budget rather than failed:
   * when the budget refills (ISO), or "" when the response named no time. The
   * renderer shows it as a wait with cached data, not as a failure.
   */
  rateLimitedUntil?: string;
}

/** GraphQL rate-limit info at request time. */
export interface RateLimitInfo {
  hostLabel: string;
  remaining: number;
  cost: number;
  resetAt: string;
  /** The hourly budget (5000 on github.com); absent on readings that did not report it. */
  limit?: number;
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

/** Result of `launchClaude`: what was started and where, or why not. */
export type ClaudeLaunchResult =
  | { ok: true; kind: "drive" | "review" | "close" | "explain" | "open"; dir: string }
  | { ok: false; error: string };

/** Result of `launchClaudeGroup`: how many PRs went in and where it runs, or why not. */
export type ClaudeGroupLaunchResult = { ok: true; count: number; dir: string } | { ok: false; error: string };

/**
 * A Claude Code session running on this machine, as its registry file
 * (`~/.claude/sessions/<pid>.json`) and transcript describe it — the input the
 * cards match against to show which PR has a live session. Built in
 * `main/claude-sessions.ts`, matched in `shared/claude-sessions.ts`.
 */
export interface ClaudeSessionInfo {
  /** Claude Code's session id — the transcript's file name. */
  id: string;
  /** The session's title (the Desktop sidebar's, or a derived one for the CLI). */
  name: string;
  /**
   * `busy` — working on a turn; `waiting` — asked the user something; `idle` —
   * the turn ended; `paused` — a Claude Desktop session whose process Desktop
   * stopped without archiving it (opening it resumes it).
   */
  status: "busy" | "waiting" | "idle" | "paused";
  /** What it waits for, when `status` is `waiting` (e.g. "input needed"). */
  waitingFor?: string;
  /**
   * Where it runs, which decides what "switch to it" opens: a Claude Desktop
   * session, a terminal tab, or a process with no window (`claude -p`, the SDK).
   */
  where: "desktop" | "terminal" | "background";
  /** `host/owner/repo/pull/N` of every PR link the user sent it. */
  prKeys: string[];
  /** The group headings whose "Explain all" or "Review all" started it: kind and Jira key. */
  groups?: Array<{ kind: "explain" | "review"; key: string }>;
  /** `host/owner/repo` of each git remote of its working folder. */
  repoKeys: string[];
  /** The branch checked out in its working folder; null when detached or not a git folder. */
  branch: string | null;
  /** Epoch ms of a paused session's last activity — the most recent of several goes first. */
  lastActivityAt?: number;
}

/** Result of `focusClaudeSession`. */
export type FocusClaudeSessionResult = { ok: true } | { ok: false; error: string };

// --- The PR agent, as main shows it to the renderer -------------------------

/**
 * What the agent does with a PR: review it, brief it, offer to merge it (no
 * run — a button), or the Jira dry run after you merged one. Re-review and
 * drive land in a later stage.
 */
export type AgentScenario = "review" | "brief" | "rereview" | "drive" | "merge" | "afterMerge" | "reapprove" | "reask";

export type AgentItemState = "queued" | "working" | "needsYou" | "done" | "error";

/** What a run's drawing step left: the diagrams, or the comment that already had one, or why none. */
export interface AgentItemDiagrams {
  /** Passed the guard (`cleanDiagrams`) and, once `checked`, rendered in the app's own mermaid. */
  list: import("./agent-diagrams").AgentDiagram[];
  /** Checked in the renderer (a flowchart can't be parsed without a DOM). None is posted unchecked. */
  checked: boolean;
  /** The PR has a comment with a Mermaid diagram already — nothing drawn, its link instead. */
  existingUrl?: string;
  /** Why none was drawn or some were dropped, in a line. */
  note?: string;
}

/** One thing the agent did or is doing on a PR — persisted in userData/agent/state.json. */
export interface AgentItem {
  runId: string;
  key: string;
  prId: string;
  prNumber: number;
  repo: string;
  url: string;
  title: string;
  hostLabel: string;
  scenario: AgentScenario;
  mode: "shadow" | "on";
  state: AgentItemState;
  /** One line: what it is doing, or why it stopped. */
  headline: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  worktree?: string;
  checkout?: string;
  /** The review it would post (shadow) or the brief — the session's final message, without its result block. */
  output?: string;
  /** What the final message means for you: one sentence, its questions to you, its findings (`shared/agent-result.ts`). */
  result?: import("./agent-result").RunResultCard;
  /** Your answer to its question, queued: the next run continues the session with it. */
  answer?: string;
  /** A brief's questions for the author, carried into the review "Draft a review" queues. */
  carry?: string[];
  /** Your choice on each thread the author pushed back on (by its first comment's id): keep your comment, or drop it. */
  disputes?: Record<string, "keep" | "drop">;
  error?: string;
  /**
   * The app closed while it ran. It goes on by itself at the next start: the
   * same session where its folder is still there, else (and always for a
   * drive) a new run.
   */
  interrupted?: boolean;
  /**
   * How many runs of it in a row ended with their process cut short (Ctrl+C,
   * a shutdown, a workflow still running). Each goes on by itself like an
   * interrupted run, up to a cap; a run that ends any other way clears it.
   */
  cuts?: number;
  /** Diagrams of the change, drawn after the run (Settings › Agent › Diagrams). */
  diagrams?: AgentItemDiagrams;
  /**
   * Re-approve / re-ask: the approvals a base-only push dismissed — whose, and
   * the head they were given on. The PR's own changes are the same at both.
   */
  reapproval?: { logins: string[]; oldHead: string };
  /** The next run continues `sessionId` instead of starting a session: after a restart, or with your answer. */
  resumeSession?: boolean;
  /**
   * Your place for it in the queue (dragged, or "Run next"): lower runs first.
   * Unset, it queues by the time it was queued.
   */
  rank?: number;
  /**
   * What a review prepared to post — captured by the app's publish wrapper,
   * posted by the app (`main/agent/publish.ts`). Absent when it prepared
   * nothing, or ran as a plain dry run.
   */
  plan?: import("./agent-publish").PublishSummary;
  /** The review run's own folder (wrapper, payloads, plan, publish progress). */
  runFolder?: string;
  /** The fingerprint of the plan file `plan` was read from: Publish posts only while the file still matches it. */
  planHash?: string;
  /** The plan changed in the session after you first saw it ("Edit first"): its Publish isn't "accepted unchanged". */
  planEdited?: boolean;
  /** The plan is on GitHub. */
  published?: boolean;
  /** A merge offer: the methods the repository allows and the one the button uses. */
  mergeMethods?: { suggested: MergeMethod | null; allowed: MergeMethod[] };
  mergeMethod?: MergeMethod;
  /**
   * A drive run's commits on top of the head it started from (`base`), as the
   * app read them from its worktree — what the Push button would send.
   */
  drive?: AgentDriveResult;
  /** The drive's commits are on the PR's branch. */
  pushed?: boolean;
  /** A drive: what it was queued for — "ci", "conflicts", "comments". */
  reasons?: string[];
  /**
   * A drive: where its push goes and what git looked like before the session
   * — the remote URL then (not a remote name the session could repoint), and
   * a fingerprint of the repository's git config and hooks and your global
   * git config. A push goes out only while the fingerprint still matches.
   */
  pushTo?: { url: string; commonDir: string; worktreeGitDir: string | null; fingerprint: string; sshSnapshot?: string };
}

export interface AgentDriveResult {
  /** The PR's head the run started from: a push goes out only while it is still the head. */
  base: string;
  /** The commit the drive ended at — what you were shown, and the one commit a Push sends. */
  head: string;
  /** What it was driven for: "ci", "conflicts", "comments". */
  reasons: string[];
  /** Oldest first. */
  commits: Array<{ oid: string; subject: string }>;
  /** `git diff --stat`, and the patch itself (cut at 100 kB). */
  stat: string;
  patch: string;
}

/** A run in flight: its plan and live line (see agent-stream.ts), the last few things it did. */
export interface AgentRunState {
  runId: string;
  progress: import("./agent-stream").RunProgress;
  recent: Array<{ at: string; text: string }>;
  paused: boolean;
}

export interface AgentState {
  enabled: boolean;
  items: AgentItem[];
  running: AgentRunState[];
  /** Why each PR on the dashboard is idle, by PR id. */
  idle: Record<string, string>;
  runsToday: number;
  perDay: number;
  parallel: number;
  /** Set while Claude's usage limit holds new runs back. */
  heldUntil: string | null;
  /** The companion settings, so the header shows the chip only when wanted. */
  headerChip: boolean;
  /** …and the tray its status line and Pause item. */
  trayState: boolean;
  /**
   * Paused as a whole (Board, companion, tray): nothing new starts, runs in
   * flight are paused, and nothing is posted or pushed on its own.
   */
  paused: boolean;
  /** Inside quiet hours: the local clock they end at ("08:00"). Only runs you ask for start meanwhile. */
  quietUntil: string | null;
  /** Shadow reviews you published exactly as prepared — the count behind the Shadow → On hint. */
  acceptedUnchanged: number;
  /** Reviews are in Shadow and you've published enough of them unchanged to consider On. */
  suggestOn: boolean;
  /**
   * Your PRs an SDLC orchestrator run drives, by PR id: its Jira key and the
   * stage it is at — the badge their cards wear instead of the agent's work.
   */
  orchestrated?: Record<string, { key: string; stage: string | null }>;
}

/** What the renderer may ask of the agent. It names a run or a PR by id — never a path or a command. */
export type AgentAction =
  | { type: "skip" | "retry" | "continue" | "reviewAnyway" | "pause" | "resume" | "stop" | "takeOver" | "publish" | "push" | "reapprove"; runId: string }

  // The whole agent — two members, so a check for both narrows the rest.
  | { type: "pauseAgent" }
  | { type: "resumeAgent" }
  | { type: "hint"; runId: string; text: string }
  /** Your answer to a finished run's question: the same session goes on with it. */
  | { type: "answer"; runId: string; text: string }
  /** Keep your comment, or drop it, in a thread where the author pushed back — applied when the review is sent. */
  | { type: "dispute"; runId: string; replyTo: number; choice: "keep" | "drop" }
  | { type: "merge"; runId: string; method?: MergeMethod }
  /** `before`: the queued run it goes in front of; null or absent, the end of the queue. */
  | { type: "enqueue"; prId: string; before?: string | null }
  /** Your approval again, on a PR it already stands on, to answer a review request made after it. */
  | { type: "approveAgain"; prId: string }
  | { type: "moveQueued"; runId: string; before: string | null };

export type AgentActionResult = { ok: true } | { ok: false; error: string };

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
  /**
   * Jira setup state for the settings UI and grouping. `cached` (the default)
   * answers at once, with the last known twg status or `checking`; `fresh` waits
   * for a new `twg whoami`.
   */
  getJiraStatus(mode?: JiraStatusMode): Promise<JiraStatus>;
  /**
   * Store (or clear, when given an empty string) the Jira API token, encrypted
   * via the OS keychain. Returns whether it was persisted.
   */
  setJiraToken(token: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * Opens a terminal running `twg login --force`: the sign-in is interactive
   * (site choice, browser consent), so the app can only start it, not finish it.
   */
  twgLogin(): Promise<{ ok: boolean; error?: string }>;
  /** The running app version. */
  getAppVersion(): Promise<string>;
  /**
   * Open a terminal in the PR's local checkout and start `claude` with the
   * prompt for the PR's state — or for `kind`, when the user picked an action
   * from the button's menu. Refused while the integration is off.
   */
  launchClaude(prId: string, kind?: "drive" | "review" | "close" | "explain" | "open"): Promise<ClaudeLaunchResult>;
  /**
   * Start a group heading's Claude session: "Explain all" (one session that
   * explains the group's PRs together) or "Review all" (a Claude Desktop
   * session that starts one nested review session per PR awaiting your
   * review). Only the kind, the Jira key and the PR ids cross over; main reads
   * the PRs from its own snapshot. Refused while the integration is off.
   */
  launchClaudeGroup(kind: "explain" | "review", groupKey: string, prIds: string[]): Promise<ClaudeGroupLaunchResult>;
  /** The Claude Code sessions running now; empty while the integration is off. */
  getClaudeSessions(): Promise<ClaudeSessionInfo[]>;
  /**
   * Bring a running session to the front: its Claude Desktop session, or the
   * terminal tab it runs in. Only the session id crosses over; main looks it up
   * in its own scan.
   */
  focusClaudeSession(sessionId: string): Promise<FocusClaudeSessionResult>;
  /** Subscribe to changes in the running sessions. Returns an unsubscribe function. */
  onClaudeSessions(listener: (sessions: ClaudeSessionInfo[]) => void): () => void;
  /** The PR agent's state, or null when there is no agent (fixture mode). */
  getAgentState(): Promise<AgentState | null>;
  /** Act on an agent run or hand a PR to the agent. */
  agentAction(action: AgentAction): Promise<AgentActionResult>;
  /** Shows the agent's log (userData/agent/log.jsonl) in the file manager. */
  revealAgentLog(): Promise<void>;
  /**
   * Main asks whether the agent's diagrams parse — a flowchart needs a DOM,
   * and the renderer is the only browser at hand. Returns an unsubscribe function.
   */
  onCheckDiagrams(listener: (request: { requestId: string; sources: string[] }) => void): () => void;
  /** The answer: one yes/no per source, in order. Nothing else crosses back. */
  diagramsChecked(requestId: string, results: boolean[]): Promise<void>;
  /** Subscribe to agent state pushes (sent only while the window is visible). */
  onAgentState(listener: (state: AgentState) => void): () => void;
  /** An agent notification was clicked: show the Board, where its decision waits. */
  /** A clicked agent notification: the Board, at the item it was about. */
  onAgentShowBoard(listener: (runId?: string) => void): () => void;
  /** The tray's "Show agent": open the agent's popover (the Board when the header chip is off). */
  onAgentOpenCompanion(listener: () => void): () => void;
  /** Copy text (e.g. a PR URL) to the system clipboard. */
  copyText(text: string): Promise<void>;
  /**
   * The Jira task of a stale PR of yours and the transitions Jira offers on it,
   * for the close dialog. Only the PR id crosses over; the issue key is read
   * from main's own snapshot.
   */
  getStaleJiraTask(prId: string): Promise<{ ok: true; task: JiraTaskInfo } | { ok: false; error: string }>;
  /** Close a stale PR of yours and apply the chosen action to its Jira task. */
  closeStalePr(prId: string, options: CloseStaleOptions): Promise<CloseStaleResult>;
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
