// Minimal dependency-free test runner (run after `npm run build:main`, which
// compiles the shared modules to dist/main/shared/*.js). Covers the pure config
// logic — host derivation and settings validation — which is the trickiest part
// and is Electron-free, so it runs in plain Node (and in CI).
const assert = require("node:assert");
const path = require("node:path");

const cfg = require(path.join(__dirname, "../dist/main/shared/config.js"));

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
