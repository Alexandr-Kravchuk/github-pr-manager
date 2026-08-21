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
const issueKey = require(path.join(__dirname, "../dist/main/shared/issue-key.js"));
const prFilter = require(path.join(__dirname, "../dist/main/shared/pr-filter.js"));
const singleInstance = require(path.join(__dirname, "../dist/main/main/single-instance.js"));
const windowBounds = require(path.join(__dirname, "../dist/main/shared/window-bounds.js"));

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
// The renderer value-imports DEFAULT_NOTIFICATION_SETTINGS from shared/notify,
// the view-filter helpers from shared/pr-filter, the issue-link builder from
// shared/issue-key and the F5 decision from shared/hotkeys. That's only safe while those modules pull in no node:
// builtin — a regression would break the Vite renderer build. Assert the
// compiled output is clean so the AGENTS.md carve-out is enforced, not just
// documented.
for (const mod of ["notify.js", "pr-filter.js", "issue-key.js", "hotkeys.js"]) {
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

  // state.ts documents that `needsAttention` mirrors the card accent, and
  // `actionRank` ranks off the same "your move" idea. The harness cannot run the
  // renderer, so that mirror is otherwise upheld by convention alone: a change
  // that drops the term from state.ts would leave these two silently out of step
  // and every test would still pass. A text scan is the cheapest thing that
  // notices, on the pattern of the animation guard above.
  test("renderer keeps prSignal and actionRank in step with the attention terms", () => {
    const reads = (abs, label, fn) => {
      const src = stripComments(fs.readFileSync(abs, "utf8"));
      const at = src.indexOf(fn);
      assert.ok(at !== -1, `${label} no longer defines ${fn} — update this guard`);
      // The function body, bounded by the next top-level declaration rather than
      // a fixed window — a magic length silently stops covering the tail of the
      // function the moment a branch is added above the terms we check.
      const rest = src.slice(at + fn.length);
      const end = rest.search(/\n(?:export\s+)?(?:function|const|class|interface|type)\s/);
      const body = end === -1 ? rest : rest.slice(0, end);
      for (const term of ["returnedToMe", "myReReviewDue"]) {
        assert.ok(
          body.includes(term),
          `${label} ${fn} no longer reads ${term}; state.ts's needsAttention and the card accent must move together`,
        );
      }
    };
    // prSignal moved out of PrCard.tsx into shared/pr-filter.ts — a pure
    // function of a PullRequest, so it lives in the renderer-importable,
    // Node-free half of `shared` where it can be unit-tested directly (see the
    // `prSignal:` tests below) instead of only through this text scan.
    reads(
      path.join(__dirname, "../src/shared/pr-filter.ts"),
      "src/shared/pr-filter.ts",
      "function prSignal",
    );
    reads(path.join(rendererRoot, "src/App.tsx"), "src/App.tsx", "function actionRank");
  });
}

// --- renderer wiring for the trackComments setting ---------------------------
// The renderer half of the setting has no other gate: this repo has no renderer
// component tests, so without these the toggle could stop being persisted, or
// App.tsx stop calling the sanitizer, and all the other tests would still pass.
// Source-text assertions, the same tool the animation guard above uses — coarse
// on purpose: they pin that the wiring EXISTS, not how it behaves (that part is
// unit-tested in `sanitizeFilterState` and `validateSettings`).
{
  const fs = require("node:fs");
  const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

  test("Settings.tsx persists trackComments in the saved settings payload", () => {
    const src = read("src/renderer/src/components/Settings.tsx");
    // The checkbox's state must reach `saveSettings`, or the toggle looks like it
    // works and silently reverts on reopen.
    assert.match(src, /const settings: Settings = \{[\s\S]*?\btrackComments,[\s\S]*?\};/);
    assert.match(src, /setTrackComments\(/, "the checkbox must be wired to state");
  });

  test("App.tsx runs a stored newOnly through sanitizeFilterState", () => {
    const src = read("src/renderer/src/App.tsx");
    // Both halves matter: the import can survive while the call is refactored out.
    assert.match(src, /^\s*sanitizeFilterState,$/m, "must be imported from shared/pr-filter");
    // Structural, not literal: the call must be made and must be handed the flag.
    // Pinning the exact argument spelling would fail on a reformat or an extracted
    // variable while the behaviour is intact, and there is no formatter config
    // here to make that spelling predictable.
    assert.match(src, /sanitizeFilterState\([\s\S]{0,200}?trackComments/, "must be called with the flag");
  });

  test("main.ts hands the seen:mark handler the live setting", () => {
    const src = read("src/main/main.ts");
    // `tsc` only proves the option is passed, not that it comes from settings: a
    // hardcoded `true` here would silently undo the mark-seen guard (comments
    // that landed while tracking was off replayed as NEW after re-enabling) with
    // every test still green. Same reasoning as the renderer pins around it.
    assert.match(src, /markSeen\([\s\S]{0,400}?trackComments/, "the handler must pass the flag");
    assert.match(src, /loadSettings\(\)\.trackComments/, "and read it from settings, not hardcode it");
  });

  test("App.tsx gates the New comments chip and the header count on trackComments", () => {
    const src = read("src/renderer/src/App.tsx");
    // Same reasoning: assert the gate co-occurs with what it gates, not the
    // exact JSX or the header wording.
    assert.match(src, /trackComments &&[\s\S]{0,120}?<FilterChip/, "the chip must be conditional");
    assert.match(src, /trackComments &&[\s\S]{0,120}?stats\.fresh/, "the header stat must be conditional");
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
// Boot the COMPILED dist/main/main/main.js with a fake `electron` injected into
// the module cache, returning what the wiring did. Each call gets a fresh
// module graph; `cleanup()` restores the require cache to its pre-boot shape.
// Everything already cached before any boot — the test file's own module
// graph, snapshotted ONCE so a boot that throws mid-require can never leak its
// half-loaded graph into the next boot's baseline (each boot evicts everything
// newer than this snapshot before requiring).
const bootBaseline = new Set(Object.keys(require.cache));

const bootCompiledMain = (lockGranted) => {
  const mainJs = path.join(__dirname, "../dist/main/main/main.js");
  const elPath = require.resolve("electron", { paths: [path.dirname(mainJs)] });
  for (const k of Object.keys(require.cache)) {
    if (!bootBaseline.has(k)) delete require.cache[k]; // fresh main.js graph each boot
  }
  const events = [];
  const handlers = new Map();
  const updaterEvents = [];
  let quits = 0;
  const fakeApp = {
    requestSingleInstanceLock: () => lockGranted,
    quit: () => quits++,
    on: (event, cb) => {
      events.push(event);
      handlers.set(event, cb);
    },
    whenReady: () => new Promise(() => {}), // never resolves: startApp stays parked
    getVersion: () => "0.0.0-test",
    getPath: () => os.tmpdir(),
    getAppPath: () => path.join(__dirname, ".."),
    setAppUserModelId: () => {},
    isReady: () => false,
  };
  class FakeBrowserWindow {
    static getAllWindows() {
      return [];
    }
    on() {}
  }
  // A functional-enough tray surface so the booted module's own controller can
  // be driven end-to-end (setEnabled(true) -> an icon really "exists").
  class FakeTray {
    constructor() {
      this.destroyed = false;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
    setToolTip() {}
    setContextMenu() {}
    on() {}
  }
  const fakeElectron = {
    app: fakeApp,
    BrowserWindow: FakeBrowserWindow,
    Menu: { buildFromTemplate: (template) => template },
    Tray: FakeTray,
    autoUpdater: { on: (event) => updaterEvents.push(event) },
    nativeTheme: { on() {} },
    powerMonitor: { on() {} },
    ipcMain: { handle() {}, on() {} },
    session: {},
    shell: {},
    clipboard: {},
    Notification: class {},
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize: () => ({}) }) },
  };
  require.cache[elPath] = { id: elPath, filename: elPath, loaded: true, exports: fakeElectron };
  require(mainJs);
  return {
    events,
    handlers,
    updaterEvents,
    get quits() {
      return quits;
    },
    cleanup() {
      // Restore the cache to its pre-boot shape so later tests see a clean graph.
      for (const k of Object.keys(require.cache)) {
        if (!bootBaseline.has(k)) delete require.cache[k];
      }
      delete require.cache[elPath];
    },
  };
};

test("main.js wiring: lost lock -> quits, registers no ready/window handlers", () => {
  const r = bootCompiledMain(false);
  try {
    assert.strictEqual(r.quits, 1, "the non-primary instance quits exactly once");
    assert.ok(
      !r.events.includes("second-instance"),
      "a non-primary instance must not register a second-instance handler",
    );
    assert.ok(
      !r.events.includes("window-all-closed"),
      "a non-primary instance must not register window-all-closed",
    );
    assert.ok(
      !r.events.includes("before-quit"),
      "a non-primary instance must not register before-quit",
    );
    assert.ok(
      !r.updaterEvents.includes("before-quit-for-update"),
      "a non-primary instance must not register the updater quit latch",
    );
  } finally {
    r.cleanup();
  }
});

test("main.js wiring: won lock -> no quit, registers second-instance + window-all-closed", () => {
  const r = bootCompiledMain(true);
  try {
    assert.strictEqual(r.quits, 0, "the primary instance does not quit");
    assert.ok(r.events.includes("second-instance"), "the primary registers a second-instance handler");
    assert.ok(r.events.includes("window-all-closed"), "the primary registers window-all-closed");
    // before-quit is what releases the close-to-tray hold on the window; without
    // it a tray-mode app can be hidden but never quit.
    assert.ok(r.events.includes("before-quit"), "the primary registers before-quit");
    // macOS quitAndInstall closes windows BEFORE before-quit; the tray latch
    // must therefore also come from the native updater's signal, or a pending
    // update deadlocks against close-to-tray forever.
    assert.ok(
      r.updaterEvents.includes("before-quit-for-update"),
      "the primary latches quitting on the updater's before-quit-for-update",
    );
    const secondInstance = r.handlers.get("second-instance");
    assert.strictEqual(
      typeof secondInstance,
      "function",
      "the registered second-instance handler is callable",
    );
    // Exercise the wired handler: no window yet (startApp never ran), so it must
    // take the deferred path without throwing rather than focusing nothing.
    assert.doesNotThrow(() => secondInstance(), "the wired handler runs cleanly with no window");
  } finally {
    r.cleanup();
  }
});

// --- tray controller, verified against a mocked Electron --------------------
// `tray.ts` is Electron-only, so it is exercised by requiring the COMPILED
// module with a fake `electron` in the module cache. The controller owns both
// the icon and the close/quit decision, so these tests cover the actual
// production code path for the riskiest part of the feature: what a window
// `close` does in each of its three states.
{
  const trayJs = path.join(__dirname, "../dist/main/main/tray.js");
  const elPath = require.resolve("electron", { paths: [path.dirname(trayJs)] });
  const preloaded = new Set(Object.keys(require.cache));

  // One fake electron per scenario; the controller keeps its state per instance,
  // so a single module load serves every test.
  const trays = [];
  let iconEmpty = false;
  let trayThrows = false;

  class FakeTray {
    constructor(icon) {
      if (trayThrows) throw new Error("tray unavailable");
      this.icon = icon;
      this.destroyed = false;
      this.handlers = [];
      this.menu = null;
      trays.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
    setToolTip() {}
    setContextMenu(menu) {
      this.menu = menu;
    }
    on(event, cb) {
      this.handlers.push([event, cb]);
    }
  }

  for (const k of Object.keys(require.cache)) {
    if (!preloaded.has(k)) delete require.cache[k];
  }
  require.cache[elPath] = {
    id: elPath,
    filename: elPath,
    loaded: true,
    exports: {
      app: { getAppPath: () => path.join(__dirname, "..") },
      Menu: { buildFromTemplate: (template) => template },
      nativeImage: {
        createFromPath: () => ({ isEmpty: () => iconEmpty, resize: (size) => ({ size }) }),
      },
      Tray: FakeTray,
    },
  };
  const { createTrayController } = require(trayJs);

  // The failure paths log through console.error; keep the test output clean.
  const quiet = (fn) => {
    const original = console.error;
    const lines = [];
    console.error = (...args) => lines.push(args.join(" "));
    try {
      return { result: fn(), lines };
    } finally {
      console.error = original;
    }
  };

  // A controller plus the calls it made, for one scenario.
  const setup = () => {
    trays.length = 0;
    iconEmpty = false;
    trayThrows = false;
    const calls = { open: 0, quit: 0, hide: 0 };
    const controller = createTrayController({
      open: () => calls.open++,
      quit: () => calls.quit++,
      hide: () => calls.hide++,
    });
    return { controller, calls };
  };

  // A window `close` event, recording whether the close was intercepted.
  const closeEvent = () => {
    const event = { prevented: false, preventDefault: () => (event.prevented = true) };
    return event;
  };

  test("tray controller: enabling creates exactly one icon, idempotently", () => {
    const { controller } = setup();
    assert.strictEqual(controller.setEnabled(true), true);
    assert.strictEqual(controller.hidesToTray(), true);
    assert.strictEqual(trays.length, 1, "exactly one Tray is constructed");
    assert.strictEqual(controller.setEnabled(true), true, "a second call is a no-op");
    assert.strictEqual(trays.length, 1);
  });

  test("tray controller: disabling removes the icon; re-enabling builds a new one", () => {
    const { controller } = setup();
    controller.setEnabled(true);
    assert.strictEqual(controller.setEnabled(false), false);
    assert.strictEqual(controller.hidesToTray(), false);
    assert.strictEqual(trays[0].destroyed, true);
    assert.strictEqual(controller.setEnabled(true), true);
    assert.strictEqual(trays.length, 2, "the preference can be toggled back on");
  });

  // `ensureTray` reads `process.platform` at icon-creation time, so a per-test
  // override is enough to exercise both branches of the click wiring from macOS.
  const onPlatform = (value, fn) => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  };

  test("tray controller: the menu opens and quits", () => {
    const { controller, calls } = setup();
    controller.setEnabled(true);
    const [tray] = trays;
    const labels = tray.menu.map((item) => item.label ?? item.type);
    assert.deepStrictEqual(labels, ["Open PR Dashboard", "separator", "Quit PR Dashboard"]);
    tray.menu[0].click();
    tray.menu[2].click();
    assert.strictEqual(calls.open, 1);
    assert.strictEqual(calls.quit, 1);
  });

  test("tray controller: Windows/Linux -> both click gestures reopen the dashboard", () => {
    const { controller, calls } = onPlatform("win32", () => {
      const s = setup();
      s.controller.setEnabled(true);
      return s;
    });
    const [tray] = trays;
    assert.deepStrictEqual(
      tray.handlers.map(([event]) => event),
      ["click", "double-click"],
    );
    for (const [, cb] of tray.handlers) cb();
    assert.strictEqual(calls.open, 2);
    assert.strictEqual(controller.hidesToTray(), true);
  });

  // macOS emits `click` even while it is opening the context menu, so a wired
  // click handler reopened the window on any click on the menu bar icon —
  // without the user ever choosing "Open PR Dashboard".
  test("tray controller: macOS -> no click handler, only the menu opens the window", () => {
    const { controller, calls } = onPlatform("darwin", () => {
      const s = setup();
      s.controller.setEnabled(true);
      return s;
    });
    const [tray] = trays;
    assert.deepStrictEqual(tray.handlers, [], "no click gesture may reopen the window on macOS");
    assert.strictEqual(calls.open, 0);
    // The menu being the only way in is only safe while close really hides: an
    // icon that exists but stops hiding to tray would leave nothing to restore.
    assert.strictEqual(controller.hidesToTray(), true);
    const event = closeEvent();
    controller.handleClose(event);
    assert.strictEqual(event.prevented, true);
    assert.strictEqual(calls.hide, 1);
    tray.menu[0].click();
    assert.strictEqual(calls.open, 1, "the menu item is the only way in");
  });

  // The three branches of the close decision — the invariant a refactor is most
  // likely to break, and the reason the decision lives in a testable controller
  // rather than inline in the window handler.
  test("close: tray present and not quitting -> hidden, not destroyed", () => {
    const { controller, calls } = setup();
    controller.setEnabled(true);
    const event = closeEvent();
    controller.handleClose(event);
    assert.strictEqual(event.prevented, true, "the close must be intercepted");
    assert.strictEqual(calls.hide, 1, "the window is hidden instead");
  });

  test("close: quitting -> the close proceeds untouched", () => {
    const { controller, calls } = setup();
    controller.setEnabled(true);
    controller.markQuitting();
    const event = closeEvent();
    controller.handleClose(event);
    assert.strictEqual(event.prevented, false, "a real quit must not be intercepted");
    assert.strictEqual(calls.hide, 0);
  });

  test("close: no tray (preference off) -> the close proceeds even when not quitting", () => {
    const { controller, calls } = setup();
    controller.setEnabled(false);
    const event = closeEvent();
    controller.handleClose(event);
    assert.strictEqual(event.prevented, false);
    assert.strictEqual(calls.hide, 0);
  });

  test("close: a cancelled quit restores hiding (the latch is not one-way)", () => {
    const { controller, calls } = setup();
    controller.setEnabled(true);
    controller.markQuitting();
    controller.cancelQuitting();
    const event = closeEvent();
    controller.handleClose(event);
    assert.strictEqual(event.prevented, true, "close hides again once the quit is cancelled");
    assert.strictEqual(calls.hide, 1);
  });

  test("tray controller: no usable icon -> close keeps quitting, loudly", () => {
    const { controller, calls } = setup();
    iconEmpty = true;
    const { result, lines } = quiet(() => controller.setEnabled(true));
    assert.strictEqual(result, false, "the preference cannot be honored");
    assert.strictEqual(controller.hidesToTray(), false);
    assert.strictEqual(trays.length, 0, "an empty icon must not reach the Tray constructor");
    assert.ok(
      lines.some((l) => l.includes("close button will keep quitting")),
      "the divergence from the saved preference must not be silent",
    );
    // The decisive part: with no icon, a close must still destroy the window.
    const event = closeEvent();
    controller.handleClose(event);
    assert.strictEqual(event.prevented, false, "no tray icon must never trap the window");
    assert.strictEqual(calls.hide, 0);
  });

  test("tray controller: a throwing Tray constructor is reported, not propagated", () => {
    const { controller } = setup();
    trayThrows = true;
    const { result } = quiet(() => controller.setEnabled(true));
    assert.strictEqual(result, false);
    assert.strictEqual(controller.hidesToTray(), false);
  });

  for (const k of Object.keys(require.cache)) {
    if (!preloaded.has(k)) delete require.cache[k];
  }
  delete require.cache[elPath];
}

// --- application menu, verified against a mocked Electron -------------------
// `menu.ts` is Electron-only, so it is exercised by requiring the COMPILED
// module with a fake `electron` in the module cache. What matters here is not
// cosmetic: `Menu.setApplicationMenu` REPLACES Electron's default menu, so the
// template has to keep carrying the edit/window roles (Cmd+C/V/A in the search
// and token fields, Cmd+Q/H/W) alongside the two shortcuts this app adds.
{
  const menuJs = path.join(__dirname, "../dist/main/main/menu.js");
  const elPath = require.resolve("electron", { paths: [path.dirname(menuJs)] });
  const preloaded = new Set(Object.keys(require.cache));

  for (const k of Object.keys(require.cache)) {
    if (!preloaded.has(k)) delete require.cache[k];
  }
  let installed = null;
  require.cache[elPath] = {
    id: elPath,
    filename: elPath,
    loaded: true,
    exports: {
      app: { name: "PR Dashboard", isPackaged: true },
      Menu: {
        buildFromTemplate: (template) => ({ template }),
        setApplicationMenu: (menu) => {
          installed = menu;
        },
      },
    },
  };
  const { buildAppMenuTemplate, createMenuActions, installAppMenu } = require(menuJs);

  // Every item in the template, flattened across submenus.
  const flatten = (template) =>
    template.flatMap((item) => [
      item,
      ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
    ]);
  // Roles bring accelerators of their own, which no `accelerator` field shows,
  // and Electron's own role defaults differ per platform (`togglefullscreen` is
  // Ctrl+Cmd+F on macOS but F11 elsewhere; `toggleDevTools` is Alt+Cmd+I vs
  // Ctrl+Shift+I). Hand-maintained against Electron's documented role-accelerator
  // defaults — extend both platform tables, and the coverage assertion below,
  // before adding a role to the template. Roles with no default accelerator
  // (`about`, `services`, `unhide`, `zoom`, `front`) get an explicit `[]` so an
  // unlisted role fails loudly instead of silently contributing nothing.
  const ROLE_ACCELERATORS = {
    darwin: {
      about: [],
      services: [],
      hide: ["CmdOrCtrl+H"],
      hideOthers: ["CmdOrCtrl+Alt+H"],
      unhide: [],
      quit: ["CmdOrCtrl+Q"],
      editMenu: [
        "CmdOrCtrl+Z",
        "CmdOrCtrl+Shift+Z",
        "CmdOrCtrl+X",
        "CmdOrCtrl+C",
        "CmdOrCtrl+V",
        "CmdOrCtrl+A",
      ],
      resetZoom: ["CmdOrCtrl+0"],
      zoomIn: ["CmdOrCtrl+Plus"],
      zoomOut: ["CmdOrCtrl+-"],
      togglefullscreen: ["Ctrl+CmdOrCtrl+F"],
      forceReload: ["CmdOrCtrl+Shift+R"],
      toggleDevTools: ["Alt+CmdOrCtrl+I"],
      minimize: ["CmdOrCtrl+M"],
      zoom: [],
      close: ["CmdOrCtrl+W"],
      front: [],
    },
    other: {
      quit: ["CmdOrCtrl+Q"],
      editMenu: ["CmdOrCtrl+Z", "CmdOrCtrl+Y", "CmdOrCtrl+X", "CmdOrCtrl+C", "CmdOrCtrl+V", "CmdOrCtrl+A"],
      resetZoom: ["CmdOrCtrl+0"],
      zoomIn: ["CmdOrCtrl+Plus"],
      zoomOut: ["CmdOrCtrl+-"],
      togglefullscreen: ["F11"],
      forceReload: ["CmdOrCtrl+Shift+R"],
      toggleDevTools: ["Ctrl+Shift+I"],
      windowMenu: ["CmdOrCtrl+M"],
    },
  };

  // Order-insensitive, case-insensitive: Electron treats "Shift+CmdOrCtrl+R" and
  // "CmdOrCtrl+Shift+R" as the same combination, so a plain string comparison
  // would miss that collision.
  const normalizeAccelerator = (accelerator) =>
    accelerator
      .split("+")
      .map((part) => part.trim().toLowerCase())
      .sort()
      .join("+");

  // Every distinct role the template actually uses must have an entry in the
  // table above (possibly `[]`) — an omission is a gap in the check, not an
  // absence of accelerators, and must fail loudly rather than pass silently.
  const assertRoleTableCovers = (template, platformKey) => {
    const table = ROLE_ACCELERATORS[platformKey];
    for (const role of new Set(flatten(template).map((item) => item.role).filter(Boolean))) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(table, role),
        `ROLE_ACCELERATORS.${platformKey} has no entry for role "${role}" — add one (even []) before trusting the uniqueness checks`,
      );
    }
  };

  /** Every accelerator the menu claims — explicit fields plus role-supplied. */
  const claimedAccelerators = (template, platformKey) => {
    const table = ROLE_ACCELERATORS[platformKey];
    assertRoleTableCovers(template, platformKey);
    return flatten(template).flatMap((item) => [
      ...(item.accelerator ? [item.accelerator] : []),
      ...(item.role && table[item.role] ? table[item.role] : []),
    ]);
  };
  const byAccelerator = (template, accelerator, platformKey = "darwin") => {
    const target = normalizeAccelerator(accelerator);
    return claimedAccelerators(template, platformKey).filter(
      (claimed) => normalizeAccelerator(claimed) === target,
    );
  };

  const deps = () => {
    const calls = { openSettings: 0, refresh: 0 };
    return {
      calls,
      deps: {
        openSettings: () => calls.openSettings++,
        refresh: () => calls.refresh++,
      },
    };
  };

  test("app menu: Settings sits in the macOS app menu on CmdOrCtrl+,", () => {
    const { deps: d, calls } = deps();
    const template = buildAppMenuTemplate(d, { platform: "darwin" });
    // macOS convention: Preferences lives in the application menu, not File.
    const appSubmenu = template[0].submenu;
    const settings = appSubmenu.find((item) => item.accelerator === "CmdOrCtrl+,");
    assert.ok(settings, "the app menu carries the Settings item");
    assert.match(settings.label, /^Settings/);
    assert.strictEqual(byAccelerator(template, "CmdOrCtrl+,").length, 1, "exactly one owner of the accelerator");
    assert.strictEqual(byAccelerator(template, "F5").length, 0, "F5 must stay unclaimed — it is the renderer's own shortcut");
    settings.click();
    assert.strictEqual(calls.openSettings, 1, "the item forwards to openSettings");
  });

  test("app menu: Refresh sits in View on CmdOrCtrl+R, and nothing else claims it", () => {
    const { deps: d, calls } = deps();
    const template = buildAppMenuTemplate(d, { platform: "darwin", devItems: true });
    const view = template.find((item) => item.label === "View");
    assert.ok(view, "a View menu exists");
    const refresh = view.submenu.find((item) => item.label === "Refresh");
    assert.strictEqual(refresh.accelerator, "CmdOrCtrl+R");
    // The `reload` role would claim CmdOrCtrl+R too and shadow Refresh; only
    // forceReload may sit next to the DevTools toggle.
    assert.ok(
      !flatten(template).some((item) => item.role === "reload"),
      "the reload role must not be present — it would shadow Refresh",
    );
    assert.strictEqual(byAccelerator(template, "CmdOrCtrl+R").length, 1, "exactly one owner of the accelerator");
    // F5 is the renderer's own shortcut (App.tsx), not a menu accelerator; a
    // future item or role claiming it here would silently kill F5 refresh.
    assert.strictEqual(byAccelerator(template, "F5").length, 0, "F5 must stay unclaimed by the menu");
    refresh.click();
    assert.strictEqual(calls.refresh, 1, "the item forwards to refresh");
  });

  test("app menu: the replaced default's roles are kept (copy/paste and window keys survive)", () => {
    const template = buildAppMenuTemplate(deps().deps, { platform: "darwin" });
    const roles = flatten(template).map((item) => item.role);
    // `close` is spelled out because the macOS windowMenu role omits it and this
    // app has no File menu there — without it Cmd+W stops working.
    for (const role of ["editMenu", "close", "minimize", "quit", "hide", "about"]) {
      assert.ok(roles.includes(role), `the ${role} role must stay in the template`);
    }
  });

  test("app menu: Windows/Linux put Settings in File, still on CmdOrCtrl+,", () => {
    const template = buildAppMenuTemplate(deps().deps, { platform: "win32" });
    assert.strictEqual(template[0].label, "File");
    // There the windowMenu role already carries Close, so it stays a role.
    assert.ok(flatten(template).some((item) => item.role === "windowMenu"));
    const settings = template[0].submenu.find((item) => item.accelerator === "CmdOrCtrl+,");
    assert.ok(settings, "File carries the Settings item");
    // Refresh is platform-independent: CmdOrCtrl resolves to Control here.
    // win32's own role accelerators (windowMenu's CmdOrCtrl+M, etc.) apply here,
    // not the darwin table — hence the explicit platform key.
    assert.strictEqual(byAccelerator(template, "CmdOrCtrl+R", "other").length, 1);
    assert.strictEqual(byAccelerator(template, "F5", "other").length, 0, "F5 must stay unclaimed on Windows/Linux too");
  });

  test("app menu: DevTools items only in a dev run", () => {
    const dev = flatten(buildAppMenuTemplate(deps().deps, { platform: "darwin", devItems: true }));
    const packaged = flatten(buildAppMenuTemplate(deps().deps, { platform: "darwin", devItems: false }));
    assert.ok(dev.some((item) => item.role === "toggleDevTools"), "a dev run keeps the DevTools toggle");
    assert.ok(
      !packaged.some((item) => item.role === "toggleDevTools"),
      "a packaged run must not expose the DevTools toggle",
    );
  });

  test("app menu: both actions surface the window, then forward their channel", () => {
    const order = [];
    const actions = createMenuActions({
      focusWindow: () => order.push("focus"),
      send: (channel) => order.push(channel),
    });
    actions.openSettings();
    // The window comes first: with close-to-tray on, a hidden renderer would
    // otherwise get the event with nothing on screen to show for it.
    assert.deepStrictEqual(order, ["focus", "menu:open-settings"]);
    order.length = 0;
    actions.refresh();
    // Refresh is deliberately symmetric with Settings — pressing it is a request
    // to SEE fresh data, and a hidden refresh spends a GraphQL request for
    // nothing visible.
    assert.deepStrictEqual(order, ["focus", "menu:refresh"]);
  });

  test("app menu: the option defaults are the production call's shape", () => {
    // The real call site passes no platform and omits devItems when packaged,
    // so both fallbacks have to be exercised or a regression in either is
    // invisible.
    const template = buildAppMenuTemplate(deps().deps);
    const items = flatten(template);
    if (process.platform === "darwin") {
      assert.ok(
        !template.some((item) => item.label === "File"),
        "macOS keeps Settings in the app menu, not a File menu",
      );
    } else {
      assert.strictEqual(template[0].label, "File");
    }
    const platformKey = process.platform === "darwin" ? "darwin" : "other";
    assert.strictEqual(byAccelerator(template, "CmdOrCtrl+,", platformKey).length, 1);
    assert.strictEqual(byAccelerator(template, "CmdOrCtrl+R", platformKey).length, 1);
    assert.strictEqual(byAccelerator(template, "F5", platformKey).length, 0, "F5 must stay unclaimed");
    assert.ok(
      !items.some((item) => item.role === "toggleDevTools" || item.role === "forceReload"),
      "an omitted devItems must mean no developer items",
    );
  });

  test("app menu: installAppMenu actually installs a built menu", () => {
    installed = null;
    installAppMenu(deps().deps, { platform: "darwin" });
    assert.ok(installed && Array.isArray(installed.template), "setApplicationMenu got a built menu");
  });

  for (const k of Object.keys(require.cache)) {
    if (!preloaded.has(k)) delete require.cache[k];
  }
  delete require.cache[elPath];
}

// --- hotkey wiring: menu -> IPC -> renderer --------------------------------
// The accelerators are useless unless the two channels line up on both sides of
// the bridge, and neither end can prove that alone. The compiled main.js must
// SEND on exactly the channels the compiled preload.js LISTENS on.
test("hotkey wiring: main sends the menu channels preload subscribes to", () => {
  const fs = require("node:fs");
  const mainJs = fs.readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
  const menuJs = fs.readFileSync(path.join(__dirname, "../dist/main/main/menu.js"), "utf8");
  const preloadJs = fs.readFileSync(path.join(__dirname, "../dist/main/main/preload.js"), "utf8");
  assert.match(mainJs, /installAppMenu/, "main installs the application menu");
  assert.match(mainJs, /createMenuActions/, "main builds the actions through the tested factory");
  for (const channel of ["menu:open-settings", "menu:refresh"]) {
    assert.ok(menuJs.includes(channel), `menu.js sends on ${channel}`);
    assert.ok(preloadJs.includes(channel), `preload.js subscribes to ${channel}`);
  }
});

// --- the F5 refresh decision ------------------------------------------------
// F5 is the ONLY shortcut the renderer decides for itself, so the decision is a
// pure predicate rather than a branch buried in an event handler: these cases
// are what actually holds criterion 3, where a source-text guard cannot.
{
  const hotkeys = require(path.join(__dirname, "../dist/main/shared/hotkeys.js"));
  const press = (over = {}) => ({
    key: "F5",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...over,
  });

  test("shouldRefreshOnKey: bare F5 refreshes", () => {
    assert.strictEqual(hotkeys.shouldRefreshOnKey(press()), true);
  });

  test("shouldRefreshOnKey: any modifier leaves the combination alone", () => {
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) {
      assert.strictEqual(
        hotkeys.shouldRefreshOnKey(press({ [modifier]: true })),
        false,
        `F5 with ${modifier} must not refresh`,
      );
    }
  });

  test("shouldRefreshOnKey: auto-repeat does not chain forced polls", () => {
    // Holding the key down otherwise queues one forced poll after another: the
    // renderer's in-flight guard only drops presses that land DURING a poll,
    // and every poll spends from an hourly GraphQL budget shared with every
    // other client on the same token.
    assert.strictEqual(hotkeys.shouldRefreshOnKey(press({ repeat: true })), false);
  });

  test("shouldRefreshOnKey: other keys are not refresh", () => {
    for (const key of ["F4", "F6", "r", "R", "Enter", "F50", ""]) {
      assert.strictEqual(
        hotkeys.shouldRefreshOnKey(press({ key })),
        false,
        `${JSON.stringify(key)} must not refresh`,
      );
    }
  });

  // --- the forced-refresh cooldown -------------------------------------------
  // Shared by the header button, CmdOrCtrl+R and F5 — App.tsx's `refresh()`
  // calls this before every one of them. `shouldRefreshOnKey` alone only
  // screens an auto-repeated F5; a burst of distinct presses (double-tapping
  // the button, or holding CmdOrCtrl+R, which carries no `repeat` flag) still
  // needs this second gate or it chains forced polls against a shared hourly
  // GraphQL budget.
  test("shouldAllowForcedRefresh: refreshes once the cooldown has fully elapsed", () => {
    assert.strictEqual(hotkeys.shouldAllowForcedRefresh(3000, 0, 3000), true);
    assert.strictEqual(hotkeys.shouldAllowForcedRefresh(10_000, 5000, 3000), true);
  });

  test("shouldAllowForcedRefresh: a press inside the cooldown window is dropped", () => {
    assert.strictEqual(hotkeys.shouldAllowForcedRefresh(1000, 0, 3000), false);
    assert.strictEqual(hotkeys.shouldAllowForcedRefresh(2999, 0, 3000), false);
  });

  test("shouldAllowForcedRefresh: the very first refresh is never blocked", () => {
    // lastForcedAt starts at 0 in App.tsx; a launch-time refresh at any
    // realistic wall-clock `now` must not be mistaken for a repeat.
    assert.strictEqual(hotkeys.shouldAllowForcedRefresh(Date.now(), 0, 3000), true);
  });
}

// F5 is the second Refresh shortcut and is NOT a menu accelerator (one item
// carries one accelerator), so it only works if the renderer keeps handling the
// key itself. This guard fails if that listener is dropped in a refactor.
test("hotkey wiring: the renderer still handles F5 itself", () => {
  const raw = require("node:fs").readFileSync(
    path.join(__dirname, "../src/renderer/src/App.tsx"),
    "utf8",
  );
  // Comments blanked (offsets preserved) so a disabled/commented-out handler
  // cannot satisfy the check the way a bare identifier match would — mirrors
  // the renderer animation guard above, which exists for the same reason.
  const src = raw
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  assert.match(
    src,
    /addEventListener\("keydown",\s*onKeyDown\)/,
    "App.tsx registers the F5 keydown listener",
  );
  assert.match(
    src,
    /removeEventListener\("keydown",\s*onKeyDown\)/,
    "the F5 listener must be cleaned up on unmount/re-run, or repeated menu opens stack duplicate listeners",
  );
  // The handler body itself: decide via the predicate, prevent the browser's
  // own F5 (reload), then actually refresh — a stub that dropped any one of
  // these would pass a bare-identifier check but do the wrong thing.
  const onKeyDown = src.match(/const onKeyDown = \(event: KeyboardEvent\) => \{([\s\S]*?)\};/);
  assert.ok(onKeyDown, "App.tsx defines the onKeyDown handler for F5");
  assert.match(onKeyDown[1], /shouldRefreshOnKey\(event\)/, "the handler defers the F5 decision to the predicate");
  assert.match(onKeyDown[1], /event\.preventDefault\(\)/, "the handler prevents the browser's own F5 reload");
  assert.match(onKeyDown[1], /void refresh\(\)/, "the handler actually calls refresh()");

  assert.match(
    src,
    /onOpenSettings\(\(\) => setView\("settings"\)\)/,
    "App.tsx subscribes to the menu's Settings event and switches the view",
  );
  assert.match(
    src,
    /onRefreshRequest\(\(\) => void refresh\(\)\)/,
    "App.tsx subscribes to the menu's Refresh event and actually refreshes",
  );
});

// --- defaultSettings ---------------------------------------------------------
test("defaultSettings: empty + 60s + toggles", () => {
  const d = cfg.defaultSettings();
  assert.strictEqual(d.pollIntervalSeconds, 60);
  assert.strictEqual(d.launchAtLogin, false);
  assert.strictEqual(d.autoUpdate, true);
  assert.strictEqual(d.closeToTray, true);
  assert.strictEqual(d.theme, "system");
  assert.strictEqual(d.trackComments, true);
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
  // Close-to-tray defaults ON, so a settings.json written before the preference
  // existed still gets tray behaviour instead of silently opting out.
  assert.strictEqual(s.closeToTray, true);
  // Same reason: comment tracking is the original behaviour, so an older
  // settings.json must not read as "ignore comments".
  assert.strictEqual(s.trackComments, true);
});
test("validateSettings: toggles honored when present", () => {
  const s = cfg.validateSettings({
    launchAtLogin: true,
    autoUpdate: false,
    closeToTray: false,
    trackComments: false,
    hosts: [],
  });
  assert.strictEqual(s.launchAtLogin, true);
  assert.strictEqual(s.autoUpdate, false);
  assert.strictEqual(s.closeToTray, false);
  assert.strictEqual(s.trackComments, false);
});
test("validateSettings: a non-boolean closeToTray falls back to the default", () => {
  assert.strictEqual(cfg.validateSettings({ closeToTray: "yes", hosts: [] }).closeToTray, true);
});
test("validateSettings: a non-boolean trackComments falls back to the default", () => {
  assert.strictEqual(cfg.validateSettings({ trackComments: "no", hosts: [] }).trackComments, true);
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
    trackComments: true,
    hosts: [{ label: "GH", graphqlUrl: "https://api.github.com/graphql", repos: ["a/b"] }],
  });
  assert.deepStrictEqual(pub, {
    pollIntervalSeconds: 60,
    hosts: [{ label: "GH", repos: ["a/b"] }],
    trackComments: true,
  });
});
test("toPublicConfig: trackComments is propagated, not assumed", () => {
  // The renderer's whole half of the feature reads this mirror, so asserting only
  // the `true` case would pass for a hardcoded `true` while the chip, the header
  // stat and the filter reset never turned off for anyone.
  const pub = cfg.toPublicConfig({ pollIntervalSeconds: 60, trackComments: false, hosts: [] });
  assert.strictEqual(pub.trackComments, false);
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

// viewerApproved is the narrower half: reviewed AND the verdict was approve.
const changesRequestedByRev = {
  author: { __typename: "User", login: "rev", avatarUrl: "" },
  state: "CHANGES_REQUESTED",
};
test("mapPr.viewerApproved: true when the viewer's latest review approves", () =>
  assert.strictEqual(github.mapPr(rawPr(), "GH", [], "rev").viewerApproved, true));
test("mapPr.viewerApproved: false when the viewer asked for changes instead", () =>
  assert.strictEqual(
    github.mapPr(
      rawPr({ latestOpinionatedReviews: { nodes: [changesRequestedByRev] } }),
      "GH",
      [],
      "rev",
    ).viewerApproved,
    false,
  ));
test("mapPr.viewerApproved: someone else's approval is not yours", () =>
  assert.strictEqual(github.mapPr(rawPr(), "GH", [], "someone-else").viewerApproved, false));
test("mapPr.viewerApproved: false when the viewer is unknown", () =>
  assert.strictEqual(github.mapPr(rawPr(), "GH", [], null).viewerApproved, false));

// --- myReReviewDue: your change request is blocking, and it's your move -----
// The mirror of viewerApproved, and the one attention signal that must survive
// being looked at: the merge stays blocked until you re-review, and GitHub asks
// nobody. Author action is required, so the flag stays false while the ball is
// still with them. See issue #14.
const REVIEWED_AT = "2026-07-07T10:00:00Z";
const myChangeRequest = { ...changesRequestedByRev, submittedAt: REVIEWED_AT };
const myApproval = {
  author: { __typename: "User", login: "rev", avatarUrl: "" },
  state: "APPROVED",
  submittedAt: REVIEWED_AT,
};
const commitAt = (at) => ({
  nodes: [{ commit: { pushedDate: at, committedDate: at, statusCheckRollup: null } }],
});
// `comments(last: 1)` — one node per thread, the most recent comment on it.
const thread = (isResolved, login, createdAt) => ({
  isResolved,
  comments: { totalCount: 1, nodes: [{ author: { login }, createdAt }] },
});
const reReviewDue = (overrides, viewer = "rev") =>
  github.mapPr(
    rawPr({ latestOpinionatedReviews: { nodes: [myChangeRequest] }, ...overrides }),
    "GH",
    [],
    viewer,
  ).myReReviewDue;

test("mapPr.myReReviewDue: a push after your change request puts it back on you", () =>
  assert.strictEqual(reReviewDue({ commits: commitAt("2026-07-07T11:00:00Z") }), true));
test("mapPr.myReReviewDue: the author answering and leaving nothing unresolved counts too", () =>
  assert.strictEqual(
    reReviewDue({ reviewThreads: { nodes: [thread(true, "auth", "2026-07-07T11:30:00Z")] } }),
    true,
  ));
// The discriminating case for that predicate: it must be the PR AUTHOR, not
// merely somebody other than you. A co-reviewer or a bot getting the last word
// says nothing about the author having done the work, and every other fixture
// here uses "auth" — which is also the fixture's author — so without this the
// narrowing is untestable and a future edit could widen it back unnoticed.
test("mapPr.myReReviewDue: a bot or third reviewer replying last is not the author acting", () =>
  assert.strictEqual(
    reReviewDue({ reviewThreads: { nodes: [thread(true, "copilot", "2026-07-07T11:30:00Z")] } }),
    false,
  ));
// The body-only trap: such a review has no threads, so "nothing unresolved" is
// true from the instant you submit it. Without the author-acted requirement the
// card would light up while the ball is still with them.
test("mapPr.myReReviewDue: a change request with no threads and no push stays with the author", () =>
  assert.strictEqual(reReviewDue({}), false));
test("mapPr.myReReviewDue: a push predating your review is not a response to it", () =>
  assert.strictEqual(reReviewDue({ commits: commitAt("2026-07-07T09:00:00Z") }), false));
test("mapPr.myReReviewDue: a reply while another thread is still open is the author's turn", () =>
  assert.strictEqual(
    reReviewDue({
      reviewThreads: {
        nodes: [
          thread(true, "auth", "2026-07-07T11:30:00Z"),
          thread(false, "auth", "2026-07-07T11:31:00Z"),
        ],
      },
    }),
    false,
  ));
// Resolving without answering says nothing about whether the point was handled,
// and nothing else moved — deliberately silent, documented rather than fixed.
test("mapPr.myReReviewDue: threads resolved with your own comment last stays false", () =>
  assert.strictEqual(
    reReviewDue({ reviewThreads: { nodes: [thread(true, "rev", "2026-07-07T09:30:00Z")] } }),
    false,
  ));
// `.some()`, not `.every()`: a thread you answered last must not mask the
// author's replies on the others.
test("mapPr.myReReviewDue: your own last word on one thread doesn't hide the author's on another", () =>
  assert.strictEqual(
    reReviewDue({
      reviewThreads: {
        nodes: [
          thread(true, "rev", "2026-07-07T09:30:00Z"),
          thread(true, "auth", "2026-07-07T11:30:00Z"),
        ],
      },
    }),
    true,
  ));
test("mapPr.myReReviewDue: false once you approve on the re-review", () =>
  assert.strictEqual(
    reReviewDue({
      latestOpinionatedReviews: { nodes: [myApproval] },
      commits: commitAt("2026-07-07T11:00:00Z"),
    }),
    false,
  ));
test("mapPr.myReReviewDue: someone else's change request is not yours to clear", () =>
  assert.strictEqual(
    reReviewDue({ commits: commitAt("2026-07-07T11:00:00Z") }, "someone-else"),
    false,
  ));
test("mapPr.myReReviewDue: false when the viewer is unknown", () =>
  assert.strictEqual(reReviewDue({ commits: commitAt("2026-07-07T11:00:00Z") }, null), false));
// A review whose submittedAt is absent gives nothing to compare the push
// against; false rather than a guess.
test("mapPr.myReReviewDue: false when your review carries no timestamp", () =>
  assert.strictEqual(
    reReviewDue({
      latestOpinionatedReviews: { nodes: [changesRequestedByRev] },
      commits: commitAt("2026-07-07T11:00:00Z"),
    }),
    false,
  ));
// A plain "Comment" review never lands in latestOpinionatedReviews, so it can't
// replace your change request — which is right: the merge is still blocked. At
// the mapPr level such a re-review is therefore only two things: your change
// request still standing, plus your own later comments on the threads. That is
// exactly this fixture, so it also pins that your own later word doesn't clear
// the signal. Non-obvious enough to pin, so nobody "fixes" it into clearing it.
test("mapPr.myReReviewDue: a comment-only re-review does NOT clear it, own later comments included", () =>
  assert.strictEqual(
    reReviewDue({
      commits: commitAt("2026-07-07T11:00:00Z"),
      reviewThreads: { nodes: [thread(false, "rev", "2026-07-07T12:00:00Z")] },
    }),
    true,
  ));
// The other direction of the same timestamp comparison: a change request you
// submitted AFTER the last push starts the clock over — nothing has answered it
// yet, so the ball is with the author again.
test("mapPr.myReReviewDue: a fresh change request clears it", () =>
  assert.strictEqual(
    reReviewDue({
      latestOpinionatedReviews: {
        nodes: [{ ...changesRequestedByRev, submittedAt: "2026-07-07T12:00:00Z" }],
      },
      commits: commitAt("2026-07-07T11:00:00Z"),
      reviewThreads: { nodes: [thread(false, "auth", "2026-07-07T11:30:00Z")] },
    }),
    false,
  ));
// --- issue-key: the card's Jira link -------------------------------------
// Returns null wherever a link can't be built, because the badge IS the link:
// the card renders nothing rather than a dead one.
test("jiraBrowseUrl: builds <site>/browse/<KEY>", () =>
  assert.strictEqual(
    issueKey.jiraBrowseUrl("https://org.atlassian.net", "ENG-93374"),
    "https://org.atlassian.net/browse/ENG-93374",
  ));
test("jiraBrowseUrl: tolerates a hand-edited trailing slash", () =>
  assert.strictEqual(
    issueKey.jiraBrowseUrl("https://org.atlassian.net/", "ENG-1"),
    "https://org.atlassian.net/browse/ENG-1",
  ));
test("jiraBrowseUrl: null when Jira isn't configured", () => {
  assert.strictEqual(issueKey.jiraBrowseUrl(null, "ENG-1"), null);
  assert.strictEqual(issueKey.jiraBrowseUrl(undefined, "ENG-1"), null);
  assert.strictEqual(issueKey.jiraBrowseUrl("", "ENG-1"), null);
});
test("jiraBrowseUrl: null when the PR has no issue key", () =>
  assert.strictEqual(issueKey.jiraBrowseUrl("https://org.atlassian.net", null), null));

// The site is validated like the key: a value that isn't an absolute http(s) URL
// would build a string that LOOKS like a link and then die in
// validateExternalUrl with nothing shown to the user. Normalization upstream
// (`validateJira` in config.ts) keeps the app from reaching here with one, but
// this is an exported pure function and shouldn't lean on its caller.
for (const bad of [
  "example.atlassian.net", // schemeless — what a hand-edited settings.json can hold
  "//example.atlassian.net",
  "javascript:alert(1)",
  "ftp://example.atlassian.net",
  "not a url",
]) {
  test(`jiraBrowseUrl: null for a site that isn't an http(s) URL (${bad})`, () =>
    assert.strictEqual(issueKey.jiraBrowseUrl(bad, "ENG-1"), null));
}
test("jiraBrowseUrl: keeps a path — a self-hosted Jira can live under one", () =>
  assert.strictEqual(
    issueKey.jiraBrowseUrl("https://host/jira", "ENG-1"),
    "https://host/jira/browse/ENG-1",
  ));
test("jiraBrowseUrl: a padded site is tidied, not passed through", () =>
  // `new URL` ignores surrounding whitespace, so validating the raw value while
  // building from it would emit "  https://site  /browse/ENG-1" — a string that
  // then throws in validateExternalUrl and drops the click without a word.
  assert.strictEqual(
    issueKey.jiraBrowseUrl("  https://org.atlassian.net/  ", "ENG-1"),
    "https://org.atlassian.net/browse/ENG-1",
  ));
test("jiraBrowseUrl: whitespace alone is not a site", () =>
  assert.strictEqual(issueKey.jiraBrowseUrl("   ", "ENG-1"), null));
test("jiraBrowseUrl accepts every key parseIssueKey produces (one shared shape)", () => {
  // Both sides are built from ISSUE_KEY_PATTERN. Were they to diverge again,
  // a key would still parse and the badge would just silently stop rendering —
  // nothing else in the suite would notice.
  for (const title of ["ENG-93374 sync schemas", "Fix A1-9: the thing", "PRJ2-100 x"]) {
    const key = github.mapPr(rawPr({ title }), "GH", [], null).issueKey;
    assert.ok(key, `expected a key to be parsed from "${title}"`);
    assert.strictEqual(
      issueKey.jiraBrowseUrl("https://org.atlassian.net", key),
      `https://org.atlassian.net/browse/${key}`,
    );
  }
});
// The badge carries the key, so the title shouldn't repeat it — but only where
// cutting it is safe and leaves a readable title.
for (const [title, key, expected] of [
  ["ENG-1 Fix the thing", "ENG-1", "Fix the thing"],
  ["ENG-1: Fix the thing", "ENG-1", "Fix the thing"],
  ["ENG-1 - Fix the thing", "ENG-1", "Fix the thing"],
  ["ENG-1 — Fix the thing", "ENG-1", "Fix the thing"],
  // Mid-title: cutting anything would mangle the sentence.
  ["Fix ENG-1: the thing", "ENG-1", "Fix ENG-1: the thing"],
  // Parsed from the branch, absent from the title.
  ["Datasource column selector", "ENG-1", "Datasource column selector"],
  // Nothing would be left to read.
  ["ENG-1", "ENG-1", "ENG-1"],
  ["ENG-1:", "ENG-1", "ENG-1:"],
  // A different key that merely shares a prefix must not be cut.
  ["ENG-12 Fix", "ENG-1", "ENG-12 Fix"],
  ["No key here", null, "No key here"],
]) {
  test(`stripLeadingIssueKey(${JSON.stringify(title)}, ${key}) -> ${JSON.stringify(expected)}`, () =>
    assert.strictEqual(issueKey.stripLeadingIssueKey(title, key), expected));
}

test("jiraBrowseUrl: rejects a key that isn't the shape github.ts parses", () => {
  // Defence in depth: today's parser can't emit these, but a key that escapes
  // the /browse/ path must never become a link.
  assert.strictEqual(issueKey.jiraBrowseUrl("https://org.atlassian.net", "../../admin"), null);
  assert.strictEqual(issueKey.jiraBrowseUrl("https://org.atlassian.net", "ENG-1/../x"), null);
  assert.strictEqual(issueKey.jiraBrowseUrl("https://org.atlassian.net", "eng-1"), null);
});

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
// jiraSiteState — the settings half of getJiraStatus, split out of the
// Electron-bound jira-store so its fail-closed branch is reachable from here.
// The renderer reads a null site as "render no issue-key link", so a broken
// settings file must degrade to no link rather than a broken one.
test("jiraSiteState: carries the configured site through", () =>
  assert.deepStrictEqual(
    jiraHealth.jiraSiteState(() => ({ jira: { baseUrl: "https://org.atlassian.net", email: "me@x.com" } })),
    { hasConfig: true, baseUrl: "https://org.atlassian.net" },
  ));
test("jiraSiteState: no jira block -> no config, no site", () =>
  assert.deepStrictEqual(jiraHealth.jiraSiteState(() => ({})), {
    hasConfig: false,
    baseUrl: null,
  }));
test("jiraSiteState: half-filled config still yields its site, but hasConfig is false", () =>
  // Pins the pure contract, not a reachable state: `validateJira` drops a jira
  // block missing either half, so settings can't hold this. The two fields
  // answer different questions — hasJiraConfig needs both, a link needs only
  // the site — and that must stay true if validation ever loosens.
  assert.deepStrictEqual(
    jiraHealth.jiraSiteState(() => ({ jira: { baseUrl: "https://org.atlassian.net" } })),
    { hasConfig: false, baseUrl: "https://org.atlassian.net" },
  ));
test("jiraSiteState: a throwing loadSettings fails closed instead of propagating", () =>
  assert.deepStrictEqual(
    jiraHealth.jiraSiteState(() => {
      throw new Error("settings.json: JSON parse error");
    }),
    { hasConfig: false, baseUrl: null },
  ));

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
  viewerApproved: false,
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
  hideApproved: false,
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

// --- pr-filter: the exclude chip (Hide my approvals) -------------------------
// The one chip that REMOVES rows. A re-request outranks your approval: the PR is
// waiting on you again, and a filter that silently swallowed live work would be
// worse than no filter at all.
for (const [label, fixture, expected] of [
  ["approved, nothing pending", mkPr({ viewerApproved: true, roles: ["reviewed"] }), true],
  ["approved but re-requested", mkPr({ viewerApproved: true, roles: ["reviewer", "reviewed"] }), false],
  ["reviewed without approving", mkPr({ viewerApproved: false, roles: ["reviewed"] }), false],
  ["my own PR, approved by others", mkPr({ viewerApproved: false, roles: ["author"] }), false],
]) {
  test(`isFinishedApproval: ${label} -> ${expected}`, () =>
    assert.strictEqual(prFilter.isFinishedApproval(fixture), expected));
}

const APPROVALS = [
  mkPr({ viewerApproved: true, roles: ["reviewed"], title: "approved and quiet" }),
  mkPr({ viewerApproved: true, roles: ["reviewer", "reviewed"], title: "approved then re-requested" }),
  mkPr({ viewerApproved: true, roles: ["reviewed"], isDraft: true, title: "approved draft" }),
  mkPr({ roles: ["reviewer"], needsAttention: true, title: "still waiting on me" }),
  mkPr({ roles: ["author"], hasNewActivity: true, title: "mine" }),
];
test("filterPrs(hideApproved): drops finished approvals, keeps the re-requested one", () =>
  assert.deepStrictEqual(
    prFilter.filterPrs(APPROVALS, st({ hideApproved: true })).map((pr) => pr.title),
    ["approved then re-requested", "still waiting on me", "mine"],
  ));
test("filterPrs(hideApproved): off by default — nothing disappears unasked", () =>
  // Four of five: the approved draft is hidden by the draft gate, not by this chip.
  assert.strictEqual(prFilter.filterPrs(APPROVALS, st()).length, 4));
test("activeFilterCount: hideApproved counts, so Clear filters brings the rows back", () => {
  assert.strictEqual(prFilter.activeFilterCount(st({ hideApproved: true })), 1);
  assert.strictEqual(prFilter.activeFilterCount(st()), 0);
});

// The badge's promise, computed independently of excludeDelta's own expression:
// the delta is exactly the rows that vanish when the chip goes on, and excluding
// never adds one. Reused across FACET_STATES, so host / role / search / narrowing
// / reveal combinations come along for free.
for (const [i, state] of FACET_STATES.entries()) {
  test(`excludeDelta equals the rows the click removes [state ${i}]`, () => {
    const off = prFilter.filterPrs(APPROVALS, { ...state, hideApproved: false });
    const on = prFilter.filterPrs(APPROVALS, { ...state, hideApproved: true });
    const offNumbers = new Set(off.map((pr) => pr.number));
    const onNumbers = new Set(on.map((pr) => pr.number));
    assert.ok(
      on.every((pr) => offNumbers.has(pr.number)),
      "excluding must never add a row that wasn't already shown",
    );
    assert.strictEqual(
      prFilter.excludeDelta(APPROVALS, state),
      off.filter((pr) => !onNumbers.has(pr.number)).length,
    );
  });
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

// --- pr-filter: prSignal under trackComments --------------------------------
// The card-colour promises the README and the `trackComments` docblock make.
// `prSignal` reads `hasNewActivity`, `hasUnaddressedComments` and
// `unresolvedThreads`, all gated by the same flag, so with the setting off
// every comment-shaped signal must stop colouring the card — not just the
// unread one. Fixtures are the fields prSignal reads.
{
  const sigPr = (o = {}) => ({
    roles: ["author"],
    failingChecks: [],
    pendingChecks: [],
    hasUnaddressedChangeRequest: false,
    hasUnaddressedComments: false,
    hasConflicts: false,
    returnedToMe: false,
    awaitingReview: true,
    hasNewActivity: false,
    hasHumanApproval: false,
    reviewDecision: null,
    ciState: "success",
    unresolvedThreads: 0,
    ...o,
  });

  test("prSignal: your own awaiting-review PR with a new comment turns amber while tracking is on", () =>
    assert.strictEqual(
      prFilter.prSignal(sigPr({ hasNewActivity: true }), { trackComments: true }),
      "attention",
    ));
  test("prSignal: with tracking off (no flag set) the same PR keeps the grey waiting accent", () =>
    // What the README promises: nothing is being asked of you until a reviewer
    // actually blocks it, so the card stays quiet instead of turning amber.
    assert.strictEqual(
      prFilter.prSignal(sigPr({ hasNewActivity: false }), { trackComments: false }),
      "waiting",
    ));
  test("prSignal: an unresolved thread still colours the card with tracking on", () =>
    assert.strictEqual(
      prFilter.prSignal(sigPr({ awaitingReview: false, hasNewActivity: false, unresolvedThreads: 2 }), {
        trackComments: true,
      }),
      "attention",
    ));
  test("prSignal: an unresolved thread stops colouring the card with tracking off", () =>
    // The extended promise: the setting mutes every comment-shaped signal, so an
    // open thread no longer paints the card amber while it's off.
    assert.strictEqual(
      prFilter.prSignal(sigPr({ awaitingReview: false, hasNewActivity: false, unresolvedThreads: 2 }), {
        trackComments: false,
      }),
      "idle",
    ));
  test("prSignal: an unaddressed comment stops blocking your own PR with tracking off", () =>
    assert.strictEqual(
      prFilter.prSignal(sigPr({ awaitingReview: false, hasUnaddressedComments: true }), {
        trackComments: false,
      }),
      "idle",
    ));
  test("prSignal: an unaddressed comment still blocks your own PR with tracking on", () =>
    assert.strictEqual(
      prFilter.prSignal(sigPr({ awaitingReview: false, hasUnaddressedComments: true }), {
        trackComments: true,
      }),
      "blocked",
    ));
}

// --- pr-filter: sanitizeFilterState ----------------------------------------
// The persisted-preference guard behind App.tsx's reset effect. With
// `trackComments` off no PR ever has `hasNewActivity`, so a stored
// `newOnly: true` would filter the list down to nothing with its chip no longer
// in the row to switch off.
test("sanitizeFilterState: tracking off clears a stored newOnly", () => {
  const sanitized = prFilter.sanitizeFilterState(st({ newOnly: true }), { trackComments: false });
  assert.strictEqual(sanitized.newOnly, false);
  // Nothing else is touched — it is a reset of one flag, not of the filter row.
  assert.deepStrictEqual(sanitized, { ...st({ newOnly: true }), newOnly: false });
});
test("sanitizeFilterState: nothing to clear returns the same object", () => {
  // Identity is the signal the caller uses to decide whether to set state at all,
  // so returning a fresh copy would re-render on every pass.
  const off = st();
  assert.strictEqual(prFilter.sanitizeFilterState(off, { trackComments: false }), off);
  const on = st({ newOnly: true });
  assert.strictEqual(prFilter.sanitizeFilterState(on, { trackComments: true }), on);
});

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
    myReReviewDue: false,
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
      await state.applyActivity([p], file, { trackComments: true });
      assert.strictEqual(p.returnedToMe, false);
      assert.strictEqual(p.lastSeenAt, null);
    }));

  await atest("applyActivity.returnedToMe: a new push after a review flips it on", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewPr()], file, { trackComments: true }); // baseline at 07-07
      const later = reviewPr({ lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([later], file, { trackComments: true });
      assert.strictEqual(later.returnedToMe, true);
    }));

  await atest("applyActivity.returnedToMe: new comments flip it on too", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewPr()], file, { trackComments: true });
      const more = reviewPr({ totalComments: 5 });
      await state.applyActivity([more], file, { trackComments: true });
      assert.strictEqual(more.returnedToMe, true);
      assert.strictEqual(more.hasNewActivity, true);
    }));

  await atest("applyActivity.returnedToMe: never set on your own PR", () =>
    withTempStore(async (file) => {
      // Author who somehow also reviewed + pushed — the !author guard must win.
      await state.applyActivity([reviewPr({ roles: ["author"] })], file, { trackComments: true });
      const pushed = reviewPr({ roles: ["author"], lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file, { trackComments: true });
      assert.strictEqual(pushed.returnedToMe, false);
    }));

  await atest("applyActivity.returnedToMe: not set for an un-engaged reviewer request", () =>
    withTempStore(async (file) => {
      // Requested but never reviewed and never opened: a new push is not "back to me".
      await state.applyActivity([reviewPr({ viewerHasReviewed: false })], file, { trackComments: true });
      const pushed = reviewPr({ viewerHasReviewed: false, lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file, { trackComments: true });
      assert.strictEqual(pushed.returnedToMe, false);
    }));

  // --- state: a push you already reviewed is not "returned to me" (tracking ON)
  // `entry.lastCommitPushedAt` is written only on first encounter and by
  // markSeen, so it goes stale whenever the app isn't polling, and a push from
  // BEFORE your own review then read as new. With tracking ON the snapshot diff
  // is still the signal, so the guard is what keeps that case quiet.
  await atest("applyActivity.returnedToMe: a push that predates my own review does not return the PR", () =>
    withTempStore(async (file) => {
      // Baseline recorded while the newest commit was still 07-06 (stale snapshot).
      const stale = reviewPr({ lastCommitPushedAt: "2026-07-06T00:00:00Z" });
      await state.applyActivity([stale], file, { trackComments: true });
      // Live: the author pushed at 07-07, but I reviewed at 07-08 — after it.
      const seenIt = reviewPr({
        lastCommitPushedAt: "2026-07-07T00:00:00Z",
        viewerReviewedAt: "2026-07-08T00:00:00Z",
      });
      await state.applyActivity([seenIt], file, { trackComments: true });
      assert.strictEqual(seenIt.returnedToMe, false, "I already reviewed that push");
    }));

  await atest("applyActivity.returnedToMe: a push AFTER my review still returns the PR (tracking on)", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewPr()], file, { trackComments: true }); // baseline at 07-07
      const pushed = reviewPr({
        lastCommitPushedAt: "2026-07-09T00:00:00Z",
        viewerReviewedAt: "2026-07-08T00:00:00Z",
      });
      await state.applyActivity([pushed], file, { trackComments: true });
      assert.strictEqual(pushed.returnedToMe, true, "genuinely new work since my review");
    }));

  await atest("applyActivity.returnedToMe: the guard leaves a comment-only reviewer alone (tracking on)", () =>
    withTempStore(async (file) => {
      // The documented 4-of-5 case: `reviewed-by:@me` matches a plain "Comment"
      // review, which leaves viewerReviewedAt null. The guard must not silence it.
      await state.applyActivity([reviewPr({ viewerReviewedAt: null })], file, { trackComments: true });
      const pushed = reviewPr({ viewerReviewedAt: null, lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file, { trackComments: true });
      assert.strictEqual(pushed.returnedToMe, true);
    }));

  // --- state: with tracking OFF the push question is answered from GitHub -----
  // The snapshot is not consulted at all: `returnedToMe` becomes "did the author
  // push after my last review?", a fact about the PR rather than about when this
  // app last looked. That is what makes the pre-open view already correct.
  await atest("applyActivity(trackComments=false): a push after my review returns the PR, stale snapshot or not", () =>
    withTempStore(async (file) => {
      const stale = reviewPr({ lastCommitPushedAt: "2026-07-06T00:00:00Z" });
      await state.applyActivity([stale], file, { trackComments: false });
      const pushed = reviewPr({
        lastCommitPushedAt: "2026-07-09T00:00:00Z",
        viewerReviewedAt: "2026-07-08T00:00:00Z",
      });
      await state.applyActivity([pushed], file, { trackComments: false });
      assert.strictEqual(pushed.returnedToMe, true);
    }));

  await atest("applyActivity(trackComments=false): a push I already reviewed never returns the PR", () =>
    withTempStore(async (file) => {
      // The stale baseline that used to drive this is now irrelevant by design.
      const stale = reviewPr({ lastCommitPushedAt: "2026-07-06T00:00:00Z" });
      await state.applyActivity([stale], file, { trackComments: false });
      const seenIt = reviewPr({
        lastCommitPushedAt: "2026-07-07T00:00:00Z",
        viewerReviewedAt: "2026-07-08T00:00:00Z",
      });
      await state.applyActivity([seenIt], file, { trackComments: false });
      assert.strictEqual(seenIt.returnedToMe, false);
    }));

  await atest("applyActivity(trackComments=false): a comment-only reviewer gets no push signal", () =>
    withTempStore(async (file) => {
      // The stated price of the invariant: with no opinionated review of mine
      // there is no live yardstick, so such a PR stays quiet while off.
      await state.applyActivity([reviewPr({ viewerReviewedAt: null })], file, { trackComments: false });
      const pushed = reviewPr({ viewerReviewedAt: null, lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file, { trackComments: false });
      assert.strictEqual(pushed.returnedToMe, false);
    }));

  await atest("applyActivity(trackComments=false): the snapshot is kept current for both fields", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewPr()], file, { trackComments: false });
      const moved = reviewPr({ totalComments: 9, lastCommitPushedAt: "2026-07-09T00:00:00Z" });
      await state.applyActivity([moved], file, { trackComments: false });
      const stored = JSON.parse(await fs.readFile(file, "utf8"))["PR_state_1"];
      assert.strictEqual(stored.comments, 9, "comment baseline resynced");
      assert.strictEqual(stored.lastCommitPushedAt, "2026-07-09T00:00:00Z", "push baseline resynced");
      // …so flipping the setting back on starts from now, with no replay.
      const after = reviewPr({ totalComments: 9, lastCommitPushedAt: "2026-07-09T00:00:00Z" });
      await state.applyActivity([after], file, { trackComments: true });
      assert.strictEqual(after.hasNewActivity, false, "no comment flood on re-enable");
      assert.strictEqual(after.returnedToMe, false, "no push flood on re-enable");
    }));

  // === THE INVARIANT ==========================================================
  // With tracking off, opening a PR must not change the dashboard: the view
  // already shows the true state instead of one that silently corrects itself on
  // a glance. Asserted on both halves — the flags the renderer reads AND the
  // state file, since a write is the only way a later tick could diverge.
  await atest("INVARIANT(trackComments=false): opening a PR changes neither the flags nor the state file", () =>
    withTempStore(async (file) => {
      const pr = (o = {}) =>
        reviewPr({
          roles: ["reviewed"],
          viewerReviewedAt: "2026-07-08T00:00:00Z",
          lastCommitPushedAt: "2026-07-09T00:00:00Z",
          totalComments: 9,
          unresolvedThreads: 2,
          hasUnaddressedComments: true,
          ...o,
        });
      await state.applyActivity([pr()], file, { trackComments: false }); // baseline
      const before = pr();
      await state.applyActivity([before], file, { trackComments: false });
      const fileBefore = await fs.readFile(file, "utf8");
      const flags = (p) => ({
        hasNewActivity: p.hasNewActivity,
        returnedToMe: p.returnedToMe,
        needsAttention: p.needsAttention,
        lastSeenAt: p.lastSeenAt,
      });

      // Open the card, exactly as the renderer does.
      await state.markSeen(
        [
          {
            id: "PR_state_1",
            comments: 9,
            updatedAt: "2026-07-07T00:00:00Z",
            lastCommitPushedAt: "2026-07-09T00:00:00Z",
          },
        ],
        file,
        { trackComments: false },
      );

      const after = pr();
      await state.applyActivity([after], file, { trackComments: false });
      assert.deepStrictEqual(flags(after), flags(before), "the dashboard must not move on a glance");
      assert.strictEqual(
        await fs.readFile(file, "utf8"),
        fileBefore,
        "markSeen must write nothing while tracking is off",
      );
      // And the state it shows is the correct one, not a stale latch.
      assert.strictEqual(after.returnedToMe, true, "the push after my review is real work");
    }));

  // The live numbers off PR #96 (Creatio-Platform/creatio-ai-app-development-toolkit),
  // the report this work came from: passive-reviewed, my CHANGES_REQUESTED at
  // 07:51:57 landing AFTER the author's 07:38:22 commit, two threads still open
  // (so myReReviewDue's both branches are false) and a stale snapshot baseline.
  // It must be out of Need attention BEFORE the card is opened — under either
  // setting, and for a different reason in each: the live comparison while off,
  // the pushPredatesMyReview guard while on.
  for (const trackComments of [false, true]) {
    await atest(`applyActivity.needsAttention: PR #96's exact shape stays out of Need attention (tracking ${trackComments ? "on" : "off"})`, () =>
      withTempStore(async (file) => {
        const pr96 = (o = {}) =>
          reviewPr({
            roles: ["reviewed"],
            viewerHasReviewed: true,
            viewerReviewedAt: "2026-08-21T07:51:57Z",
            myReReviewDue: false,
            unresolvedThreads: 2,
            lastCommitPushedAt: "2026-08-21T07:38:22Z",
            ...o,
          });
        // Snapshot from before that commit — exactly the stale state on disk.
        await state.applyActivity([pr96({ lastCommitPushedAt: "2026-08-20T11:31:46Z" })], file, {
          trackComments,
        });
        const live = pr96();
        await state.applyActivity([live], file, { trackComments });
        assert.strictEqual(live.returnedToMe, false);
        assert.strictEqual(live.needsAttention, false, "nothing is owed by me here");
      }));
  }

  await atest("markSeen then applyActivity: viewing sets lastSeenAt and re-arms the baseline", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewPr({ viewerHasReviewed: false })], file, { trackComments: true }); // baseline
      await state.markSeen(
        [{ id: "PR_state_1", comments: 2, updatedAt: "2026-07-07T00:00:00Z", lastCommitPushedAt: "2026-07-07T00:00:00Z" }],
        file,
        { trackComments: true },
      );
      const pushed = reviewPr({ viewerHasReviewed: false, lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file, { trackComments: true });
      assert.strictEqual(typeof pushed.lastSeenAt, "string"); // viewed → set
      assert.strictEqual(pushed.returnedToMe, true); // engaged via a view, new push
    }));

  // --- state: trackComments off (the "ignore comments" setting) -------------
  // The whole comment channel goes silent at its single source: `hasNewActivity`
  // stays false, so every consumer (the chip, the card badge and its Mark-as-seen
  // button, needsAttention, the filters) stops reacting to comments without
  // knowing about the setting. A new push is what `returnedToMe` is left with.
  await atest("applyActivity(trackComments=false): new comments do not set hasNewActivity", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewPr()], file, { trackComments: false }); // baseline
      const more = reviewPr({ totalComments: 9 });
      await state.applyActivity([more], file, { trackComments: false });
      assert.strictEqual(more.hasNewActivity, false);
      assert.strictEqual(more.returnedToMe, false);
    }));

  await atest("applyActivity(trackComments=false): comments alone no longer claim attention", () =>
    withTempStore(async (file) => {
      const passive = (o = {}) => reviewPr({ roles: ["reviewed"], ...o });
      await state.applyActivity([passive()], file, { trackComments: false }); // passive role, quiet
      const more = passive({ totalComments: 9 });
      await state.applyActivity([more], file, { trackComments: false });
      assert.strictEqual(more.needsAttention, false);
    }));

  await atest("applyActivity(trackComments=false): a push after my review returns the PR, comments still muted", () =>
    withTempStore(async (file) => {
      // Was "a new push still returns the PR to you", keyed off the snapshot
      // diff. The trigger is now the live comparison against my own review, so
      // the yardstick is stated explicitly instead of coming from the baseline.
      await state.applyActivity([reviewPr()], file, { trackComments: false });
      const pushed = reviewPr({
        totalComments: 9,
        lastCommitPushedAt: "2026-07-08T00:00:00Z",
        viewerReviewedAt: "2026-07-07T12:00:00Z",
      });
      await state.applyActivity([pushed], file, { trackComments: false });
      assert.strictEqual(pushed.returnedToMe, true);
      assert.strictEqual(pushed.hasNewActivity, false);
    }));

  await atest("applyActivity(trackComments=false): the comment baseline stays current, so re-enabling doesn't flood", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewPr()], file, { trackComments: false }); // baseline at 2 comments
      await state.applyActivity([reviewPr({ totalComments: 9 })], file, { trackComments: false }); // untracked growth
      // Tracking back on: the 7 comments that landed while it was off are past,
      // not unread — only what arrives from here counts.
      const back = reviewPr({ totalComments: 9 });
      await state.applyActivity([back], file, { trackComments: true });
      assert.strictEqual(back.hasNewActivity, false);
      const next = reviewPr({ totalComments: 10 });
      await state.applyActivity([next], file, { trackComments: true });
      assert.strictEqual(next.hasNewActivity, true);
    }));

  await atest("applyActivity(trackComments=false): an unchanged comment count leaves the state file alone", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewPr()], file, { trackComments: false }); // baseline written
      const before = await fs.readFile(file, "utf8");
      await state.applyActivity([reviewPr()], file, { trackComments: false }); // nothing moved
      assert.strictEqual(await fs.readFile(file, "utf8"), before, "an untracked tick must not rewrite the store");
      // ...and a tick that does move the count writes, so the guard isn't just "never write".
      await state.applyActivity([reviewPr({ totalComments: 3 })], file, { trackComments: false });
      assert.notStrictEqual(await fs.readFile(file, "utf8"), before);
    }));

  await atest("applyActivity(trackComments=false): a shrinking comment count rebaselines downward", () =>
    withTempStore(async (file) => {
      // Deleted comments while tracking was off: the baseline follows the count
      // either way (`!==`, not `>`), so re-enabling starts from what is actually
      // there — not from a stale higher number that would swallow the next comment.
      await state.applyActivity([reviewPr({ totalComments: 5 })], file, { trackComments: false });
      await state.applyActivity([reviewPr({ totalComments: 1 })], file, { trackComments: false });
      const back = reviewPr({ totalComments: 1 });
      await state.applyActivity([back], file, { trackComments: true });
      assert.strictEqual(back.hasNewActivity, false);
      const next = reviewPr({ totalComments: 2 });
      await state.applyActivity([next], file, { trackComments: true });
      assert.strictEqual(next.hasNewActivity, true);
    }));

  await atest("markSeen(trackComments=false): a stale renderer count cannot lower the baseline", () =>
    withTempStore(async (file) => {
      // While tracking is off the tick stops pushing on a comment-only change
      // (hashSnapshot drops the count), so the renderer's copy lags. Opening the
      // PR still posts that stale number. It is now discarded outright — markSeen
      // writes nothing while off — so re-enabling cannot replay those comments.
      await state.applyActivity([reviewPr()], file, { trackComments: false }); // baseline at 2
      await state.applyActivity([reviewPr({ totalComments: 9 })], file, { trackComments: false }); // resync to 9
      await state.markSeen(
        // The renderer's stale payload: it never saw the snapshot that had 9.
        [{ id: "PR_state_1", comments: 2, updatedAt: "2026-07-07T00:00:00Z", lastCommitPushedAt: "2026-07-07T00:00:00Z" }],
        file,
        { trackComments: false },
      );
      const back = reviewPr({ totalComments: 9 });
      await state.applyActivity([back], file, { trackComments: true });
      assert.strictEqual(back.hasNewActivity, false, "re-enabling must not replay comments seen while off");
      assert.strictEqual(back.returnedToMe, false, "nor toast a return to you for them");
      // No view stamp: while off, opening the card deliberately records nothing
      // (see the INVARIANT case above). lastSeenAt therefore stays null.
      assert.strictEqual(back.lastSeenAt, null, "no view stamp is written while off");
      // The next real comment does count, so nothing deafened the channel.
      const next = reviewPr({ totalComments: 10 });
      await state.applyActivity([next], file, { trackComments: true });
      assert.strictEqual(next.hasNewActivity, true);
    }));

  await atest("markSeen(trackComments=true): the posted count still re-arms the baseline", () =>
    withTempStore(async (file) => {
      // The guard above must not change the tracked path: with tracking on the
      // renderer's count IS current (the field is hashed), so it is authoritative.
      await state.applyActivity([reviewPr()], file, { trackComments: true }); // baseline at 2
      await state.markSeen(
        [{ id: "PR_state_1", comments: 6, updatedAt: "2026-07-07T00:00:00Z", lastCommitPushedAt: "2026-07-07T00:00:00Z" }],
        file,
        { trackComments: true },
      );
      const same = reviewPr({ totalComments: 6 });
      await state.applyActivity([same], file, { trackComments: true });
      assert.strictEqual(same.hasNewActivity, false, "marking seen clears NEW at the posted count");
      const more = reviewPr({ totalComments: 7 });
      await state.applyActivity([more], file, { trackComments: true });
      assert.strictEqual(more.hasNewActivity, true);
    }));

  await atest("applyActivity + markSeen concurrently while off: the resync is not clobbered", () =>
    withTempStore(async (file) => {
      // While off there is exactly ONE writer — the resync — because markSeen is
      // a no-op, so the lost-update race this pins can no longer even occur
      // through markSeen. Kept as a regression test: if markSeen ever starts
      // writing again while off, its stale renderer payload lands here and drags
      // the baseline back to 2, which is what makes re-enabling replay comments.
      await state.applyActivity([reviewPr()], file, { trackComments: false }); // baseline at 2
      const resync = state.applyActivity([reviewPr({ totalComments: 9 })], file, {
        trackComments: false,
      });
      const viewed = state.markSeen(
        // The renderer's payload, carrying the count it last saw.
        [{ id: "PR_state_1", comments: 2, updatedAt: "2026-07-07T00:00:00Z", lastCommitPushedAt: "2026-07-07T00:00:00Z" }],
        file,
        { trackComments: false },
      );
      await Promise.all([resync, viewed]);

      const after = reviewPr({ totalComments: 9 });
      await state.applyActivity([after], file, { trackComments: true });
      assert.strictEqual(after.hasNewActivity, false, "the resynced count must not be erased");
    }));

  await atest("applyActivity + markSeen concurrently while ON: the read-modify-write cycle is serialized", () =>
    withTempStore(async (file) => {
      // The overlap that still exists with tracking on: a PR's first encounter
      // creating its baseline while the user clicks the card in the same tick.
      // Each cycle must run as ONE chained task, or the file is written from a
      // copy read before the other landed and one of the two writes vanishes.
      const first = state.applyActivity([reviewPr()], file, { trackComments: true });
      const viewed = state.markSeen(
        [{ id: "PR_state_1", comments: 4, updatedAt: "2026-07-07T00:00:00Z", lastCommitPushedAt: "2026-07-07T00:00:00Z" }],
        file,
        { trackComments: true },
      );
      await Promise.all([first, viewed]);
      // Whichever landed last, the file must be one complete entry, not a torn mix.
      const stored = JSON.parse(await fs.readFile(file, "utf8"))["PR_state_1"];
      assert.ok(stored, "the entry exists");
      assert.strictEqual(typeof stored.comments, "number");
      assert.strictEqual(typeof stored.seenAt, "string");
    }));

  // The extended claim, per the README/Settings-hint/docblock update: turning
  // the setting off mutes EVERY comment-shaped signal, not just the unread one.
  // `needsAttention` is computed inside the function the setting gates, so a
  // narrowed gate would break that claim silently; the fixtures are authored
  // PRs (the default `reviewer` role would make needsAttention true on its own,
  // and a passive `reviewed` one reduces it to `returnedToMe`, so neither term
  // would ever be reached).
  await atest("applyActivity(trackComments=false): an unresolved thread no longer claims attention", () =>
    withTempStore(async (file) => {
      const threaded = (o = {}) =>
        reviewPr({ roles: ["author"], awaitingReview: false, unresolvedThreads: 3, ...o });
      await state.applyActivity([threaded()], file, { trackComments: false });
      const more = threaded({ totalComments: 9 });
      await state.applyActivity([more], file, { trackComments: false });
      assert.strictEqual(more.hasNewActivity, false, "the unread channel is muted");
      assert.strictEqual(more.needsAttention, false, "and so is an open thread, while the setting is off");
    }));

  await atest("applyActivity(trackComments=true): an unresolved thread still claims attention", () =>
    withTempStore(async (file) => {
      const threaded = (o = {}) =>
        reviewPr({ roles: ["author"], awaitingReview: false, unresolvedThreads: 3, ...o });
      await state.applyActivity([threaded()], file, { trackComments: true });
      const more = threaded({ totalComments: 9 });
      await state.applyActivity([more], file, { trackComments: true });
      assert.strictEqual(more.needsAttention, true, "a thread to resolve is work owed");
    }));

  await atest(
    "applyActivity(trackComments=false): a comment awaiting your reply no longer claims attention",
    () =>
      withTempStore(async (file) => {
        const unanswered = (o = {}) =>
          reviewPr({ roles: ["author"], awaitingReview: false, hasUnaddressedComments: true, ...o });
        await state.applyActivity([unanswered()], file, { trackComments: false });
        const more = unanswered({ totalComments: 9 });
        await state.applyActivity([more], file, { trackComments: false });
        assert.strictEqual(more.hasNewActivity, false);
        assert.strictEqual(more.needsAttention, false);
      }),
  );

  await atest("applyActivity(trackComments=true): a comment awaiting your reply still claims attention", () =>
    withTempStore(async (file) => {
      const unanswered = (o = {}) =>
        reviewPr({ roles: ["author"], awaitingReview: false, hasUnaddressedComments: true, ...o });
      await state.applyActivity([unanswered()], file, { trackComments: true });
      const more = unanswered({ totalComments: 9 });
      await state.applyActivity([more], file, { trackComments: true });
      assert.strictEqual(more.needsAttention, true);
    }));

  // --- state: the passive `reviewed` role doesn't claim attention ------------
  // A PR you have only already reviewed is on the dashboard so it doesn't vanish
  // the moment you submit a review — not because someone is waiting on you. Only
  // its return to your court counts; the author's CI, threads and pending change
  // request are theirs, or every PR you ever reviewed would sit in the red pile.
  const reviewedPr = (o = {}) => reviewPr({ roles: ["reviewed"], ...o });

  await atest("applyActivity.needsAttention: an already-reviewed PR is quiet while nothing moves", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewedPr()], file, { trackComments: true }); // baseline
      const same = reviewedPr();
      await state.applyActivity([same], file, { trackComments: true });
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
      await state.applyActivity([noisy()], file, { trackComments: true }); // baseline
      const again = noisy();
      await state.applyActivity([again], file, { trackComments: true });
      assert.strictEqual(again.needsAttention, false);
    }));

  await atest("applyActivity.needsAttention: a reviewed PR wakes up when it comes back to me", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewedPr()], file, { trackComments: true }); // baseline
      const pushed = reviewedPr({ lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file, { trackComments: true });
      assert.strictEqual(pushed.returnedToMe, true);
      assert.strictEqual(pushed.needsAttention, true);
    }));

  // …with one exception, and it's the whole point of issue #14: your own change
  // request blocks the merge until you re-review, and nothing on GitHub will ask
  // you. That is a state, not activity, so — unlike returnedToMe — marking the
  // card seen must not clear it.
  await atest("applyActivity.needsAttention: a due re-review wakes a reviewed PR with nothing new", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewedPr({ myReReviewDue: true })], file, { trackComments: true }); // baseline
      const same = reviewedPr({ myReReviewDue: true });
      await state.applyActivity([same], file, { trackComments: true });
      assert.strictEqual(same.returnedToMe, false); // nothing moved since the snapshot
      assert.strictEqual(same.needsAttention, true); // …yet it's still your move
    }));

  await atest("applyActivity.needsAttention: viewing the card does not clear a due re-review", () =>
    withTempStore(async (file) => {
      await state.applyActivity([reviewedPr({ myReReviewDue: true })], file, { trackComments: true }); // baseline
      await state.markSeen(
        [{ id: "PR_state_1", comments: 2, updatedAt: "2026-07-07T00:00:00Z", lastCommitPushedAt: "2026-07-07T00:00:00Z" }],
        file,
        { trackComments: true },
      );
      const seen = reviewedPr({ myReReviewDue: true });
      await state.applyActivity([seen], file, { trackComments: true });
      // Asserted first: the passive branch is `returnedToMe || myReReviewDue`, so
      // without pinning this to false the test could pass through the wrong term
      // while the behaviour it guards had regressed.
      assert.strictEqual(seen.returnedToMe, false);
      assert.strictEqual(seen.needsAttention, true);
    }));

  // The role, not `viewerHasReviewed`, is what proves engagement: a plain
  // "Comment" review matches `reviewed-by:@me` but never lands in
  // latestOpinionatedReviews (observed on 4 of 5 live reviewed-role PRs). Keying
  // engagement off the opinionated flag alone would leave those cards mute
  // forever, since a passive PR's attention flag IS returnedToMe.
  await atest("applyActivity.returnedToMe: a comment-only review still counts as engaged", () =>
    withTempStore(async (file) => {
      const commentOnly = (o = {}) => reviewedPr({ viewerHasReviewed: false, ...o });
      await state.applyActivity([commentOnly()], file, { trackComments: true }); // baseline
      const more = commentOnly({ totalComments: 5 });
      await state.applyActivity([more], file, { trackComments: true });
      assert.strictEqual(more.returnedToMe, true, "the reviewed role alone must prove engagement");
      assert.strictEqual(more.needsAttention, true);
    }));

  await atest("applyActivity.returnedToMe: a plain reviewer request is still un-engaged", () =>
    withTempStore(async (file) => {
      // The guard the clause above must not weaken: asked to review, never
      // reviewed and never opened — a new push is not "back to me".
      const asked = (o = {}) => reviewPr({ roles: ["reviewer"], viewerHasReviewed: false, ...o });
      await state.applyActivity([asked()], file, { trackComments: true });
      const pushed = asked({ lastCommitPushedAt: "2026-07-08T00:00:00Z" });
      await state.applyActivity([pushed], file, { trackComments: true });
      assert.strictEqual(pushed.returnedToMe, false);
    }));

  await atest("applyActivity.needsAttention: a re-request alongside the past review is your turn again", () =>
    withTempStore(async (file) => {
      const reRequested = reviewPr({ roles: ["reviewer", "reviewed"] });
      await state.applyActivity([reRequested], file, { trackComments: true });
      assert.strictEqual(reRequested.needsAttention, true);
    }));

  await atest("applyActivity.needsAttention: your own PR keeps the full rules when you also reviewed it", () =>
    withTempStore(async (file) => {
      // reviewed-by:@me matches your own PRs too, so `author` and `reviewed`
      // co-occur — the passive branch must not swallow the author's failing CI.
      const mine = reviewPr({ roles: ["author", "reviewed"], failingChecks: ["build"] });
      await state.applyActivity([mine], file, { trackComments: true });
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

  // --- poller: the trackComments setting reaches the whole tick --------------
  // The tick is where the setting meets both consumers: `applyActivity` (which
  // writes hasNewActivity) and `hashSnapshot` (which decides whether the tick
  // pushes at all). Neither has a test-visible seam of its own, so this drives a
  // real Poller over a real state file. Every emission count is asserted before
  // a snapshot is indexed — without that, a tick that stops emitting would make
  // the off-branch read the baseline snapshot, which already carries
  // `hasNewActivity: false`, and the case would pass while testing nothing.
  await atest("Poller.tick: trackComments=false reaches applyActivity and hashSnapshot — no flag, no push", () =>
    withTempStore(async (file) => {
      const snapshots = [];
      let comments = 2;
      let trackComments = false;
      const mkPr = () => ({
        id: "PR_track_1",
        updatedAt: "2026-07-07T00:00:00Z",
        lastCommitPushedAt: "2026-07-07T00:00:00Z",
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
        viewerHasReviewed: true,
        roles: ["reviewed"],
        isDraft: false,
        isIgnored: false,
        parentKey: null,
        parentSummary: null,
      });
      const p = new poller.Poller({
        loadSettings: () => ({ ...cfg.defaultSettings(), trackComments }),
        toHostConfigs: () => [
          { label: "up", graphqlUrl: "https://up.test/graphql", token: "t", repos: ["o/r"] },
        ],
        statePath: file,
        ignoredStatePath: path.join(os.tmpdir(), "prd-poller-ignored-missing.json"),
        appVersion: "test",
        onSnapshot: (s) => snapshots.push(s),
        onConfigError: () => {},
        fetchHostFn: async () => ({ pullRequests: [mkPr()], rateLimit: null }),
      });

      await p.refresh(); // baseline tick at 2 comments
      assert.strictEqual(snapshots.length, 1, "the first tick always pushes");
      const off = snapshots[0].pullRequests[0];
      assert.strictEqual(off.hasNewActivity, false, "trackComments=false must not reach the flag");
      assert.strictEqual(off.returnedToMe, false, "nor claim the PR came back to you");

      comments = 7; // comments landed while tracking is off
      await p.refresh();
      assert.strictEqual(
        snapshots.length,
        1,
        "an untracked comment changes nothing the UI shows — the tick must not push",
      );

      // Same poller, same state file, setting flipped on. The off-path resync
      // moved the baseline to 7, so this asserts the *next* comment counts —
      // re-enabling deliberately does not replay the ones that landed while off.
      trackComments = true;
      comments = 8;
      await p.refresh();
      assert.strictEqual(snapshots.length, 2, "tracking back on must push");
      const on = snapshots[1].pullRequests[0];
      assert.strictEqual(on.hasNewActivity, true, "trackComments=true must reach the flag");

      p.stop();
    }));

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
  // The comment count is the unread channel's raw input and renders nowhere, so
  // with the setting off a change in it alone must not drive a push. Narrow on
  // purpose: a real new comment also bumps `updatedAt`, which stays hashed
  // because the card renders it, so these cases pin the count's own contribution
  // to the hash — not a claim that comment ticks stop pushing. With the setting
  // on the count must still push, which is the whole point.
  test("hashSnapshot: a totalComments-only delta changes the hash while tracking is on", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ totalComments: 2 }), { trackComments: true }),
      poller.hashSnapshot(hsnap({ totalComments: 3 }), { trackComments: true }),
    ));
  test("hashSnapshot: tracking on is the default, so an omitted flag hashes the count", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ totalComments: 2 })),
      poller.hashSnapshot(hsnap({ totalComments: 3 })),
    ));
  test("hashSnapshot: the count's own contribution to the hash is dropped while tracking is off", () =>
    assert.strictEqual(
      poller.hashSnapshot(hsnap({ totalComments: 2 }), { trackComments: false }),
      poller.hashSnapshot(hsnap({ totalComments: 3 }), { trackComments: false }),
    ));
  test("hashSnapshot: unresolvedThreads still moves the hash while tracking is off", () =>
    // Threads are work owed, not unread marks — the setting leaves them live, so
    // dropping the comment count must not take them with it.
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ unresolvedThreads: 0 }), { trackComments: false }),
      poller.hashSnapshot(hsnap({ unresolvedThreads: 1 }), { trackComments: false }),
    ));
  test("hashSnapshot: flipping the setting alone changes the hash (so the chip comes back)", () =>
    // Turning tracking back on has to reach the renderer even on a tick where no
    // PR field moved, or the chip stays missing until something else changes.
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap(), { trackComments: false }),
      poller.hashSnapshot(hsnap(), { trackComments: true }),
    ));
  test("hashSnapshot: a roles-only delta changes the hash (so review_requested fires)", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ roles: ["author"] })),
      poller.hashSnapshot(hsnap({ roles: ["author", "reviewer"] })),
    ));
  // The field-coupling guard further down already fails if this one is dropped
  // from the hash (the notifier reads it for returned_to_me), but that guard
  // proves *coupling*; this states the behaviour the fix is actually about — a
  // tick whose only delta is a PR coming back to you must re-emit, or the toast,
  // the "↩ Back to you" badge and the action-sort rank all fail to appear.
  test("hashSnapshot: a returnedToMe-only delta changes the hash (so returned_to_me fires)", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ returnedToMe: false })),
      poller.hashSnapshot(hsnap({ returnedToMe: true })),
    ));
  // Unlike its neighbours, this field is read by the view filter rather than the
  // notifier, so the Proxy guard below — which only compares against what
  // `diffNotifications` reads — would not notice it being dropped from the
  // tuple. Until that guard has a filter-side twin, this test is the only thing
  // standing between a refactor and a "Hide my approvals" view that goes stale
  // for a whole poll tick.
  test("hashSnapshot: a viewerApproved-only delta changes the hash", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ viewerApproved: false })),
      poller.hashSnapshot(hsnap({ viewerApproved: true })),
    ));
  // Same blind spot as viewerApproved — read by the view, not the notifier — with
  // an extra reason it needs its own tuple entry: on a PR that already needs
  // attention through returnedToMe this flag flips WITHOUT moving
  // needsAttention, so nothing else in the tuple would carry the delta and the
  // card accent plus the action-sort rank would lag a whole poll tick.
  test("hashSnapshot: a myReReviewDue-only delta changes the hash", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ myReReviewDue: false })),
      poller.hashSnapshot(hsnap({ myReReviewDue: true })),
    ));
  test("hashSnapshot: a myReReviewDue delta re-emits even while needsAttention stays true", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ needsAttention: true, myReReviewDue: false })),
      poller.hashSnapshot(hsnap({ needsAttention: true, myReReviewDue: true })),
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


  // --- window geometry (shared/window-bounds.ts) ------------------------------
  // Window position used to reset on every launch (nothing was persisted); the
  // sanitizer is what keeps a restored position from landing off-screen.
  const DISPLAY = (x, y, width, height) => ({ workArea: { x, y, width, height } });
  const LAPTOP = [DISPLAY(0, 25, 1728, 1085)];

  test("sanitizeWindowBounds: bounds on the display come back unchanged", () => {
    const saved = { x: 100, y: 120, width: 1280, height: 860 };
    assert.deepStrictEqual(windowBounds.sanitizeWindowBounds(saved, LAPTOP), saved);
  });

  test("sanitizeWindowBounds: null/garbage saved bounds -> null (use the default)", () => {
    assert.strictEqual(windowBounds.sanitizeWindowBounds(null, LAPTOP), null);
    assert.strictEqual(windowBounds.sanitizeWindowBounds({ x: NaN, y: 0, width: 1280, height: 860 }, LAPTOP), null);
    assert.strictEqual(windowBounds.sanitizeWindowBounds({ x: 0, y: 0, width: 0, height: 860 }, LAPTOP), null);
    assert.strictEqual(windowBounds.sanitizeWindowBounds({ x: 0, y: 0, width: 1280, height: 860 }, []), null);
  });

  test("sanitizeWindowBounds: a display that is gone -> null, not an off-screen window", () => {
    // Saved on a second monitor to the right; only the laptop screen is left.
    const saved = { x: 2200, y: 300, width: 1280, height: 860 };
    assert.strictEqual(windowBounds.sanitizeWindowBounds(saved, LAPTOP), null);
  });

  test("sanitizeWindowBounds: a sliver on screen is treated as off-screen", () => {
    const saved = { x: 1690, y: 300, width: 1280, height: 860 };
    assert.strictEqual(windowBounds.sanitizeWindowBounds(saved, LAPTOP), null);
  });

  test("sanitizeWindowBounds: partially off-screen is pulled back inside the work area", () => {
    const out = windowBounds.sanitizeWindowBounds({ x: 900, y: 900, width: 1280, height: 860 }, LAPTOP);
    assert.ok(out, "a mostly-visible window keeps its position rather than being dropped");
    assert.strictEqual(out.x + out.width <= 1728, true);
    assert.strictEqual(out.y + out.height <= 25 + 1085, true);
    assert.strictEqual(out.y >= 25, true, "must not slide under the menu bar");
  });

  test("sanitizeWindowBounds: a size below the window minimum is raised to it", () => {
    const out = windowBounds.sanitizeWindowBounds({ x: 10, y: 40, width: 300, height: 200 }, LAPTOP);
    assert.strictEqual(out.width, windowBounds.MIN_WINDOW_WIDTH);
    assert.strictEqual(out.height, windowBounds.MIN_WINDOW_HEIGHT);
  });

  test("sanitizeWindowBounds: a size larger than the current display is clamped to it", () => {
    const small = [DISPLAY(0, 0, 1440, 900)];
    const out = windowBounds.sanitizeWindowBounds({ x: 0, y: 0, width: 2560, height: 1400 }, small);
    assert.deepStrictEqual(out, { x: 0, y: 0, width: 1440, height: 900 });
  });

  test("sanitizeWindowBounds: picks the display holding most of the window", () => {
    const two = [DISPLAY(0, 0, 1440, 900), DISPLAY(1440, 0, 1920, 1080)];
    const out = windowBounds.sanitizeWindowBounds({ x: 1500, y: 100, width: 1280, height: 860 }, two);
    assert.deepStrictEqual(out, { x: 1500, y: 100, width: 1280, height: 860 });
  });

  test("parseWindowState: missing/garbage store -> null (first run, never a throw)", () => {
    assert.strictEqual(windowBounds.parseWindowState(null), null);
    assert.strictEqual(windowBounds.parseWindowState("nope"), null);
    assert.strictEqual(windowBounds.parseWindowState({}), null);
    assert.strictEqual(windowBounds.parseWindowState({ bounds: { x: 1 } }), null);
  });

  test("parseWindowState: keeps maximized/full-screen flags even without usable bounds", () => {
    const state = windowBounds.parseWindowState({ isMaximized: true });
    assert.deepStrictEqual(state, { bounds: null, isMaximized: true, isFullScreen: false });
  });

  test("parseWindowState: rounds bounds and defaults the flags to false", () => {
    const state = windowBounds.parseWindowState({ bounds: { x: 10.4, y: 20.6, width: 1280, height: 860 } });
    assert.deepStrictEqual(state, {
      bounds: { x: 10, y: 21, width: 1280, height: 860 },
      isMaximized: false,
      isFullScreen: false,
    });
  });

  // A hidden window is neither destroyed nor minimized — close-to-tray makes
  // that the normal idle state, so without the visibility guard the second
  // `close` (the real quit) would overwrite the good record saved on the way in.
  const fakeWindow = (over = {}) => ({
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    getNormalBounds: () => ({ x: 10, y: 20, width: 1280, height: 860 }),
    ...over,
  });

  test("snapshotWindowState: a visible window yields its normal bounds and flags", () => {
    assert.deepStrictEqual(windowBounds.snapshotWindowState(fakeWindow()), {
      bounds: { x: 10, y: 20, width: 1280, height: 860 },
      isMaximized: false,
      isFullScreen: false,
    });
  });

  test("snapshotWindowState: hidden (close-to-tray) -> null, so the good record stands", () => {
    assert.strictEqual(windowBounds.snapshotWindowState(fakeWindow({ isVisible: () => false })), null);
  });

  test("snapshotWindowState: destroyed / minimized / absent -> null", () => {
    assert.strictEqual(windowBounds.snapshotWindowState(fakeWindow({ isDestroyed: () => true })), null);
    assert.strictEqual(windowBounds.snapshotWindowState(fakeWindow({ isMinimized: () => true })), null);
    assert.strictEqual(windowBounds.snapshotWindowState(null), null);
  });

  test("snapshotWindowState: maximized keeps the normal bounds, not the screen-sized ones", () => {
    const state = windowBounds.snapshotWindowState(
      fakeWindow({ isMaximized: () => true, isFullScreen: () => true }),
    );
    assert.deepStrictEqual(state.bounds, { x: 10, y: 20, width: 1280, height: 860 });
    assert.strictEqual(state.isMaximized, true);
    assert.strictEqual(state.isFullScreen, true);
  });

  test("main.js wiring: window geometry is restored on create and saved on move/resize/close", () => {
    const src = require("node:fs").readFileSync(
      path.join(__dirname, "../dist/main/main/main.js"),
      "utf8",
    );
    assert.match(src, /loadWindowState\)\(\)/, "createWindow must read the saved geometry");
    assert.match(src, /windowOptionsFrom\)\(/, "the saved geometry must feed the BrowserWindow options");
    for (const evt of ["resize", "move", "maximize", "unmaximize"]) {
      assert.ok(
        src.includes(`"${evt}"`),
        `a ${evt} listener must persist the new geometry`,
      );
    }
    // macOS quitAndInstall closes windows before `before-quit`, so the update
    // path only records geometry if the flush hangs off `close` itself.
    const closeHandler = /mainWindow\.on\("close",[\s\S]{0,400}?\}\);/.exec(src);
    assert.ok(closeHandler, "the close handler must still be registered");
    assert.match(closeHandler[0], /flush\(\)/, "close must flush before the window can be hidden to tray");
    assert.ok(
      closeHandler[0].indexOf("flush()") < closeHandler[0].indexOf("trayController.handleClose"),
      "the flush must run before handleClose, which may hide the window",
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
