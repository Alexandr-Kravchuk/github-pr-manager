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
  AgentAction,
  AgentItem,
  AgentState,
  ClaudeSessionInfo,
  DashboardResponse,
  PrManagerApi,
  PullRequest,
  Settings,
} from "../../shared/types";
import { DEFAULT_AGENT_SETTINGS } from "../../shared/agent-defaults";
import { DEFAULT_CLAUDE_SETTINGS } from "../../shared/claude-launch";

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
    stack: null,
    blockedByStack: false,
    author: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" },
    createdAt: new Date(Date.now() - 864e5).toISOString(),
    updatedAt: new Date(Date.now() - 36e5).toISOString(),
    lastCommitPushedAt: new Date(Date.now() - 36e5).toISOString(),
    headRefName: "feature/sample",
    headOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    additions: 120,
    deletions: 30,
    changedFiles: 6,
    mergeMethods: { suggested: "squash", allowed: ["merge", "squash", "rebase"] },
    requestedOfMe: (overrides.roles ?? []).includes("reviewer"),
    isCrossRepository: false,
    authorRepliedAt: null,
    reviewerRepliedAt: null,
    issueKey: null,
    issueSummary: null,
    parentKey: null,
    parentSummary: null,
    grandparentKey: null,
    grandparentSummary: null,
    reviewDecision: null,
    roles: ["author"],
    viewerHasReviewed: false,
    viewerApproved: false,
    viewerReviewedAt: null,
    viewerReviewedHead: false,
    myReReviewDue: false,
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
    hasUnaddressedReviewFeedback: false,
    hasHumanApproval: false,
    hasConflicts: false,
    isBehindBase: false,
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
      issueSummary: "Add a response deadline for read-only MCP tools",
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
      issueSummary: "Retry transient network errors per operation",
      parentKey: "ENG-93367",
      parentSummary: "Analyze long app creating",
      headRefName: "feature/eng-93374-retry",
      roles: ["reviewer"],
      author: { login: "teammate", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4" },
      awaitingReview: true,
      hasNoReviews: true,
    }),
    // Same ticket as the PR above, in a second repo — one issue key across two
    // repos is what "Group by issue" exists for, and what makes its heading
    // ("KEY · summary") visible in the browser dev mock.
    pr({
      title: "ENG-93374: document the retry budget",
      repo: "acme/clio-knowledge",
      number: 118,
      issueKey: "ENG-93374",
      issueSummary: "Retry transient network errors per operation",
      parentKey: "ENG-93367",
      parentSummary: "Analyze long app creating",
      headRefName: "feature/eng-93374-docs",
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
      issueSummary: "Honor the static prefix when a column is renamed",
      // A subtask whose task has no PR here: it reaches the epic's cluster
      // through `grandparentKey`, and the card names the task it skips over.
      parentKey: "ENG-93368",
      parentSummary: "Column rename keeps the schema prefix",
      grandparentKey: "ENG-93367",
      grandparentSummary: "Analyze long app creating",
      headRefName: "feature/eng-93375",
      // I reviewed this earlier and the author pushed new changes back to me —
      // so GitHub has cleared the review request and only `reviewed-by:@me`
      // still finds it. The passive role, with returnedToMe as its one way to
      // claim attention.
      roles: ["reviewed"],
      author: { login: "teammate", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4" },
      viewerHasReviewed: true,
      returnedToMe: true,
      hasNoReviews: false,
      lastSeenAt: new Date(Date.now() - 2 * 864e5).toISOString(),
      totalComments: 8,
      unresolvedThreads: 2,
      reviewers: [{ login: "me", avatarUrl: "", reviewState: "changes_requested" }],
    }),
    // Approved by me and quiet — exactly what "Hide my approvals" takes away.
    pr({
      title: "ENG-93380: Cache the tenant probe",
      repo: "acme/clio",
      number: 934,
      issueKey: "ENG-93380",
      issueSummary: "Cache the Atlassian tenant probe",
      roles: ["reviewed"],
      author: { login: "teammate", avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4" },
      viewerHasReviewed: true,
      viewerApproved: true,
      hasHumanApproval: true,
      hasNoReviews: false,
      reviewDecision: "APPROVED",
      canBeMerged: true,
      reviewers: [{ login: "me", avatarUrl: "", reviewState: "approved" }],
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
  // Manual QA fixture for the `trackComments` accent promise: two authored,
  // awaiting-review PRs — one with a new comment while tracking is on (amber),
  // one identical except `hasNewActivity: false` (as it would be with tracking
  // off) which must read as the grey `waiting` accent instead.
  track: [
    pr({
      title: "Track test — hasNewActivity true (tracking ON)",
      number: 501,
      awaitingReview: true,
      totalComments: 3,
      hasNewActivity: true,
    }),
    pr({
      title: "Track test — hasNewActivity false (tracking OFF)",
      number: 502,
      awaitingReview: true,
      totalComments: 3,
      hasNewActivity: false,
    }),
  ],
};

// The PR agent's Board, chip and statuses: PRs in every state it shows. `?buddy=agent`.
FIXTURES.agent = [...FIXTURES.showcase, ...FIXTURES.review];

const mood = new URLSearchParams(window.location.search).get("buddy") ?? "sleeping";

const snapshot: DashboardResponse = {
  pullRequests: FIXTURES[mood] ?? FIXTURES.sleeping,
  errors: [],
  // Two hosts so the header's host pills act as filters; GHE's budget is low on
  // purpose, so its dot shows the amber state.
  rateLimits: [
    { hostLabel: "GitHub", remaining: 4980, limit: 5000, cost: 20, resetAt: new Date().toISOString(), fetchedAt: new Date().toISOString() },
    { hostLabel: "GHE", remaining: 320, limit: 5000, cost: 20, resetAt: new Date().toISOString(), fetchedAt: new Date().toISOString() },
  ],
  fetchedAt: new Date().toISOString(),
  version: "dev",
};

const settings: Settings = {
  pollIntervalSeconds: 60,
  launchAtLogin: false,
  autoUpdate: false,
  closeToTray: true,
  theme: "system",
  trackComments: true,
  notifications: {
    enabled: true,
    native: true,
    sound: false,
    events: { yourTurn: true, ciFailed: true, goodNews: true },
  },
  hosts: [{ label: "GitHub", graphqlUrl: "https://api.github.com/graphql", repos: ["acme/widgets"] }],
  claude: { ...DEFAULT_CLAUDE_SETTINGS, enabled: true },
  agent: structuredClone(DEFAULT_AGENT_SETTINGS),
};

/** Running Claude sessions, matched to the `?buddy=review` fixtures by their head branch. */
const CLAUDE_SESSIONS: ClaudeSessionInfo[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "🚀 ENG-93373 · Deadline for the reminder job",
    status: "busy",
    where: "desktop",
    prKeys: [],
    repoKeys: ["github.com/acme/clio"],
    branch: "feature/eng-93373-deadline",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "✋🏻 ENG-93374 · Retry the webhook delivery",
    status: "waiting",
    waitingFor: "input needed",
    where: "terminal",
    prKeys: [],
    repoKeys: ["github.com/acme/clio"],
    branch: "feature/eng-93374-retry",
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    name: "✅ ENG-93375 · Drive PR green",
    status: "idle",
    where: "terminal",
    prKeys: [],
    repoKeys: ["github.com/acme/clio"],
    branch: "feature/eng-93375",
  },
  {
    id: "00000000-0000-4000-8000-000000000005",
    name: "🔀 ENG-93374 · Retry budget docs",
    status: "paused",
    where: "desktop",
    prKeys: [],
    repoKeys: ["github.com/acme/clio-knowledge"],
    branch: "feature/eng-93374-docs",
    lastActivityAt: Date.now() - 3 * 36e5,
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    name: "widgets-7f",
    status: "busy",
    where: "background",
    prKeys: [],
    repoKeys: ["github.com/acme/clio"],
    branch: "feature/eng-93375",
  },
];

/**
 * The agent's state for `?buddy=agent`: two runs with a plan, one queued, a
 * brief, a failure and a shadow review waiting, a finished one. Actions change
 * it in memory, so the Board and the companion can be tried in a browser.
 * Every other fixture set has the agent off, as a fresh install does.
 */
function mockAgentState(): AgentState {
  const prs = snapshot.pullRequests;
  const byNumber = (n: number) => prs.find((p) => p.number === n);
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const item = (n: number, over: Partial<AgentItem>): AgentItem | null => {
    const pr = byNumber(n);
    if (!pr) return null;
    return {
      runId: runId(n),
      key: `${pr.id}|review|${pr.headOid}`,
      prId: pr.id,
      prNumber: pr.number,
      repo: pr.repo,
      url: pr.url,
      title: pr.title,
      hostLabel: pr.hostLabel,
      scenario: "review",
      mode: "shadow",
      state: "queued",
      headline: "Queued: review",
      queuedAt: iso(20 * 60_000),
      ...over,
    };
  };
  const items = [
    item(911, { state: "working", headline: "Reviewing", startedAt: iso(3 * 60_000), sessionId: "11111111-1111-4111-8111-111111111111" }),
    item(44, { state: "working", headline: "Reviewing", startedAt: iso(40_000), sessionId: "22222222-2222-4222-8222-222222222222" }),
    item(88, { state: "queued", headline: "Queued: review" }),
    item(912, {
      scenario: "brief",
      mode: "on",
      state: "needsYou",
      headline: "Brief ready",
      finishedAt: iso(15 * 60_000),
      sessionId: "33333333-3333-4333-8333-333333333333",
      worktree: "/tmp/agent-clio-912",
      output:
        "Problem: transient network errors fail the whole sync.\nApproach: retry each operation with a bounded budget.\nRisky parts: the retry has no overall time limit.\n\nDecisions for you:\n1. Is an unbounded retry acceptable?\n2. The public contract of sync-schemas changed: agreed?",
    }),
    item(118, { state: "error", headline: "No checkout of acme/clio-knowledge: set its folder in Settings > Claude", finishedAt: iso(30 * 60_000) }),
    item(929, {
      state: "needsYou",
      headline: "Would post: request changes, 1 inline comment, 1 reply",
      finishedAt: iso(5 * 60_000),
      sessionId: "44444444-4444-4444-8444-444444444444",
      worktree: "/tmp/agent-clio-929",
      runFolder: "/tmp/prd-agent/929",
      output: "Prepared a review: request changes, one inline comment, one reply.",
      plan: {
        event: "REQUEST_CHANGES",
        body: "**Summary.** The rename keeps the static prefix in the designer now, but the schema column still drops it when the entity is renamed (AC-2).\n\n**Requirement coverage.** AC-1 covered, AC-2 missing, AC-3 covered.",
        comments: [{ path: "src/Schema/SchemaColumn.cs", line: 142, body: "**Major — AC-2.** `Rename()` rebuilds the name from `Caption`, so the `Usr` prefix is lost: renaming `UsrAccount` gives `Account`. Keep the prefix from the old name." }],
        replies: [{ replyTo: 1001, body: "Still applies at the head: the guard on line 88 checks the caption, not the name." }],
        resolves: 0,
        escalations: [],
      },
    }),
    item(934, {
      key: `${byNumber(934)?.id}|rereview|${byNumber(934)?.headOid}|reply@${iso(30 * 60_000)}`,
      scenario: "rereview",
      state: "needsYou",
      headline: "Would post: comment, 1 resolve, 1 dispute for you",
      finishedAt: iso(8 * 60_000),
      sessionId: "66666666-6666-4666-8666-666666666666",
      worktree: "/tmp/agent-clio-934",
      runFolder: "/tmp/prd-agent/934",
      output: "Re-review: one thread fixed at the head, one where the author disagrees — handed back to you.",
      plan: {
        event: "COMMENT",
        body: "**Re-review.** The tenant probe now caches per host (thread on TenantProbe.cs:40 — fixed, resolving).",
        comments: [],
        replies: [],
        resolves: 1,
        escalations: [{ replyTo: 2002, body: "The author says the probe cache is per tenant by design; the finding says a stale entry outlives a tenant switch. A design call — yours." }],
      },
    }),
    item(142, {
      key: `${byNumber(142)?.id}|drive|${byNumber(142)?.headOid}|ci`,
      scenario: "drive",
      state: "needsYou",
      headline: "Would push 2 commits: fix: back off on 403 with retry-after",
      reasons: ["ci"],
      finishedAt: iso(3 * 60_000),
      sessionId: "77777777-7777-4777-8777-777777777777",
      worktree: "/tmp/agent-dashboard-142",
      drive: {
        base: byNumber(142)?.headOid ?? "0".repeat(40),
        head: "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3",
        reasons: ["ci"],
        commits: [
          { oid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", subject: "test: cover a 403 with retry-after" },
          { oid: "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3", subject: "fix: back off on 403 with retry-after" },
        ],
        stat: " src/main/poller.ts        | 12 ++++++------\n tests/poller.test.cjs     | 18 ++++++++++++++++++\n 2 files changed, 24 insertions(+), 6 deletions(-)",
        patch: "diff --git a/src/main/poller.ts b/src/main/poller.ts\n@@ -561,7 +561,13 @@\n-    const wait = 60_000;\n+    const retryAfter = Number(res.headers.get(\"retry-after\"));\n+    const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : 60_000;\n",
      },
    }),
    item(85, {
      key: `${byNumber(85)?.id}|merge|${byNumber(85)?.headOid}`,
      scenario: "merge",
      mode: "on",
      state: "needsYou",
      headline: "Ready to merge — squash",
      finishedAt: iso(2 * 60_000),
      mergeMethods: byNumber(85)?.mergeMethods,
      mergeMethod: "squash",
    }),
  ].filter((i): i is AgentItem => i !== null);
  // A PR you merged a moment ago: gone from the dashboard, its Jira dry run still waits on the Board.
  items.push({
    runId: runId(930),
    key: "PR_merged_930|afterMerge|0f1e2d",
    prId: "PR_merged_930",
    prNumber: 930,
    repo: "acme/clio",
    url: "https://github.com/acme/clio/pull/930",
    title: "Document the retry budget",
    hostLabel: prs[0]?.hostLabel ?? "GitHub",
    scenario: "afterMerge",
    mode: "on",
    state: "needsYou",
    headline: "Jira dry run ready — apply it in a session",
    queuedAt: iso(12 * 60_000),
    finishedAt: iso(9 * 60_000),
    sessionId: "55555555-5555-4555-8555-555555555555",
    output: "Would resolve ENG-93380 (Done → Closed): merged PR #930 implements every acceptance criterion.\nWould leave ENG-93374 open: its PR #912 is still in review.\n\nApply these changes?",
  });
  const run = (n: number, steps: Array<[string, "pending" | "in_progress" | "completed"]>, activity: string) => ({
    runId: runId(n),
    progress: {
      sessionId: null,
      steps: steps.map(([subject, status], i) => ({ id: String(i + 1), subject, status })),
      pendingCreates: [],
      activity,
      lastText: null,
      toolCalls: 12,
      rateLimit: { status: "allowed", resetsAt: null },
      backgroundTasks: 0,
      result: null,
    },
    recent: [
      { at: iso(150_000), text: `$ gh pr view ${n} --json title,body,files` },
      { at: iso(120_000), text: `$ gh pr diff ${n}` },
      { at: iso(60_000), text: activity },
    ],
    paused: false,
  });
  return {
    enabled: true,
    items,
    running: [
      run(
        911,
        [
          ["Check whether you already reviewed it", "completed"],
          ["Read the Jira task", "completed"],
          ["Collect the diff", "completed"],
          ["Run 5 reviewers in parallel", "in_progress"],
          ["Decide", "pending"],
          ["Write up the review", "pending"],
        ],
        "Agent: security reviewer",
      ),
      run(44, [["Read the PR", "in_progress"], ["Review the dependency bumps", "pending"]], "$ gh pr diff 44"),
    ].filter((r) => items.some((i) => i.runId === r.runId)),
    idle: Object.fromEntries(
      prs.map((p) => [p.id, p.roles.includes("author") ? "Yours: nothing for the agent yet" : p.isDraft ? "Draft: picked up once ready for review" : "Nothing for the agent"]),
    ),
    runsToday: 6,
    perDay: 30,
    parallel: 2,
    heldUntil: null,
    headerChip: true,
    acceptedUnchanged: 4,
    suggestOn: false,
  };
}

const agentListeners = new Set<(s: AgentState) => void>();
let agentState: AgentState =
  mood === "agent"
    ? mockAgentState()
    : { enabled: false, items: [], running: [], idle: {}, runsToday: 0, perDay: 30, parallel: 2, heldUntil: null, headerChip: true, acceptedUnchanged: 0, suggestOn: false };

function mockAgentAction(action: AgentAction): { ok: true } | { ok: false; error: string } {
  if (!agentState.enabled) return { ok: false, error: "The agent is off: switch it on in Settings > Agent." };
  const items = agentState.items.map((i) => ({ ...i }));
  const at = new Date().toISOString();
  if (action.type === "enqueue") {
    const pr = snapshot.pullRequests.find((p) => p.id === action.prId);
    if (!pr) return { ok: false, error: "That PR is not on the dashboard any more." };
    items.push({
      runId: crypto.randomUUID(),
      key: `${pr.id}|review|${pr.headOid}|asked`,
      prId: pr.id,
      prNumber: pr.number,
      repo: pr.repo,
      url: pr.url,
      title: pr.title,
      hostLabel: pr.hostLabel,
      scenario: "review",
      mode: "shadow",
      state: "queued",
      headline: "Queued: review (asked by you)",
      queuedAt: at,
    });
  } else {
    const it = items.find((i) => i.runId === action.runId);
    if (!it) return { ok: false, error: "That run is gone." };
    const running = agentState.running.find((r) => r.runId === action.runId);
    switch (action.type) {
      case "skip":
        Object.assign(it, { state: "done", headline: "Dismissed", finishedAt: at, later: false });
        break;
      case "later":
        it.later = !it.later;
        break;
      case "retry":
      case "reviewAnyway":
        Object.assign(it, { state: "queued", scenario: "review", headline: "Queued: review (asked by you)", queuedAt: at, output: undefined });
        break;
      case "pause":
      case "resume":
        if (running) running.paused = action.type === "pause";
        break;
      case "stop":
      case "takeOver":
        agentState.running = agentState.running.filter((r) => r !== running);
        Object.assign(it, {
          state: "needsYou",
          headline: action.type === "stop" ? "Stopped by you" : "You took it over in your terminal",
          finishedAt: at,
          worktree: "/tmp/x",
        });
        break;
      case "hint":
        if (running) running.recent = [...running.recent, { at, text: `You: ${action.text}` }];
        break;
      case "continue":
        break;
      case "publish":
        if (!it.plan) return { ok: false, error: "Nothing prepared to publish." };
        Object.assign(it, { state: "done", published: true, headline: "Published: request changes, 1 inline comment, 1 reply", finishedAt: at });
        agentState = { ...agentState, acceptedUnchanged: agentState.acceptedUnchanged + 1 };
        break;
      case "push":
        if (!it.drive) return { ok: false, error: "There is nothing to push." };
        Object.assign(it, { state: "done", pushed: true, headline: `Pushed ${it.drive.commits.length} commits`, finishedAt: at });
        break;
      case "merge":
        Object.assign(it, { state: "done", headline: `Merged (${action.method ?? it.mergeMethod ?? "squash"}), branch deleted`, finishedAt: at });
        items.push({ ...it, runId: crypto.randomUUID(), key: `${it.prId}|afterMerge|x`, scenario: "afterMerge", state: "queued", headline: "Queued: the Jira dry run", queuedAt: at });
        break;
    }
  }
  agentState = { ...agentState, items };
  for (const l of agentListeners) l(agentState);
  return { ok: true };
}

const api: PrManagerApi = {
  getDashboard: async () => ({ ok: true, snapshot }),
  refresh: async () => ({ ok: true, snapshot }),
  getConfig: async () => ({
    ok: true,
    config: {
      pollIntervalSeconds: 60,
      hosts: [
        { label: "GitHub", repos: ["acme/widgets"] },
        { label: "GHE", repos: ["corp/widgets"] },
      ],
      trackComments: true,
      claudeEnabled: true,
    },
  }),
  markSeen: async () => {},
  setIgnored: async () => {},
  openExternal: async () => {},
  getSettings: async () => settings,
  saveSettings: async () => ({ ok: true }),
  setTheme: async () => {},
  getGhStatus: async () => ({ installed: true, hosts: [{ hostname: "github.com", label: "GitHub", authenticated: true }] }),
  // A site is set so the issue-key badge renders in mock mode; openExternal is a
  // no-op above, so clicking it stays inert.
  getJiraStatus: async () => ({
    configured: true,
    hasConfig: true,
    hasToken: true,
    baseUrl: "https://example.atlassian.net",
    encryptionAvailable: true,
  }),
  setJiraToken: async () => ({ ok: true }),
  getAppVersion: async () => "dev",
  launchClaude: async () => ({ ok: false, error: "Not available in mock mode." }),
  getClaudeSessions: async () => CLAUDE_SESSIONS,
  focusClaudeSession: async () => ({ ok: false, error: "Not available in mock mode." }),
  onClaudeSessions: () => () => {},
  copyText: async () => {},
  getWhatsNew: async () => null,
  dismissWhatsNew: async () => {},
  onSnapshot: () => () => {},
  onConfigError: () => () => {},
  onUpdateStatus: () => () => {},
  onNotifySound: () => () => {},
  onOpenSettings: () => () => {},
  onRefreshRequest: () => () => {},
  getAgentState: async () => agentState,
  agentAction: async (action) => mockAgentAction(action),
  onAgentState: (listener) => {
    agentListeners.add(listener);
    return () => {
      agentListeners.delete(listener);
    };
  },
  onAgentShowBoard: () => () => {},
};

(window as unknown as { api: PrManagerApi }).api = api;
