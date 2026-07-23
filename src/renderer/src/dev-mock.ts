/**
 * Browser-only dev stand-in for the preload bridge. Loaded (dynamically) by
 * main.tsx ONLY when running the Vite dev server in a plain browser, where
 * there is no Electron preload and thus no `window.api`. Lets the renderer be
 * developed and eyeballed without booting Electron.
 *
 * `?buddy=sad|curious|sleeping` picks a PR fixture set that drives the header
 * buddy into that mood (default: sleeping).
 */
import type {
  DashboardResponse,
  PrManagerApi,
  PullRequest,
  Settings,
} from "../../shared/types";

function pr(overrides: Partial<PullRequest>): PullRequest {
  return {
    id: Math.random().toString(36).slice(2),
    hostLabel: "GitHub",
    repo: "acme/widgets",
    number: 42,
    title: "Sample pull request",
    url: "https://github.com/acme/widgets/pull/42",
    isDraft: false,
    baseRefName: "main",
    baseIsDefaultBranch: true,
    author: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" },
    createdAt: new Date(Date.now() - 864e5).toISOString(),
    updatedAt: new Date(Date.now() - 36e5).toISOString(),
    lastCommitPushedAt: new Date(Date.now() - 36e5).toISOString(),
    headRefName: "feature/sample",
    issueKey: null,
    parentKey: null,
    parentSummary: null,
    reviewDecision: null,
    roles: ["author"],
    viewerHasReviewed: false,
    hasNoReviews: true,
    unresolvedThreads: 0,
    unaddressedThreads: 0,
    totalComments: 0,
    checks: [],
    failingChecks: [],
    pendingChecks: [],
    ciState: "success",
    reviewers: [],
    awaitingReview: false,
    hasUnaddressedChangeRequest: false,
    hasUnaddressedComments: false,
    hasHumanApproval: false,
    hasConflicts: false,
    canBeMerged: false,
    hasNewActivity: false,
    returnedToMe: false,
    lastSeenAt: null,
    needsAttention: false,
    isIgnored: false,
    ...overrides,
  };
}

const FIXTURES: Record<string, PullRequest[]> = {
  sad: [
    pr({
      title: "Fix flaky poller test",
      number: 101,
      baseRefName: "feature/base-work",
      baseIsDefaultBranch: false,
      failingChecks: [{ name: "CI / build", kind: "check", state: "failure", url: null }],
      checks: [{ name: "CI / build", kind: "check", state: "failure", url: null }],
      ciState: "failure",
      needsAttention: true,
    }),
    pr({ title: "Quiet green one", number: 102, hasHumanApproval: true, canBeMerged: true }),
  ],
  curious: [
    pr({
      title: "Add rate-limit backoff",
      number: 201,
      roles: ["reviewer"],
      author: { login: "teammate", avatarUrl: "" },
    }),
    pr({ title: "Waiting on review", number: 202, awaitingReview: true }),
  ],
  sleeping: [
    pr({ title: "Waiting on review", number: 301, awaitingReview: true }),
    pr({
      title: "CI still running",
      number: 302,
      pendingChecks: [{ name: "CI / e2e", kind: "check", state: "pending", url: null }],
      ciState: "pending",
    }),
  ],
  // Rich, representative set for the README hero shot: a spread of states across
  // two repos so grouping, host badges, filters and the buddy all have something
  // to show. `?buddy=showcase`.
  showcase: [
    pr({
      title: "Fix rate-limit backoff when a host returns 403",
      repo: "acme/dashboard",
      number: 142,
      totalComments: 3,
      unresolvedThreads: 1,
      failingChecks: [{ name: "CI / unit", kind: "check", state: "failure", url: null }],
      checks: [
        { name: "CI / unit", kind: "check", state: "failure", url: null },
        { name: "CI / lint", kind: "check", state: "success", url: null },
      ],
      ciState: "failure",
      awaitingReview: true,
      reviewers: [{ login: "octo-lead", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4", reviewState: "pending" }],
      needsAttention: true,
    }),
    pr({
      title: "Add a system / light / dark theme toggle to Settings",
      repo: "acme/dashboard",
      number: 139,
      reviewDecision: "CHANGES_REQUESTED",
      hasUnaddressedChangeRequest: true,
      hasUnaddressedComments: true,
      unresolvedThreads: 3,
      unaddressedThreads: 2,
      totalComments: 11,
      hasNewActivity: true,
      reviewers: [{ login: "octo-lead", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4", reviewState: "changes_requested" }],
      needsAttention: true,
    }),
    pr({
      title: "Wire up the auto-update restart prompt",
      repo: "acme/dashboard",
      number: 137,
      reviewDecision: "APPROVED",
      hasHumanApproval: true,
      canBeMerged: true,
      totalComments: 5,
      reviewers: [{ login: "octo-lead", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4", reviewState: "approved" }],
    }),
    pr({
      title: "Review: debounce the notifications probe",
      repo: "acme/poller",
      number: 88,
      roles: ["reviewer"],
      author: { login: "teammate", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4" },
      awaitingReview: true,
      pendingChecks: [{ name: "CI / e2e", kind: "check", state: "pending", url: null }],
      checks: [{ name: "CI / e2e", kind: "check", state: "pending", url: null }],
      ciState: "pending",
    }),
    pr({
      title: "Persist seen-state atomically",
      repo: "acme/poller",
      number: 85,
      hasNewActivity: true,
      totalComments: 2,
      hasHumanApproval: true,
      canBeMerged: true,
      reviewers: [{ login: "octo-lead", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4", reviewState: "approved" }],
    }),
    pr({
      title: "Bump Electron to 35 and re-verify notarization",
      repo: "acme/poller",
      number: 83,
      isDraft: true,
      baseRefName: "feature/electron-35",
      baseIsDefaultBranch: false,
    }),
  ],
  // Exercises the sort/filter/group work: reviewer requests (some untouched,
  // one returned-to-me), a nobody-reviewed-yet PR, and two PRs of one ticket.
  review: [
    pr({
      title: "ENG-93373: Add response deadline for read-only MCP tools",
      repo: "acme/clio",
      number: 911,
      issueKey: "ENG-93373",
      parentKey: "ENG-93367",
      parentSummary: "Analyze long app creating",
      headRefName: "feature/eng-93373-deadline",
      roles: ["reviewer"],
      author: { login: "teammate", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4" },
      awaitingReview: true,
      hasNoReviews: true,
      reviewers: [{ login: "me", avatarUrl: "", reviewState: "pending" }],
    }),
    pr({
      title: "ENG-93374: sync-schemas retry transient network errors per-op",
      repo: "acme/clio",
      number: 912,
      issueKey: "ENG-93374",
      parentKey: "ENG-93367",
      parentSummary: "Analyze long app creating",
      headRefName: "feature/eng-93374-retry",
      roles: ["reviewer"],
      author: { login: "teammate", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4" },
      awaitingReview: true,
      hasNoReviews: true,
    }),
    pr({
      title: "ENG-93375: modify-entity-schema-column honors the static prefix",
      repo: "acme/clio",
      number: 929,
      issueKey: "ENG-93375",
      parentKey: "ENG-93367",
      parentSummary: "Analyze long app creating",
      headRefName: "feature/eng-93375",
      roles: ["reviewer"],
      author: { login: "teammate", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4" },
      // I reviewed this earlier and the author pushed new changes back to me.
      viewerHasReviewed: true,
      returnedToMe: true,
      hasNoReviews: false,
      lastSeenAt: new Date(Date.now() - 2 * 864e5).toISOString(),
      totalComments: 8,
      unresolvedThreads: 2,
      reviewers: [{ login: "me", avatarUrl: "", reviewState: "changes_requested" }],
    }),
    pr({
      title: "Chore: bump deps (nobody has looked yet)",
      repo: "acme/gadgets",
      number: 44,
      issueKey: null,
      roles: ["reviewer"],
      author: { login: "teammate", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4" },
      awaitingReview: true,
      hasNoReviews: true,
      createdAt: new Date(Date.now() - 9 * 864e5).toISOString(),
    }),
  ],
};

const mood = new URLSearchParams(window.location.search).get("buddy") ?? "sleeping";

const snapshot: DashboardResponse = {
  pullRequests: FIXTURES[mood] ?? FIXTURES.sleeping,
  errors: [],
  rateLimits: [{ hostLabel: "GitHub", remaining: 4980, cost: 20, resetAt: new Date().toISOString(), fetchedAt: new Date().toISOString() }],
  fetchedAt: new Date().toISOString(),
  version: "dev",
};

const settings: Settings = {
  pollIntervalSeconds: 60,
  launchAtLogin: false,
  autoUpdate: false,
  theme: "system",
  hosts: [{ label: "GitHub", graphqlUrl: "https://api.github.com/graphql", repos: ["acme/widgets"] }],
};

const api: PrManagerApi = {
  getDashboard: async () => ({ ok: true, snapshot }),
  refresh: async () => ({ ok: true, snapshot }),
  getConfig: async () => ({
    ok: true,
    config: { pollIntervalSeconds: 60, hosts: [{ label: "GitHub", repos: ["acme/widgets"] }] },
  }),
  markSeen: async () => {},
  setIgnored: async () => {},
  openExternal: async () => {},
  getSettings: async () => settings,
  saveSettings: async () => ({ ok: true }),
  setTheme: async () => {},
  getGhStatus: async () => ({ installed: true, hosts: [{ hostname: "github.com", label: "GitHub", authenticated: true }] }),
  getJiraStatus: async () => ({ configured: true, hasConfig: true, hasToken: true, encryptionAvailable: true }),
  setJiraToken: async () => ({ ok: true }),
  getAppVersion: async () => "dev",
  copyText: async () => {},
  getWhatsNew: async () => null,
  dismissWhatsNew: async () => {},
  onSnapshot: () => () => {},
  onConfigError: () => () => {},
  onUpdateStatus: () => () => {},
};

(window as unknown as { api: PrManagerApi }).api = api;
