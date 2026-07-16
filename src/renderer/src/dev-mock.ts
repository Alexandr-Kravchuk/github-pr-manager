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
    reviewDecision: null,
    roles: ["author"],
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
    canBeMerged: false,
    hasNewActivity: false,
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
  getAppVersion: async () => "dev",
  copyText: async () => {},
  getWhatsNew: async () => null,
  dismissWhatsNew: async () => {},
  onSnapshot: () => () => {},
  onConfigError: () => () => {},
};

(window as unknown as { api: PrManagerApi }).api = api;
