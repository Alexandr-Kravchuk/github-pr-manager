/**
 * PRD_MOCK fixture mode — dev-only. When the env var is set, the poller's
 * network layer is swapped for canned PRs so every downstream piece still runs
 * for real: poller ticks, seen-state, IPC, renderer. The active case is
 * re-read from `.prd-mock` in the project cwd on every tick (fallback: the
 * PRD_MOCK value itself), so cases can be switched without a restart. The
 * seen-state goes to a separate `.mock` file to keep the real one clean.
 *
 * Cases: re-review-due, sad-ci, sad-changes, sad-comments, curious, mixed,
 * waiting, busy, approved, empty, draft-red, grid-many, grid-repos, grid-tall,
 * track-a/track-b, track-thread (see below).
 *
 * `track-a`/`track-b` are a manual QA pair for the `trackComments` setting: the
 * same PR id at 2 vs. 3 comments with a real `updatedAt` bump between them
 * (unlike the other cases, not `Date.now()`-derived, so ticks are stable until
 * you switch on purpose) — switching between them simulates a genuine GitHub
 * comment landing. Combine with editing `settings.json`'s `trackComments` under
 * `--user-data-dir` to see the poller's own gate live: `hasNewActivity`/
 * `returnedToMe` flip only when tracking is on, and re-enabling after an
 * off-path resync doesn't replay the comments that landed while off. Unlike
 * every other setting here, `trackComments` is read from the REAL
 * `settings.json` rather than pinned (see `mockPollerOverrides`), specifically
 * so this works without a rebuild.
 *
 * `track-thread` is the sibling QA fixture for the EXTENDED gate: an authored
 * PR with an unresolved thread AND an unaddressed comment, neither pinned to
 * `Date.now()`. With `trackComments` on it reads `blocked` (red) and claims
 * "Need attention"; flip the setting off in the same `settings.json` and, on
 * the next tick, it must go idle and drop out of "Need attention" — the two
 * signals `needsAttention`/`prSignal` now gate alongside `hasNewActivity`.
 *
 * Notification transitions: switch `.prd-mock` from `notif-quiet` (baseline) to
 * `notif-ci` / `notif-changes` / `notif-approved` to drive a single field
 * transition on the SAME PR id, firing that desktop notification. `notif-review`
 * is a standalone reviewer PR — switching to it from any case fires
 * "review requested". See `shared/notify.ts`.
 */
import fs from "node:fs";
import path from "node:path";

import { defaultSettings } from "../shared/config";
import type { HostFetchResult } from "../shared/github";
import type { CheckItem, HostConfig, PullRequest, Reviewer, Settings } from "../shared/types";
import { loadSettings as loadRealSettings } from "./settings";

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
/**
 * Frozen once at import, unlike `pr()`'s defaults which call `Date.now()` on
 * every tick. That drift is harmless for most cases but fatal here: a fixture
 * whose `lastCommitPushedAt` advances each tick reads as a fresh push, so
 * `returnedToMe` turns true on tick 2 and lights all three cards — masking the
 * one signal this case exists to show.
 */
const RRD_AT = new Date(Date.now() - 36e5).toISOString();
/** The viewer's own verdicts, for the passive-reviewed cases below. */
const myBlockingReview: Reviewer = {
  login: "me",
  avatarUrl: OCTOCAT,
  reviewState: "changes_requested",
};
const myApproval: Reviewer = { login: "me", avatarUrl: OCTOCAT, reviewState: "approved" };

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
    lastCommitPushedAt: new Date(Date.now() - 36e5).toISOString(),
    headRefName: "feature/sample",
    issueKey: null,
    parentKey: null,
    parentSummary: null,
    reviewDecision: null,
    roles: ["author"],
    viewerHasReviewed: false,
    viewerApproved: false,
    myReReviewDue: false,
    hasNoReviews: true,
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
    hasConflicts: false,
    canBeMerged: false,
    // Overwritten by applyActivity:
    hasNewActivity: false,
    returnedToMe: false,
    lastSeenAt: null,
    needsAttention: false,
    // Overwritten by applyIgnored:
    isIgnored: false,
    ...overrides,
  };
}

/** Grows every tick so the "busy" case flips its NEW-comments badge on tick 2. */
let tick = 0;

const CASES: Record<string, () => PullRequest[]> = {
  // The three passive-reviewed states side by side — a PR you already reviewed
  // and were NOT re-requested on, which is the shape `myReReviewDue` exists for
  // (issue #14). A real re-request would add the `reviewer` role and light the
  // card through the ordinary path, hiding exactly what this case demonstrates,
  // so all three deliberately carry `roles: ["reviewed"]` only.
  "re-review-due": () => [
    pr({
      id: "mock-rrd-due",
      updatedAt: RRD_AT,
      lastCommitPushedAt: RRD_AT,
      number: 301,
      title: "Your change request is answered — your move",
      author: { login: "teammate", avatarUrl: TEAMMATE },
      roles: ["reviewed"],
      reviewDecision: "CHANGES_REQUESTED",
      viewerHasReviewed: true,
      // The whole point: attention without any snapshot delta behind it.
      myReReviewDue: true,
      reviewers: [myBlockingReview],
      unresolvedThreads: 0,
      totalComments: 5,
      hasNoReviews: false,
    }),
    pr({
      id: "mock-rrd-waiting",
      updatedAt: RRD_AT,
      lastCommitPushedAt: RRD_AT,
      number: 302,
      title: "You asked for changes — still the author's turn",
      author: { login: "teammate", avatarUrl: TEAMMATE },
      roles: ["reviewed"],
      reviewDecision: "CHANGES_REQUESTED",
      viewerHasReviewed: true,
      myReReviewDue: false,
      reviewers: [myBlockingReview],
      // Open threads are what says the author has not answered yet.
      unresolvedThreads: 2,
      totalComments: 3,
      hasNoReviews: false,
    }),
    pr({
      id: "mock-rrd-approved",
      updatedAt: RRD_AT,
      lastCommitPushedAt: RRD_AT,
      number: 303,
      title: "You approved it — done from your side",
      author: { login: "teammate", avatarUrl: TEAMMATE },
      roles: ["reviewed"],
      reviewDecision: "APPROVED",
      viewerHasReviewed: true,
      viewerApproved: true,
      myReReviewDue: false,
      reviewers: [myApproval],
      hasHumanApproval: true,
      hasNoReviews: false,
    }),
  ],
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
    // The passive role: my review is submitted, so GitHub dropped the request —
    // the card is here to keep it on my radar, and stays quiet (no attention
    // accent) until it comes back to me.
    pr({
      id: "mock-reviewed",
      number: 202,
      title: "Teammate's PR I have already reviewed",
      roles: ["reviewed"],
      author: { login: "teammate", avatarUrl: TEAMMATE },
      viewerHasReviewed: true,
      hasNoReviews: false,
      reviewDecision: "CHANGES_REQUESTED",
      hasUnaddressedChangeRequest: true,
      unresolvedThreads: 2,
      totalComments: 6,
      reviewers: [{ login: "me", avatarUrl: OCTOCAT, reviewState: "changes_requested" }],
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
      canBeMerged: true,
      reviewers: [reviewerApproved],
      totalComments: 4,
    }),
  ],
  // QA fixture for the `trackComments` setting — deliberately NOT derived from
  // `Date.now()` like the cases above, so `updatedAt` is stable across ticks and
  // only moves when switching case on purpose (simulating a real GitHub comment
  // landing, which bumps both the count and the timestamp together).
  "track-a": () => [
    pr({
      id: "mock-track",
      number: 501,
      title: "My PR awaiting review, 2 comments",
      awaitingReview: true,
      totalComments: 2,
      updatedAt: "2026-08-20T10:00:00.000Z",
      lastCommitPushedAt: "2026-08-20T10:00:00.000Z",
      reviewers: [reviewerPending],
    }),
  ],
  "track-b": () => [
    pr({
      id: "mock-track",
      number: 501,
      title: "My PR awaiting review, 3 comments",
      awaitingReview: true,
      totalComments: 3,
      updatedAt: "2026-08-20T11:00:00.000Z",
      lastCommitPushedAt: "2026-08-20T10:00:00.000Z",
      reviewers: [reviewerPending],
    }),
  ],
  // QA fixture for the EXTENDED `trackComments` gate: an unresolved thread and
  // an unaddressed comment on your own PR, not just a raw comment count. Not
  // `awaitingReview` — that would route it into `waiting` before the
  // blocked/attention branches this fixture exists to exercise are reached.
  "track-thread": () => [
    pr({
      id: "mock-track-thread",
      number: 502,
      title: "My PR with an open thread nobody answered",
      awaitingReview: false,
      unresolvedThreads: 2,
      hasUnaddressedComments: true,
      updatedAt: "2026-08-20T10:00:00.000Z",
      lastCommitPushedAt: "2026-08-20T10:00:00.000Z",
    }),
  ],
  empty: () => [],
  // Notification transition fixtures — all share id "mock-notif" so switching
  // between them mutates one PR's fields (the transition the notifier diffs on).
  "notif-quiet": () => [pr({ id: "mock-notif", number: 901, title: "My quiet green PR" })],
  "notif-ci": () => [
    pr({
      id: "mock-notif",
      number: 901,
      title: "My quiet green PR",
      checks: [failing, passing],
      failingChecks: [failing],
      ciState: "failure",
    }),
  ],
  "notif-changes": () => [
    pr({
      id: "mock-notif",
      number: 901,
      title: "My quiet green PR",
      reviewDecision: "CHANGES_REQUESTED",
      hasUnaddressedChangeRequest: true,
      unresolvedThreads: 1,
      totalComments: 3,
      reviewers: [reviewerBlocking],
    }),
  ],
  "notif-approved": () => [
    pr({
      id: "mock-notif",
      number: 901,
      title: "My quiet green PR",
      reviewDecision: "APPROVED",
      hasHumanApproval: true,
      canBeMerged: true,
      reviewers: [reviewerApproved],
    }),
  ],
  "notif-review": () => [
    pr({
      id: "mock-notif-review",
      number: 902,
      title: "Teammate PR needing my review",
      roles: ["reviewer"],
      author: { login: "teammate", avatarUrl: TEAMMATE },
      awaitingReview: true,
    }),
  ],
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
  ignoredStatePath: string;
} {
  return {
    loadSettings: () => {
      // Everything except trackComments is pinned for the fixture (fast cadence,
      // a fake host) — but trackComments is exactly the preference this harness
      // needs to exercise, so it is read from the REAL settings.json instead of
      // pinned, letting the Settings screen's checkbox actually reach the poller
      // in mock mode. Falls back to the default if settings.json is missing/bad.
      let trackComments = defaultSettings().trackComments;
      try {
        trackComments = loadRealSettings().trackComments;
      } catch {
        // Invalid settings.json: keep the default rather than fail the tick.
      }
      return {
        ...defaultSettings(),
        pollIntervalSeconds: 10,
        trackComments,
        hosts: [{ label: HOST_LABEL, graphqlUrl: "https://mock.invalid/graphql", repos: ["acme/widgets"] }],
      };
    },
    toHostConfigs: () => [
      { label: HOST_LABEL, graphqlUrl: "https://mock.invalid/graphql", token: "mock", repos: ["acme/widgets"] },
    ],
    fetchHostFn: mockFetchHost,
    probeNotificationsFn: mockProbeNotifications,
    statePath: path.join(userDataPath, "seen-state.mock.json"),
    ignoredStatePath: path.join(userDataPath, "ignored-state.mock.json"),
  };
}
