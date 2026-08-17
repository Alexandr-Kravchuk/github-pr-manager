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
const notify = require(path.join(__dirname, "../dist/main/shared/notify.js"));
const idleGate = require(path.join(__dirname, "../dist/main/shared/idle-gate.js"));
const github = require(path.join(__dirname, "../dist/main/shared/github.js"));
const ignored = require(path.join(__dirname, "../dist/main/shared/ignored.js"));
const state = require(path.join(__dirname, "../dist/main/shared/state.js"));
const jira = require(path.join(__dirname, "../dist/main/shared/jira.js"));
const jiraHealth = require(path.join(__dirname, "../dist/main/shared/jira-health.js"));
const prFilter = require(path.join(__dirname, "../dist/main/shared/pr-filter.js"));
const singleInstance = require(path.join(__dirname, "../dist/main/main/single-instance.js"));

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

// --- pickAppId (Windows AppUserModelID, single-sourced from package.json) ----
const FB = "com.creatio.prdashboard";
test("pickAppId: returns build.appId when present", () =>
  assert.strictEqual(cfg.pickAppId('{"build":{"appId":"com.example.app"}}', FB), "com.example.app"));
test("pickAppId: falls back when build.appId is missing", () =>
  assert.strictEqual(cfg.pickAppId('{"build":{}}', FB), FB));
test("pickAppId: falls back when there is no build block", () =>
  assert.strictEqual(cfg.pickAppId('{"name":"x"}', FB), FB));
test("pickAppId: falls back when appId is not a non-empty string", () => {
  assert.strictEqual(cfg.pickAppId('{"build":{"appId":42}}', FB), FB);
  assert.strictEqual(cfg.pickAppId('{"build":{"appId":"  "}}', FB), FB);
});
test("pickAppId: falls back on malformed JSON", () =>
  assert.strictEqual(cfg.pickAppId("{ not json", FB), FB));

// --- shared value-import carve-outs stay Node-free (renderer imports them) ---
// The renderer value-imports DEFAULT_NOTIFICATION_SETTINGS from shared/notify
// and the view-filter helpers from shared/pr-filter. That's only safe
// while those modules pull in no node: builtin — a regression would break the
// Vite renderer build. Assert the compiled output is clean so the AGENTS.md
// carve-out is enforced, not just documented.
for (const mod of ["notify.js", "pr-filter.js"]) {
  test(`${mod} compiles free of node: builtin references`, () => {
    const src = require("node:fs").readFileSync(
      path.join(__dirname, `../dist/main/shared/${mod}`),
      "utf8",
    );
    const hits =
      src.match(
        /require\(["'](?:node:[^"']+|fs|path|os|crypto|child_process|net|https?|url|util|stream|events)["']\)|from ["']node:[^"']+["']/g,
      ) || [];
    assert.deepStrictEqual(hits, [], `${mod} must not reference node: builtins, found: ${hits.join(", ")}`);
  });
}

// --- the renderer ships no always-running animation --------------------------
// An `infinite` CSS animation keeps the compositor producing frames for as long
// as the app is open, and Electron launches with MacWebContentsOcclusion
// disabled — so the frames keep coming even while the window is hidden. In
// v1.12.0 a single 2x2px `animate-pulse` dot in the header held the GPU helper
// at ~33% CPU permanently, hidden window included. The pattern here is a finite
// animation remounted via `key` (see Buddy.tsx and `.live-beat` in styles.css).
// Comments are blanked before matching (offsets preserved, so reported line
// numbers stay honest) — the rule has to be explainable where it's enforced,
// and stripping rather than exempting whole lines means a banned token on a
// comment continuation line can't smuggle real code past the guard.
{
  const fs = require("node:fs");
  const rendererRoot = path.join(__dirname, "../src/renderer");
  const listFiles = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)],
      );

  // Blank out `//` and `/* */` comments, keeping every other offset intact.
  // String literals are preserved — `className="animate-spin"` is the very
  // thing being hunted, and `https://…` inside one must not read as a comment.
  const stripComments = (src) => {
    let out = "";
    let state = "code"; // code | line | block | ' | " | `
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      const n = src[i + 1];
      if (state === "code") {
        if (c === "/" && (n === "/" || n === "*")) {
          state = n === "/" ? "line" : "block";
          out += "  ";
          i++;
        } else {
          if (c === "'" || c === '"' || c === "`") state = c;
          out += c;
        }
      } else if (state === "line") {
        if (c === "\n") state = "code";
        out += c === "\n" ? c : " ";
      } else if (state === "block") {
        if (c === "*" && n === "/") {
          state = "code";
          out += "  ";
          i++;
        } else {
          out += c === "\n" ? c : " ";
        }
      } else {
        // Inside a string literal: keep it, but don't let an escaped quote end it.
        if (c === "\\") {
          out += src[i + 1] === "\n" ? " \n" : "  ";
          i++;
        } else {
          if (c === state || c === "\n") state = "code";
          out += c;
        }
      }
    }
    return out;
  };

  // Tailwind's animate-{pulse,spin,bounce,ping} all compile to `infinite`, and
  // so does any arbitrary-value utility that spells it out. The CSS alternative
  // spans newlines on purpose: a Prettier-wrapped shorthand must not slip by.
  const FOREVER =
    // No `\b` around the bracketed form: Tailwind joins its parts with `_`,
    // which is a word character, so `linear_infinite` has no boundary to find.
    /\banimate-(?:pulse|spin|bounce|ping)\b|\banimate-\[[^\]]*infinite[^\]]*\]|\banimation(?:-iteration-count)?\s*:[^;{}]*\binfinite\b/g;

  test("infinite-animation detector matches what it claims", () => {
    const hit = (s) => new RegExp(FOREVER.source).test(s);
    assert.ok(hit('className="animate-pulse"'), "bare Tailwind utility");
    assert.ok(hit("animate-[spin_1s_linear_infinite]"), "arbitrary-value utility");
    assert.ok(hit("animation: x 1s infinite;"), "shorthand on one line");
    assert.ok(hit("animation:\n    x 1s linear\n    infinite;"), "wrapped shorthand");
    assert.ok(hit("animation-iteration-count: infinite;"), "longhand");
    assert.ok(!hit("animation: live-beat 1.1s ease-in-out 2;"), "finite shorthand is fine");
    assert.ok(!hit("animation: a 1s; }\n.b { infinite"), "must not span rules");
    // Comments are blanked, string literals survive, and offsets don't shift.
    const sample = 'a /* animate-spin */\n// animate-pulse\nx="animate-ping"';
    assert.ok(!hit(stripComments(sample.split("\n").slice(0, 2).join("\n"))), "comments stripped");
    assert.ok(hit(stripComments(sample)), "string literals survive stripping");
    assert.strictEqual(stripComments(sample).length, sample.length, "offsets preserved");
  });

  test("renderer declares no infinite animations", () => {
    const hits = [];
    let scanned = 0;
    for (const file of listFiles(rendererRoot)) {
      if (!/\.(?:tsx?|css|html)$/.test(file)) continue;
      scanned++;
      const src = stripComments(fs.readFileSync(file, "utf8"));
      for (const m of src.matchAll(FOREVER)) {
        const line = src.slice(0, m.index).split("\n").length;
        hits.push(`${path.relative(rendererRoot, file)}:${line}`);
      }
    }
    // Without this, a broken glob or extension filter would silently downgrade
    // the guard to a no-op that still reports green.
    assert.ok(scanned > 5, `expected to scan the renderer, only saw ${scanned} files`);
    assert.deepStrictEqual(
      hits,
      [],
      `infinite animations burn CPU whether or not the window is visible, found at: ${hits.join(", ")}`,
    );
  });
}

// --- single-instance decision logic (pure, unit-tested) ----------------------
// The lock/second-instance branches live in single-instance.ts precisely so they
// can run here without booting Electron (main.ts runs the real lock request at
// import time and can't be required from a test). These cover the behavior the
// PR exists to add: quit on a lost lock, focus synchronously when a window is
// up, defer the focus when it isn't. The deferred (async) case is exercised in
// the async block below.
test("acquireSingleInstanceLock: lost lock -> quit, returns false, no handler registered", () => {
  let quits = 0;
  let registered = 0;
  const primary = singleInstance.acquireSingleInstanceLock({
    requestSingleInstanceLock: () => false,
    quit: () => quits++,
    onSecondInstance: () => registered++,
    getMainWindow: () => null,
    focusMainWindow: () => {},
    whenWindowReady: () => Promise.resolve(),
  });
  assert.strictEqual(primary, false, "a non-primary instance reports false");
  assert.strictEqual(quits, 1, "the losing instance quits exactly once");
  assert.strictEqual(registered, 0, "the losing instance registers no second-instance handler");
});

test("acquireSingleInstanceLock: won lock -> no quit, returns true, registers handler", () => {
  let quits = 0;
  let handler = null;
  const primary = singleInstance.acquireSingleInstanceLock({
    requestSingleInstanceLock: () => true,
    quit: () => quits++,
    onSecondInstance: (h) => {
      handler = h;
    },
    getMainWindow: () => null,
    focusMainWindow: () => {},
    whenWindowReady: () => Promise.resolve(),
  });
  assert.strictEqual(primary, true, "the primary instance reports true");
  assert.strictEqual(quits, 0, "the primary instance does not quit");
  assert.strictEqual(typeof handler, "function", "a second-instance handler is registered");
});

test("handleSecondInstance: window present -> focuses synchronously, ignores the window-ready signal", () => {
  let focused = 0;
  let signalConsulted = 0;
  singleInstance.handleSecondInstance(
    {}, // a truthy window stand-in
    () => focused++,
    () => {
      signalConsulted++;
      return Promise.resolve();
    },
  );
  assert.strictEqual(focused, 1, "an existing window is focused synchronously");
  assert.strictEqual(
    signalConsulted,
    0,
    "the window-ready signal is not consulted when a window already exists",
  );
});

test("acquireSingleInstanceLock: the registered handler routes through handleSecondInstance", () => {
  let focused = 0;
  let handler = null;
  singleInstance.acquireSingleInstanceLock({
    requestSingleInstanceLock: () => true,
    quit: () => {},
    onSecondInstance: (h) => {
      handler = h;
    },
    getMainWindow: () => ({}), // truthy window
    focusMainWindow: () => focused++,
    whenWindowReady: () => Promise.resolve(),
  });
  handler();
  assert.strictEqual(focused, 1, "invoking the registered handler focuses the existing window");
});

// --- single-instance startup is gated on the acquired lock -------------------
// The double-launch fix hinges on one wiring invariant in main.ts: the real
// startup (`app.whenReady().then(startApp)`) and the `window-all-closed`
// registration run ONLY in the primary instance — i.e. lexically inside the
// `if (isPrimaryInstance) { ... }` gate. The branch decisions are unit-tested
// above; this scan guards the main.ts wiring those units can't see. If a refactor
// moved either registration out of the gate (reintroducing the double-launch
// bug), Electron would register them on every instance again with no error and
// no failing runtime test. The previous version of this guard used
// `indexOf("app.whenReady(")`, which — once the deferred-focus call was added —
// matched that call instead of the startup one and silently stopped protecting
// anything; brace-matching the gate avoids relying on occurrence order.
// Comments are blanked first (offset-preserving), mirroring the animation guard:
// `window-all-closed` and `isPrimaryInstance` appear in nearby prose, and a raw
// indexOf could latch onto the comment rather than the code.
//
// Known limitation (see the behavioral test below, which is the authoritative
// check): this is a source-SHAPE scan, not a runtime one. The comment blanking is
// a naive regex — it does NOT understand string or template literals, so a string
// containing `//`, `/*`, or a stray `{`/`}` inside the gate body could corrupt the
// brace match. It also can't see a semantically-equivalent refactor that drops the
// `if (isPrimaryInstance)` gate entirely (e.g. an early `return`). It survives as a
// cheap, fast first line of defense; the Electron-mock integration test below is
// what actually verifies the runtime wiring. Keep the gate body free of
// literals bearing those characters, or this guard needs hardening.
//
// Intentionally kept as defense-in-depth alongside the behavioral mock test: the
// mock test is the primary, refactor-resilient check, but this near-free source
// scan catches a stray registration pasted outside the gate at edit time — before
// a build — and reads as executable documentation of the invariant next to
// main.ts. If it ever becomes a maintenance drag, drop it; the mock test stands
// alone.
//
// TRIAGE NOTE: if this test fails, do NOT assume the invariant is broken — first
// check the authoritative behavioral test below ("main.js wiring: won lock ->
// registers second-instance + window-all-closed"). If that one is green, this
// failure is almost certainly a false alarm from a benign reshape (a string
// literal or reformat this source scan can't parse), not a real regression.
test("main gates startup + window-all-closed on the acquired single-instance lock", () => {
  const raw = require("node:fs").readFileSync(
    path.join(__dirname, "../src/main/main.ts"),
    "utf8",
  );
  // Blank `//` and `/* */` comments, preserving byte offsets (spaces for text,
  // newlines kept) so brace-matching positions still line up with real source.
  const src = raw
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  const lockAt = src.indexOf("acquireSingleInstanceLock(");
  assert.ok(lockAt !== -1, "expected acquireSingleInstanceLock() to be called in main.ts");

  const gateAt = src.indexOf("if (isPrimaryInstance)", lockAt);
  assert.ok(gateAt !== -1, "expected an `if (isPrimaryInstance)` gate after the lock call");
  assert.ok(lockAt < gateAt, "the lock must be acquired before the primary-instance gate");

  const open = src.indexOf("{", gateAt);
  assert.ok(open !== -1, "malformed primary-instance gate (no `{`)");
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  assert.ok(close !== -1, "could not brace-match the primary-instance gate body");

  const inside = (needle) => {
    const at = src.indexOf(needle);
    return at !== -1 && at > open && at < close;
  };
  assert.ok(
    inside("app.whenReady().then(startApp)"),
    "startup (app.whenReady().then(startApp)) must run only inside the primary-instance gate",
  );
  assert.ok(
    inside('app.on("window-all-closed"'),
    "window-all-closed must be registered only inside the primary-instance gate",
  );
});

// --- single-instance wiring, verified against a mocked Electron --------------
// The pure decision logic is unit-tested above and the source shape is scanned
// by the guard above; this test closes the gap between them by requiring the
// COMPILED main.js with a fake `electron` injected into the module cache, so the
// real `acquireSingleInstanceLock({...})` deps object in main.ts is exercised.
// `app.whenReady()` is stubbed with a never-resolving promise, so `startApp`
// (poller, window, auto-updater) never runs — only the bootstrap wiring does.
// This is a behavioral check: unlike the text guard, a refactor that drops the
// lock gate would fail here regardless of how the source is shaped.
{
  const Module = require("node:module");
  const mainJs = path.join(__dirname, "../dist/main/main/main.js");
  const elPath = require.resolve("electron", { paths: [path.dirname(mainJs)] });
  // Everything already cached before we touch main.js — the test file's own
  // module graph. We only ever evict what requiring main.js adds, never these.
  const preloaded = new Set(Object.keys(require.cache));

  // Boot main.js once with a fake electron and return what the wiring did.
  const bootMain = (lockGranted) => {
    for (const k of Object.keys(require.cache)) {
      if (!preloaded.has(k)) delete require.cache[k]; // fresh main.js graph each boot
    }
    const events = [];
    let secondInstanceHandler = null;
    let quits = 0;
    const fakeApp = {
      requestSingleInstanceLock: () => lockGranted,
      quit: () => quits++,
      on: (event, cb) => {
        events.push(event);
        if (event === "second-instance") secondInstanceHandler = cb;
      },
      whenReady: () => new Promise(() => {}), // never resolves: startApp stays parked
      getVersion: () => "0.0.0-test",
      getPath: () => os.tmpdir(),
      setAppUserModelId: () => {},
      isReady: () => false,
    };
    class FakeBrowserWindow {
      static getAllWindows() {
        return [];
      }
      on() {}
    }
    const fakeElectron = {
      app: fakeApp,
      BrowserWindow: FakeBrowserWindow,
      nativeTheme: { on() {} },
      powerMonitor: { on() {} },
      ipcMain: { handle() {}, on() {} },
      session: {},
      shell: {},
      clipboard: {},
      Notification: class {},
      nativeImage: { createFromPath: () => ({}) },
    };
    require.cache[elPath] = { id: elPath, filename: elPath, loaded: true, exports: fakeElectron };
    require(mainJs);
    return { events, secondInstanceHandler, quits };
  };

  test("main.js wiring: lost lock -> quits, registers no ready/window handlers", () => {
    const r = bootMain(false);
    assert.strictEqual(r.quits, 1, "the non-primary instance quits exactly once");
    assert.ok(
      !r.events.includes("second-instance"),
      "a non-primary instance must not register a second-instance handler",
    );
    assert.ok(
      !r.events.includes("window-all-closed"),
      "a non-primary instance must not register window-all-closed",
    );
  });

  test("main.js wiring: won lock -> no quit, registers second-instance + window-all-closed", () => {
    const r = bootMain(true);
    assert.strictEqual(r.quits, 0, "the primary instance does not quit");
    assert.ok(r.events.includes("second-instance"), "the primary registers a second-instance handler");
    assert.ok(r.events.includes("window-all-closed"), "the primary registers window-all-closed");
    assert.strictEqual(
      typeof r.secondInstanceHandler,
      "function",
      "the registered second-instance handler is callable",
    );
    // Exercise the wired handler: no window yet (startApp never ran), so it must
    // take the deferred path without throwing rather than focusing nothing.
    assert.doesNotThrow(() => r.secondInstanceHandler(), "the wired handler runs cleanly with no window");
  });

  // Restore the cache to its pre-test shape so later tests see a clean graph.
  for (const k of Object.keys(require.cache)) {
    if (!preloaded.has(k)) delete require.cache[k];
  }
  delete require.cache[elPath];
}

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
test("validateSettings: notifications default off (opt-in), native on, sound off, all events on", () => {
  const n = cfg.validateSettings({ hosts: [] }).notifications;
  assert.strictEqual(n.enabled, false);
  assert.strictEqual(n.native, true);
  assert.strictEqual(n.sound, false);
  assert.deepStrictEqual(n.events, { yourTurn: true, ciFailed: true, goodNews: true });
});
test("validateSettings: notifications honored + garbage falls back per-field", () => {
  const n = cfg.validateSettings({
    hosts: [],
    notifications: { enabled: false, sound: true, native: "nope", events: { ciFailed: false, extra: 1 } },
  }).notifications;
  assert.strictEqual(n.enabled, false);
  assert.strictEqual(n.sound, true);
  assert.strictEqual(n.native, true); // non-boolean falls back to default
  assert.strictEqual(n.events.ciFailed, false);
  assert.strictEqual(n.events.yourTurn, true); // absent falls back to default
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
test("mapPr.canBeMerged: re-requested CHANGES_REQUESTED still blocks via reviewDecision", () =>
  assert.strictEqual(
    canMerge({
      // A human approve is present and the change-requester was re-requested
      // (so hasUnaddressedChangeRequest is false), but branch protection's
      // reviewDecision still says CHANGES_REQUESTED — not mergeable.
      reviewDecision: "CHANGES_REQUESTED",
      reviewRequests: {
        totalCount: 1,
        nodes: [{ requestedReviewer: { __typename: "User", login: "rev2", avatarUrl: "" } }],
      },
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

// --- github: mapPr hasConflicts (merge-conflict flag) ------------------------
// Keys strictly off GitHub's CONFLICTING verdict. UNKNOWN (recomputing right
// after a push) must NOT count, or a freshly pushed PR would be flagged the
// instant it lands. This flag is what promotes an approved+green PR to the red
// "blocked" signal so drive-pr-green picks it up instead of it stalling in
// drive-green-prs-close.
const conflicting = (overrides) => github.mapPr(rawPr(overrides), "GH", ["authored"], null).hasConflicts;
test("mapPr.hasConflicts: CONFLICTING mergeability is true", () =>
  assert.strictEqual(conflicting({ mergeable: "CONFLICTING" }), true));
test("mapPr.hasConflicts: MERGEABLE is false", () =>
  assert.strictEqual(conflicting({ mergeable: "MERGEABLE" }), false));
test("mapPr.hasConflicts: transient UNKNOWN stays false", () =>
  assert.strictEqual(conflicting({ mergeable: "UNKNOWN" }), false));

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

// --- pr-filter: the reveal gate (Drafts/Ignored chips) ----------------------
// Drafts and ignored PRs are hidden by default and each chip REVEALS its own
// category on top of the normal list. The rule that matters: ANY owning chip is
// enough, so an ignored draft surfaces under Drafts OR Ignored. Requiring both
// is the bug this replaces — two ignored drafts badged "Drafts (2) Ignored (2)"
// while every single-chip click rendered zero rows.
const PLAIN = { isDraft: false, isIgnored: false };
const DRAFT = { isDraft: true, isIgnored: false };
const IGNORED = { isDraft: false, isIgnored: true };
const IGNORED_DRAFT = { isDraft: true, isIgnored: true };
// [showDrafts, showIgnored, pr, expectedRevealed]
const revealCases = [
  // both off → only uncategorized PRs show
  [false, false, PLAIN, true],
  [false, false, DRAFT, false],
  [false, false, IGNORED, false],
  [false, false, IGNORED_DRAFT, false],
  // Drafts on → drafts join the normal list; plain PRs stay (reveal, not "only")
  [true, false, PLAIN, true],
  [true, false, DRAFT, true],
  [true, false, IGNORED, false],
  [true, false, IGNORED_DRAFT, true],
  // Ignored on → ignored join, drafts among them included
  [false, true, PLAIN, true],
  [false, true, DRAFT, false],
  [false, true, IGNORED, true],
  [false, true, IGNORED_DRAFT, true],
  // both on → everything
  [true, true, PLAIN, true],
  [true, true, DRAFT, true],
  [true, true, IGNORED, true],
  [true, true, IGNORED_DRAFT, true],
];
for (const [sd, si, pr, expected] of revealCases) {
  const kind =
    pr === PLAIN ? "plain" : pr === DRAFT ? "draft" : pr === IGNORED ? "ignored" : "ignored-draft";
  test(`isRevealed: drafts=${sd} ignored=${si} ${kind} → ${expected}`, () =>
    assert.strictEqual(prFilter.isRevealed(pr, { showDrafts: sd, showIgnored: si }), expected));
}
test("isRevealed: one chip is enough for an ignored draft (the regression)", () => {
  assert.strictEqual(prFilter.isRevealed(IGNORED_DRAFT, { showDrafts: true, showIgnored: false }), true);
  assert.strictEqual(prFilter.isRevealed(IGNORED_DRAFT, { showDrafts: false, showIgnored: true }), true);
});

// --- pr-filter: filterPrs / facet counts ------------------------------------
let prSeq = 0;
const mkPr = (over = {}) => ({
  number: ++prSeq,
  title: "Some change",
  repo: "acme/widgets",
  author: { login: "octocat" },
  hostLabel: "GitHub",
  roles: ["author"],
  isDraft: false,
  isIgnored: false,
  needsAttention: false,
  failingChecks: [],
  hasNewActivity: false,
  canBeMerged: false,
  hasNoReviews: false,
  returnedToMe: false,
  ...over,
});
const ST = {
  role: "all",
  host: "all",
  search: "",
  attentionOnly: false,
  failingOnly: false,
  newOnly: false,
  mergeableOnly: false,
  noReviewsOnly: false,
  showDrafts: false,
  showIgnored: false,
};
const st = (over = {}) => ({ ...ST, ...over });

// The live shape that produced the bug report: every open PR is an ignored draft.
const IGNORED_DRAFTS = [
  mkPr({ isDraft: true, isIgnored: true, hasNoReviews: true }),
  mkPr({ isDraft: true, isIgnored: true, hasNoReviews: true }),
];
test("filterPrs: two ignored drafts are hidden by default", () =>
  assert.strictEqual(prFilter.filterPrs(IGNORED_DRAFTS, st()).length, 0));
test("filterPrs: the Drafts chip alone reveals ignored drafts", () =>
  assert.strictEqual(prFilter.filterPrs(IGNORED_DRAFTS, st({ showDrafts: true })).length, 2));
test("filterPrs: the Ignored chip alone reveals ignored drafts", () =>
  assert.strictEqual(prFilter.filterPrs(IGNORED_DRAFTS, st({ showIgnored: true })).length, 2));
test("filterPrs: both chips on reveals them once, not twice", () =>
  assert.strictEqual(
    prFilter.filterPrs(IGNORED_DRAFTS, st({ showDrafts: true, showIgnored: true })).length,
    2,
  ));

test("revealDelta: each chip promises the 2 rows it actually adds", () => {
  assert.strictEqual(prFilter.revealDelta(IGNORED_DRAFTS, st(), "drafts"), 2);
  assert.strictEqual(prFilter.revealDelta(IGNORED_DRAFTS, st(), "ignored"), 2);
});
test("revealDelta: 0 once the other chip already revealed the same PRs", () => {
  assert.strictEqual(
    prFilter.revealDelta(IGNORED_DRAFTS, st({ showIgnored: true }), "drafts"),
    0,
  );
  assert.strictEqual(
    prFilter.revealDelta(IGNORED_DRAFTS, st({ showDrafts: true }), "ignored"),
    0,
  );
});
test("revealDelta: still reports its own contribution while active", () =>
  assert.strictEqual(prFilter.revealDelta(IGNORED_DRAFTS, st({ showDrafts: true }), "drafts"), 2));

// A draft can never be "Ready to merge" (mapPr sets canBeMerged = !isDraft), so
// the badge must read 0 rather than advertise drafts the click can't surface.
test("revealDelta: Drafts is 0 while Ready to merge is on", () =>
  assert.strictEqual(
    prFilter.revealDelta(IGNORED_DRAFTS, st({ mergeableOnly: true }), "drafts"),
    0,
  ));

// Partial overlap on purpose: a plain draft, a plain ignored PR and one ignored
// draft, which is what IGNORED_DRAFTS cannot express.
const MIXED = [
  mkPr({ needsAttention: true, failingChecks: ["build"], hostLabel: "GitHub" }),
  mkPr({ needsAttention: true, hasNewActivity: true, canBeMerged: true, hostLabel: "GHE" }),
  mkPr({ hasNoReviews: true, roles: ["reviewer"], title: "Bump deps", returnedToMe: true }),
  mkPr({ isDraft: true, hasNoReviews: true, needsAttention: true }),
  // returnedToMe on a hidden PR as well, so `baselineStats.returned` proves the
  // exclusion instead of merely being non-zero.
  mkPr({ isIgnored: true, failingChecks: ["test"], needsAttention: true, returnedToMe: true }),
  mkPr({ isDraft: true, isIgnored: true, hasNewActivity: true }),
];
// The promise a badge makes: click this chip and you get exactly this many rows.
const FACET_STATES = [
  st(),
  st({ showDrafts: true }),
  st({ showIgnored: true }),
  st({ showDrafts: true, showIgnored: true }),
  st({ host: "GHE" }),
  st({ role: "reviewer" }),
  st({ search: "bump" }),
  st({ attentionOnly: true, showDrafts: true }),
  st({ failingOnly: true, showIgnored: true }),
];
// Keys come from NARROW_CHIPS rather than a hardcoded list, so a sixth chip
// cannot be added without inheriting the invariant.
for (const chip of prFilter.NARROW_CHIPS) {
  for (const [i, state] of FACET_STATES.entries()) {
    test(`narrowFacetCount(${chip.key}) equals the rows it yields [state ${i}]`, () =>
      assert.strictEqual(
        prFilter.narrowFacetCount(MIXED, state, chip.key),
        prFilter.filterPrs(MIXED, { ...state, [chip.flag]: true }).length,
      ));
  }
}
test("narrowFacetCount: counts hidden drafts only once the chip reveals them", () => {
  // Two PRs have hasNoReviews; one of them is a draft, hidden by default.
  assert.strictEqual(prFilter.narrowFacetCount(MIXED, st(), "noReviews"), 1);
  assert.strictEqual(prFilter.narrowFacetCount(MIXED, st({ showDrafts: true }), "noReviews"), 2);
});
test("narrowFacetCount: honours host, role and search", () => {
  assert.strictEqual(prFilter.narrowFacetCount(MIXED, st({ host: "GHE" }), "attention"), 1);
  assert.strictEqual(prFilter.narrowFacetCount(MIXED, st({ role: "reviewer" }), "noReviews"), 1);
  assert.strictEqual(prFilter.narrowFacetCount(MIXED, st({ search: "bump" }), "noReviews"), 1);
});

// The reveal side, over the partially-overlapping MIXED fixture. On IGNORED_DRAFTS
// every delta is 2 or 0, so "the whole category unless the sibling is on" passes
// there; the asymmetric 1s below can only come from counting the rows the click
// actually adds.
const num = (pr) => pr.number;
test("revealDelta: each chip adds its own category from the base state", () => {
  assert.strictEqual(prFilter.revealDelta(MIXED, st(), "drafts"), 2);
  assert.strictEqual(prFilter.revealDelta(MIXED, st(), "ignored"), 2);
});
test("revealDelta: counts only what the sibling chip has not already revealed", () => {
  assert.strictEqual(prFilter.revealDelta(MIXED, st({ showDrafts: true }), "ignored"), 1);
  assert.strictEqual(prFilter.revealDelta(MIXED, st({ showIgnored: true }), "drafts"), 1);
});

// The badge's promise, checked against an independently computed set difference
// rather than against revealDelta's own expression: the delta is exactly the rows
// that appear when the flag flips on, and revealing never drops a row. Reusing
// FACET_STATES pulls host / role / search / narrowing states in for free, which is
// what criterion 2 promises of the reveal badges too.
for (const [key, flag] of Object.entries(prFilter.REVEAL_FLAG)) {
  for (const [i, state] of FACET_STATES.entries()) {
    test(`revealDelta(${key}) equals the rows the click adds [state ${i}]`, () => {
      const on = prFilter.filterPrs(MIXED, { ...state, [flag]: true });
      const off = prFilter.filterPrs(MIXED, { ...state, [flag]: false });
      const onNumbers = new Set(on.map(num));
      const offNumbers = new Set(off.map(num));
      assert.ok(
        off.every((pr) => onNumbers.has(pr.number)),
        "revealing must never drop a row that was already shown",
      );
      assert.strictEqual(
        prFilter.revealDelta(MIXED, state, key),
        on.filter((pr) => !offNumbers.has(pr.number)).length,
      );
    });
  }
}

// --- pr-filter: isPassiveReviewed (shared by the badge and the attention flag)
// Tested directly, like its sibling gates: state.ts reads it for needsAttention
// and PrCard for the badge, so a wrong clause would silently desynchronize the
// card's accent from what it says about itself.
for (const [roles, expected] of [
  [["reviewed"], true],
  [["reviewer"], false],
  [["author"], false],
  [["reviewer", "reviewed"], false], // re-requested — an active ask outranks it
  [["author", "reviewed"], false], // your own PR, which reviewed-by:@me also matches
]) {
  test(`isPassiveReviewed([${roles}]) -> ${expected}`, () =>
    assert.strictEqual(prFilter.isPassiveReviewed({ roles }), expected));
}

// --- pr-filter: the role selector, including the passive `reviewed` role ------
// A PR you already reviewed carries `reviewed`; being re-requested adds
// `reviewer` back alongside it, so the two selections legitimately overlap.
const BY_ROLE = [
  mkPr({ roles: ["author"], title: "mine" }),
  mkPr({ roles: ["reviewer"], title: "asked of me" }),
  mkPr({ roles: ["reviewed"], title: "already reviewed" }),
  mkPr({ roles: ["reviewer", "reviewed"], title: "re-requested" }),
];
const titlesFor = (role) => prFilter.filterPrs(BY_ROLE, st({ role })).map((pr) => pr.title);
test("filterPrs(role): 'reviewed' selects the PRs you have reviewed, re-requested included", () =>
  assert.deepStrictEqual(titlesFor("reviewed"), ["already reviewed", "re-requested"]));
test("filterPrs(role): 'reviewer' still means an outstanding request, not a past review", () =>
  assert.deepStrictEqual(titlesFor("reviewer"), ["asked of me", "re-requested"]));
test("filterPrs(role): 'author' is unaffected by the new role", () =>
  assert.deepStrictEqual(titlesFor("author"), ["mine"]));

// --- pr-filter: matchesSearch (via filterPrs) -------------------------------
// The haystack spans title, repo, author login and #number, and the needle is
// trimmed. Fixed numbers rather than the shared prSeq counter, so the "#" cases
// don't drift when a fixture is added above.
const SEARCHABLE = [
  mkPr({ number: 41, title: "Bump deps", repo: "acme/widgets", author: { login: "octocat" } }),
  mkPr({ number: 412, title: "Rewrite parser", repo: "acme/gizmos", author: { login: "hubot" } }),
  mkPr({ number: 7, title: "Untitled", repo: "other/thing", author: null }),
];
test("filterPrs: the query is trimmed before matching", () => {
  assert.deepStrictEqual(prFilter.filterPrs(SEARCHABLE, st({ search: "bump" })).map(num), [41]);
  assert.deepStrictEqual(prFilter.filterPrs(SEARCHABLE, st({ search: "  bump  " })).map(num), [41]);
});
test("filterPrs: a whitespace-only query filters nothing", () =>
  assert.strictEqual(prFilter.filterPrs(SEARCHABLE, st({ search: "   " })).length, 3));
test("filterPrs: the query matches repo and author login, not just the title", () => {
  assert.deepStrictEqual(prFilter.filterPrs(SEARCHABLE, st({ search: "gizmos" })).map(num), [412]);
  assert.deepStrictEqual(prFilter.filterPrs(SEARCHABLE, st({ search: "hubot" })).map(num), [412]);
});
test("filterPrs: the query matches the PR number", () => {
  assert.deepStrictEqual(prFilter.filterPrs(SEARCHABLE, st({ search: "#7" })).map(num), [7]);
  // Substring, not equality: "#41" also hits #412. Pinned so a stricter number
  // match would be a deliberate change rather than a surprise.
  assert.deepStrictEqual(prFilter.filterPrs(SEARCHABLE, st({ search: "#41" })).map(num), [41, 412]);
});
test("filterPrs: an author-less PR is searchable instead of throwing", () => {
  assert.deepStrictEqual(prFilter.filterPrs(SEARCHABLE, st({ search: "untitled" })).map(num), [7]);
  assert.deepStrictEqual(prFilter.filterPrs(SEARCHABLE, st({ search: "octocat" })).map(num), [41]);
});

test("isBaselinePr: the standing workload is neither draft nor ignored", () => {
  assert.strictEqual(prFilter.isBaselinePr(PLAIN), true);
  assert.strictEqual(prFilter.isBaselinePr(DRAFT), false);
  assert.strictEqual(prFilter.isBaselinePr(IGNORED), false);
  assert.strictEqual(prFilter.isBaselinePr(IGNORED_DRAFT), false);
});

test("baselineStats: excludes both ignored PRs and drafts", () => {
  const stats = prFilter.baselineStats(MIXED);
  assert.strictEqual(stats.total, 3);
  assert.strictEqual(stats.attention, 2);
  assert.strictEqual(stats.failing, 1);
  assert.strictEqual(stats.fresh, 1);
  // Two PRs are returnedToMe; the ignored one is not part of the workload.
  assert.strictEqual(stats.returned, 1);
});
test("baselineStats: all-hidden inbox reports zero, matching the header", () =>
  assert.deepStrictEqual(prFilter.baselineStats(IGNORED_DRAFTS), {
    total: 0,
    attention: 0,
    failing: 0,
    fresh: 0,
    returned: 0,
  }));

// --- pr-filter: activeFilterCount / emptyStateKind --------------------------
// The reveal chips must not read as active filters — counting them let
// "Clear filters" SHRINK the list — and the empty state keys on the same number
// to decide whether it may claim a filter is at work.
test("activeFilterCount: nothing set is 0, and the reveal chips stay out of it", () => {
  assert.strictEqual(prFilter.activeFilterCount(st()), 0);
  assert.strictEqual(prFilter.activeFilterCount(st({ showDrafts: true, showIgnored: true })), 0);
});
test("activeFilterCount: a whitespace-only search is not a filter", () =>
  assert.strictEqual(prFilter.activeFilterCount(st({ search: "   " })), 0));
for (const over of [
  { search: "bump" },
  { role: "reviewer" },
  { host: "GHE" },
  ...prFilter.NARROW_CHIPS.map((chip) => ({ [chip.flag]: true })),
]) {
  test(`activeFilterCount: ${Object.keys(over)[0]} adds exactly 1`, () =>
    assert.strictEqual(prFilter.activeFilterCount(st(over)), 1));
}
test("activeFilterCount: every narrowing control at once", () =>
  assert.strictEqual(
    prFilter.activeFilterCount(
      st({
        search: "bump",
        role: "reviewer",
        host: "GHE",
        attentionOnly: true,
        failingOnly: true,
        newOnly: true,
        mergeableOnly: true,
        noReviewsOnly: true,
      }),
    ),
    3 + prFilter.NARROW_CHIPS.length,
  ));

test("emptyStateKind: an empty fetch is not a filter story", () =>
  assert.strictEqual(prFilter.emptyStateKind(st(), 0), "no-prs"));
test("emptyStateKind: all-hidden when only the reveal chips could help", () => {
  assert.strictEqual(prFilter.emptyStateKind(st(), IGNORED_DRAFTS.length), "all-hidden");
  // A reveal chip being on does not turn it into "a filter is at work".
  assert.strictEqual(
    prFilter.emptyStateKind(st({ showDrafts: true }), IGNORED_DRAFTS.length),
    "all-hidden",
  );
});
// The claim the `all-hidden` copy is allowed to make. Both directions must hold:
// a hidden draft that wants you must be counted (the header baseline no longer
// counts it, yet it still toasts), and a muted PR must NOT be — nothing clears
// needsAttention for ignored PRs, so counting them would say the user's own
// mutes need attention.
test("hiddenAttentionCount: an ignored inbox never claims to need you", () => {
  // The live PR #6 shape: two ignored drafts, both needsAttention.
  const ignoredDrafts = [
    mkPr({ isDraft: true, isIgnored: true, needsAttention: true }),
    mkPr({ isDraft: true, isIgnored: true, needsAttention: true }),
  ];
  assert.strictEqual(prFilter.hiddenAttentionCount(ignoredDrafts), 0);
  assert.strictEqual(prFilter.hiddenAttentionCount(IGNORED_DRAFTS), 0);
});
test("hiddenAttentionCount: a draft that wants you is counted", () => {
  assert.strictEqual(
    prFilter.hiddenAttentionCount([
      mkPr({ isDraft: true, needsAttention: true }),
      mkPr({ isDraft: true, needsAttention: false }),
      mkPr({ isDraft: true, isIgnored: true, needsAttention: true }),
    ]),
    1,
  );
});
test("hiddenAttentionCount: nothing to report is 0, not a falsy surprise", () =>
  assert.strictEqual(prFilter.hiddenAttentionCount([]), 0));

test("emptyStateKind: no-match as soon as anything narrows", () => {
  assert.strictEqual(prFilter.emptyStateKind(st({ attentionOnly: true }), 2), "no-match");
  assert.strictEqual(prFilter.emptyStateKind(st({ search: "zzz" }), 2), "no-match");
  assert.strictEqual(prFilter.emptyStateKind(st({ host: "GHE" }), 2), "no-match");
  assert.strictEqual(prFilter.emptyStateKind(st({ role: "reviewer" }), 2), "no-match");
});

(async () => {
  await atest("handleSecondInstance: no window -> defers focus until a window is created", async () => {
    let focused = 0;
    let signalWindowReady;
    const windowReady = new Promise((r) => {
      signalWindowReady = r;
    });
    // A second launch arrives before the first window exists.
    singleInstance.handleSecondInstance(null, () => focused++, () => windowReady);
    assert.strictEqual(focused, 0, "focus must not fire while no window exists yet");
    // The window is created — the deferred raise must now fire. This is the case
    // AK flagged: keying off window-creation (not app.whenReady) guarantees the
    // window actually exists when focusMainWindow runs.
    signalWindowReady();
    await windowReady;
    await Promise.resolve(); // flush the .then microtask queued on the signal
    assert.strictEqual(focused, 1, "focus fires once the first window is created");
  });

  await atest("createWindowReadyGate: stays pending until marked, then resolves (idempotent)", async () => {
    const gate = singleInstance.createWindowReadyGate();
    let resolved = false;
    void gate.whenWindowReady().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    assert.strictEqual(resolved, false, "whenWindowReady is pending before markWindowReady");
    gate.markWindowReady();
    gate.markWindowReady(); // second call must be a harmless no-op
    await gate.whenWindowReady();
    await Promise.resolve();
    assert.strictEqual(resolved, true, "whenWindowReady resolves after markWindowReady");
  });

  await atest("end-to-end: second-instance before the window -> focus fires after createWindow signals the gate", async () => {
    // Drive the real production wiring — acquireSingleInstanceLock + the deferred
    // handleSecondInstance branch + the window-ready gate — exactly as main.ts
    // composes them (this is createWindowReadyGate(), not a hand-rolled promise).
    // Asserts focus ACTUALLY fires after the window appears, closing AK's gap that
    // prior coverage only checked "doesn't throw".
    const gate = singleInstance.createWindowReadyGate();
    let win = null; // stands in for main.ts's live `mainWindow`
    let focused = 0;
    let handler = null;
    singleInstance.acquireSingleInstanceLock({
      requestSingleInstanceLock: () => true,
      quit: () => {},
      onSecondInstance: (h) => {
        handler = h;
      },
      getMainWindow: () => win, // live reference, like `() => mainWindow`
      focusMainWindow: () => {
        if (win) focused++; // null-guarded like the real focusMainWindow
      },
      whenWindowReady: gate.whenWindowReady,
    });
    // A second launch arrives before the first window exists.
    handler();
    await Promise.resolve();
    assert.strictEqual(focused, 0, "focus must not fire while no window exists");
    // createWindow() runs: assign the window, THEN signal the gate (main.ts order).
    // If the gate were marked before the window was assigned, focus would no-op —
    // this ordering is exactly what the window-ready signal guarantees.
    win = {};
    gate.markWindowReady();
    await gate.whenWindowReady();
    await Promise.resolve();
    assert.strictEqual(focused, 1, "focus fires once the window exists and the gate is marked");
  });

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

  // --- state: the passive `reviewed` role doesn't claim attention ------------
  // A PR you have only already reviewed is on the dashboard so it doesn't vanish
  // the moment you submit a review — not because someone is waiting on you. Only
  // its return to your court counts; the author's CI, threads and pending change
  // request are theirs, or every PR you ever reviewed would sit in the red pile.
  const reviewedPr = (o = {}) => reviewPr({ roles: ["reviewed"], ...o });

  await atest("applyActivity.needsAttention: an already-reviewed PR is quiet while nothing moves", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewedPr()], file); // baseline
      const same = reviewedPr();
      await state.applyActivity([same], file);
      assert.strictEqual(same.needsAttention, false);
    }));

  await atest("applyActivity.needsAttention: the author's CI/threads on a reviewed PR stay the author's", () =>
    withTempStore(async (file) => {
      const noisy = () =>
        reviewedPr({
          failingChecks: ["build"],
          unresolvedThreads: 3,
          hasUnaddressedChangeRequest: true,
          hasUnaddressedComments: true,
        });
      await state.applyActivity([noisy()], file); // baseline
      const again = noisy();
      await state.applyActivity([again], file);
      assert.strictEqual(again.needsAttention, false);
    }));

  await atest("applyActivity.needsAttention: a reviewed PR wakes up when it comes back to me", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewedPr()], file); // baseline
      const pushed = reviewedPr({ lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file);
      assert.strictEqual(pushed.returnedToMe, true);
      assert.strictEqual(pushed.needsAttention, true);
    }));

  // The role, not `viewerHasReviewed`, is what proves engagement: a plain
  // "Comment" review matches `reviewed-by:@me` but never lands in
  // latestOpinionatedReviews (observed on 4 of 5 live reviewed-role PRs). Keying
  // engagement off the opinionated flag alone would leave those cards mute
  // forever, since a passive PR's attention flag IS returnedToMe.
  await atest("applyActivity.returnedToMe: a comment-only review still counts as engaged", () =>
    withTempStore(async (file) => {
      const commentOnly = (o = {}) => reviewedPr({ viewerHasReviewed: false, ...o });
      await state.applyActivity([commentOnly()], file); // baseline
      const more = commentOnly({ totalComments: 5 });
      await state.applyActivity([more], file);
      assert.strictEqual(more.returnedToMe, true, "the reviewed role alone must prove engagement");
      assert.strictEqual(more.needsAttention, true);
    }));

  await atest("applyActivity.returnedToMe: a plain reviewer request is still un-engaged", () =>
    withTempStore(async (file) => {
      // The guard the clause above must not weaken: asked to review, never
      // reviewed and never opened — a new push is not "back to me".
      const asked = (o = {}) => reviewPr({ roles: ["reviewer"], viewerHasReviewed: false, ...o });
      await state.applyActivity([asked()], file);
      const pushed = asked({ lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file);
      assert.strictEqual(pushed.returnedToMe, false);
    }));

  await atest("applyActivity.needsAttention: a re-request alongside the past review is your turn again", () =>
    withTempStore(async (file) => {
      const reRequested = reviewPr({ roles: ["reviewer", "reviewed"] });
      await state.applyActivity([reRequested], file);
      assert.strictEqual(reRequested.needsAttention, true);
    }));

  await atest("applyActivity.needsAttention: your own PR keeps the full rules when you also reviewed it", () =>
    withTempStore(async (file) => {
      // reviewed-by:@me matches your own PRs too, so `author` and `reviewed`
      // co-occur — the passive branch must not swallow the author's failing CI.
      const mine = reviewPr({ roles: ["author", "reviewed"], failingChecks: ["build"] });
      await state.applyActivity([mine], file);
      assert.strictEqual(mine.needsAttention, true);
    }));

  // --- github: fetchHost also collects the PRs you already reviewed ----------
  // GitHub clears the review request the moment you submit a review, so such a
  // PR stops matching `review-requested:@me`. Without the `reviewed-by:@me`
  // alias it drops off the dashboard exactly when the author starts addressing
  // your comments — the case `returnedToMe` exists to catch.
  const realGithubFetch = global.fetch;
  let hostSeq = 0;

  // Drives fetchHost against a stubbed transport and returns both the request it
  // sent and the PRs it produced. A fresh graphqlUrl per call: team discovery is
  // cached per host for 10 minutes and has no test-visible reset.
  async function runFetchHost(searches) {
    const graphqlUrl = `https://api.stub${++hostSeq}.test/graphql`;
    let sent = null;
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => [] };
      }
      sent = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { remaining: 4990, cost: 4, resetAt: "2026-07-07T01:00:00Z" },
            viewer: { login: "me" },
            authored: { nodes: searches.authored ?? [] },
            reviewing: { nodes: searches.reviewing ?? [] },
            reviewed: { nodes: searches.reviewed ?? [] },
          },
        }),
      };
    };
    const result = await github.fetchHost({
      label: "H",
      graphqlUrl,
      repos: ["a/b"],
      token: "t",
    });
    return { sent, result };
  }

  await atest("fetchHost: asks for reviewed-by:@me over the same repos, as its own alias", async () => {
    const { sent } = await runFetchHost({});
    assert.strictEqual(
      sent.variables.reviewedQuery,
      "is:open is:pr repo:a/b reviewed-by:@me sort:updated-desc",
      // The only qualifier whose match set grows for the PR's whole open life,
      // so past the first: 25 cap the default order would hide the recent ones
      // and reshuffle between polls.
      "the reviewed search must be pinned to a recency order",
    );
    assert.ok(
      sent.query.includes("reviewed: search(query: $reviewedQuery"),
      "the reviewed search must be its own alias in the merged query",
    );
  });

  await atest("fetchHost: a PR you already reviewed arrives with the passive `reviewed` role", async () => {
    const { result } = await runFetchHost({ reviewed: [rawPr({ id: "PR_reviewed" })] });
    assert.strictEqual(result.pullRequests.length, 1);
    assert.deepStrictEqual(result.pullRequests[0].roles, ["reviewed"]);
  });

  await atest("fetchHost: a re-requested PR is one card carrying both roles", async () => {
    const { result } = await runFetchHost({
      reviewing: [rawPr({ id: "PR_both" })],
      reviewed: [rawPr({ id: "PR_both" })],
    });
    assert.strictEqual(result.pullRequests.length, 1, "the two searches must merge by id");
    assert.deepStrictEqual(result.pullRequests[0].roles, ["reviewer", "reviewed"]);
  });

  await atest("fetchHost: your own PR keeps `author` when reviewed-by:@me also matches it", async () => {
    const { result } = await runFetchHost({
      authored: [rawPr({ id: "PR_mine" })],
      reviewed: [rawPr({ id: "PR_mine" })],
    });
    assert.strictEqual(result.pullRequests.length, 1);
    assert.ok(result.pullRequests[0].roles.includes("author"));
  });

  global.fetch = realGithubFetch;

  // --- jira: fetchParents ----------------------------------------------------
  const JIRA_CFG = { baseUrl: "https://org.atlassian.net", email: "me@x.com" };
  // Must be UUID-shaped: resolveCloudId rejects anything else (URL-injection guard).
  const CLOUD_ID = "158d8f10-2fb5-4b9b-9d0f-6a1c3f4b5e6d";
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

  await atest("fetchParents: falls back to the site URL on 401/403 (classic token)", async () => {
    // Both statuses are "wrong token type for this base" — a regression narrowing
    // the condition to 401-only must fail here.
    for (const status of [401, 403]) {
      jira.clearParentCache();
      global.fetch = async (url) => {
        if (isTenant(url)) return tenantOk();
        if (url === GATEWAY) return errRes(status); // classic token → gateway rejects
        if (url === SITE)
          return okJson({ issues: [{ key: "ENG-1", fields: { parent: { key: "ENG-0", fields: { summary: "P" } } } }] });
        throw new Error("unexpected url " + url);
      };
      const map = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-1"]);
      assert.strictEqual(map.get("ENG-1").parentKey, "ENG-0");
    }
  });

  await atest("fetchParents: a non-UUID cloudId is rejected — site only, no gateway", async () => {
    // tenant_info lives on a user-configured host; a malformed cloudId must not
    // be interpolated into the api.atlassian.com URL path.
    jira.clearParentCache();
    let hitGateway = false;
    global.fetch = async (url) => {
      if (isTenant(url)) return okJson({ cloudId: "../../oauth/token#" });
      if (url.startsWith("https://api.atlassian.com/")) { hitGateway = true; return errRes(401); }
      if (url === SITE)
        return okJson({ issues: [{ key: "ENG-1", fields: { parent: { key: "ENG-0" } } }] });
      throw new Error("unexpected url " + url);
    };
    const map = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(map.get("ENG-1").parentKey, "ENG-0");
    assert.strictEqual(hitGateway, false);
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
      // First pass IS the in-blip fetch: cloudId lookup fails → site only → empty,
      // gateway never tried. This is where a negative WOULD be written if the
      // untrusted-base guard regressed.
      const first = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-9"]);
      assert.strictEqual(first.has("ENG-9"), false);
      assert.strictEqual(gatewayHits, 0);
      // Advance just past the 60s cloudId TTL — far short of the 10-min parentCache TTL.
      clock += 61 * 1000;
      // Second pass: cloudId re-resolves, the gateway wins (site base not pinned,
      // no negatives cached), so recovery happens inside the 60s window. Recovering
      // here — well before CACHE_TTL_MS — is the proof that the blip wrote no
      // poisoning negative: a cached negative would still be fresh at +61s, keep
      // ENG-9 out of the stale set, and leave the map empty (failing the assert).
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

  await atest("fetchParents: a thrown-gateway fallback neither pins the site nor caches negatives", async () => {
    // The untrusted-fallback guard (`cleanFallback`): a 200-but-empty reached
    // past a thrown gateway might be a scoped token that belongs on the gateway.
    // If the site base got pinned or negatives written here, the dashboard would
    // stay silently empty long after the gateway recovers. Mutation guard:
    // replacing resultIsTrustworthy with `bases.length > 1` must fail this test.
    jira.clearParentCache();
    const realNow = Date.now;
    let clock = 5_000_000;
    Date.now = () => clock;
    let gatewayCalls = 0;
    try {
      global.fetch = async (url) => {
        if (isTenant(url)) return tenantOk();
        if (url === GATEWAY) {
          gatewayCalls++;
          if (gatewayCalls === 1) throw new Error("proxy reset"); // transient outage
          return okJson({ issues: [{ key: "ENG-11", fields: { parent: { key: "ENG-10", fields: { summary: "P" } } } }] });
        }
        if (url === SITE) return okJson({ issues: [] }); // scoped token → 200-but-empty
        throw new Error("unexpected url " + url);
      };
      // Pass 1: gateway throws, site answers empty → untrusted; nothing may be cached.
      const first = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-11"]);
      assert.strictEqual(first.has("ENG-11"), false);
      // Past the 60s gateway backoff but far inside the 10-min parentCache TTL: a
      // poisoning negative from pass 1 would still be fresh and keep the key out
      // of the stale set; a pinned site base would never retry the gateway.
      // Either regression leaves the map empty here.
      clock += 61 * 1000;
      const second = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-11"]);
      assert.strictEqual(second.get("ENG-11").parentKey, "ENG-10");
      assert.strictEqual(gatewayCalls, 2);
    } finally {
      Date.now = realNow;
      global.fetch = realFetch;
    }
  });

  await atest("fetchParents: a thrown gateway is backed off, not re-probed on every pass", async () => {
    // Recurring-timeout guard: after the gateway throws (proxy blocking
    // api.atlassian.com while allowing the site), later passes inside the backoff
    // window must go straight to the site — no repeated 10s timeout per chunk per
    // tick — and the gateway is re-attempted once the window lapses.
    jira.clearParentCache();
    const realNow = Date.now;
    let clock = 9_000_000;
    Date.now = () => clock;
    let gatewayAttempts = 0;
    try {
      global.fetch = async (url, init) => {
        if (isTenant(url)) return tenantOk();
        if (url === GATEWAY) { gatewayAttempts++; throw new Error("blocked by proxy"); }
        if (url === SITE) {
          // Answer only the keys actually queried, so each pass must fetch.
          const queried = (JSON.parse(init.body).jql.match(/ENG-\d+/g)) || [];
          return okJson({ issues: queried.map((k) => ({ key: k, fields: { parent: { key: "ENG-20", fields: { summary: "P" } } } })) });
        }
        throw new Error("unexpected url " + url);
      };
      const first = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-21"]);
      assert.strictEqual(first.get("ENG-21").parentKey, "ENG-20");
      assert.strictEqual(gatewayAttempts, 1);
      // Inside the backoff window: the gateway must not be attempted again.
      const second = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-22"]);
      assert.strictEqual(second.get("ENG-22").parentKey, "ENG-20");
      assert.strictEqual(gatewayAttempts, 1);
      // Past the window: the gateway candidate is back (and may throw again).
      clock += 61 * 1000;
      const third = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-23"]);
      assert.strictEqual(third.get("ENG-23").parentKey, "ENG-20");
      assert.strictEqual(gatewayAttempts, 2);
    } finally {
      Date.now = realNow;
      global.fetch = realFetch;
    }
  });

  await atest("fetchParents: a clearParentCache during an in-flight pass discards that pass's cache writes", async () => {
    // Token-change race: the user saves a new token while a pass built with the
    // old token is awaiting its fetch. When that pass resolves it must not re-pin
    // the base or repopulate the caches that were just cleared — otherwise the
    // new token would be sent to the old token's pinned base forever.
    jira.clearParentCache();
    let tenantCalls = 0;
    let searchCalls = 0;
    global.fetch = async (url) => {
      if (isTenant(url)) { tenantCalls++; return tenantOk(); }
      searchCalls++;
      if (searchCalls === 1) jira.clearParentCache(); // the token save lands mid-flight
      return okJson({ issues: [{ key: "ENG-31", fields: { parent: { key: "ENG-30", fields: { summary: "P" } } } }] });
    };
    // The raced pass reports empty — its result belongs to the pre-clear world.
    const first = await jira.fetchParents(JIRA_CFG, "old-token", ["ENG-31"]);
    assert.strictEqual(first.has("ENG-31"), false);
    // The next pass must re-probe everything: nothing from the raced pass survived.
    const second = await jira.fetchParents(JIRA_CFG, "new-token", ["ENG-31"]);
    assert.strictEqual(second.get("ENG-31").parentKey, "ENG-30");
    assert.strictEqual(tenantCalls, 2); // cloudId re-resolved → cleared cache stayed cleared
    assert.strictEqual(searchCalls, 2); // parent re-fetched → no stale positive/pin survived
  });

  await atest("fetchParents: negatives are still cached after the base is pinned (no per-tick re-query)", async () => {
    // Regression: once the base is pinned, apiBasesFor returns a single-element
    // array. A `bases.length > 1` trust check alone would then treat every
    // steady-state call as untrusted and stop caching negatives, re-querying
    // no-parent keys on every tick. A pinned base must stay trusted.
    jira.clearParentCache();
    let searchCalls = 0;
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      searchCalls++; // gateway search — returns a parent only for ENG-A, never ENG-B
      return okJson({ issues: [{ key: "ENG-A", fields: { parent: { key: "ENG-P", fields: { summary: "P" } } } }] });
    };
    // Call 1 pins the gateway (bases.length === 2 here).
    await jira.fetchParents(JIRA_CFG, "tok", ["ENG-A"]);
    // Call 2 runs with the base already pinned (bases === [gateway]); ENG-B is not
    // returned, so its negative must still be written despite the single-element set.
    await jira.fetchParents(JIRA_CFG, "tok", ["ENG-B"]);
    const callsBefore = searchCalls;
    // Call 3 for the same no-parent key must make no new request — proving the
    // negative from call 2 was cached.
    const again = await jira.fetchParents(JIRA_CFG, "tok", ["ENG-B"]);
    assert.strictEqual(again.has("ENG-B"), false);
    assert.strictEqual(searchCalls, callsBefore);
  });

  await atest("clearParentCache: wipes parent + cloudId + apiBase caches (token change forces a full re-probe)", async () => {
    jira.clearParentCache();
    let tenantCalls = 0;
    let searchCalls = 0;
    global.fetch = async (url) => {
      if (isTenant(url)) { tenantCalls++; return tenantOk(); }
      searchCalls++;
      return okJson({ issues: [{ key: "ENG-1", fields: { parent: { key: "ENG-0", fields: { summary: "P" } } } }] });
    };
    await jira.fetchParents(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(tenantCalls, 1); // cloudId resolved once
    assert.strictEqual(searchCalls, 1);
    // A repeat with everything cached hits the network for neither.
    await jira.fetchParents(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(tenantCalls, 1);
    assert.strictEqual(searchCalls, 1);
    // Clearing (as setJiraToken does on a token change) forces a full re-probe.
    jira.clearParentCache();
    await jira.fetchParents(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(tenantCalls, 2); // cloudIdCache cleared → tenant_info re-probed
    assert.strictEqual(searchCalls, 2); // parentCache + apiBaseCache cleared → re-queried
  });

  await atest("fetchParents: the tenant_info probe uses a shorter timeout than the search", async () => {
    // Cold-cache + full-outage guard: the enricher pays the cloudId probe and
    // the search as two sequential timeouts in one tick, so the lightweight
    // unauthenticated tenant_info probe must not hold the full per-request
    // budget — otherwise a total Jira outage doubles the worst-case poll stall.
    // Capture the AbortController deadline each fetch arms and assert the probe's
    // is materially shorter than the search's. Reverting the probe to the full
    // REQUEST_TIMEOUT_MS must fail here.
    jira.clearParentCache();
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const delays = [];
    global.setTimeout = (_fn, ms) => {
      delays.push(ms);
      return 0;
    };
    global.clearTimeout = () => {};
    try {
      global.fetch = async (url) => {
        if (isTenant(url)) return tenantOk();
        if (url === GATEWAY)
          return okJson({ issues: [{ key: "ENG-1", fields: { parent: { key: "ENG-0", fields: { summary: "P" } } } }] });
        throw new Error("unexpected url " + url);
      };
      await jira.fetchParents(JIRA_CFG, "tok", ["ENG-1"]);
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      global.fetch = realFetch;
    }
    // First timer armed is the tenant_info probe; the last is the search request.
    assert.ok(delays.length >= 2, `expected >=2 timeouts, saw ${delays.length}`);
    const probe = delays[0];
    const search = delays[delays.length - 1];
    assert.ok(probe < search, `probe timeout (${probe}ms) must be shorter than the search (${search}ms)`);
    assert.ok(probe * 2 <= search, `probe timeout (${probe}ms) should be materially shorter than the search (${search}ms)`);
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

  // --- poller: fetchedAt is not a per-snapshot identity ----------------------
  // Why the header live-dot keys on a snapshot counter (App.tsx) and not on
  // `snapshot.fetchedAt`: the snapshot carries the *oldest* per-host timestamp
  // ("only as fresh as its stalest host"), and a host that keeps failing drags
  // its previous value forward. So two materially different snapshots can be
  // pushed with an identical `fetchedAt` — keying a remount on it would drop
  // the blink for every one of them.
  await atest("Poller.tick: two distinct snapshots can carry the same fetchedAt", async () => {
    const snapshots = [];
    let comments = 0;
    const mkPr = () => ({
      id: "PR1",
      updatedAt: "2026-07-07T00:00:00Z",
      totalComments: comments,
      unresolvedThreads: 0,
      ciState: "success",
      reviewDecision: null,
      hasHumanApproval: false,
      hasNewActivity: false,
      needsAttention: false,
      failingChecks: [],
      pendingChecks: [],
      checks: [],
      awaitingReview: false,
      hasUnaddressedChangeRequest: false,
      hasUnaddressedComments: false,
      roles: ["author"],
      isDraft: false,
      isIgnored: false,
      parentKey: null,
      parentSummary: null,
    });
    const p = new poller.Poller({
      loadSettings: () => ({
        pollIntervalSeconds: 60,
        launchAtLogin: false,
        autoUpdate: false,
        theme: "system",
        hosts: [],
      }),
      toHostConfigs: () => [
        { label: "up", graphqlUrl: "https://up.test/graphql", token: "t", repos: ["o/r"] },
        { label: "down", graphqlUrl: "https://down.test/graphql", token: "t", repos: ["o/r"] },
      ],
      statePath: path.join(os.tmpdir(), "prd-poller-state-missing.json"),
      ignoredStatePath: path.join(os.tmpdir(), "prd-poller-ignored-missing.json"),
      appVersion: "test",
      onSnapshot: (s) => snapshots.push(s),
      onConfigError: () => {},
      // One healthy host, one that never comes back.
      fetchHostFn: async (host) => {
        if (host.label === "down") throw new Error("host down");
        return {
          pullRequests: [mkPr()],
          rateLimit: { hostLabel: "up", remaining: 5000, cost: 1, resetAt: "2026-07-07T13:00:00Z" },
        };
      },
    });

    await p.refresh();
    await new Promise((r) => setTimeout(r, 5)); // so the two fetch stamps differ
    comments = 1; // hash-relevant change → the second snapshot really is pushed
    await p.refresh();

    assert.strictEqual(snapshots.length, 2, "a changed PR must push a second snapshot");
    // The healthy host genuinely refetched between the two pushes...
    assert.notStrictEqual(
      snapshots[0].rateLimits[0].fetchedAt,
      snapshots[1].rateLimits[0].fetchedAt,
      "the healthy host should carry a newer per-host fetchedAt",
    );
    // ...yet the snapshot-level timestamp is pinned to the host that is down.
    assert.strictEqual(
      snapshots[0].fetchedAt,
      snapshots[1].fetchedAt,
      "snapshot.fetchedAt is the oldest host's stamp — it is not a per-push id",
    );

    p.stop();
  });

  await atest("stableJiraMessage: strips the variable detail after the error separator", () => {
    // Change-detection view of jiraHealth.message: a Jira HTTP error appends a
    // per-response-varying body (request ids, retry hints) after the separator.
    // Hashing the raw text would re-emit every tick and reset the idle backoff,
    // so only the stable prefix is kept.
    assert.strictEqual(poller.stableJiraMessage(undefined), undefined);
    // No separator → passed through unchanged.
    assert.strictEqual(poller.stableJiraMessage("Jira HTTP 401 Unauthorized"), "Jira HTTP 401 Unauthorized");
    // Separator present → truncated at the boundary.
    assert.strictEqual(
      poller.stableJiraMessage("Jira HTTP 429 Too Many Requests — retry after 42s; reqId=abc"),
      "Jira HTTP 429 Too Many Requests",
    );
    // Same status, different variable tail → identical stable prefix (no re-emit).
    assert.strictEqual(
      poller.stableJiraMessage("Jira HTTP 429 Too Many Requests — reqId=aaa"),
      poller.stableJiraMessage("Jira HTTP 429 Too Many Requests — reqId=bbb"),
    );
    // Genuinely different failure still differs in the prefix (still re-emits).
    assert.notStrictEqual(
      poller.stableJiraMessage("Jira HTTP 429 Too Many Requests — x"),
      poller.stableJiraMessage("Jira HTTP 500 Server Error — x"),
    );
  });

  // --- poller: hashSnapshot re-emit coupling ---------------------------------
  // hashSnapshot gates snapshot re-emit, and handleNotifications runs only on
  // re-emit — so every field the notifier (notify.ts) reads MUST be hashed here,
  // or a tick whose only delta is that field silently never fires. These lock
  // the hasUnaddressedComments and roles fields in (siblings of
  // hasUnaddressedChangeRequest, which the notifier also reads).
  const hsnap = (prOverrides = {}, top = {}) => ({
    pullRequests: [
      {
        id: "PR_1",
        updatedAt: "2026-01-01T00:00:00Z",
        hasUnaddressedChangeRequest: false,
        hasUnaddressedComments: false,
        roles: ["author"],
        // hashSnapshot reads .length on these three arrays.
        failingChecks: [],
        pendingChecks: [],
        checks: [],
        ...prOverrides,
      },
    ],
    errors: [],
    rateLimits: [],
    fetchedAt: "2026-01-01T00:00:00Z",
    version: "1.0.0",
    ...top,
  });
  test("hashSnapshot: a hasUnaddressedComments-only delta changes the hash (so the notification fires)", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap()),
      poller.hashSnapshot(hsnap({ hasUnaddressedComments: true })),
    ));
  test("hashSnapshot: a roles-only delta changes the hash (so review_requested fires)", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ roles: ["author"] })),
      poller.hashSnapshot(hsnap({ roles: ["author", "reviewer"] })),
    ));
  test("hashSnapshot: identical PR fields hash equal, ignoring fetchedAt (no spurious re-emit)", () =>
    assert.strictEqual(
      poller.hashSnapshot(hsnap({}, { fetchedAt: "2026-01-01T00:00:00Z" })),
      poller.hashSnapshot(hsnap({}, { fetchedAt: "2026-06-06T12:34:56Z" })),
    ));

  // --- notify: diffNotifications ---------------------------------------------
  const N_ON = { enabled: true, native: true, sound: false, events: { yourTurn: true, ciFailed: true, goodNews: true } };
  const npr = (o = {}) => ({
    id: "1",
    repo: "a/b",
    number: 1,
    title: "T",
    url: "https://x/1",
    roles: ["author"],
    hasUnaddressedChangeRequest: false,
    hasUnaddressedComments: false,
    ciState: "success",
    hasHumanApproval: false,
    ...o,
  });
  const kinds = (evs) => evs.map((e) => e.kind);

  test("diffNotifications: first snapshot (null prev) is a silent baseline", () =>
    assert.deepStrictEqual(notify.diffNotifications(null, [npr()], N_ON), []));
  test("diffNotifications: disabled fires nothing", () =>
    assert.deepStrictEqual(
      notify.diffNotifications([npr()], [npr({ ciState: "failure" })], { ...N_ON, enabled: false }),
      [],
    ));
  test("diffNotifications: newly-appeared reviewer PR fires review_requested", () =>
    assert.deepStrictEqual(
      kinds(notify.diffNotifications([], [npr({ id: "2", roles: ["reviewer"] })], N_ON)),
      ["review_requested"],
    ));
  test("diffNotifications: opening your own PR (no prior) fires nothing", () =>
    assert.deepStrictEqual(notify.diffNotifications([], [npr({ id: "9" })], N_ON), []));
  // returned_to_me — the one reviewer-side rule besides review_requested, and
  // the only notification the `reviewed` category can ever produce: GitHub drops
  // the review request once you review, so such a PR never re-enters the
  // `reviewer` role that review_requested keys on.
  const backPr = (o = {}) => npr({ id: "5", roles: ["reviewed"], returnedToMe: false, ...o });
  test("diffNotifications: a reviewed PR coming back to you fires returned_to_me", () =>
    assert.deepStrictEqual(
      kinds(notify.diffNotifications([backPr()], [backPr({ returnedToMe: true })], N_ON)),
      ["returned_to_me"],
    ));
  test("diffNotifications: returned_to_me does not re-fire while the flag stays true", () =>
    assert.deepStrictEqual(
      // The flag stays true until the PR is marked seen, so a state-based rule
      // here would re-toast the same PR on every poll.
      notify.diffNotifications(
        [backPr({ returnedToMe: true })],
        [backPr({ returnedToMe: true })],
        N_ON,
      ),
      [],
    ));
  test("diffNotifications: a PR merely new to the snapshot has not come back", () =>
    assert.deepStrictEqual(
      notify.diffNotifications([], [backPr({ returnedToMe: true })], N_ON),
      [],
    ));
  test("diffNotifications: returned_to_me is suppressed when yourTurn is off", () =>
    assert.deepStrictEqual(
      notify.diffNotifications([backPr()], [backPr({ returnedToMe: true })], {
        ...N_ON,
        events: { ...N_ON.events, yourTurn: false },
      }),
      [],
    ));
  test("diffNotifications: an explicit re-request outranks the PR coming back", () =>
    assert.deepStrictEqual(
      kinds(
        notify.diffNotifications(
          [backPr()],
          [backPr({ roles: ["reviewer", "reviewed"], returnedToMe: true })],
          N_ON,
        ),
      ),
      ["review_requested"],
    ));

  test("diffNotifications: change request on your PR", () =>
    assert.deepStrictEqual(
      kinds(notify.diffNotifications([npr()], [npr({ hasUnaddressedChangeRequest: true })], N_ON)),
      ["changes_requested"],
    ));
  test("diffNotifications: CI failing transition on your PR", () =>
    assert.deepStrictEqual(
      kinds(notify.diffNotifications([npr()], [npr({ ciState: "failure" })], N_ON)),
      ["ci_failed"],
    ));
  test("diffNotifications: first human approval on your PR", () =>
    assert.deepStrictEqual(
      kinds(notify.diffNotifications([npr()], [npr({ hasHumanApproval: true })], N_ON)),
      ["approved"],
    ));
  test("diffNotifications: approval suppressed when goodNews is off", () =>
    assert.deepStrictEqual(
      notify.diffNotifications([npr()], [npr({ hasHumanApproval: true })], {
        ...N_ON,
        events: { ...N_ON.events, goodNews: false },
      }),
      [],
    ));
  test("diffNotifications: approval on a PR you only review does not fire (author-scoped)", () =>
    assert.deepStrictEqual(
      notify.diffNotifications(
        [npr({ id: "4", roles: ["reviewer"] })],
        [npr({ id: "4", roles: ["reviewer"], hasHumanApproval: true })],
        N_ON,
      ),
      [],
    ));
  test("diffNotifications: CI failing on a PR you only review does not fire (author-scoped)", () =>
    assert.deepStrictEqual(
      notify.diffNotifications(
        [npr({ id: "3", roles: ["reviewer"] })],
        [npr({ id: "3", roles: ["reviewer"], ciState: "failure" })],
        N_ON,
      ),
      [],
    ));
  test("diffNotifications: one event per PR — highest priority wins", () =>
    assert.deepStrictEqual(
      kinds(
        notify.diffNotifications(
          [npr()],
          [npr({ hasUnaddressedChangeRequest: true, ciState: "failure" })],
          N_ON,
        ),
      ),
      ["changes_requested"],
    ));
  test("diffNotifications: a group toggle off suppresses its events", () =>
    assert.deepStrictEqual(
      notify.diffNotifications([npr()], [npr({ ciState: "failure" })], {
        ...N_ON,
        events: { ...N_ON.events, ciFailed: false },
      }),
      [],
    ));
  test("diffNotifications: no re-fire while a state persists (needs a transition)", () =>
    assert.deepStrictEqual(
      notify.diffNotifications(
        [npr({ ciState: "failure" })],
        [npr({ ciState: "failure" })],
        N_ON,
      ),
      [],
    ));
  test("diffNotifications: ignored PR fires nothing (muted everywhere)", () =>
    assert.deepStrictEqual(
      notify.diffNotifications([npr()], [npr({ ciState: "failure", isIgnored: true })], N_ON),
      [],
    ));
  test("diffNotifications: new unanswered comment on your PR fires unanswered_comment", () =>
    assert.deepStrictEqual(
      kinds(notify.diffNotifications([npr()], [npr({ hasUnaddressedComments: true })], N_ON)),
      ["unanswered_comment"],
    ));
  test("diffNotifications: unanswered_comment suppressed when yourTurn is off", () =>
    assert.deepStrictEqual(
      notify.diffNotifications([npr()], [npr({ hasUnaddressedComments: true })], {
        ...N_ON,
        events: { ...N_ON.events, yourTurn: false },
      }),
      [],
    ));

  // --- notify <-> poller: general field-coupling invariant -------------------
  // The enumerative spot-checks above lock specific fields; this locks the whole
  // class. Every PR field diffNotifications READS to decide a transition must be
  // hashed by hashSnapshot (or a tick whose only delta is that field never
  // re-emits and the toast is lost). Both read-sets are captured with a
  // recording Proxy, so a *future* notifier-read field left out of the hash
  // fails this automatically — no new per-field test required.
  test("hashSnapshot hashes every PR field diffNotifications reads for transitions", () => {
    const RENDER_ONLY = new Set(["repo", "number", "title", "url"]); // build the toast body, not the decision
    const fieldsReadBy = (run) => {
      const read = new Set();
      const wrap = (o) =>
        new Proxy(o, {
          get(t, k) {
            if (typeof k === "string") read.add(k);
            return t[k];
          },
        });
      run(wrap);
      return read;
    };
    // Force a ci_failed transition so makeEvent runs and the render-only reads
    // are exercised (and then proven excluded).
    const notifierReads = fieldsReadBy((wrap) =>
      notify.diffNotifications([wrap(npr())], [wrap(npr({ ciState: "failure" }))], N_ON),
    );
    const hpr = { id: "1", roles: ["author"], failingChecks: [], pendingChecks: [], checks: [] };
    const hashReads = fieldsReadBy((wrap) =>
      poller.hashSnapshot({ pullRequests: [wrap(hpr)], errors: [], rateLimits: [], fetchedAt: "", version: "" }),
    );
    const missing = [...notifierReads].filter((f) => !RENDER_ONLY.has(f) && !hashReads.has(f));
    assert.deepStrictEqual(missing, [], `notifier-read PR fields missing from hashSnapshot: ${missing.join(", ")}`);
  });

  // --- notify: runNotifyCycle (baseline advance + best-effort delivery) ------
  // Locks the ordering guarantee that lives in main.ts's notifier: the baseline
  // advances even when delivery throws, and a delivery failure never escapes.
  test("runNotifyCycle: advances baseline to next and delivers the diffed events", () => {
    const delivered = [];
    const next = [npr({ ciState: "failure" })];
    const baseline = notify.runNotifyCycle([npr()], next, N_ON, (evs) =>
      delivered.push(...evs.map((e) => e.kind)),
    );
    assert.strictEqual(baseline, next);
    assert.deepStrictEqual(delivered, ["ci_failed"]);
  });
  test("runNotifyCycle: a throwing deliverer still advances the baseline and never escapes", () => {
    const next = [npr({ ciState: "failure" })];
    let baseline;
    assert.doesNotThrow(() => {
      baseline = notify.runNotifyCycle([npr()], next, N_ON, () => {
        throw new Error("deliver boom");
      });
    });
    assert.strictEqual(baseline, next); // baseline advanced despite the throw
  });
  test("runNotifyCycle: disabled delivers an empty batch and still advances baseline", () => {
    const next = [npr({ ciState: "failure" })];
    let got = null;
    const baseline = notify.runNotifyCycle([npr()], next, { ...N_ON, enabled: false }, (evs) => {
      got = evs;
    });
    assert.deepStrictEqual(got, []);
    assert.strictEqual(baseline, next);
  });

  // --- notify: createReleaseGuard (dedup + safety-net) -----------------------
  test("createReleaseGuard: releases once and clears the timer even when called repeatedly", () => {
    let released = 0;
    let cleared = 0;
    const release = notify.createReleaseGuard(
      { onRelease: () => released++, setTimer: () => ({ clear: () => cleared++ }) },
      60_000,
    );
    release();
    release();
    release();
    assert.strictEqual(released, 1);
    assert.strictEqual(cleared, 1);
  });
  test("createReleaseGuard: the safety-net timer fires release when nothing else does", () => {
    let released = 0;
    let captured = null;
    notify.createReleaseGuard(
      { onRelease: () => released++, setTimer: (fn) => ((captured = fn), { clear: () => {} }) },
      60_000,
    );
    assert.strictEqual(released, 0); // nothing has fired yet
    captured(); // simulate the timer elapsing
    assert.strictEqual(released, 1);
  });
  test("createReleaseGuard: a stale safety-net firing after release is a no-op (one-shot)", () => {
    let released = 0;
    let captured = null;
    const release = notify.createReleaseGuard(
      { onRelease: () => released++, setTimer: (fn) => ((captured = fn), { clear: () => {} }) },
      60_000,
    );
    release(); // a click/close/failed arrives first
    captured(); // the (already-cancelled) timer still fires later
    assert.strictEqual(released, 1);
  });

  // --- notify: planDelivery (pure delivery decision) -------------------------
  const evs = (n) =>
    Array.from({ length: n }, (_, i) => ({ prId: String(i), kind: "ci_failed", title: "t", body: "b", url: "u" }));
  const CTX = { focused: false, nativeSupported: true };
  const NP = (o = {}) => ({ enabled: true, native: true, sound: false, ...o });
  const CAP = notify.MAX_INDIVIDUAL_NOTIFICATIONS;

  test("planDelivery: no events -> none", () =>
    assert.strictEqual(notify.planDelivery([], NP(), CTX).mode, "none"));
  test("planDelivery: disabled -> none", () =>
    assert.strictEqual(notify.planDelivery(evs(2), NP({ enabled: false }), CTX).mode, "none"));
  test("planDelivery: focused window -> none (suppressed)", () =>
    assert.strictEqual(notify.planDelivery(evs(1), NP(), { ...CTX, focused: true }).mode, "none"));
  test("planDelivery: burst over the cap -> silent summary (no sound)", () => {
    const p = notify.planDelivery(evs(CAP + 1), NP(), CTX);
    assert.strictEqual(p.mode, "summary");
    assert.strictEqual(p.summarySilent, true);
  });
  test("planDelivery: burst over the cap with sound -> audible summary", () =>
    assert.strictEqual(notify.planDelivery(evs(CAP + 1), NP({ sound: true }), CTX).summarySilent, false));
  test("planDelivery: at the cap -> individual, chime only on the first", () => {
    const p = notify.planDelivery(evs(CAP), NP({ sound: true }), CTX);
    assert.strictEqual(p.mode, "individual");
    // silent[i] === true means no chime; only index 0 should chime.
    assert.deepStrictEqual(p.silent, [false, true, true, true]);
  });
  test("planDelivery: individual with sound off -> every toast silent", () =>
    assert.deepStrictEqual(notify.planDelivery(evs(2), NP({ sound: false }), CTX).silent, [true, true]));
  test("planDelivery: native off but sound on -> sound-only", () =>
    assert.strictEqual(notify.planDelivery(evs(2), NP({ native: false, sound: true }), CTX).mode, "sound-only"));
  test("planDelivery: native unsupported but sound on -> sound-only", () =>
    assert.strictEqual(
      notify.planDelivery(evs(2), NP({ sound: true }), { ...CTX, nativeSupported: false }).mode,
      "sound-only",
    ));
  test("planDelivery: native off and sound off -> none", () =>
    assert.strictEqual(notify.planDelivery(evs(2), NP({ native: false, sound: false }), CTX).mode, "none"));

  // --- notify defaults: single source of truth -------------------------------
  test("defaultNotificationSettings equals the shared default and is a fresh clone", () => {
    assert.deepStrictEqual(cfg.defaultNotificationSettings(), notify.DEFAULT_NOTIFICATION_SETTINGS);
    const a = cfg.defaultNotificationSettings();
    a.events.yourTurn = false;
    assert.strictEqual(notify.DEFAULT_NOTIFICATION_SETTINGS.events.yourTurn, true); // shared const not mutated
  });

  // --- idle gate: hidden window no longer pauses when a toast could fire -------
  // Base = "polling should run" (active). Each case flips one field.
  // Both costly inputs are thunks in IdleGateInputs (lazy, so the free branches
  // never pay for a native query) — the helper takes plain values and wraps them,
  // counting reads so the branch ORDER is assertable, not just the result.
  const GATE = {
    systemSuspended: false,
    hasWindow: true,
    windowHidden: false,
    systemIdleSeconds: 0,
    notificationsActionable: false,
  };
  const gateWithReads = (over) => {
    const o = { ...GATE, ...over };
    let idleReads = 0;
    let actionableReads = 0;
    const paused = idleGate.isPollingPaused({
      systemSuspended: o.systemSuspended,
      hasWindow: o.hasWindow,
      windowHidden: o.windowHidden,
      notificationsActionable: () => {
        actionableReads++;
        return o.notificationsActionable;
      },
      systemIdleSeconds: () => {
        idleReads++;
        return o.systemIdleSeconds;
      },
    });
    return { paused, idleReads, actionableReads };
  };
  const gate = (over) => gateWithReads(over).paused;

  test("isPollingPaused: visible, active, no notifications -> runs", () =>
    assert.strictEqual(gate({}), false));
  test("isPollingPaused: suspended always pauses (even with notifications on)", () => {
    assert.strictEqual(gate({ systemSuspended: true }), true);
    assert.strictEqual(gate({ systemSuspended: true, notificationsActionable: true }), true);
  });
  test("isPollingPaused: no window yet (startup/activate) -> runs", () =>
    // hasWindow false wins even if a stale windowHidden slips through.
    assert.strictEqual(gate({ hasWindow: false, windowHidden: true }), false));
  test("isPollingPaused: hidden window WITHOUT notifications -> pauses (budget saving)", () =>
    assert.strictEqual(gate({ windowHidden: true, notificationsActionable: false }), true));
  test("isPollingPaused: hidden window WITH notifications -> runs (the fix)", () =>
    assert.strictEqual(gate({ windowHidden: true, notificationsActionable: true }), false));
  test("isPollingPaused: away user pauses regardless of notifications", () => {
    const away = idleGate.IDLE_PAUSE_SECONDS + 1;
    assert.strictEqual(gate({ systemIdleSeconds: away }), true);
    assert.strictEqual(gate({ systemIdleSeconds: away, notificationsActionable: true }), true);
    assert.strictEqual(
      gate({ windowHidden: true, systemIdleSeconds: away, notificationsActionable: true }),
      true,
    );
  });
  test("isPollingPaused: idle exactly at the threshold is not yet away -> runs", () =>
    assert.strictEqual(gate({ systemIdleSeconds: idleGate.IDLE_PAUSE_SECONDS }), false));
  test("isPollingPaused: null idle (platform can't report) treated as active", () =>
    assert.strictEqual(gate({ systemIdleSeconds: null }), false));

  // The costly inputs stay unread whenever a free branch already decided — the
  // ordering regression this guards against is invisible to result-only asserts.
  test("isPollingPaused: suspended decides without reading either costly input", () => {
    const r = gateWithReads({ systemSuspended: true });
    assert.strictEqual(r.idleReads, 0);
    assert.strictEqual(r.actionableReads, 0);
  });
  test("isPollingPaused: no window decides without reading either costly input", () => {
    const r = gateWithReads({ hasWindow: false });
    assert.strictEqual(r.idleReads, 0);
    assert.strictEqual(r.actionableReads, 0);
  });
  test("isPollingPaused: hidden + nothing to notify decides without reading idle time", () =>
    assert.strictEqual(
      gateWithReads({ windowHidden: true, notificationsActionable: false }).idleReads,
      0,
    ));
  test("isPollingPaused: a visible window never asks whether notifications fire", () =>
    // Only the hidden branch needs it; asking anyway would be a wasted native call.
    assert.strictEqual(gateWithReads({}).actionableReads, 0));
  test("isPollingPaused: idle time is read once when the free branches don't decide", () => {
    assert.strictEqual(gateWithReads({}).idleReads, 1);
    assert.strictEqual(
      gateWithReads({ windowHidden: true, notificationsActionable: true }).idleReads,
      1,
    );
  });
  test("isPollingPaused: the hidden branch reads actionability exactly once", () =>
    assert.strictEqual(
      gateWithReads({ windowHidden: true, notificationsActionable: true }).actionableReads,
      1,
    ));

  // --- hasDeliverableNotifications: the gate's "could a toast fire?" signal ----
  // Guards the dead configurations the master `enabled` toggle alone can't see:
  // keeping background polling alive for them spends budget for nothing.
  const notifSettings = (over = {}) => ({
    ...notify.DEFAULT_NOTIFICATION_SETTINGS,
    enabled: true,
    ...over,
    events: { ...notify.DEFAULT_NOTIFICATION_SETTINGS.events, ...(over.events ?? {}) },
  });

  // nativeSupported is a REQUIRED arg (no optimistic default) — always explicit.
  const deliverable = (over, nativeSupported = true) =>
    notify.hasDeliverableNotifications(notifSettings(over), nativeSupported);

  test("hasDeliverableNotifications: master toggle off -> false", () =>
    assert.strictEqual(deliverable({ enabled: false }), false));
  test("hasDeliverableNotifications: enabled with a channel and an event -> true", () =>
    assert.strictEqual(deliverable({}), true));
  test("hasDeliverableNotifications: every event type off -> false", () =>
    assert.strictEqual(
      deliverable({ events: { yourTurn: false, ciFailed: false, goodNews: false } }),
      false,
    ));
  test("hasDeliverableNotifications: one event type left on -> true", () =>
    assert.strictEqual(
      deliverable({ events: { yourTurn: false, ciFailed: true, goodNews: false } }),
      true,
    ));
  test("hasDeliverableNotifications: both delivery channels off -> false", () =>
    assert.strictEqual(deliverable({ native: false, sound: false }), false));
  test("hasDeliverableNotifications: sound-only still deliverable", () =>
    assert.strictEqual(deliverable({ native: false, sound: true }), true));
  test("hasDeliverableNotifications: native unsupported by the OS falls back to sound", () => {
    // Mirrors planDelivery: native+unsupported is not a channel, sound still is.
    assert.strictEqual(deliverable({ native: true, sound: false }, false), false);
    assert.strictEqual(deliverable({ native: true, sound: true }, false), true);
  });

  // --- parity: the gate's verdict can never disagree with actual delivery ------
  // hasDeliverableNotifications and planDelivery both answer "can a channel carry
  // this?", and both now route through pickDeliveryChannel. This asserts the
  // agreement directly over the full settings matrix rather than trusting the
  // shared helper to stay shared: if the two ever drift so that the gate says
  // "nothing can fire" while planDelivery still delivers, a hidden window stops
  // polling with a deliverable toast pending — the exact bug the gate prevents.
  test("parity: hasDeliverableNotifications agrees with planDelivery on every settings combo", () => {
    const bools = [false, true];
    const ev = (n) => ({ yourTurn: !!(n & 1), ciFailed: !!(n & 2), goodNews: !!(n & 4) });
    const oneEvent = [
      { prId: "1", kind: "ci_failed", title: "t", body: "b", url: "http://x" },
    ];
    let combos = 0;
    for (const enabled of bools) {
      for (const native of bools) {
        for (const sound of bools) {
          for (let e = 0; e < 8; e++) {
            for (const nativeSupported of bools) {
              const s = { enabled, native, sound, events: ev(e) };
              const canFire = notify.hasDeliverableNotifications(s, nativeSupported);
              // planDelivery is handed a non-empty batch and an unfocused window,
              // so the ONLY thing left that can zero it out is channel viability.
              const plan = notify.planDelivery(oneEvent, s, { focused: false, nativeSupported });
              const wouldDeliver = plan.mode !== "none";
              // A settings state with no enabled event type can't produce events at
              // all, so planDelivery is never reached with one — exclude those from
              // the equivalence and assert the gate blocks them instead.
              const anyEvent = ev(e).yourTurn || ev(e).ciFailed || ev(e).goodNews;
              if (enabled && anyEvent) {
                assert.strictEqual(
                  canFire,
                  wouldDeliver,
                  `drift at enabled=${enabled} native=${native} sound=${sound} ` +
                    `events=${e} nativeSupported=${nativeSupported}: ` +
                    `gate=${canFire} planDelivery=${plan.mode}`,
                );
              } else {
                assert.strictEqual(canFire, false, `gate must block events=${e} enabled=${enabled}`);
              }
              combos++;
            }
          }
        }
      }
    }
    assert.strictEqual(combos, 128); // 2*2*2*8*2 — the whole space, not a sample
  });

  // --- pickDeliveryChannel: pin the shared rule directly -----------------------
  // The parity test above only proves the two callers AGREE; since both now route
  // through pickDeliveryChannel, a wrong rule in the helper moves them in lockstep
  // and parity stays green by construction. So the rule itself — native wins when
  // wanted AND OS-supported, else sound, else nothing — needs its own truth table.
  test("pickDeliveryChannel: native wins only when wanted AND supported", () => {
    const ch = (native, sound, nativeSupported) =>
      notify.pickDeliveryChannel({ enabled: true, native, sound, events: {} }, nativeSupported);
    // native requested + OS supports it -> native, regardless of sound.
    assert.strictEqual(ch(true, false, true), "native");
    assert.strictEqual(ch(true, true, true), "native");
    // native requested but OS can't -> fall back to sound if wanted, else null.
    assert.strictEqual(ch(true, true, false), "sound");
    assert.strictEqual(ch(true, false, false), null);
    // native not wanted -> sound if wanted, else null (support flag irrelevant).
    assert.strictEqual(ch(false, true, true), "sound");
    assert.strictEqual(ch(false, true, false), "sound");
    assert.strictEqual(ch(false, false, true), null);
    assert.strictEqual(ch(false, false, false), null);
  });

  // --- poller threads its already-loaded settings into the idle gate -----------
  // The isPaused widening from `() => boolean` to `(settings) => boolean` is
  // backward-compatible, so nothing else would fail if tick() passed undefined or
  // a stale object — and the gate would then read notification prefs off garbage.
  // Note: refresh() forces past the gate entirely, so this drives a plain tick.
  //
  // Beyond the argument threading, this also pins the *behavioural* contract: a
  // gate that returns true must actually suppress the tick's side effects. The
  // argument assertions alone would survive a condition inversion on the gate
  // check in tick() (`!force && !skipIdleGate && isPaused?.(settings)`), which
  // would consult the gate with the right settings yet poll anyway — so we assert
  // no snapshot is emitted. refresh() is the only other path past the gate and it
  // forces past it, so this plain tick is the sole test of the gate-active path.
  await atest("Poller.tick: gate returning true parks the tick with the loaded settings", async () => {
    const loaded = {
      pollIntervalSeconds: 60,
      launchAtLogin: false,
      autoUpdate: false,
      theme: "system",
      hosts: [],
      notifications: { enabled: true, native: true, sound: false, events: { yourTurn: true, ciFailed: true, goodNews: true } },
    };
    let seen = "never called";
    let calls = 0;
    const snapshots = [];
    const p = new poller.Poller({
      loadSettings: () => loaded,
      toHostConfigs: () => [],
      statePath: path.join(os.tmpdir(), "prd-poller-state-missing.json"),
      ignoredStatePath: path.join(os.tmpdir(), "prd-poller-ignored-missing.json"),
      appVersion: "test",
      onSnapshot: (s) => snapshots.push(s),
      onConfigError: () => {},
      // Returning true parks the tick before any network work.
      isPaused: (s) => {
        calls++;
        seen = s;
        return true;
      },
    });
    p.start();
    await p.awaitFirstTick();
    p.stop();
    assert.strictEqual(calls, 1, "the gate should be consulted exactly once per tick");
    assert.strictEqual(seen, loaded, "isPaused must receive the very object loadSettings returned");
    assert.strictEqual(seen.notifications.enabled, true);
    assert.strictEqual(snapshots.length, 0, "a paused tick must not emit a snapshot — the gate must suppress, not just be consulted");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
