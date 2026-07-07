// Minimal dependency-free test runner (run after `npm run build:main`, which
// compiles the shared modules to dist/main/shared/*.js). Covers the pure config
// logic — host derivation and settings validation — which is the trickiest part
// and is Electron-free, so it runs in plain Node (and in CI).
const assert = require("node:assert");
const path = require("node:path");

const cfg = require(path.join(__dirname, "../dist/main/shared/config.js"));
const poller = require(path.join(__dirname, "../dist/main/main/poller.js"));
const notif = require(path.join(__dirname, "../dist/main/shared/notifications.js"));
const github = require(path.join(__dirname, "../dist/main/shared/github.js"));

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
  mergeable: "MERGEABLE",
  author: { login: "auth", avatarUrl: "" },
  repository: { nameWithOwner: "a/b", defaultBranchRef: { name: "main" } },
  reviewDecision: "APPROVED",
  reviewRequests: { totalCount: 0, nodes: [] },
  latestOpinionatedReviews: { nodes: [approvedReview] },
  comments: { totalCount: 0 },
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  ...overrides,
});
const canMerge = (overrides) => github.mapPr(rawPr(overrides), "GH", ["authored"]).canBeMerged;
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
