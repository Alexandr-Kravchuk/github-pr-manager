/**
 * PRD_MOCK fixture mode — dev-only. When the env var is set, the poller's
 * network layer is swapped for canned PRs so every downstream piece still runs
 * for real: poller ticks, seen-state, IPC, renderer. The active case is
 * re-read from `.prd-mock` in the project cwd on every tick (fallback: the
 * PRD_MOCK value itself), so cases can be switched without a restart. The
 * seen-state goes to a separate `.mock` file to keep the real one clean.
 *
 * Cases: sad-ci, sad-changes, sad-comments, curious, mixed, waiting, busy,
 * approved, empty, draft-red, grid-many, grid-repos, grid-tall.
 */
import fs from "node:fs";
import path from "node:path";

import { defaultSettings } from "../shared/config";
import type { HostFetchResult } from "../shared/github";
import type { CheckItem, HostConfig, PullRequest, Reviewer, Settings } from "../shared/types";

export function isMockMode(): boolean {
  return Boolean(process.env.PRD_MOCK);
}

const HOST_LABEL = "Mock";
const CASE_FILE = path.resolve(process.cwd(), ".prd-mock");

const OCTOCAT = "https://avatars.githubusercontent.com/u/583231?v=4";
const TEAMMATE = "https://avatars.githubusercontent.com/u/9919?v=4";

const failing: CheckItem = { name: "CI / build", kind: "check", state: "failure", url: null };
const pending: CheckItem = { name: "CI / e2e", kind: "check", state: "pending", url: null };
const passing: CheckItem = { name: "CI / build", kind: "check", state: "success", url: null };

const reviewerPending: Reviewer = { login: "teammate", avatarUrl: TEAMMATE, reviewState: "pending" };
const reviewerBlocking: Reviewer = {
  login: "teammate",
  avatarUrl: TEAMMATE,
  reviewState: "changes_requested",
};
const reviewerApproved: Reviewer = {
  login: "teammate",
  avatarUrl: TEAMMATE,
  reviewState: "approved",
};

function pr(overrides: Partial<PullRequest> & { id: string; number: number }): PullRequest {
  return {
    hostLabel: HOST_LABEL,
    repo: "acme/widgets",
    title: "Sample pull request",
    url: "https://github.com/acme/widgets/pull/1",
    isDraft: false,
    baseRefName: "main",
    baseIsDefaultBranch: true,
    author: { login: "me", avatarUrl: OCTOCAT },
    createdAt: new Date(Date.now() - 2 * 864e5).toISOString(),
    updatedAt: new Date(Date.now() - 36e5).toISOString(),
    reviewDecision: null,
    roles: ["author"],
    unresolvedThreads: 0,
    unaddressedThreads: 0,
    totalComments: 0,
    checks: [passing],
    failingChecks: [],
    pendingChecks: [],
    ciState: "success",
    reviewers: [],
    awaitingReview: false,
    hasUnaddressedChangeRequest: false,
    hasUnaddressedComments: false,
    hasHumanApproval: false,
    // Overwritten by applyActivity:
    hasNewActivity: false,
    lastSeenAt: null,
    needsAttention: false,
    ...overrides,
  };
}

/** Grows every tick so the "busy" case flips its NEW-comments badge on tick 2. */
let tick = 0;

const CASES: Record<string, () => PullRequest[]> = {
  "sad-ci": () => [
    pr({
      id: "mock-sad-ci",
      number: 101,
      title: "My PR with failing CI",
      checks: [failing, passing],
      failingChecks: [failing],
      ciState: "failure",
      reviewers: [reviewerPending],
      awaitingReview: true,
    }),
  ],
  "sad-changes": () => [
    pr({
      id: "mock-sad-changes",
      number: 102,
      title: "My PR with changes requested",
      reviewDecision: "CHANGES_REQUESTED",
      hasUnaddressedChangeRequest: true,
      unresolvedThreads: 2,
      unaddressedThreads: 0,
      totalComments: 6,
      reviewers: [reviewerBlocking],
    }),
  ],
  "sad-comments": () => [
    pr({
      id: "mock-sad-comments",
      number: 103,
      title: "My PR with an unanswered reviewer comment",
      unresolvedThreads: 3,
      unaddressedThreads: 2,
      hasUnaddressedComments: true,
      totalComments: 9,
      reviewers: [reviewerPending],
    }),
  ],
  curious: () => [
    pr({
      id: "mock-curious",
      number: 201,
      title: "Teammate's PR waiting for my review",
      roles: ["reviewer"],
      author: { login: "teammate", avatarUrl: TEAMMATE },
      awaitingReview: true,
    }),
  ],
  mixed: () => [
    ...CASES["sad-ci"](),
    ...CASES.curious(),
    ...CASES.waiting(),
    ...CASES.approved(),
  ],
  waiting: () => [
    pr({
      id: "mock-waiting",
      number: 301,
      title: "My PR waiting for someone's review",
      awaitingReview: true,
      reviewers: [reviewerPending],
      // Stacked PR — based on a feature branch, not main.
      baseRefName: "feature/base-work",
      baseIsDefaultBranch: false,
    }),
  ],
  busy: () => [
    pr({
      id: "mock-busy-pending",
      number: 302,
      title: "My PR with CI still running",
      checks: [pending],
      pendingChecks: [pending],
      ciState: "pending",
    }),
    pr({
      id: "mock-busy-comments",
      number: 303,
      title: "My PR where comments keep coming",
      unresolvedThreads: 1,
      totalComments: 5 + tick,
    }),
  ],
  approved: () => [
    pr({
      id: "mock-approved",
      number: 401,
      title: "My approved PR, green CI",
      reviewDecision: "APPROVED",
      hasHumanApproval: true,
      reviewers: [reviewerApproved],
      totalComments: 4,
    }),
  ],
  empty: () => [],
  // Layout cases — exercise the grouped/ungrouped card grid, not the buddy.
  "grid-many": () =>
    Array.from({ length: 8 }, (_, i) =>
      pr({
        id: `mock-grid-many-${i}`,
        number: 600 + i,
        title: `PR #${600 + i} in the same repo`,
        ...(i % 3 === 0 ? { unresolvedThreads: 2, totalComments: 5, reviewers: [reviewerPending] } : {}),
        ...(i % 4 === 1 ? { checks: [failing], failingChecks: [failing], ciState: "failure" as const } : {}),
      }),
    ),
  "grid-repos": () => [
    ...Array.from({ length: 5 }, (_, i) =>
      pr({ id: `mock-grid-widgets-${i}`, number: 700 + i, title: `Widgets PR ${i + 1}` }),
    ),
    ...Array.from({ length: 2 }, (_, i) =>
      pr({ id: `mock-grid-gadgets-${i}`, number: 710 + i, repo: "acme/gadgets", title: `Gadgets PR ${i + 1}` }),
    ),
    pr({ id: "mock-grid-tools", number: 720, repo: "acme/tools", title: "Lonely tools PR" }),
  ],
  "grid-tall": () => [
    pr({
      id: "mock-grid-tall-long",
      number: 801,
      title:
        "A very long pull request title that wraps onto multiple lines to make this card noticeably taller than its neighbours in the same grid row",
      reviewDecision: "CHANGES_REQUESTED",
      hasUnaddressedChangeRequest: true,
      unresolvedThreads: 4,
      unaddressedThreads: 2,
      hasUnaddressedComments: true,
      totalComments: 12,
      checks: [failing, pending, passing],
      failingChecks: [failing],
      pendingChecks: [pending],
      ciState: "failure",
      reviewers: [reviewerBlocking, reviewerPending, reviewerApproved],
      awaitingReview: true,
    }),
    pr({ id: "mock-grid-tall-short", number: 802, title: "Tiny one" }),
    pr({
      id: "mock-grid-tall-draft",
      number: 803,
      title: "Draft with a medium-length title that wraps once on narrow columns",
      isDraft: true,
      reviewers: [reviewerPending],
    }),
    pr({ id: "mock-grid-tall-short2", number: 804, title: "Another tiny one", repo: "acme/gadgets" }),
  ],
  "draft-red": () => [
    pr({
      id: "mock-draft-red",
      number: 501,
      title: "Draft PR with failing CI (should not wake the buddy)",
      isDraft: true,
      checks: [failing],
      failingChecks: [failing],
      ciState: "failure",
    }),
  ],
};

function currentCase(): string {
  try {
    const fromFile = fs.readFileSync(CASE_FILE, "utf8").trim();
    if (fromFile in CASES) return fromFile;
    if (fromFile) console.warn(`[mock] unknown case "${fromFile}" in .prd-mock`);
  } catch {
    /* no case file — fall through to the env value */
  }
  const fromEnv = (process.env.PRD_MOCK ?? "").trim();
  return fromEnv in CASES ? fromEnv : "empty";
}

/** No-op notifications probe for mock mode — never touches the network. */
export async function mockProbeNotifications(): Promise<{
  changed: boolean;
  lastModified: string | null;
  watermark: string | null;
  pollIntervalMs: number;
  status: "ok" | "unavailable";
}> {
  return { changed: false, lastModified: null, watermark: null, pollIntervalMs: 60_000, status: "ok" };
}

export async function mockFetchHost(host: HostConfig): Promise<HostFetchResult> {
  tick++;
  const name = currentCase();
  console.log(`[mock] tick=${tick} case=${name}`);
  return {
    pullRequests: CASES[name](),
    rateLimit: {
      hostLabel: host.label,
      remaining: 5000,
      cost: 1,
      resetAt: new Date(Date.now() + 36e5).toISOString(),
    },
  };
}

/** Poller option overrides for mock mode — no gh, no network, fast cadence. */
export function mockPollerOverrides(userDataPath: string): {
  loadSettings: () => Settings;
  toHostConfigs: () => HostConfig[];
  fetchHostFn: typeof mockFetchHost;
  probeNotificationsFn: typeof mockProbeNotifications;
  statePath: string;
} {
  return {
    loadSettings: () => ({
      ...defaultSettings(),
      pollIntervalSeconds: 10,
      hosts: [{ label: HOST_LABEL, graphqlUrl: "https://mock.invalid/graphql", repos: ["acme/widgets"] }],
    }),
    toHostConfigs: () => [
      { label: HOST_LABEL, graphqlUrl: "https://mock.invalid/graphql", token: "mock", repos: ["acme/widgets"] },
    ],
    fetchHostFn: mockFetchHost,
    probeNotificationsFn: mockProbeNotifications,
    statePath: path.join(userDataPath, "seen-state.mock.json"),
  };
}
