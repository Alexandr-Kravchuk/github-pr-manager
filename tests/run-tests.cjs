// Minimal dependency-free test runner (run after `npm run build:main`, which
// compiles the shared modules to dist/main/shared/*.js). Covers the pure config
// logic — host derivation and settings validation — which is the trickiest part
// and is Electron-free, so it runs in plain Node (and in CI).
const assert = require("node:assert");
const path = require("node:path");

const fs = require("node:fs/promises");
const os = require("node:os");

const cfg = require(path.join(__dirname, "../dist/main/shared/config.js"));
const poller = require(path.join(__dirname, "../dist/main/main/poller.js"));
const notif = require(path.join(__dirname, "../dist/main/shared/notifications.js"));
const github = require(path.join(__dirname, "../dist/main/shared/github.js"));
const ignored = require(path.join(__dirname, "../dist/main/shared/ignored.js"));
const state = require(path.join(__dirname, "../dist/main/shared/state.js"));
const jira = require(path.join(__dirname, "../dist/main/shared/jira.js"));
const jiraHealth = require(path.join(__dirname, "../dist/main/shared/jira-health.js"));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   -", name);
  } catch (e) {
    failed++;
    console.error("  FAIL -", name, "\n        ", e.message);
  }
}

async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok   -", name);
  } catch (e) {
    failed++;
    console.error("  FAIL -", name, "\n        ", e.message);
  }
}

// --- ghHostnameFromUrl -------------------------------------------------------
test("ghHostnameFromUrl: github.com cloud", () =>
  assert.strictEqual(cfg.ghHostnameFromUrl("https://api.github.com/graphql"), "github.com"));
test("ghHostnameFromUrl: GHE cloud (data residency)", () =>
  assert.strictEqual(
    cfg.ghHostnameFromUrl("https://api.creatio.ghe.com/graphql"),
    "creatio.ghe.com",
  ));
test("ghHostnameFromUrl: GHE server (/api/graphql)", () =>
  assert.strictEqual(
    cfg.ghHostnameFromUrl("https://github.company.com/api/graphql"),
    "github.company.com",
  ));
test("ghHostnameFromUrl: invalid URL throws ConfigError", () =>
  assert.throws(() => cfg.ghHostnameFromUrl("not a url"), /Invalid graphqlUrl/));

// --- defaultSettings ---------------------------------------------------------
test("defaultSettings: empty + 60s + toggles", () => {
  const d = cfg.defaultSettings();
  assert.strictEqual(d.pollIntervalSeconds, 60);
  assert.strictEqual(d.launchAtLogin, false);
  assert.strictEqual(d.autoUpdate, true);
  assert.strictEqual(d.theme, "system");
  assert.deepStrictEqual(d.hosts, []);
});

// --- validateSettings --------------------------------------------------------
test("validateSettings: missing hosts is valid (unconfigured)", () => {
  const s = cfg.validateSettings({ pollIntervalSeconds: 30 });
  assert.strictEqual(s.pollIntervalSeconds, 30);
  assert.deepStrictEqual(s.hosts, []);
});
test("validateSettings: toggles default off/on when absent", () => {
  const s = cfg.validateSettings({ hosts: [] });
  assert.strictEqual(s.launchAtLogin, false);
  assert.strictEqual(s.autoUpdate, true);
});
test("validateSettings: toggles honored when present", () => {
  const s = cfg.validateSettings({ launchAtLogin: true, autoUpdate: false, hosts: [] });
  assert.strictEqual(s.launchAtLogin, true);
  assert.strictEqual(s.autoUpdate, false);
});
test("validateSettings: theme defaults to system when absent/invalid", () => {
  assert.strictEqual(cfg.validateSettings({ hosts: [] }).theme, "system");
  assert.strictEqual(cfg.validateSettings({ theme: "sepia", hosts: [] }).theme, "system");
});
test("validateSettings: theme honored when light/dark", () => {
  assert.strictEqual(cfg.validateSettings({ theme: "light", hosts: [] }).theme, "light");
  assert.strictEqual(cfg.validateSettings({ theme: "dark", hosts: [] }).theme, "dark");
});
test("validateSettings: sub-minimum interval falls back to 60", () => {
  assert.strictEqual(cfg.validateSettings({ pollIntervalSeconds: 2, hosts: [] }).pollIntervalSeconds, 60);
});
test("validateSettings: valid host normalized", () => {
  const s = cfg.validateSettings({
    pollIntervalSeconds: 45,
    hosts: [{ label: " GH ", graphqlUrl: "https://api.github.com/graphql", repos: ["a/b", "bad", "c/d"] }],
  });
  assert.strictEqual(s.hosts.length, 1);
  assert.strictEqual(s.hosts[0].label, "GH");
  // repos without "owner/name" shape are dropped
  assert.deepStrictEqual(s.hosts[0].repos, ["a/b", "c/d"]);
});
test("validateSettings: host missing graphqlUrl throws", () =>
  assert.throws(() => cfg.validateSettings({ hosts: [{ label: "x" }] }), /missing graphqlUrl/));
test("validateSettings: host with invalid graphqlUrl throws", () =>
  assert.throws(
    () => cfg.validateSettings({ hosts: [{ label: "x", graphqlUrl: "nope" }] }),
    /Invalid graphqlUrl/,
  ));
test("validateSettings: non-object throws", () =>
  assert.throws(() => cfg.validateSettings(42), /expected an object/));

// --- normalizeJiraBaseUrl ----------------------------------------------------
test("normalizeJiraBaseUrl: adds https:// when the scheme is missing", () =>
  assert.strictEqual(cfg.normalizeJiraBaseUrl("org.atlassian.net"), "https://org.atlassian.net"));
test("normalizeJiraBaseUrl: strips path/trailing slash to origin", () =>
  assert.strictEqual(cfg.normalizeJiraBaseUrl("https://org.atlassian.net/jira/"), "https://org.atlassian.net"));
test("normalizeJiraBaseUrl: null on garbage", () =>
  assert.strictEqual(cfg.normalizeJiraBaseUrl("http://"), null));

// --- validateSettings: jira --------------------------------------------------
test("validateSettings: valid jira normalized", () => {
  const s = cfg.validateSettings({
    hosts: [],
    jira: { baseUrl: "org.atlassian.net", email: " me@x.com " },
  });
  assert.deepStrictEqual(s.jira, { baseUrl: "https://org.atlassian.net", email: "me@x.com" });
});
test("validateSettings: incomplete jira (no email) is dropped", () =>
  assert.strictEqual(cfg.validateSettings({ hosts: [], jira: { baseUrl: "org.atlassian.net" } }).jira, undefined));
test("validateSettings: absent jira is undefined", () =>
  assert.strictEqual(cfg.validateSettings({ hosts: [] }).jira, undefined));
test("validateSettings: jira with invalid baseUrl throws", () =>
  assert.throws(
    () => cfg.validateSettings({ hosts: [], jira: { baseUrl: "http://", email: "me@x.com" } }),
    /jira\.baseUrl/,
  ));

// --- toPublicConfig ----------------------------------------------------------
test("toPublicConfig: strips graphqlUrl, keeps label + repos", () => {
  const pub = cfg.toPublicConfig({
    pollIntervalSeconds: 60,
    hosts: [{ label: "GH", graphqlUrl: "https://api.github.com/graphql", repos: ["a/b"] }],
  });
  assert.deepStrictEqual(pub, {
    pollIntervalSeconds: 60,
    hosts: [{ label: "GH", repos: ["a/b"] }],
  });
});

// --- poller: hostIntervalMs --------------------------------------------------
const future = (s) => new Date(Date.now() + s * 1000).toISOString();
test("hostIntervalMs: no rate-limit reading uses base", () =>
  assert.strictEqual(poller.hostIntervalMs(null, 60_000), 60_000));
test("hostIntervalMs: cheap host (cost 1) stays at base", () =>
  assert.strictEqual(
    poller.hostIntervalMs({ hostLabel: "GHE", remaining: 5000, cost: 1, resetAt: future(3600) }, 60_000),
    60_000,
  ));
test("hostIntervalMs: expensive host (cost 35) gets the 5-min floor", () =>
  assert.strictEqual(
    poller.hostIntervalMs({ hostLabel: "GH", remaining: 5000, cost: 35, resetAt: future(3600) }, 60_000),
    300_000,
  ));
test("hostIntervalMs: backoff base does not stretch an expensive host beyond its floor", () =>
  assert.strictEqual(
    poller.hostIntervalMs({ hostLabel: "GH", remaining: 5000, cost: 35, resetAt: future(3600) }, 600_000),
    300_000,
  ));
test("hostIntervalMs: exhausted budget waits at least the minute floor", () =>
  assert.strictEqual(
    poller.hostIntervalMs({ hostLabel: "GHE", remaining: 0, cost: 1, resetAt: future(5) }, 60_000),
    60_000,
  ));

// --- poller: hotness floor ---------------------------------------------------
const rl = (cost) => ({ hostLabel: "GH", remaining: 5000, cost, resetAt: future(3600) });
test("hostIntervalMs: cold expensive host stretches the floor 4x", () =>
  assert.strictEqual(poller.hostIntervalMs(rl(35), 60_000, false), 1_200_000));
test("hostIntervalMs: hot expensive host keeps the tight 5-min floor", () =>
  assert.strictEqual(poller.hostIntervalMs(rl(35), 60_000, true), 300_000));
test("hostIntervalMs: hotness never stretches a cheap host below base", () =>
  assert.strictEqual(poller.hostIntervalMs(rl(1), 60_000, false), 60_000));

// --- poller: isHotPr / hostHasHotPr ------------------------------------------
const NOW = Date.parse("2026-07-07T12:00:00Z");
const basePr = { ciState: "success", unresolvedThreads: 0, updatedAt: "2026-07-07T00:00:00Z" };
test("isHotPr: pending CI is hot", () =>
  assert.strictEqual(poller.isHotPr({ ...basePr, ciState: "pending" }, NOW), true));
test("isHotPr: failing CI is hot", () =>
  assert.strictEqual(poller.isHotPr({ ...basePr, ciState: "failure" }, NOW), true));
test("isHotPr: an open thread is hot", () =>
  assert.strictEqual(poller.isHotPr({ ...basePr, unresolvedThreads: 1 }, NOW), true));
test("isHotPr: recent activity is hot", () =>
  assert.strictEqual(
    poller.isHotPr({ ...basePr, updatedAt: new Date(NOW - 10 * 60 * 1000).toISOString() }, NOW),
    true,
  ));
test("isHotPr: green + quiet + stale is cold", () =>
  assert.strictEqual(poller.isHotPr(basePr, NOW), false));
test("hostHasHotPr: false when all cold, true if any hot", () => {
  assert.strictEqual(poller.hostHasHotPr([basePr, basePr], NOW), false);
  assert.strictEqual(poller.hostHasHotPr([basePr, { ...basePr, ciState: "pending" }], NOW), true);
});

// --- notifications: parsePollIntervalMs --------------------------------------
test("parsePollIntervalMs: honors the header, floored at 60s", () => {
  assert.strictEqual(notif.parsePollIntervalMs("120"), 120_000);
  assert.strictEqual(notif.parsePollIntervalMs("30"), 60_000);
});
test("parsePollIntervalMs: missing/garbage falls back to 60s", () => {
  assert.strictEqual(notif.parsePollIntervalMs(null), 60_000);
  assert.strictEqual(notif.parsePollIntervalMs("nope"), 60_000);
});

// --- notifications: newestTrackedActivity ------------------------------------
const items = [
  { updated_at: "2026-07-07T10:00:00Z", repository: { full_name: "acme/widgets" } },
  { updated_at: "2026-07-07T11:00:00Z", repository: { full_name: "other/repo" } },
  { updated_at: "2026-07-07T09:00:00Z", repository: { full_name: "ACME/Widgets" } },
];
test("newestTrackedActivity: newest updated_at among tracked repos (case-insensitive)", () =>
  assert.strictEqual(notif.newestTrackedActivity(items, ["acme/widgets"]), "2026-07-07T10:00:00Z"));
test("newestTrackedActivity: null when nothing tracked matches", () =>
  assert.strictEqual(notif.newestTrackedActivity(items, ["nobody/here"]), null));
test("newestTrackedActivity: null on empty inputs", () => {
  assert.strictEqual(notif.newestTrackedActivity([], ["acme/widgets"]), null);
  assert.strictEqual(notif.newestTrackedActivity(items, []), null);
});

// --- poller: computeIdleFactor -----------------------------------------------
test("computeIdleFactor: no backoff until the streak passes the threshold", () => {
  assert.strictEqual(poller.computeIdleFactor(0), 1);
  assert.strictEqual(poller.computeIdleFactor(2), 1);
});
test("computeIdleFactor: doubles per extra unchanged tick", () => {
  assert.strictEqual(poller.computeIdleFactor(3), 2);
  assert.strictEqual(poller.computeIdleFactor(4), 4);
  assert.strictEqual(poller.computeIdleFactor(5), 8);
});
test("computeIdleFactor: capped", () => {
  assert.strictEqual(poller.computeIdleFactor(6), 16);
  assert.strictEqual(poller.computeIdleFactor(50), 16);
});

// --- github: mapPr canBeMerged (merge-readiness roll-up) ---------------------
// A ready-to-merge PR: not a draft, GitHub says MERGEABLE, one human approval,
// no change request, and no checks (so nothing failing or pending). Each test
// overrides exactly one dimension to prove it flips the flag off.
const approvedReview = { author: { __typename: "User", login: "rev", avatarUrl: "" }, state: "APPROVED" };
const rawPr = (overrides = {}) => ({
  id: "PR_1",
  number: 1,
  title: "T",
  url: "https://github.com/a/b/pull/1",
  isDraft: false,
  createdAt: "2026-07-07T00:00:00Z",
  updatedAt: "2026-07-07T00:00:00Z",
  baseRefName: "main",
  headRefName: "feature/x",
  mergeable: "MERGEABLE",
  author: { login: "auth", avatarUrl: "" },
  repository: { nameWithOwner: "a/b", defaultBranchRef: { name: "main" } },
  reviewDecision: "APPROVED",
  reviewRequests: { totalCount: 0, nodes: [] },
  latestOpinionatedReviews: { nodes: [approvedReview] },
  comments: { totalCount: 0 },
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { pushedDate: "2026-07-07T00:00:00Z", committedDate: "2026-07-07T00:00:00Z", statusCheckRollup: null } }] },
  ...overrides,
});
const canMerge = (overrides) => github.mapPr(rawPr(overrides), "GH", ["authored"], null).canBeMerged;
const failingRollup = {
  nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: {
    nodes: [{ __typename: "CheckRun", name: "ci", conclusion: "FAILURE", status: "COMPLETED", detailsUrl: null }],
  } } } }],
};
const pendingRollup = {
  nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: {
    nodes: [{ __typename: "CheckRun", name: "ci", conclusion: null, status: "IN_PROGRESS", detailsUrl: null }],
  } } } }],
};

test("mapPr.canBeMerged: green + approved + mergeable is ready", () =>
  assert.strictEqual(canMerge(), true));
test("mapPr.canBeMerged: draft is never ready", () =>
  assert.strictEqual(canMerge({ isDraft: true }), false));
test("mapPr.canBeMerged: transient UNKNOWN mergeability stays false", () =>
  assert.strictEqual(canMerge({ mergeable: "UNKNOWN" }), false));
test("mapPr.canBeMerged: conflicting is not ready", () =>
  assert.strictEqual(canMerge({ mergeable: "CONFLICTING" }), false));
test("mapPr.canBeMerged: no human approval is not ready", () =>
  assert.strictEqual(canMerge({ latestOpinionatedReviews: { nodes: [] } }), false));
test("mapPr.canBeMerged: a bot approval does not count as human", () =>
  assert.strictEqual(
    canMerge({
      latestOpinionatedReviews: {
        nodes: [{ author: { __typename: "Bot", login: "dependabot", avatarUrl: "" }, state: "APPROVED" }],
      },
    }),
    false,
  ));
test("mapPr.canBeMerged: unaddressed change request blocks readiness", () =>
  assert.strictEqual(
    canMerge({
      latestOpinionatedReviews: {
        nodes: [
          approvedReview,
          { author: { __typename: "User", login: "rev2", avatarUrl: "" }, state: "CHANGES_REQUESTED" },
        ],
      },
    }),
    false,
  ));
test("mapPr.canBeMerged: failing CI blocks readiness", () =>
  assert.strictEqual(canMerge({ commits: failingRollup }), false));
test("mapPr.canBeMerged: still-running CI blocks readiness", () =>
  assert.strictEqual(canMerge({ commits: pendingRollup }), false));

// --- github: mapPr defaults isIgnored to false (set later by ignored.ts) -----
test("mapPr.isIgnored: defaults to false", () =>
  assert.strictEqual(github.mapPr(rawPr(), "GH", ["authored"], null).isIgnored, false));

// --- github: mapPr issue key parsing -----------------------------------------
test("mapPr.issueKey: parsed from the title", () =>
  assert.strictEqual(
    github.mapPr(rawPr({ title: "ENG-93374 sync schemas" }), "GH", [], null).issueKey,
    "ENG-93374",
  ));
test("mapPr.issueKey: falls back to the head branch (case-insensitive)", () =>
  assert.strictEqual(
    github.mapPr(rawPr({ title: "no key here", headRefName: "feature/eng-93373-foo" }), "GH", [], null)
      .issueKey,
    "ENG-93373",
  ));
test("mapPr.issueKey: null when neither title nor branch has one", () =>
  assert.strictEqual(
    github.mapPr(rawPr({ title: "just words", headRefName: "wip" }), "GH", [], null).issueKey,
    null,
  ));

// --- github: mapPr viewer/no-review signals ----------------------------------
test("mapPr.hasNoReviews: true when no opinionated reviews", () =>
  assert.strictEqual(
    github.mapPr(rawPr({ latestOpinionatedReviews: { nodes: [] } }), "GH", [], null).hasNoReviews,
    true,
  ));
test("mapPr.hasNoReviews: false when someone reviewed", () =>
  assert.strictEqual(github.mapPr(rawPr(), "GH", [], null).hasNoReviews, false));
test("mapPr.viewerHasReviewed: true when the viewer authored a review", () =>
  assert.strictEqual(github.mapPr(rawPr(), "GH", [], "rev").viewerHasReviewed, true));
test("mapPr.viewerHasReviewed: false for a different viewer", () =>
  assert.strictEqual(github.mapPr(rawPr(), "GH", [], "someone-else").viewerHasReviewed, false));
test("mapPr.viewerHasReviewed: false when the viewer is unknown", () =>
  assert.strictEqual(github.mapPr(rawPr(), "GH", [], null).viewerHasReviewed, false));

// --- ignored: persistent ignore store ----------------------------------------
async function withTempStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prd-ignored-"));
  const file = path.join(dir, "ignored-state.json");
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// --- jira-health: pure enrichment classification -----------------------------
const JH_CFG = { baseUrl: "https://org.atlassian.net", email: "me@x.com" };
test("enrichmentSkipReason: no-config when baseUrl/email missing", () => {
  assert.strictEqual(jiraHealth.enrichmentSkipReason(undefined, true, 3), "no-config");
  assert.strictEqual(jiraHealth.enrichmentSkipReason({ baseUrl: "https://org.atlassian.net" }, true, 3), "no-config");
  assert.strictEqual(jiraHealth.enrichmentSkipReason({ email: "me@x.com" }, true, 3), "no-config");
});
test("enrichmentSkipReason: no-token when config present but token absent", () =>
  assert.strictEqual(jiraHealth.enrichmentSkipReason(JH_CFG, false, 3), "no-token"));
test("enrichmentSkipReason: no-keys when config+token present but zero keys", () =>
  assert.strictEqual(jiraHealth.enrichmentSkipReason(JH_CFG, true, 0), "no-keys"));
test("enrichmentSkipReason: null (run) when config+token+keys all present", () =>
  assert.strictEqual(jiraHealth.enrichmentSkipReason(JH_CFG, true, 2), null));
test("healthFromResolution: ok when >=1 parent resolved", () =>
  assert.deepStrictEqual(jiraHealth.healthFromResolution(3, 2), { state: "ok", queried: 3, resolved: 2 }));
test("healthFromResolution: empty when nothing resolved", () =>
  assert.deepStrictEqual(jiraHealth.healthFromResolution(3, 0), { state: "empty", queried: 3, resolved: 0 }));
test("healthFromError: error state carries the Error message", () =>
  assert.deepStrictEqual(jiraHealth.healthFromError(4, new Error("boom")), {
    state: "error",
    message: "boom",
    queried: 4,
    resolved: 0,
  }));
test("healthFromError: stringifies a non-Error rejection", () =>
  assert.deepStrictEqual(jiraHealth.healthFromError(1, "nope"), {
    state: "error",
    message: "nope",
    queried: 1,
    resolved: 0,
  }));

(async () => {
  await atest("applyIgnored: flags ignored PRs, leaves the rest false", () =>
    withTempStore(async (file) => {
      await ignored.setIgnored("PR_1", true, file);
      const prs = [
        { id: "PR_1", isIgnored: false },
        { id: "PR_2", isIgnored: false },
      ];
      await ignored.applyIgnored(prs, file);
      assert.strictEqual(prs[0].isIgnored, true);
      assert.strictEqual(prs[1].isIgnored, false);
    }));

  await atest("applyIgnored: missing store file leaves everything un-ignored", () =>
    withTempStore(async (file) => {
      const prs = [{ id: "PR_1", isIgnored: true }];
      await ignored.applyIgnored(prs, file);
      assert.strictEqual(prs[0].isIgnored, false);
    }));

  await atest("setIgnored: un-ignore removes the entry", () =>
    withTempStore(async (file) => {
      await ignored.setIgnored("PR_1", true, file);
      await ignored.setIgnored("PR_1", false, file);
      const prs = [{ id: "PR_1", isIgnored: false }];
      await ignored.applyIgnored(prs, file);
      assert.strictEqual(prs[0].isIgnored, false);
    }));

  // --- state: returnedToMe (re-review signal) --------------------------------
  const reviewPr = (o = {}) => ({
    id: "PR_state_1",
    totalComments: 2,
    updatedAt: "2026-07-07T00:00:00Z",
    lastCommitPushedAt: "2026-07-07T00:00:00Z",
    roles: ["reviewer"],
    viewerHasReviewed: true,
    failingChecks: [],
    hasUnaddressedChangeRequest: false,
    hasUnaddressedComments: false,
    unresolvedThreads: 0,
    awaitingReview: false,
    ...o,
  });

  await atest("applyActivity.returnedToMe: false on the first-seen baseline", () =>
    withTempStore(async (file) => {
      const p = reviewPr();
      await state.applyActivity([p], file);
      assert.strictEqual(p.returnedToMe, false);
      assert.strictEqual(p.lastSeenAt, null);
    }));

  await atest("applyActivity.returnedToMe: a new push after a review flips it on", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewPr()], file); // baseline at 07-07
      const later = reviewPr({ lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([later], file);
      assert.strictEqual(later.returnedToMe, true);
    }));

  await atest("applyActivity.returnedToMe: new comments flip it on too", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewPr()], file);
      const more = reviewPr({ totalComments: 5 });
      await state.applyActivity([more], file);
      assert.strictEqual(more.returnedToMe, true);
      assert.strictEqual(more.hasNewActivity, true);
    }));

  await atest("applyActivity.returnedToMe: never set on your own PR", () =>
    withTempStore(async (file) => {
      // Author who somehow also reviewed + pushed — the !author guard must win.
      await state.applyActivity([reviewPr({ roles: ["author"] })], file);
      const pushed = reviewPr({ roles: ["author"], lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file);
      assert.strictEqual(pushed.returnedToMe, false);
    }));

  await atest("applyActivity.returnedToMe: not set for an un-engaged reviewer request", () =>
    withTempStore(async (file) => {
      // Requested but never reviewed and never opened: a new push is not "back to me".
      await state.applyActivity([reviewPr({ viewerHasReviewed: false })], file);
      const pushed = reviewPr({ viewerHasReviewed: false, lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file);
      assert.strictEqual(pushed.returnedToMe, false);
    }));

  await atest("markSeen then applyActivity: viewing sets lastSeenAt and re-arms the baseline", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewPr({ viewerHasReviewed: false })], file); // baseline
      await state.markSeen(
        [{ id: "PR_state_1", comments: 2, updatedAt: "2026-07-07T00:00:00Z", lastCommitPushedAt: "2026-07-07T00:00:00Z" }],
        file,
      );
      const pushed = reviewPr({ viewerHasReviewed: false, lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file);
      assert.strictEqual(typeof pushed.lastSeenAt, "string"); // viewed → set
      assert.strictEqual(pushed.returnedToMe, true); // engaged via a view, new push
    }));

  // --- jira: fetchParents ----------------------------------------------------
  const JIRA_CFG = { baseUrl: "https://org.atlassian.net", email: "me@x.com" };
  const CLOUD_ID = "cloud-abc-123";
  const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/search/jql`;
  const SITE = `${JIRA_CFG.baseUrl}/rest/api/3/search/jql`;
  const okJson = (body) => ({ ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => "" });
  const errRes = (status) => ({ ok: false, status, statusText: "ERR", json: async () => ({}), text: async () => "err" });
  const tenantOk = () => okJson({ cloudId: CLOUD_ID });
  const isTenant = (url) => url.endsWith("/_edge/tenant_info");
  // Restore the real fetch after these tests.
  const realFetch = global.fetch;

  await atest("fetchParents: resolves via the API gateway (scoped token)", async () => {
    jira.clearParentCache();
    let hitSite = false;
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      if (url === GATEWAY)
        return okJson({ issues: [
          { key: "ENG-93373", fields: { parent: { key: "ENG-93367", fields: { summary: "Analyze long app creating" } } } },
          { key: "ENG-93374", fields: { parent: { key: "ENG-93367", fields: { summary: "Analyze long app creating" } } } },
        ] });
      if (url === SITE) { hitSite = true; return okJson({ issues: [] }); }
      throw new Error("unexpected url " + url);
    };
    const map = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-93373", "ENG-93374"]);
    assert.strictEqual(map.get("ENG-93373").parentKey, "ENG-93367");
    assert.strictEqual(map.get("ENG-93374").parentSummary, "Analyze long app creating");
    assert.strictEqual(hitSite, false); // scoped path must never touch the site URL
  });

  await atest("fetchParents: falls back to the site URL on 401 (classic token)", async () => {
    jira.clearParentCache();
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      if (url === GATEWAY) return errRes(401); // classic token → gateway rejects
      if (url === SITE)
        return okJson({ issues: [{ key: "ENG-1", fields: { parent: { key: "ENG-0", fields: { summary: "P" } } } }] });
      throw new Error("unexpected url " + url);
    };
    const map = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(map.get("ENG-1").parentKey, "ENG-0");
  });

  await atest("fetchParents: uses site only when cloudId can't be resolved", async () => {
    jira.clearParentCache();
    let hitGateway = false;
    global.fetch = async (url) => {
      if (isTenant(url)) return errRes(404);
      if (url === GATEWAY) { hitGateway = true; return errRes(401); }
      if (url === SITE)
        return okJson({ issues: [{ key: "ENG-1", fields: { parent: { key: "ENG-0" } } }] });
      throw new Error("unexpected url " + url);
    };
    const map = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(map.get("ENG-1").parentKey, "ENG-0");
    assert.strictEqual(hitGateway, false); // no cloudId → gateway never attempted
  });

  await atest("fetchParents: a key with no parent is absent from the map", async () => {
    jira.clearParentCache();
    global.fetch = async (url) =>
      isTenant(url) ? tenantOk() : okJson({ issues: [{ key: "ENG-1", fields: {} }] });
    const map = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(map.has("ENG-1"), false);
  });

  await atest("fetchParents: caches — a second call makes no request", async () => {
    jira.clearParentCache();
    let searchCalls = 0;
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      searchCalls++;
      return okJson({ issues: [{ key: "ENG-100", fields: { parent: { key: "ENG-1", fields: { summary: "P" } } } }] });
    };
    await jira.fetchParents(JIRA_CFG, "tok", ["ENG-100"]);
    const again = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-100"]);
    assert.strictEqual(searchCalls, 1);
    assert.strictEqual(again.get("ENG-100").parentKey, "ENG-1");
  });

  await atest("fetchParents: throws when every base rejects (401)", async () => {
    jira.clearParentCache();
    global.fetch = async (url) => (isTenant(url) ? tenantOk() : errRes(401));
    await assert.rejects(() => jira.fetchParents(JIRA_CFG, "tok", ["ENG-5"]), /Jira HTTP 401/);
  });

  await atest("fetchParents: recovers within the cloudId TTL after a transient blip (no 10-min negative poisoning)", async () => {
    // Regression: a transient tenant_info blip must not keep the banner 'empty'
    // for the full CACHE_TTL_MS. The failed cloudId is cached only ~60s, the
    // site-only base is left uncached, AND the untrusted 200-but-empty writes no
    // negative parentCache entries — so the first pass after the 60s TTL re-probes
    // and the scoped token reaches the gateway, long before the 10-min TTL. This
    // advances the clock only 61s to exercise that intervening window.
    jira.clearParentCache();
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    let tenantCalls = 0;
    let gatewayHits = 0;
    try {
      global.fetch = async (url) => {
        if (isTenant(url)) {
          tenantCalls++;
          if (tenantCalls === 1) throw new Error("network blip"); // transient
          return tenantOk(); // recovers on the next probe
        }
        if (url === GATEWAY) {
          gatewayHits++;
          return okJson({ issues: [{ key: "ENG-9", fields: { parent: { key: "ENG-0", fields: { summary: "P" } } } }] });
        }
        if (url === SITE) return okJson({ issues: [] }); // scoped token → 200-but-empty
        throw new Error("unexpected url " + url);
      };
      // First pass: cloudId lookup fails → site only → empty, gateway never tried.
      const first = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-9"]);
      assert.strictEqual(first.has("ENG-9"), false);
      assert.strictEqual(gatewayHits, 0);
      // Advance just past the 60s cloudId TTL — far short of the 10-min parentCache TTL.
      clock += 61 * 1000;
      // Second pass: cloudId re-resolves, the gateway wins (site base not pinned,
      // no negatives cached), so recovery happens inside the 60s window.
      const second = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-9"]);
      assert.strictEqual(second.get("ENG-9").parentKey, "ENG-0");
      assert.ok(gatewayHits >= 1);
    } finally {
      Date.now = realNow;
      global.fetch = realFetch;
    }
  });

  await atest("fetchParents: a 5xx/429 on the gateway throws and does NOT fall back to the site", async () => {
    // The 401/403-only fallback is deliberate: a scoped token on the site URL
    // answers 200-but-empty, so silently retrying there on a 429/500 would mask a
    // real gateway error as "no parents found". Lock the invariant in.
    for (const status of [429, 500]) {
      jira.clearParentCache();
      let hitSite = false;
      global.fetch = async (url) => {
        if (isTenant(url)) return tenantOk();
        if (url === GATEWAY) return errRes(status);
        if (url === SITE) { hitSite = true; return okJson({ issues: [] }); }
        throw new Error("unexpected url " + url);
      };
      await assert.rejects(
        () => jira.fetchParents(JIRA_CFG, "tok", ["ENG-7"]),
        new RegExp(`Jira HTTP ${status}`),
      );
      assert.strictEqual(hitSite, false);
    }
  });

  await atest("fetchParents: a network throw on the gateway still falls back to the site", async () => {
    // A thrown fetch (timeout/DNS, or a proxy blocking the gateway host while
    // allowing the site) must advance to the site like a 401 would, so a classic
    // token behind such a proxy isn't stranded on a hard error.
    jira.clearParentCache();
    let hitSite = false;
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      if (url === GATEWAY) throw new Error("ECONNREFUSED api.atlassian.com");
      if (url === SITE) {
        hitSite = true;
        return okJson({ issues: [{ key: "ENG-2", fields: { parent: { key: "ENG-1", fields: { summary: "P" } } } }] });
      }
      throw new Error("unexpected url " + url);
    };
    const map = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-2"]);
    assert.strictEqual(hitSite, true);
    assert.strictEqual(map.get("ENG-2").parentKey, "ENG-1");
  });

  global.fetch = realFetch;

  // --- poller: tick folds jiraHealth into the snapshot + change detection ----
  await atest("Poller.tick: enrichParents throw → error health; message change re-emits, no-change dedups", async () => {
    const snapshots = [];
    let enrichError = "boom A";
    const p = new poller.Poller({
      loadSettings: () => ({
        pollIntervalSeconds: 60,
        launchAtLogin: false,
        autoUpdate: false,
        theme: "system",
        hosts: [],
      }),
      toHostConfigs: () => [],
      // Bogus paths: the poller wraps applyActivity/applyIgnored in try/catch.
      statePath: path.join(os.tmpdir(), "prd-poller-state-missing.json"),
      ignoredStatePath: path.join(os.tmpdir(), "prd-poller-ignored-missing.json"),
      appVersion: "test",
      onSnapshot: (s) => snapshots.push(s),
      onConfigError: () => {},
      enrichParents: async () => {
        throw new Error(enrichError);
      },
    });

    // Tick 1: enrichParents throws → jiraHealth defaults to the error state.
    await p.refresh();
    assert.strictEqual(snapshots.length, 1);
    assert.strictEqual(snapshots[0].jiraHealth.state, "error");
    assert.strictEqual(snapshots[0].jiraHealth.message, "boom A");

    // Tick 2: same state, different message → hash must change → re-emit.
    enrichError = "boom B";
    await p.refresh();
    assert.strictEqual(snapshots.length, 2);
    assert.strictEqual(snapshots[1].jiraHealth.message, "boom B");

    // Tick 3: nothing changed → hash identical → no re-emit.
    await p.refresh();
    assert.strictEqual(snapshots.length, 2);

    p.stop();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
