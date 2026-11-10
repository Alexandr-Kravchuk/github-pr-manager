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
const jiraTwg = require(path.join(__dirname, "../dist/main/shared/jira-twg.js"));
const jiraPass = require(path.join(__dirname, "../dist/main/shared/jira-pass.js"));
const issueKey = require(path.join(__dirname, "../dist/main/shared/issue-key.js"));
const prFilter = require(path.join(__dirname, "../dist/main/shared/pr-filter.js"));
const singleInstance = require(path.join(__dirname, "../dist/main/main/single-instance.js"));
const windowBounds = require(path.join(__dirname, "../dist/main/shared/window-bounds.js"));
const loginLaunch = require(path.join(__dirname, "../dist/main/main/login-launch.js"));

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
// shared/issue-key, the F5 decision from shared/hotkeys and the group-heading
// rules from shared/pr-group. That's only safe while those modules pull in no node:
// builtin — a regression would break the Vite renderer build. Assert the
// compiled output is clean so the AGENTS.md carve-out is enforced, not just
// documented.
for (const mod of [
  "notify.js",
  "pr-filter.js",
  "issue-key.js",
  "hotkeys.js",
  "pr-group.js",
  "pr-table.js",
  "view-mode.js",
  "claude-launch.js",
  "claude-sessions.js",
  "settings-search.js",
  "host-status.js",
  "agent-defaults.js",
  "agent-stream.js",
  "agent-view.js",
  "agent-publish.js",
  "agent-result.js",
  "agent-diagrams.js",
  "agent-reapprove.js",
  "agent-stack.js",
  "agent-explain.js",
  "stale.js",
  "jira-status.js",
  "weather.js",
  "check-groups.js",
]) {
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
// animation remounted via `key` (see `.live-beat` in styles.css).
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

  test("header sky is paused unless the header is hovered", () => {
    const css = fs.readFileSync(path.join(rendererRoot, "src/styles.css"), "utf8");
    const rule = (sel) => {
      const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.:]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
      return m ? m[1] : "";
    };
    assert.match(rule(".sky-host .sky-anim"), /animation-play-state:\s*paused/, "at rest the sky must not animate");
    assert.match(rule(".sky-host:hover .sky-anim"), /animation-play-state:\s*running/);
    // The play state must win over each one-class `animation` shorthand, which
    // resets it: two classes beat one whatever the order in the file.
    for (const cls of ["sky-fall", "sky-drift", "sky-twinkle", "sky-spin", "sky-flash"]) {
      assert.match(rule(`.${cls}`), /animation:/, `${cls} is defined`);
    }
    // Every animated element of the sky carries the pausing class.
    const sky = fs.readFileSync(path.join(rendererRoot, "src/components/HeaderSky.tsx"), "utf8");
    const animated = sky.match(/className="[^"]*\bsky-(?:fall|drift|twinkle|spin|flash)\b[^"]*"/g) ?? [];
    assert.ok(animated.length >= 5, "found the animated elements");
    for (const c of animated) assert.match(c, /\bsky-anim\b/, c);
  });

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

// --- the accent stripe survives hover ----------------------------------------
// A card's and a tile's left border is the coloured accent (`border-l-*`). A
// hover colour for the whole border (`hover:border-line-strong`) outranks it and
// painted the stripe grey under the pointer (2.3.0); hover may colour the other
// sides only (`hover:border-y-*`, `hover:border-r-*`).
for (const file of ["PrCard.tsx", "PrTile.tsx"]) {
  test(`${file}: hover never recolours the accent stripe`, () => {
    const src = require("node:fs").readFileSync(
      path.join(__dirname, `../src/renderer/src/components/${file}`),
      "utf8",
    );
    const hits = src.match(/hover:border-(?:line|[a-z]+-\d)[\w-]*/g) || [];
    assert.deepStrictEqual(hits, [], `${file} sets a whole-border hover colour: ${hits.join(", ")}`);
    assert.match(src, /hover:border-y-line-strong hover:border-r-line-strong/);
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

  test("App.tsx gates the New comments chip on trackComments", () => {
    const src = read("src/renderer/src/App.tsx");
    // Same reasoning: assert the gate co-occurs with what it gates, not the
    // exact JSX. (The header's new-comments count it also gated is gone: the
    // chip is the only place that number shows now.)
    assert.match(src, /trackComments &&[\s\S]{0,120}?<FilterChip/, "the chip must be conditional");
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
    setToolTip(text) {
      this.tooltip = text;
    }
    setContextMenu(menu) {
      this.menu = menu;
      this.menus = (this.menus ?? 0) + 1;
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
  const { createTrayController, trayTooltip } = require(trayJs);

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
    const calls = { open: 0, quit: 0, hide: 0, showAgent: 0, toggleAgent: 0 };
    const controller = createTrayController({
      open: () => calls.open++,
      quit: () => calls.quit++,
      hide: () => calls.hide++,
      showAgent: () => calls.showAgent++,
      toggleAgentPause: () => calls.toggleAgent++,
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

  test("tray controller: the PR agent's line goes in the tooltip and the menu, with Show agent and Pause/Resume agent", () => {
    const { controller, calls } = setup();
    controller.setEnabled(true);
    const [tray] = trays;
    assert.strictEqual(tray.tooltip, "PR Dashboard");
    controller.setAgent({ line: "Reviewing #911 · 4/6", paused: false });
    assert.strictEqual(tray.tooltip, "PR Dashboard\nAgent: Reviewing #911 · 4/6");
    const labels = tray.menu.map((item) => item.label ?? item.type);
    assert.deepStrictEqual(labels, ["Open PR Dashboard", "separator", "Agent: Reviewing #911 · 4/6", "Show agent", "Pause agent", "separator", "Quit PR Dashboard"]);
    assert.strictEqual(tray.menu[2].enabled, false, "the status line is a label, not an action");
    tray.menu[3].click();
    tray.menu[4].click();
    assert.deepStrictEqual([calls.showAgent, calls.toggleAgent, calls.open], [1, 1, 0]);
    controller.setAgent({ line: "Paused", paused: true });
    assert.strictEqual(tray.menu[4].label, "Resume agent");
    // A run reports a step per tool call: the same line rebuilds nothing.
    const built = tray.menus;
    controller.setAgent({ line: "Paused", paused: true });
    assert.strictEqual(tray.menus, built);
    controller.setAgent(null);
    assert.deepStrictEqual(tray.menu.map((item) => item.label ?? item.type), ["Open PR Dashboard", "separator", "Quit PR Dashboard"], "agent off: the plain menu");
    assert.strictEqual(tray.tooltip, "PR Dashboard");
  });

  test("tray controller: the agent's state set while there is no icon shows on the next one; a long line is cut for Windows", () => {
    const { controller } = setup();
    controller.setAgent({ line: "2 queued", paused: false });
    assert.strictEqual(trays.length, 0, "setting the agent's state creates no icon");
    controller.setEnabled(true);
    assert.strictEqual(trays[0].tooltip, "PR Dashboard\nAgent: 2 queued");
    const long = trayTooltip({ line: "x".repeat(300), paused: false });
    assert.strictEqual(long.length, 127);
    assert.ok(long.endsWith("…"));
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
test("validateSettings: a host without allRepos/searchLimit keeps the old scope and page", () => {
  const [h] = cfg.validateSettings({
    hosts: [{ label: "G", graphqlUrl: "https://api.github.com/graphql", repos: ["a/b"] }],
  }).hosts;
  assert.strictEqual(h.allRepos, false);
  assert.strictEqual(h.searchLimit, 25);
});
test("validateSettings: allRepos is honored only as a real true", () => {
  const host = (allRepos) =>
    cfg.validateSettings({ hosts: [{ graphqlUrl: "https://api.github.com/graphql", repos: [], allRepos }] })
      .hosts[0].allRepos;
  assert.strictEqual(host(true), true);
  assert.strictEqual(host("true"), false);
});
test("validateSearchLimit: clamps to 1–100, rounds, and falls back on garbage", () => {
  assert.strictEqual(cfg.validateSearchLimit(50), 50);
  assert.strictEqual(cfg.validateSearchLimit("40"), 40);
  assert.strictEqual(cfg.validateSearchLimit(500), 100);
  assert.strictEqual(cfg.validateSearchLimit(0), 1);
  assert.strictEqual(cfg.validateSearchLimit(12.6), 13);
  assert.strictEqual(cfg.validateSearchLimit(undefined), 25);
  assert.strictEqual(cfg.validateSearchLimit("abc"), 25);
  assert.strictEqual(cfg.validateSearchLimit(""), 25);
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
test("validateSettings: jira without an email is kept — twg needs only the site", () =>
  assert.deepStrictEqual(cfg.validateSettings({ hosts: [], jira: { baseUrl: "org.atlassian.net" } }).jira, {
    baseUrl: "https://org.atlassian.net",
  }));
test("validateSettings: jira without a site is dropped", () =>
  assert.strictEqual(cfg.validateSettings({ hosts: [], jira: { email: "me@x.com" } }).jira, undefined));
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
    claude: cfg.validateClaude(undefined),
  });
  assert.deepStrictEqual(pub, {
    pollIntervalSeconds: 60,
    hosts: [{ label: "GH", repos: ["a/b"] }],
    trackComments: true,
    claudeEnabled: false,
    claudeDesktop: false,
  });
});
test("toPublicConfig: trackComments is propagated, not assumed", () => {
  // The renderer's whole half of the feature reads this mirror, so asserting only
  // the `true` case would pass for a hardcoded `true` while the chip, the header
  // stat and the filter reset never turned off for anyone.
  const pub = cfg.toPublicConfig({
    pollIntervalSeconds: 60,
    trackComments: false,
    hosts: [],
    claude: cfg.validateClaude(undefined),
  });
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
// A GHE host costs ~7 a tick since the searches went ids-only plus one read by
// id (it cost 1–3 before); that must not push it onto github.com's floor.
test("hostIntervalMs: a GHE-sized tick (cost 7) stays at base", () =>
  assert.strictEqual(
    poller.hostIntervalMs({ hostLabel: "GHE", remaining: 5000, cost: 7, resetAt: future(3600) }, 60_000),
    60_000,
  ));
test("hostIntervalMs: a github.com-sized tick (cost 20) gets the 5-min floor", () =>
  assert.strictEqual(
    poller.hostIntervalMs({ hostLabel: "GH", remaining: 5000, cost: 20, resetAt: future(3600) }, 60_000),
    300_000,
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

// --- poller: budget reserve and spent budget --------------------------------
// The GraphQL budget is per account, shared with every gh client (scheduled
// routines, the sessions they start, the app on another machine). The app may
// not take the last 10% of it, and once it stops — reserve or a spent budget —
// the next fetch worth making is the first one after the reset.
const within = (actual, expected, slackMs = 2_000) =>
  assert.ok(Math.abs(actual - expected) <= slackMs, `expected ~${expected}, got ${actual}`);
test("hostIntervalMs: down to the reserve, an expensive host waits for the reset", () =>
  within(
    poller.hostIntervalMs(
      { hostLabel: "GH", remaining: 400, cost: 35, limit: 5000, resetAt: future(1800) },
      60_000,
    ),
    1_805_000,
  ));
test("hostIntervalMs: down to the reserve, a cheap host waits for the reset too", () =>
  within(
    poller.hostIntervalMs(
      { hostLabel: "GHE", remaining: 148, cost: 1, limit: 5000, resetAt: future(600) },
      60_000,
    ),
    605_000,
  ));
test("hostIntervalMs: above the reserve the floor still applies", () =>
  assert.strictEqual(
    poller.hostIntervalMs(
      { hostLabel: "GH", remaining: 5000, cost: 35, limit: 5000, resetAt: future(3600) },
      60_000,
    ),
    300_000,
  ));
test("hostIntervalMs: the reserve is spread over, not spent — safe ticks count usable points only", () =>
  // 1000 left, 500 reserved, 50 a tick -> 10 ticks over 3600 s -> 360 s apart.
  within(
    poller.hostIntervalMs(
      { hostLabel: "GH", remaining: 1000, cost: 50, limit: 5000, resetAt: future(3600) },
      60_000,
    ),
    360_000,
  ));
test("hostIntervalMs: a spent budget resuming in 2 min waits 2 min, not the 5-min floor", () =>
  within(
    poller.hostIntervalMs({ hostLabel: "GH", remaining: 0, cost: 35, resetAt: future(120) }, 60_000),
    125_000,
  ));
test("hostIntervalMs: a spent reading whose window already reset falls back to the floor", () =>
  assert.strictEqual(
    poller.hostIntervalMs({ hostLabel: "GH", remaining: 0, cost: 35, resetAt: future(-30) }, 60_000),
    300_000,
  ));
test("isBudgetSpent: fewer points than a tick, before the reset", () => {
  const now = Date.now();
  assert.strictEqual(
    poller.isBudgetSpent({ hostLabel: "GH", remaining: 20, cost: 35, resetAt: future(60) }, now),
    true,
  );
  assert.strictEqual(
    poller.isBudgetSpent({ hostLabel: "GH", remaining: 400, cost: 35, resetAt: future(60) }, now),
    false,
    "the reserve is not 'spent' — human activity may still use it",
  );
  assert.strictEqual(
    poller.isBudgetSpent({ hostLabel: "GH", remaining: 0, cost: 35, resetAt: future(-5) }, now),
    false,
    "a window that has reset is not spent",
  );
  assert.strictEqual(poller.isBudgetSpent(null, now), false);
});
test("reserveNotice: only once the usable budget cannot pay for a tick", () => {
  assert.strictEqual(
    poller.reserveNotice({ hostLabel: "GH", remaining: 5000, cost: 35, limit: 5000, resetAt: future(60) }),
    null,
  );
  assert.strictEqual(
    poller.reserveNotice({ hostLabel: "GH", remaining: 400, cost: 35, resetAt: future(60) }),
    null,
    "no limit in the reading -> no reserve, so nothing to report",
  );
  const n = poller.reserveNotice({
    hostLabel: "GHE",
    remaining: 148,
    cost: 1,
    limit: 5000,
    resetAt: "2026-10-02T13:00:00Z",
  });
  assert.strictEqual(n.hostLabel, "GHE");
  assert.strictEqual(n.rateLimitedUntil, "2026-10-02T13:00:00Z");
  assert.match(n.message, /148 of 5000/);
});

// --- poller: hotness floor ---------------------------------------------------
const rl = (cost) => ({ hostLabel: "GH", remaining: 5000, cost, resetAt: future(3600) });
test("hostIntervalMs: cold expensive host stretches the floor 4x", () =>
  assert.strictEqual(poller.hostIntervalMs(rl(35), 60_000, false), 1_200_000));
test("hostIntervalMs: hot expensive host keeps the tight 5-min floor", () =>
  assert.strictEqual(poller.hostIntervalMs(rl(35), 60_000, true), 300_000));
test("hostIntervalMs: hotness never stretches a cheap host below base", () =>
  assert.strictEqual(poller.hostIntervalMs(rl(1), 60_000, false), 60_000));

// The presence stretch lives in isHostDue, NOT in the stored interval — so that
// a factor which no longer applies can't keep a host from being fetched.
const slot = (baseIntervalMs, dueFromMs = 0) => ({ baseIntervalMs, dueFromMs });
test("isHostDue: an unstretched host is due once its own interval elapsed", () => {
  assert.strictEqual(poller.isHostDue(slot(300_000), 299_999, 1), false);
  assert.strictEqual(poller.isHostDue(slot(300_000), 300_000, 1), true);
});
test("isHostDue: the presence factor holds an idle host back", () => {
  assert.strictEqual(poller.isHostDue(slot(300_000), 300_000, 4), false);
  assert.strictEqual(poller.isHostDue(slot(300_000), 1_200_000, 4), true);
});
test("isHostDue: a factor dropping back to 1 makes a stretched host due at once", () =>
  // The user is back: the hour-long stretch computed while they were away must
  // not outlive the idleness that justified it.
  assert.strictEqual(poller.isHostDue(slot(300_000), 400_000, 1), true));
test("isHostDue: the stretched wait is capped at the 1-hour maximum", () =>
  // 5-min floor x16 would be 80 min; the cap is what makes an unattended
  // machine settle at one hydrate per hour rather than drifting past it.
  assert.strictEqual(poller.isHostDue(slot(300_000), 3_600_000, 16), true));

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
test("newestTrackedActivity: an allRepos host counts any PR notification, never an issue", () => {
  const mixed = [
    { updated_at: "2026-07-07T09:00:00Z", repository: { full_name: "x/one" }, subject: { type: "PullRequest" } },
    { updated_at: "2026-07-07T11:00:00Z", repository: { full_name: "y/two" }, subject: { type: "Issue" } },
  ];
  assert.strictEqual(notif.newestTrackedActivity(mixed, "all"), "2026-07-07T09:00:00Z");
  assert.strictEqual(notif.newestTrackedActivity([mixed[1]], "all"), null);
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

// --- the PR agent's inputs: head commit, size, merge methods -----------------
test("mapPr: head oid, size and merge methods reach the PR", () => {
  const pr = github.mapPr(
    rawPr({
      additions: 310,
      deletions: 95,
      changedFiles: 12,
      repository: {
        nameWithOwner: "a/b",
        defaultBranchRef: { name: "main" },
        viewerDefaultMergeMethod: "SQUASH",
        squashMergeAllowed: true,
        mergeCommitAllowed: true,
        rebaseMergeAllowed: false,
      },
      commits: { nodes: [{ commit: { oid: "abc123", pushedDate: "2026-07-07T00:00:00Z", committedDate: "2026-07-07T00:00:00Z", statusCheckRollup: null } }] },
    }),
    "GH",
    ["author"],
    "auth",
  );
  assert.strictEqual(pr.headOid, "abc123");
  assert.deepStrictEqual([pr.additions, pr.deletions, pr.changedFiles], [310, 95, 12]);
  assert.deepStrictEqual(pr.mergeMethods, { suggested: "squash", allowed: ["merge", "squash"] });
});
test("mapPr: a PR without the new fields reads as zero size and no head", () => {
  const pr = github.mapPr(rawPr(), "GH", ["author"], "auth");
  assert.strictEqual(pr.headOid, null);
  assert.deepStrictEqual([pr.additions, pr.deletions, pr.changedFiles], [0, 0, 0]);
});
test("mapMergeMethods: a suggestion the repo doesn't allow falls to the first allowed; no flags means all", () => {
  const repo = (extra) => ({ nameWithOwner: "a/b", defaultBranchRef: null, ...extra });
  assert.deepStrictEqual(
    github.mapMergeMethods(repo({ viewerDefaultMergeMethod: "MERGE", squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true })),
    { suggested: "squash", allowed: ["squash", "rebase"] },
  );
  assert.deepStrictEqual(github.mapMergeMethods(repo({})), { suggested: "merge", allowed: ["merge", "squash", "rebase"] });
  assert.deepStrictEqual(
    github.mapMergeMethods(repo({ squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: false })),
    { suggested: null, allowed: [] },
  );
});
test("hashSnapshot: a new head commit alone re-emits", () => {
  const a = github.mapPr(rawPr(), "GH", ["author"], "auth");
  const snap = (pr) => ({ pullRequests: [pr], errors: [], rateLimits: [], fetchedAt: "", version: "" });
  assert.notStrictEqual(poller.hashSnapshot(snap(a)), poller.hashSnapshot(snap({ ...a, headOid: "def456" })));
});
// Approval bodies have no resolvable-thread state: only reviewer clearance is
// authoritative. Conservative unknown prose must never enter the merge queue.
for (const body of ["", "LGTM!", "Looks good to me.", "Approved ✅", "Thanks!", "👍"]) {
  test(`approval body: plain acknowledgement ${JSON.stringify(body)}`, () =>
    assert.strictEqual(github.approvalBodyNeedsAttention(body), false));
}
for (const body of ["LGTM, but please add a regression test", "Fix x", "Consider avoiding shared mutable state", "Looks good. Could you handle null inputs?", "The implementation is carefully structured and I appreciate the extensive validation already included."]) {
  test(`approval body: feedback or unknown intent ${JSON.stringify(body)}`, () =>
    assert.strictEqual(github.approvalBodyNeedsAttention(body), true));
}
test("mapPr: approved review body blocks own PR even without inline comments, push/re-request cannot clear it", () => {
  const feedback = { ...approvedReview, body: "LGTM, but please add null validation" };
  for (const trackComments of [true, false]) {
    for (const reviewRequests of [{ totalCount: 0, nodes: [] }, { totalCount: 1, nodes: [{ requestedReviewer: { login: "rev" } }] }]) {
      const pr = github.mapPr(rawPr({ latestOpinionatedReviews: { nodes: [feedback] }, reviewRequests }), "GH", ["author"], "auth");
      assert.strictEqual(pr.hasHumanApproval, true);
      assert.strictEqual(pr.hasUnaddressedReviewFeedback, true);
      assert.strictEqual(pr.canBeMerged, false);
      assert.strictEqual(prFilter.prSignal(pr, { trackComments }), "blocked");
    }
    const anotherApproval = github.mapPr(rawPr({ latestOpinionatedReviews: { nodes: [feedback, { ...approvedReview, author: { __typename: "User", login: "other" }, body: "LGTM" }] } }), "GH", ["author"], "auth");
    assert.strictEqual(anotherApproval.hasUnaddressedReviewFeedback, true);
    assert.strictEqual(prFilter.prSignal(anotherApproval, { trackComments }), "blocked");
    const clean = github.mapPr(rawPr({ latestOpinionatedReviews: { nodes: [{ ...approvedReview, body: "LGTM" }] } }), "GH", ["author"], "auth");
    assert.strictEqual(clean.hasUnaddressedReviewFeedback, false);
    assert.strictEqual(prFilter.prSignal(clean, { trackComments }), "approved");
  }
});
test("mapPr: bot approval and author's own review do not create human-feedback blocker", () => {
  for (const author of [{ __typename: "Bot", login: "bot" }, { __typename: "User", login: "auth" }]) {
    const pr = github.mapPr(rawPr({ latestOpinionatedReviews: { nodes: [{ ...approvedReview, author, body: "Please fix this" }] } }), "GH", ["author"], "auth");
    assert.strictEqual(pr.hasUnaddressedReviewFeedback, false);
  }
});
test("approval feedback: only fresh author EYES on the exact review clears it", () => {
  const feedback = { ...approvedReview, body: "Please add validation", updatedAt: "2026-10-01T10:00:00Z" };
  const eyes = (login, createdAt = "2026-10-01T10:01:00Z", content = "EYES") => ({ content, createdAt, user: login == null ? null : { login } });
  for (const [label, reactions, blocked] of [
    ["absent", [], true], ["other person", [eyes("other")], true],
    ["reviewer", [eyes("rev")], true], ["deleted actor", [eyes(null)], true],
    ["wrong emoji", [eyes("auth", undefined, "THUMBS_UP")], true],
    ["old ack before edit", [eyes("auth", "2026-10-01T09:00:00Z")], true],
    ["invalid time", [eyes("auth", "invalid")], true],
    ["author", [eyes("AUTH")], false],
  ]) {
    const review = { ...feedback, reactions: { nodes: reactions } };
    const pr = github.mapPr(rawPr({ latestOpinionatedReviews: { nodes: [review] } }), "GH", ["author"], "auth");
    assert.strictEqual(pr.hasUnaddressedReviewFeedback, blocked, label);
    assert.strictEqual(pr.canBeMerged, !blocked, label);
    for (const trackComments of [true, false]) assert.strictEqual(prFilter.prSignal(pr, { trackComments }), blocked ? "blocked" : "approved", label);
  }
  const acknowledged = { ...feedback, reactions: { nodes: [eyes("auth")] } };
  for (const extra of [
    { ...feedback, author: { __typename: "User", login: "other-reviewer" } },
    { ...feedback, updatedAt: "2026-10-01T10:02:00Z" }, // replacement review has no inherited reaction
  ]) {
    const pr = github.mapPr(rawPr({ latestOpinionatedReviews: { nodes: [acknowledged, extra] } }), "GH", ["author"], "auth");
    assert.strictEqual(pr.hasUnaddressedReviewFeedback, true);
  }
  const behind = github.mapPr(rawPr({ mergeStateStatus: "BEHIND", latestOpinionatedReviews: { nodes: [acknowledged] } }), "GH", ["author"], "auth");
  assert.strictEqual(behind.hasUnaddressedReviewFeedback, false);
  assert.strictEqual(behind.canBeMerged, false);
  assert.strictEqual(prFilter.prSignal(behind, { trackComments: false }), "blocked");
  const noAuthor = github.mapPr(rawPr({ author: null, latestOpinionatedReviews: { nodes: [acknowledged] } }), "GH", ["author"], "auth");
  assert.strictEqual(noAuthor.hasUnaddressedReviewFeedback, true);
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
// The shape a GitHub Enterprise host returned for a real PR: a team-member
// approval is in, but the code owners (a requested team) have not approved, so
// GitHub keeps REVIEW_REQUIRED and refuses the merge with BLOCKED.
test("mapPr: an approval that does not satisfy a required code-owner review is not ready", () => {
  for (const roles of [["author"], ["reviewed"]]) {
    const pr = github.mapPr(
      rawPr({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" }),
      "GHE",
      roles,
      roles[0] === "author" ? "auth" : "rev",
    );
    assert.strictEqual(pr.hasHumanApproval, true);
    assert.strictEqual(pr.requiredReviewPending, true);
    assert.strictEqual(pr.canBeMerged, false);
    for (const trackComments of [true, false]) {
      assert.notStrictEqual(prFilter.prSignal(pr, { trackComments }), "approved", roles[0]);
    }
  }
  const own = github.mapPr(rawPr({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" }), "GHE", ["author"], "auth");
  assert.strictEqual(prFilter.prSignal(own, { trackComments: true }), "waiting");
});
test("mapPr: REVIEW_REQUIRED + BLOCKED without any approval is plain awaiting review", () => {
  const pr = github.mapPr(
    rawPr({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", latestOpinionatedReviews: { nodes: [] } }),
    "GHE",
    ["author"],
    "auth",
  );
  assert.strictEqual(pr.requiredReviewPending, false);
  assert.strictEqual(pr.canBeMerged, false);
});
test("mapPr: REVIEW_REQUIRED without a BLOCKED merge state still counts as ready", () => {
  for (const mergeStateStatus of ["CLEAN", "HAS_HOOKS", "UNSTABLE", undefined]) {
    const pr = github.mapPr(rawPr({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus }), "GH", ["author"], "auth");
    assert.strictEqual(pr.requiredReviewPending, false, String(mergeStateStatus));
    assert.strictEqual(pr.canBeMerged, true, String(mergeStateStatus));
  }
});

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

test("mapPr.isBehindBase: only BEHIND requests a base update", () => {
  for (const mergeStateStatus of ["BEHIND", "CLEAN", "UNKNOWN", "BLOCKED", "DIRTY", undefined]) {
    const pr = github.mapPr(rawPr({ mergeStateStatus }), "GH", ["authored"], null);
    assert.strictEqual(pr.isBehindBase, mergeStateStatus === "BEHIND");
    assert.strictEqual(pr.hasConflicts, false);
    if (mergeStateStatus === "BEHIND") assert.strictEqual(pr.canBeMerged, false);
  }
});
test("mapPr: approved conflict-free PR moves from red to green after base update", () => {
  for (const trackComments of [true, false]) {
    const before = github.mapPr(rawPr({ mergeStateStatus: "BEHIND" }), "GH", ["author"], null);
    const after = github.mapPr(rawPr({ mergeStateStatus: "CLEAN" }), "GH", ["author"], null);
    assert.strictEqual(before.hasHumanApproval, true);
    assert.strictEqual(prFilter.prSignal(before, { trackComments }), "blocked");
    assert.strictEqual(prFilter.prSignal(after, { trackComments }), "approved");
    assert.strictEqual(after.canBeMerged, true);
  }
});

// --- github: native PR stacks -------------------------------------------------
// GitHub merges a stack bottom-up only, yet reports the PRs above the bottom as
// CLEAN — measured on creatio.ghe.com core#1614 (position 2 of 2). Readiness
// must come from the stack position, not from GitHub's merge state.
const stackEntries = (...prs) => ({
  nodes: prs.map(([position, number, state = "OPEN"]) => ({
    position,
    pullRequest: { number, title: `PR ${number}`, url: `https://github.com/a/b/pull/${number}`, state },
  })),
});
const stacked = (position, entries) => rawPr({
  mergeStateStatus: "CLEAN",
  stackEntry: { position },
  stack: { number: 7, size: entries.nodes.length, baseRefName: "trunk", entries },
});
test("mapPr.stack: outside a stack (or on a host without stacks) is null and not blocked", () => {
  for (const pr of [rawPr(), rawPr({ stack: null, stackEntry: null })]) {
    const mapped = github.mapPr(pr, "GH", ["author"], null);
    assert.strictEqual(mapped.stack, null);
    assert.strictEqual(mapped.blockedByStack, false);
    assert.strictEqual(mapped.canBeMerged, true);
  }
});
test("mapPr.stack: the bottom PR is mergeable, the one above it waits for it", () => {
  const entries = stackEntries([1, 1613], [2, 1614]);
  const bottom = github.mapPr(stacked(1, entries), "GH", ["author"], null);
  assert.deepStrictEqual(bottom.stack, {
    number: 7,
    position: 1,
    size: 2,
    baseRefName: "trunk",
    entries: [
      { position: 1, number: 1613, title: "PR 1613", url: "https://github.com/a/b/pull/1613", state: "OPEN" },
      { position: 2, number: 1614, title: "PR 1614", url: "https://github.com/a/b/pull/1614", state: "OPEN" },
    ],
    bottom: null,
  });
  assert.strictEqual(bottom.blockedByStack, false);
  assert.strictEqual(bottom.canBeMerged, true);
  const top = github.mapPr(stacked(2, entries), "GH", ["author"], null);
  assert.deepStrictEqual(top.stack.bottom, { number: 1613, url: "https://github.com/a/b/pull/1613" });
  assert.strictEqual(top.blockedByStack, true);
  assert.strictEqual(top.canBeMerged, false);
});
test("prSignal: an approved green PR above the bottom of its stack is amber, not green", () => {
  const entries = stackEntries([1, 1613], [2, 1614]);
  for (const trackComments of [true, false]) {
    assert.strictEqual(prFilter.prSignal(github.mapPr(stacked(1, entries), "GH", ["author"], null), { trackComments }), "approved");
    assert.strictEqual(prFilter.prSignal(github.mapPr(stacked(2, entries), "GH", ["author"], null), { trackComments }), "attention");
  }
});
test("mapPr.stack: entries come bottom first whatever order GitHub lists them in", () => {
  const top = github.mapPr(stacked(2, stackEntries([2, 1614], [1, 1613])), "GH", ["author"], null);
  assert.deepStrictEqual(top.stack.entries.map((e) => e.number), [1613, 1614]);
});
test("mapPr.stack: waits for the lowest OPEN PR; a merged one below no longer blocks", () => {
  const third = github.mapPr(stacked(3, stackEntries([1, 10, "MERGED"], [2, 11], [3, 12])), "GH", ["author"], null);
  assert.strictEqual(third.stack.bottom.number, 11);
  const second = github.mapPr(stacked(2, stackEntries([1, 10, "MERGED"], [2, 11])), "GH", ["author"], null);
  assert.strictEqual(second.stack.bottom, null);
  assert.strictEqual(second.blockedByStack, false);
  assert.strictEqual(second.canBeMerged, true);
});

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
// A commit GitHub creates itself has `pushedDate: null`, and its
// `committedDate` can be later than your review of that very commit
// (clio#1884: review 17:07 on 740205f3, committedDate 19:44). The oid decides.
const headAt = (oid, at) => ({
  nodes: [{ commit: { oid, pushedDate: null, committedDate: at, statusCheckRollup: null } }],
});
test("mapPr.viewerReviewedHead: your review on the head commit wins over a later commit date", () => {
  const pr = github.mapPr(
    rawPr({
      latestOpinionatedReviews: { nodes: [{ ...myApproval, commit: { oid: "HEAD1" } }] },
      commits: headAt("HEAD1", "2026-07-07T11:00:00Z"),
    }),
    "GH",
    [],
    "rev",
  );
  assert.strictEqual(pr.viewerReviewedHead, true);
});
test("mapPr.viewerReviewedHead: false once the head moves past your review", () =>
  assert.strictEqual(
    github.mapPr(
      rawPr({
        latestOpinionatedReviews: { nodes: [{ ...myApproval, commit: { oid: "OLD" } }] },
        commits: headAt("HEAD2", "2026-07-07T11:00:00Z"),
      }),
      "GH",
      [],
      "rev",
    ).viewerReviewedHead,
    false,
  ));
test("mapPr.myReReviewDue: a later commit date on the commit you reviewed is not a push", () =>
  assert.strictEqual(
    reReviewDue({
      latestOpinionatedReviews: { nodes: [{ ...myChangeRequest, commit: { oid: "HEAD1" } }] },
      commits: headAt("HEAD1", "2026-07-07T11:00:00Z"),
    }),
    false,
  ));
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

// --- pr-group: a native stack reads bottom-up wherever it landed --------------
{
  const prGroup = require(path.join(__dirname, "../dist/main/shared/pr-group.js"));
  const spr = (number, stack = null, over = {}) => ({
    number,
    hostLabel: "GH",
    repo: "a/b",
    stack: stack && { number: stack[0], position: stack[1], size: 3, bottom: null },
    ...over,
  });
  const hpr = (id, issueKey, parentKey = null, over = {}) => ({
    id, issueKey, parentKey, issueSummary: `${issueKey} title`, parentSummary: parentKey && `${parentKey} title`, ...over,
  });
  const keysOf = (prs) => Object.fromEntries(prGroup.parentGroupKeys(prs));
  test("parentGroupKeys: PRs on a task with no parent group under the task itself", () => {
    // ENG-83724 "Code designer": a Task with no parent, five PRs — they were all in "Other".
    assert.deepStrictEqual(keysOf([hpr("a", "ENG-1"), hpr("b", "ENG-1")]), { a: "ENG-1", b: "ENG-1" });
  });
  test("parentGroupKeys: a task's own PR joins its subtasks' PRs, under the top key", () => {
    const prs = [hpr("sub1", "S-1", "T-1"), hpr("sub2", "S-2", "T-1"), hpr("task", "T-1", "E-1")];
    assert.deepStrictEqual(keysOf(prs), { sub1: "E-1", sub2: "E-1", task: "E-1" });
    assert.strictEqual(prGroup.groupLabel("E-1", prs, "parent"), "E-1 · E-1 title");
  });
  test("parentGroupKeys: without the task's PR, subtasks still group under their task", () => {
    const prs = [hpr("sub1", "S-1", "T-1"), hpr("sub2", "S-2", "T-1"), hpr("other", "S-9", "T-9")];
    assert.deepStrictEqual(keysOf(prs), { sub1: "T-1", sub2: "T-1", other: "T-9" });
    assert.strictEqual(prGroup.groupLabel("T-1", prs.slice(0, 2), "parent"), "T-1 · T-1 title");
  });
  test("parentGroupKeys: a subtask whose task has no PR joins the epic through its grandparent", () => {
    // ENG-104627 (subtask) -> ENG-103702 (task, no PR) -> ENG-102776 (epic): it sat
    // under the task while its sibling tasks' PRs clustered under the epic.
    const prs = [
      hpr("sub", "S-1", "T-1", { grandparentKey: "E-1", grandparentSummary: "E-1 title" }),
      hpr("t2", "T-2", "E-1"),
      hpr("t3", "T-3", "E-1"),
    ];
    assert.deepStrictEqual(keysOf(prs), { sub: "E-1", t2: "E-1", t3: "E-1" });
    // With only the subtask on the board, the heading's summary comes from its grandparent.
    assert.strictEqual(prGroup.groupLabel("E-1", prs.slice(0, 1), "parent"), "E-1 · E-1 title");
  });
  test("hiddenParentOf: names the task only when the heading skips over it", () => {
    const sub = hpr("sub", "S-1", "T-1", { grandparentKey: "E-1" });
    assert.deepStrictEqual(prGroup.hiddenParentOf(sub, "E-1"), { key: "T-1", summary: "T-1 title" });
    assert.strictEqual(prGroup.hiddenParentOf(sub, "T-1"), null); // the heading is the task
    assert.strictEqual(prGroup.hiddenParentOf(sub, null), null); // not in a parent cluster
    assert.strictEqual(prGroup.hiddenParentOf(hpr("t", "T-1", "E-1"), "E-1"), null); // a task's own PR
    assert.strictEqual(prGroup.hiddenParentOf(hpr("e", "E-1"), "E-1"), null); // no parent at all
  });
  test("parentGroupKeys: a PR with no issue key has no group", () => {
    assert.deepStrictEqual(keysOf([hpr("x", null), hpr("y", "ENG-2")]), { x: null, y: "ENG-2" });
  });
  test("groupLabel(parent): the key's summary comes from the PR whose own issue it is", () => {
    assert.strictEqual(prGroup.groupLabel("ENG-1", [hpr("a", "ENG-1")], "parent"), "ENG-1 · ENG-1 title");
    assert.strictEqual(prGroup.groupLabel("ENG-1", [hpr("a", "ENG-1", null, { issueSummary: null })], "parent"), "ENG-1");
  });
  test("orderStacks: a stack's PRs gather, bottom first, where the first of them was", () => {
    const list = [spr(1), spr(13, [7, 3]), spr(2), spr(11, [7, 1]), spr(3), spr(12, [7, 2])];
    assert.deepStrictEqual(prGroup.orderStacks(list).map((p) => p.number), [1, 11, 12, 13, 2, 3]);
  });
  test("orderStacks: the same stack number in another repo is another stack", () => {
    const list = [spr(2, [7, 2]), spr(5, [7, 1], { repo: "a/c" }), spr(1, [7, 1])];
    assert.deepStrictEqual(prGroup.orderStacks(list).map((p) => p.number), [1, 2, 5]);
  });
  test("orderStacks: a list without stacks comes back unchanged", () => {
    const list = [spr(3), spr(1), spr(2)];
    assert.strictEqual(prGroup.orderStacks(list), list);
  });
  // Exercise the actual grouping memo, including its numeric sort: testing
  // orderStacks alone missed the later sort that split stacks again.
  const appSource = require("node:fs").readFileSync(path.join(__dirname, "../src/renderer/src/App.tsx"), "utf8");
  const groupingBody = appSource.match(/const groups = useMemo<Group\[\] \| null>\(\(\) => \{([\s\S]*?)\}, \[sorted, groupBy, viewMode, sortBy\]\);/);
  assert.ok(groupingBody, "App.tsx grouping memo is available for regression tests");
  const ts = require("typescript");
  const groupingJs = ts.transpile(groupingBody[1], { target: ts.ScriptTarget.ES2022 });
  const groupPrs = new Function(
    "sorted", "groupBy", "viewMode", "sortBy", "helpers",
    `const { orderStacks, supportsGrouping, parentGroupKeys, groupKeyOf, groupLabel } = helpers;
     const OTHER_GROUP_KEY = "other";
     ${groupingJs}`,
  );
  const groupingHelpers = {
    ...prGroup,
    supportsGrouping: require("../dist/main/shared/view-mode.js").supportsGrouping,
  };
  for (const [scenario, members, expected] of [
    ["keeps native stack members adjacent", [spr(10, [7, 1]), spr(11), spr(12, [7, 2])], [10, 12, 11]],
    ["uses stack position before PR number", [spr(10, [7, 2]), spr(11), spr(12, [7, 1])], [12, 10, 11]],
    ["keeps a hand-made stack bottom-first", [
      spr(10, null, { headRefName: "top", baseRefName: "bottom", baseIsDefaultBranch: false }),
      spr(11),
      spr(12, null, { headRefName: "bottom", baseRefName: "main", baseIsDefaultBranch: true }),
    ], [12, 10, 11]],
    ["sorts unstacked PRs numerically", [spr(12), spr(10), spr(11)], [10, 11, 12]],
  ]) {
    test(`grouped By name: ${scenario} in Roomy and Compact`, () => {
      const prs = members.map((p) => ({ ...p, id: `pr${p.number}`, issueKey: "ENG-1", parentKey: "ENG-2" }));
      for (const view of ["roomy", "compact"]) {
        for (const mode of ["repo", "issue", "parent"]) {
          const groups = groupPrs(prGroup.orderStacks(prs), mode, view, "name", groupingHelpers);
          assert.deepStrictEqual(groups.map((g) => g.prs.map((p) => p.number)), [expected], `${view}/${mode}`);
          assert.deepStrictEqual(prs.map((p) => p.number), members.map((p) => p.number), "does not mutate input");
        }
      }
    });
  }
  // A hand-made stack: each PR opened on the previous one's branch (creatio-ui
  // ENG-83532: #4028 <- #4040 <- #4041 <- #4043 <- #4045, no native stack field).
  const cpr = (number, head, base, over = {}) => ({
    id: `n${number}`, number, title: `T${number}`, hostLabel: "GHE", repo: "e/ui", stack: null,
    headRefName: head, baseRefName: base, baseIsDefaultBranch: base === "main", ...over,
  });
  const chain = () => [
    cpr(4045, "h4045", "h4043"), cpr(4043, "h4043", "h4041"), cpr(4041, "h4041", "h4040"),
    cpr(4040, "h4040", "h4028"), cpr(4028, "h4028", "feature/x"),
  ];
  test("basePrIndex: each PR maps to the PR whose head is its base", () => {
    const idx = prGroup.basePrIndex(chain());
    assert.deepStrictEqual(
      Object.fromEntries([...idx].map(([id, base]) => [id, base.number])),
      { n4045: 4043, n4043: 4041, n4041: 4040, n4040: 4028 },
    );
  });
  test("basePrIndex: the same branch in another repo or host is not the base", () => {
    const list = [cpr(2, "h2", "h1"), cpr(1, "h1", "main", { repo: "e/other" }), cpr(3, "h1", "main", { hostLabel: "GH" })];
    assert.strictEqual(prGroup.basePrIndex(list).size, 0);
  });
  test("basePrIndex: a PR on the default branch or in a native stack has no hand-made base", () => {
    const list = [cpr(1, "h1", "main"), cpr(2, "h2", "h1", { baseIsDefaultBranch: true }), cpr(3, "h3", "h1", { stack: { number: 1, position: 2 } })];
    assert.strictEqual(prGroup.basePrIndex(list).size, 0);
  });
  test("orderStacks: a hand-made chain reads bottom first, where its first PR was", () => {
    const list = [cpr(9, "h9", "main"), ...chain(), cpr(8, "h8", "main")];
    assert.deepStrictEqual(prGroup.orderStacks(list).map((p) => p.number), [9, 4028, 4040, 4041, 4043, 4045, 8]);
  });
  test("orderStacks: two PRs on one base follow it, each with its own successors", () => {
    const list = [cpr(3, "h3", "h1"), cpr(4, "h4", "h2"), cpr(2, "h2", "h1"), cpr(1, "h1", "main")];
    assert.deepStrictEqual(prGroup.orderStacks(list).map((p) => p.number), [1, 3, 2, 4]);
  });
  test("orderStacks: a base cycle does not loop or drop PRs", () => {
    const list = [cpr(1, "a", "b", { baseIsDefaultBranch: false }), cpr(2, "b", "a", { baseIsDefaultBranch: false })];
    assert.deepStrictEqual(prGroup.orderStacks(list).map((p) => p.number).sort(), [1, 2]);
  });
  test("linkedPrPlace: on screen, scrolled away, or not rendered at all", () => {
    // The band the list is visible in: under a 100px sticky header, to 800px.
    assert.strictEqual(prGroup.linkedPrPlace([], 100, 800), "absent");
    assert.strictEqual(prGroup.linkedPrPlace([{ top: 300, bottom: 400 }], 100, 800), "visible");
    assert.strictEqual(prGroup.linkedPrPlace([{ top: 50, bottom: 150 }], 100, 800), "visible"); // partly under the header
    assert.strictEqual(prGroup.linkedPrPlace([{ top: -200, bottom: 90 }], 100, 800), "above"); // hidden by the header
    assert.strictEqual(prGroup.linkedPrPlace([{ top: 900, bottom: 1000 }], 100, 800), "below");
    assert.strictEqual(prGroup.linkedPrPlace([{ top: -500, bottom: -400 }, { top: 900, bottom: 1000 }], 100, 800), "below");
  });
  test("basePrTitle: names the base PR, or the branch when none is listed", () => {
    const [top, base] = chain();
    assert.match(prGroup.basePrTitle(top, base), /^Based on #4043 · T4043 \(h4043\)\. Merge #4043 first/);
    assert.strictEqual(prGroup.basePrTitle(top, undefined), "Based on h4043, not on the default branch");
  });
  test("stackTitle: names the PR that has to merge first", () => {
    const top = spr(14, null, { stack: { number: 7, position: 2, size: 2, bottom: { number: 13, url: "u" } } });
    assert.match(prGroup.stackTitle(top), /Stack #7: 2 of 2.*waits for #13/);
    assert.match(prGroup.stackTitle(spr(13, [7, 1])), /bottom PR/);
    assert.strictEqual(prGroup.stackTitle(spr(1)), "");
  });
}

// --- pr-group: what a Jira-keyed group heading says --------------------------
// The rendered heading is this PR's whole point, so it is a pure rule here rather
// than a closure inside App.tsx's grouping memo: these cases are what actually
// holds "KEY · Summary, or the bare key", where a DOM-less runner otherwise
// could not look.
{
  const prGroup = require(path.join(__dirname, "../dist/main/shared/pr-group.js"));
  const gpr = (over = {}) => ({
    issueKey: "ENG-93374",
    issueSummary: null,
    parentKey: "ENG-93367",
    parentSummary: null,
    ...over,
  });

  test("groupKeyOf: issue mode clusters by the PR's own key, parent mode by the parent", () => {
    assert.strictEqual(prGroup.groupKeyOf(gpr(), "issue"), "ENG-93374");
    assert.strictEqual(prGroup.groupKeyOf(gpr(), "parent"), "ENG-93367");
  });
  test("groupKeyOf: no key in this mode -> null (the PR falls to the Other bucket)", () => {
    assert.strictEqual(prGroup.groupKeyOf(gpr({ issueKey: null }), "issue"), null);
    assert.strictEqual(prGroup.groupKeyOf(gpr({ parentKey: null }), "parent"), null);
  });

  test("groupLabel: by issue, a resolved summary titles the heading", () =>
    assert.strictEqual(
      prGroup.groupLabel("ENG-93374", [gpr({ issueSummary: "Retry transient network errors" })], "issue"),
      "ENG-93374 · Retry transient network errors",
    ));
  test("groupLabel: by parent, the parent's summary is used and the issue's is ignored", () =>
    // Swapping the two branches would still produce a plausible-looking heading,
    // so pin which summary each mode reads: a PR carries both.
    assert.strictEqual(
      prGroup.groupLabel(
        "ENG-93367",
        [gpr({ issueSummary: "Retry transient network errors", parentSummary: "Analyze long app creating" })],
        "parent",
      ),
      "ENG-93367 · Analyze long app creating",
    ));
  test("groupLabel: nothing resolved -> the bare key (Jira off, or a key it doesn't know)", () =>
    // The pre-Jira behaviour, and the one every user without a Jira connection
    // still gets: the heading must stay usable, never "ENG-93374 · null".
    assert.strictEqual(
      prGroup.groupLabel("ENG-93374", [gpr(), gpr()], "issue"),
      "ENG-93374",
    ));
  test("groupLabel: an empty-string summary is no summary", () =>
    assert.strictEqual(
      prGroup.groupLabel("ENG-93374", [gpr({ issueSummary: "" })], "issue"),
      "ENG-93374",
    ));
  test("groupLabel: takes the first summary in the cluster, not the first PR's", () =>
    // The deliberate scan: one card without a summary must not blank a heading
    // its siblings can title.
    assert.strictEqual(
      prGroup.groupLabel("ENG-93374", [gpr(), gpr({ issueSummary: "Retry transient network errors" })], "issue"),
      "ENG-93374 · Retry transient network errors",
    ));
  test("groupLabel: an empty cluster is just the key (no crash, no separator)", () =>
    assert.strictEqual(prGroup.groupLabel("ENG-93374", [], "issue"), "ENG-93374"));
}

// --- view-mode: the display-variant switch -----------------------------------
// The mode is a persisted localStorage value, so the guard that reads it back is
// the only thing between a stale/garbled preference and a dashboard rendered in
// a mode that no longer exists. The two predicates are here because App.tsx uses
// each of them twice (skip the grouping pass / disable the control), and a
// hand-spelled `=== "cozy"` at four sites is what drifts.
{
  const viewMode = require(path.join(__dirname, "../dist/main/shared/view-mode.js"));

  test("isViewMode: accepts the three shipped modes", () => {
    for (const mode of ["roomy", "cozy", "compact"]) {
      assert.strictEqual(viewMode.isViewMode(mode), true, mode);
    }
  });
  test("isViewMode: rejects anything a stale preference could hold", () => {
    for (const bad of ["Roomy", "table", "", null, undefined, 3, {}, ["cozy"]]) {
      assert.strictEqual(viewMode.isViewMode(bad), false, JSON.stringify(bad));
    }
  });
  test("view-mode: roomy is the default and leads the switch", () => {
    assert.strictEqual(viewMode.DEFAULT_VIEW_MODE, "roomy");
    assert.strictEqual(viewMode.VIEW_MODES[0], "roomy");
  });
  test("supportsGrouping / usesListSort: cozy and board opt out", () => {
    // Cozy's table is flat and sorts by column, and the Board lays PRs out by
    // the agent's state, so BOTH header controls hand over to them. Roomy and
    // Compact are the same list at two sizes and keep them.
    assert.deepStrictEqual(viewMode.VIEW_MODES, ["roomy", "cozy", "compact", "board"]);
    assert.deepStrictEqual(
      viewMode.VIEW_MODES.map((m) => [viewMode.supportsGrouping(m), viewMode.usesListSort(m)]),
      [
        [true, true],
        [false, false],
        [true, true],
        [false, false],
      ],
    );
  });
  test("VIEW_MODE_TITLES: every mode has one (the switch is icon-only)", () => {
    // The icons are the whole control, so a missing title would leave a segment
    // with no name anywhere — including for a screen reader.
    for (const mode of viewMode.VIEW_MODES) {
      assert.ok(viewMode.VIEW_MODE_TITLES[mode], `${mode} has no title`);
    }
  });
}

// --- pr-table: the Cozy table's columns and ordering -------------------------
// A sortable column is a promise about ordering, which is exactly what a
// DOM-less runner can hold: each comparator must order by what its cell SHOWS
// (worst CI first, smallest age = newest), and the tie-break must not follow the
// flipped direction into "least recently updated".
{
  const prTable = require(path.join(__dirname, "../dist/main/shared/pr-table.js"));
  const CTX = { trackComments: true };
  const tpr = (o = {}) => ({
    id: "n1",
    repo: "clio",
    number: 10,
    title: "Retry transient network errors",
    author: { login: "ann", avatarUrl: "" },
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
    roles: ["author"],
    reviewers: [],
    reviewDecision: null,
    checks: [{ name: "build", kind: "check", state: "success", url: null }],
    failingChecks: [],
    pendingChecks: [],
    ciState: "success",
    hasUnaddressedChangeRequest: false,
    hasUnaddressedComments: false,
    hasConflicts: false,
    hasNoReviews: false,
    hasHumanApproval: false,
    hasNewActivity: false,
    awaitingReview: false,
    returnedToMe: false,
    myReReviewDue: false,
    unresolvedThreads: 0,
    totalComments: 0,
    isDraft: false,
    isIgnored: false,
    ...o,
  });
  const rev = (login, reviewState) => ({ login, avatarUrl: "", reviewState });

  test("TABLE_COLUMNS: twelve unique columns, only Reviewers, Agent and Actions unsortable", () => {
    const keys = prTable.TABLE_COLUMNS.map((c) => c.key);
    assert.strictEqual(keys.length, 12);
    assert.strictEqual(new Set(keys).size, keys.length, "duplicate column key");
    assert.ok(!keys.includes("role"), "the Role column was removed");
    assert.deepStrictEqual(
      prTable.TABLE_COLUMNS.filter((c) => !c.sortable).map((c) => c.key),
      ["reviewers", "agent", "actions"],
    );
  });

  test("visibleColumns: the Agent column shows only while the agent is on, just before Actions", () => {
    const on = prTable.visibleColumns(true).map((c) => c.key);
    const off = prTable.visibleColumns(false).map((c) => c.key);
    assert.deepStrictEqual(on, prTable.TABLE_COLUMNS.map((c) => c.key));
    assert.deepStrictEqual(on.slice(-2), ["agent", "actions"]);
    assert.deepStrictEqual(off, on.filter((k) => k !== "agent"));
  });

  test("TABLE_MIN_WIDTH_REM: every column declares a minimum and the table's floor is their sum", () => {
    // The floor has to be enforced on the table, not on the cells — a
    // fixed-layout table ignores a cell `min-width` — so a column added without
    // a minimum would silently shrink the others instead of widening the table.
    // The floor is the agent-off table's; the Agent column adds its own share.
    for (const col of prTable.TABLE_COLUMNS) {
      assert.ok(col.minWidthRem > 0, `${col.key} declares no minimum width`);
    }
    assert.strictEqual(
      prTable.TABLE_MIN_WIDTH_REM,
      prTable.visibleColumns(false).reduce((sum, c) => sum + c.minWidthRem, 0),
    );
    const agentMin = prTable.TABLE_COLUMNS.find((c) => c.key === "agent").minWidthRem;
    assert.strictEqual(prTable.tableMinWidthRem({}, false, true), prTable.TABLE_MIN_WIDTH_REM + agentMin);
    assert.strictEqual(prTable.tableMinWidthRem({ agent: 4 }, false, false), prTable.TABLE_MIN_WIDTH_REM, "a hidden column's width is not counted");
  });

  test("clampColumnWidth: a dragged width is held inside the bounds", () => {
    assert.strictEqual(prTable.clampColumnWidth(40), 40);
    assert.strictEqual(prTable.clampColumnWidth(0.5), prTable.COLUMN_MIN_REM);
    assert.strictEqual(prTable.clampColumnWidth(5000), prTable.COLUMN_MAX_REM);
    assert.ok(prTable.COLUMN_MIN_REM > 0 && prTable.COLUMN_MAX_REM > prTable.COLUMN_MIN_REM);
  });
  test("clampColumnWidth: anything that isn't a width answers null — the default width", () => {
    // Null is the un-dragged state, so a corrupt persisted value (or a NaN from
    // measuring a column that isn't on screen) restores the default layout
    // instead of collapsing the column to nothing.
    for (const bad of [NaN, Infinity, null, undefined, "32", {}]) {
      assert.strictEqual(prTable.clampColumnWidth(bad), null, String(bad));
    }
  });
  test("parseColumnWidths: keeps known columns, clamps, drops the rest one by one", () => {
    assert.deepStrictEqual(
      prTable.parseColumnWidths({ pr: 40, author: 0.1, role: 9, ci: "x", age: 5000 }),
      { pr: 40, author: prTable.COLUMN_MIN_REM, age: prTable.COLUMN_MAX_REM },
    );
    for (const bad of [null, undefined, 3, "pr"]) {
      assert.deepStrictEqual(prTable.parseColumnWidths(bad), {}, String(bad));
    }
    // The pre-2.1 shape migrates through the same parser: `{ pr: null }` means elastic.
    assert.deepStrictEqual(prTable.parseColumnWidths({ pr: null }), {});
  });

  test("repoShortName: drops the owner, keeps a bare name as is", () => {
    assert.strictEqual(prTable.repoShortName("Advance-Technologies-Foundation/clio"), "clio");
    assert.strictEqual(prTable.repoShortName("engineering/creatio-ui"), "creatio-ui");
    assert.strictEqual(prTable.repoShortName("clio"), "clio");
  });
  test("compareForColumn repo: sorts by the short name the cell shows", () => {
    const a = { repo: "zeta-org/alpha", number: 1 };
    const b = { repo: "acme/beta", number: 1 };
    assert.ok(prTable.compareForColumn(a, b, "repo", { trackComments: false }) < 0);
  });

  test("tableMinWidthRem: un-dragged is the plain sum; a dragged column swaps in its width", () => {
    assert.strictEqual(prTable.tableMinWidthRem({}, false), prTable.TABLE_MIN_WIDTH_REM);
    const prMin = prTable.TABLE_COLUMNS.find((c) => c.key === "pr").minWidthRem;
    const authorMin = prTable.TABLE_COLUMNS.find((c) => c.key === "author").minWidthRem;
    assert.strictEqual(
      prTable.tableMinWidthRem({ pr: 50, author: 2 }, false),
      prTable.TABLE_MIN_WIDTH_REM - prMin + 50 - authorMin + 2,
    );
    // The Claude button widens an undragged Actions column, not a dragged one.
    assert.strictEqual(
      prTable.tableMinWidthRem({}, true),
      prTable.TABLE_MIN_WIDTH_REM + prTable.CLAUDE_ACTIONS_EXTRA_REM,
    );
    assert.strictEqual(prTable.tableMinWidthRem({ actions: 6 }, true), prTable.tableMinWidthRem({ actions: 6 }, false));
  });

  test("isTableSort: accepts a stored sortable column with a direction", () =>
    assert.strictEqual(prTable.isTableSort({ key: "age", dir: "desc" }), true));
  test("isTableSort: rejects an unknown column, the unsortable one, and a bad shape", () => {
    // The stored value drives `sortForTable`, so a column that no longer exists
    // must fall back to the default instead of ordering the table by nothing.
    for (const bad of [
      { key: "role", dir: "asc" },
      { key: "reviewers", dir: "asc" },
      { key: "actions", dir: "asc" },
      { key: "age", dir: "up" },
      { key: "age" },
      "age",
      null,
    ]) {
      assert.strictEqual(prTable.isTableSort(bad), false, JSON.stringify(bad));
    }
  });

  test("nextTableSort: a new column takes ITS own default direction", () => {
    // Not the previous column's: "most comments first" inherited by Age would
    // mean the first click on Age showed the newest PRs, which is not what the
    // header's arrow would then be claiming.
    assert.deepStrictEqual(prTable.nextTableSort({ key: "pr", dir: "asc" }, "comments"), {
      key: "comments",
      dir: "desc",
    });
    assert.deepStrictEqual(prTable.nextTableSort({ key: "comments", dir: "desc" }, "pr"), {
      key: "pr",
      dir: "asc",
    });
  });
  test("nextTableSort: clicking the active column flips it", () => {
    assert.deepStrictEqual(prTable.nextTableSort({ key: "age", dir: "desc" }, "age"), {
      key: "age",
      dir: "asc",
    });
    assert.deepStrictEqual(prTable.nextTableSort({ key: "age", dir: "asc" }, "age"), {
      key: "age",
      dir: "desc",
    });
  });
  test("nextTableSort: the Actions header is a no-op, not an error", () => {
    const current = { key: "signal", dir: "asc" };
    assert.strictEqual(prTable.nextTableSort(current, "actions"), current);
  });

  test("compareForColumn(age): ascending is the smallest age — the newest PR", () => {
    const newer = tpr({ createdAt: "2026-09-19T00:00:00Z" });
    const older = tpr({ createdAt: "2026-08-01T00:00:00Z" });
    assert.ok(prTable.compareForColumn(newer, older, "age", CTX) < 0);
    // …so the column's first click, which is `desc`, is "oldest first".
    assert.strictEqual(prTable.TABLE_COLUMNS.find((c) => c.key === "age").defaultDir, "desc");
  });
  test("compareForColumn(updated): ascending is the oldest activity", () =>
    assert.ok(
      prTable.compareForColumn(
        tpr({ updatedAt: "2026-09-01T00:00:00Z" }),
        tpr({ updatedAt: "2026-09-20T00:00:00Z" }),
        "updated",
        CTX,
      ) < 0,
    ));
  test("compareForColumn(repo): repository first, then number", () => {
    assert.ok(prTable.compareForColumn(tpr({ repo: "aaa" }), tpr({ repo: "zzz" }), "repo", CTX) < 0);
    assert.ok(
      prTable.compareForColumn(tpr({ number: 7 }), tpr({ number: 700 }), "repo", CTX) < 0,
      "same repo orders by number, not by the number's text",
    );
  });
  test("compareForColumn(pr): by number alone, across repositories", () => {
    assert.ok(
      prTable.compareForColumn(tpr({ repo: "zzz", number: 7 }), tpr({ repo: "aaa", number: 700 }), "pr", CTX) < 0,
    );
  });
  test("compareForColumn(author): a PR with no author sorts last, not first", () =>
    assert.ok(prTable.compareForColumn(tpr(), tpr({ author: null }), "author", CTX) < 0));

  test("ciRank: failing, then running, then green — and 'no checks' last of all", () => {
    const rank = (o) => prTable.ciRank(tpr(o));
    const failing = rank({ ciState: "failure" });
    const pending = rank({ ciState: "pending" });
    const green = rank({ ciState: "success" });
    const none = rank({ checks: [] });
    assert.ok(failing < pending && pending < green, "worst CI must sort first");
    // The absence of CI is not good news: mixing it in with success would bury
    // the PRs that are actually green.
    assert.ok(green < none, "'no checks' must not outrank a passing build");
  });

  test("reviewRank: a standing change request first, a full set of approvals last", () => {
    const changes = prTable.reviewRank(tpr({ reviewDecision: "CHANGES_REQUESTED" }));
    const unaddressed = prTable.reviewRank(tpr({ hasUnaddressedChangeRequest: true }));
    const untouched = prTable.reviewRank(tpr({ hasNoReviews: true }));
    const partial = prTable.reviewRank(
      tpr({ hasHumanApproval: true, reviewers: [rev("ann", "approved"), rev("bob", "pending")] }),
    );
    const done = prTable.reviewRank(
      tpr({ hasHumanApproval: true, reviewers: [rev("ann", "approved")] }),
    );
    assert.strictEqual(changes, unaddressed, "either form of change request ranks the same");
    assert.ok(changes < untouched && untouched < partial && partial < done);
  });
  test("reviewRank: a required review still pending ranks with the partial approvals", () => {
    // Every listed user reviewer approved, yet a code owner's review is missing.
    const pr = tpr({ hasHumanApproval: true, reviewers: [rev("ann", "approved")] });
    assert.strictEqual(prTable.reviewRank({ ...pr, requiredReviewPending: true }), 3);
    assert.strictEqual(prTable.reviewRank({ ...pr, requiredReviewPending: false }), 4);
  });

  test("approvalTally: counts approvals out of the reviewers on the PR", () =>
    assert.deepStrictEqual(
      prTable.approvalTally(tpr({ reviewers: [rev("ann", "approved"), rev("bob", "pending")] })),
      { approved: 1, total: 2 },
    ));
  test("approvalTally: null when nobody is requested (the cell prints a dash)", () =>
    assert.strictEqual(prTable.approvalTally(tpr()), null));

  test("primaryRole: author outranks an owed review, which outranks a done one", () => {
    assert.strictEqual(prTable.primaryRole(tpr({ roles: ["reviewed", "author"] })), "author");
    assert.strictEqual(prTable.primaryRole(tpr({ roles: ["reviewed", "reviewer"] })), "reviewer");
    assert.strictEqual(prTable.primaryRole(tpr({ roles: ["reviewed"] })), "reviewed");
    assert.strictEqual(prTable.primaryRole(tpr({ roles: [] })), null);
  });

  test("compareForColumn(signal): the same severity the card accents use", () => {
    const blocked = tpr({ failingChecks: [{ name: "ci", kind: "check", state: "failure", url: null }] });
    const mine = tpr({ roles: ["reviewer"] });
    assert.ok(prTable.compareForColumn(blocked, mine, "signal", CTX) < 0);
    assert.ok(prTable.compareForColumn(mine, tpr(), "signal", CTX) < 0);
  });

  test("compareForColumn(comments): unresolved threads first, total comments break the tie", () => {
    assert.ok(
      prTable.compareForColumn(tpr({ unresolvedThreads: 1 }), tpr({ unresolvedThreads: 4 }), "comments", CTX) < 0,
    );
    assert.ok(
      prTable.compareForColumn(tpr({ totalComments: 1 }), tpr({ totalComments: 9 }), "comments", CTX) < 0,
    );
  });

  test("sortForTable: the tie-break is most-recently-updated and does NOT flip with the direction", () => {
    // Both rows are green with checks, so the CI column can't separate them.
    // Reversing the column must not reverse the fallback into "stalest first" —
    // that would reshuffle rows the user did not ask to reorder.
    const old = tpr({ id: "a", updatedAt: "2026-09-01T00:00:00Z" });
    const fresh = tpr({ id: "b", updatedAt: "2026-09-20T00:00:00Z" });
    const asc = prTable.sortForTable([old, fresh], { key: "ci", dir: "asc" }, CTX);
    const desc = prTable.sortForTable([old, fresh], { key: "ci", dir: "desc" }, CTX);
    assert.deepStrictEqual(asc.map((p) => p.id), ["b", "a"]);
    assert.deepStrictEqual(desc.map((p) => p.id), ["b", "a"]);
  });
  test("sortForTable: direction applies to the chosen column", () => {
    const failing = tpr({ id: "f", ciState: "failure", failingChecks: [{ name: "ci", kind: "check", state: "failure", url: null }] });
    const green = tpr({ id: "g" });
    assert.deepStrictEqual(
      prTable.sortForTable([green, failing], { key: "ci", dir: "asc" }, CTX).map((p) => p.id),
      ["f", "g"],
    );
    assert.deepStrictEqual(
      prTable.sortForTable([green, failing], { key: "ci", dir: "desc" }, CTX).map((p) => p.id),
      ["g", "f"],
    );
  });
  test("sortForTable: leaves the input array alone", () => {
    const input = [tpr({ id: "a" }), tpr({ id: "b", updatedAt: "2026-09-20T00:00:00Z" })];
    prTable.sortForTable(input, { key: "updated", dir: "desc" }, CTX);
    assert.deepStrictEqual(input.map((p) => p.id), ["a", "b"]);
  });
}

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
test("enrichmentSkipReason: no-config only when the site is missing", () => {
  assert.strictEqual(jiraHealth.enrichmentSkipReason(undefined, 3), "no-config");
  assert.strictEqual(jiraHealth.enrichmentSkipReason({ email: "me@x.com" }, 3), "no-config");
  // A site without an email runs: twg needs nothing else.
  assert.strictEqual(jiraHealth.enrichmentSkipReason({ baseUrl: "https://org.atlassian.net" }, 3), null);
});
test("canUseToken: needs the site, the email and a stored token", () => {
  assert.strictEqual(jiraHealth.canUseToken(JH_CFG, true), true);
  assert.strictEqual(jiraHealth.canUseToken(JH_CFG, false), false);
  assert.strictEqual(jiraHealth.canUseToken({ baseUrl: "https://org.atlassian.net" }, true), false);
  assert.strictEqual(jiraHealth.canUseToken(undefined, true), false);
});
test("jiraConfigured: an installed twg is enough, signed in or not; without twg the token fallback must be usable", () => {
  const site = { baseUrl: "https://org.atlassian.net" };
  assert.strictEqual(jiraHealth.jiraConfigured(site, { state: "signed-in" }, false), true);
  // An expired twg session keeps grouping set up: losing it would reset the
  // user's saved "Group by parent task" — the auth banner reports the expiry.
  assert.strictEqual(jiraHealth.jiraConfigured(site, { state: "signed-out" }, false), true);
  assert.strictEqual(jiraHealth.jiraConfigured(site, { state: "error" }, false), true);
  assert.strictEqual(jiraHealth.jiraConfigured(site, { state: "not-installed" }, true), false); // no email
  assert.strictEqual(jiraHealth.jiraConfigured(JH_CFG, { state: "not-installed" }, true), true);
  assert.strictEqual(jiraHealth.jiraConfigured(JH_CFG, { state: "not-installed" }, false), false);
  assert.strictEqual(jiraHealth.jiraConfigured(undefined, { state: "signed-in" }, true), false);
});
test("signInSource: twg only when signed in, else the token with its email, else none", () => {
  const site = { baseUrl: "https://org.atlassian.net" };
  assert.strictEqual(jiraHealth.signInSource(JH_CFG, { state: "signed-in" }, true), "twg");
  assert.strictEqual(jiraHealth.signInSource(JH_CFG, { state: "signed-out" }, true), "token");
  assert.strictEqual(jiraHealth.signInSource(JH_CFG, { state: "checking" }, true), "token");
  assert.strictEqual(jiraHealth.signInSource(site, { state: "signed-out" }, true), null); // no email
  assert.strictEqual(jiraHealth.signInSource(site, { state: "checking" }, false), null);
  assert.strictEqual(jiraHealth.signInSource(undefined, { state: "signed-in" }, true), null);
});
test("jiraConfigured: a twg still being checked keeps grouping set up", () => {
  assert.strictEqual(jiraHealth.jiraConfigured({ baseUrl: "https://org.atlassian.net" }, { state: "checking" }, false), true);
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
test("jiraSiteState: a site without an email is a configured connection (twg needs only the site)", () =>
  assert.deepStrictEqual(
    jiraHealth.jiraSiteState(() => ({ jira: { baseUrl: "https://org.atlassian.net" } })),
    { hasConfig: true, baseUrl: "https://org.atlassian.net" },
  ));
test("jiraSiteState: a throwing loadSettings fails closed instead of propagating", () =>
  assert.deepStrictEqual(
    jiraHealth.jiraSiteState(() => {
      throw new Error("settings.json: JSON parse error");
    }),
    { hasConfig: false, baseUrl: null },
  ));

test("enrichmentSkipReason: no-keys when configured but zero keys", () =>
  assert.strictEqual(jiraHealth.enrichmentSkipReason(JH_CFG, 0), "no-keys"));
test("enrichmentSkipReason: null (run) when config and keys are present", () =>
  assert.strictEqual(jiraHealth.enrichmentSkipReason(JH_CFG, 2), null));
test("healthFromResolution: ok when >=1 parent resolved", () =>
  assert.deepStrictEqual(jiraHealth.healthFromResolution(3, 2), { state: "ok", queried: 3, resolved: 2 }));
test("healthFromResolution: empty when nothing resolved", () =>
  assert.deepStrictEqual(jiraHealth.healthFromResolution(3, 0), { state: "empty", queried: 3, resolved: 0 }));
// `resolved` counts parents, not issues that came back — the two diverged when
// the lookup started returning parentless issues for their own summaries. Get it
// wrong and a Jira that resolves every summary but no parent reports `ok`,
// silencing the one banner that explains an empty "Group by parent task".
test("healthFromIssues: counts parents, not the issues that resolved", () =>
  assert.deepStrictEqual(
    jiraHealth.healthFromIssues(3, [
      { parentKey: "ENG-1" },
      { parentKey: null },
      { parentKey: "ENG-1" },
    ]),
    { state: "ok", queried: 3, resolved: 2 },
  ));
test("healthFromIssues: every key resolved but none is a subtask -> empty", () =>
  // The regression this guards: summaries came back, so the by-issue heading is
  // fine and needs no banner — but by-parent has nothing to cluster and must say
  // so. Counting issues here would report ok=2 and leave that view silently bare.
  assert.deepStrictEqual(
    jiraHealth.healthFromIssues(2, [{ parentKey: null }, { parentKey: null }]),
    { state: "empty", queried: 2, resolved: 0 },
  ));
test("healthFromIssues: nothing resolved at all -> empty, with the queried count kept", () =>
  assert.deepStrictEqual(jiraHealth.healthFromIssues(2, []), {
    state: "empty",
    queried: 2,
    resolved: 0,
  }));
// The pure rule above is only worth anything if the enricher routes through it,
// which the behavioral `buildJiraEnricher` cases (further down, against a mocked
// Electron) exercise through the enricher's real output.
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
test("healthFromError: a JiraAuthError becomes the auth state, naming the rejected source", () => {
  for (const source of ["token", "twg"]) {
    const health = jiraHealth.healthFromError(2, new jira.JiraAuthError("rejected", source), "twg");
    assert.deepStrictEqual(health, { state: "auth", message: "rejected", queried: 2, resolved: 0, source });
  }
});
test("healthFromError: an ordinary error keeps the pass's source", () =>
  assert.deepStrictEqual(jiraHealth.healthFromError(1, new Error("HTTP 500"), "twg"), {
    state: "error",
    message: "HTTP 500",
    queried: 1,
    resolved: 0,
    source: "twg",
  }));
test("shouldNotifyJiraAuth: fires on entering auth, not on staying there", () => {
  const auth = (source) => ({ state: "auth", queried: 1, resolved: 0, source });
  const ok = { state: "ok", queried: 1, resolved: 1 };
  assert.strictEqual(jiraHealth.shouldNotifyJiraAuth(ok, auth("token")), true);
  assert.strictEqual(jiraHealth.shouldNotifyJiraAuth(undefined, auth("token")), true);
  assert.strictEqual(jiraHealth.shouldNotifyJiraAuth(auth("token"), auth("token")), false);
  // A different credential failing is news of its own.
  assert.strictEqual(jiraHealth.shouldNotifyJiraAuth(auth("twg"), auth("token")), true);
  assert.strictEqual(jiraHealth.shouldNotifyJiraAuth(auth("token"), ok), false);
  assert.strictEqual(jiraHealth.shouldNotifyJiraAuth(ok, undefined), false);
});

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
  myReReviewDue: false,
  pendingChecks: [],
  ...over,
});
const ST = {
  role: "all",
  host: "all",
  author: null,
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

// The author filter: an exact login, so it is not the search box's substring
// match — "octo" in a title must not pull in a PR by someone else.
const BY_OCTOCAT = mkPr({ author: { login: "octocat" } });
const BY_OCTO = mkPr({ author: { login: "octo" }, title: "octocat docs" });
const NO_AUTHOR = mkPr({ author: null });
const AUTHORED = [BY_OCTOCAT, BY_OCTO, NO_AUTHOR];
test("filterPrs: no author filter keeps every author, a missing one too", () =>
  assert.strictEqual(prFilter.filterPrs(AUTHORED, st()).length, 3));
test("filterPrs: the author filter keeps that exact login only", () => {
  assert.deepStrictEqual(prFilter.filterPrs(AUTHORED, st({ author: "octocat" })), [BY_OCTOCAT]);
  assert.deepStrictEqual(prFilter.filterPrs(AUTHORED, st({ author: "octo" })), [BY_OCTO]);
});
test("filterPrs: the author filter narrows the sources' union, like host", () => {
  const failingOther = mkPr({ author: { login: "octo" }, failingChecks: [{ name: "build" }] });
  assert.deepStrictEqual(
    prFilter.filterPrs([BY_OCTOCAT, failingOther], st({ author: "octocat", failingOnly: true })),
    [],
  );
});
test("sourceFacetCount: a source badge counts within the author filter", () => {
  const failing = mkPr({ author: { login: "octocat" }, failingChecks: [{ name: "build" }] });
  const failingOther = mkPr({ author: { login: "octo" }, failingChecks: [{ name: "build" }] });
  assert.strictEqual(prFilter.sourceFacetCount([failing, failingOther], st({ author: "octocat" }), "failing"), 1);
});
test("toggleAuthor: an author click sets, replaces and, on the same author, clears", () => {
  assert.strictEqual(prFilter.toggleAuthor(null, "octocat"), "octocat");
  assert.strictEqual(prFilter.toggleAuthor("octo", "octocat"), "octocat");
  assert.strictEqual(prFilter.toggleAuthor("octocat", "octocat"), null);
});
test("emptyStateKind: an author filter that matches nothing is a no-match, not all-hidden", () =>
  assert.strictEqual(prFilter.emptyStateKind(st({ author: "ghost" }), 3), "no-match"));

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

test("isRevealChipShown: an OFF chip whose category has rows to add renders", () => {
  assert.strictEqual(prFilter.isRevealChipShown(IGNORED_DRAFTS, st(), "drafts"), true);
  assert.strictEqual(prFilter.isRevealChipShown(IGNORED_DRAFTS, st(), "ignored"), true);
});
test("isRevealChipShown: an OFF chip over an empty category is hidden", () => {
  assert.strictEqual(prFilter.isRevealChipShown([], st(), "drafts"), false);
  assert.strictEqual(prFilter.isRevealChipShown([], st(), "ignored"), false);
});
test("isRevealChipShown: an OFF chip whose rows the other filters exclude is hidden", () =>
  assert.strictEqual(
    prFilter.isRevealChipShown(IGNORED_DRAFTS, st({ mergeableOnly: true }), "drafts"),
    false,
  ));
// The guarantee the old "every chip always renders" rule gave: a persisted
// reveal must keep its control, or it is an active filter nobody can switch off.
test("isRevealChipShown: an ON chip renders even over an empty category", () => {
  assert.strictEqual(prFilter.isRevealChipShown([], st({ showDrafts: true }), "drafts"), true);
  assert.strictEqual(prFilter.isRevealChipShown([], st({ showIgnored: true }), "ignored"), true);
});
// Every draft here is also ignored, so the sibling-aware badge drops to 0 the
// moment the other chip turns on. Visibility must not follow it, or a click on
// Ignored mounts / unmounts Drafts next to it and the clicked chip slides away
// from the cursor.
for (const [key, sibling] of [
  ["drafts", "showIgnored"],
  ["ignored", "showDrafts"],
]) {
  test(`isRevealChipShown(${key}): the sibling chip's click does not change it`, () => {
    for (const own of [false, true]) {
      const flag = key === "drafts" ? "showDrafts" : "showIgnored";
      const off = prFilter.isRevealChipShown(IGNORED_DRAFTS, st({ [flag]: own, [sibling]: false }), key);
      const on = prFilter.isRevealChipShown(IGNORED_DRAFTS, st({ [flag]: own, [sibling]: true }), key);
      assert.strictEqual(on, off);
      assert.strictEqual(on, true);
    }
  });
}

// Crossed cases on purpose: verb and plural must each follow their own argument.
test("hideApprovalsTitle: the verb follows `active`, the plural follows the count", () => {
  assert.strictEqual(
    prFilter.hideApprovalsTitle(false, 1),
    "Hide 1 PR you approved that isn't asking for you again",
  );
  assert.strictEqual(
    prFilter.hideApprovalsTitle(true, 1),
    "Hiding 1 PR you approved that isn't asking for you again",
  );
  assert.strictEqual(
    prFilter.hideApprovalsTitle(false, 3),
    "Hide 3 PRs you approved that aren't asking for you again",
  );
  assert.strictEqual(
    prFilter.hideApprovalsTitle(true, 3),
    "Hiding 3 PRs you approved that aren't asking for you again",
  );
});
// The badge is dropped at 0, so the title is the only place the 0 is spelled out.
test("hideApprovalsTitle: spells out 0 in the plural", () => {
  assert.strictEqual(
    prFilter.hideApprovalsTitle(false, 0),
    "Hide 0 PRs you approved that aren't asking for you again",
  );
  assert.strictEqual(
    prFilter.hideApprovalsTitle(true, 0),
    "Hiding 0 PRs you approved that aren't asking for you again",
  );
});

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
// States a badge is measured under. For a source chip the badge is that source's
// size under the non-source narrowing, so a state with a sibling source on (the
// last two) must leave the number alone.
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
// Keys come from SOURCE_CHIPS rather than a hardcoded list, so a sixth source
// cannot be added without inheriting both invariants.
const sourcesOff = (state) =>
  prFilter.SOURCE_CHIPS.reduce((acc, c) => ({ ...acc, [c.flag]: false }), state);
for (const chip of prFilter.SOURCE_CHIPS) {
  for (const [i, state] of FACET_STATES.entries()) {
    // The badge is the source's own size under the non-source narrowing, which
    // is exactly the row count with this source as the ONLY one active.
    test(`sourceFacetCount(${chip.key}) is its size under the other narrowing [state ${i}]`, () =>
      assert.strictEqual(
        prFilter.sourceFacetCount(MIXED, state, chip.key),
        prFilter.filterPrs(MIXED, { ...sourcesOff(state), [chip.flag]: true }).length,
      ));
    // And it never moves when a sibling source is toggled — the property that
    // keeps every source chip clickable while another one is on.
    test(`sourceFacetCount(${chip.key}) ignores the sibling sources [state ${i}]`, () => {
      const base = prFilter.sourceFacetCount(MIXED, state, chip.key);
      for (const other of prFilter.SOURCE_CHIPS) {
        if (other.key === chip.key) continue;
        assert.strictEqual(
          prFilter.sourceFacetCount(MIXED, { ...state, [other.flag]: !state[other.flag] }, chip.key),
          base,
        );
      }
    });
  }
}
test("sourceFacetCount: counts hidden drafts only once a reveal chip surfaces them", () => {
  // Two PRs have hasNoReviews; one of them is a draft, hidden by default.
  assert.strictEqual(prFilter.sourceFacetCount(MIXED, st(), "noReviews"), 1);
  assert.strictEqual(prFilter.sourceFacetCount(MIXED, st({ showDrafts: true }), "noReviews"), 2);
});
test("sourceFacetCount: honours host, role and search", () => {
  assert.strictEqual(prFilter.sourceFacetCount(MIXED, st({ host: "GHE" }), "attention"), 1);
  assert.strictEqual(prFilter.sourceFacetCount(MIXED, st({ role: "reviewer" }), "noReviews"), 1);
  assert.strictEqual(prFilter.sourceFacetCount(MIXED, st({ search: "bump" }), "noReviews"), 1);
});

// --- pr-filter: the sources are a union, not an intersection -----------------
// The bug report: Needs attention + Ready to merge showed (almost) nothing,
// because the two chips were AND-ed. MIXED[0] needs attention only, MIXED[1]
// needs attention AND is mergeable.
test("filterPrs: two sources show both piles, not their intersection", () =>
  assert.strictEqual(
    prFilter.filterPrs(MIXED, st({ attentionOnly: true, mergeableOnly: true })).length,
    2,
  ));
test("filterPrs: a PR in both sources is listed once", () => {
  const both = prFilter.filterPrs(MIXED, st({ attentionOnly: true, mergeableOnly: true }));
  assert.strictEqual(new Set(both.map((pr) => pr.number)).size, both.length);
});
test("filterPrs: no source active is still the plain baseline", () =>
  assert.strictEqual(prFilter.filterPrs(MIXED, st()).length, 3));
test("filterPrs: role, host and search narrow the union rather than the other way round", () => {
  const sources = { attentionOnly: true, noReviewsOnly: true };
  assert.strictEqual(prFilter.filterPrs(MIXED, st(sources)).length, 3);
  assert.strictEqual(prFilter.filterPrs(MIXED, st({ ...sources, role: "reviewer" })).length, 1);
  assert.strictEqual(prFilter.filterPrs(MIXED, st({ ...sources, host: "GHE" })).length, 1);
  assert.strictEqual(prFilter.filterPrs(MIXED, st({ ...sources, search: "bump" })).length, 1);
});
test("filterPrs: Hide my approvals applies on top of the union", () => {
  const prs = [
    mkPr({ canBeMerged: true, viewerApproved: true, roles: ["reviewed"] }),
    mkPr({ needsAttention: true }),
  ];
  const sources = { attentionOnly: true, mergeableOnly: true };
  assert.strictEqual(prFilter.filterPrs(prs, st(sources)).length, 2);
  assert.strictEqual(prFilter.filterPrs(prs, st({ ...sources, hideApproved: true })).length, 1);
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
  // New comments after your approval are not a request: clio#1884, approved,
  // "Back to you" only because someone commented, stayed on the board.
  ["approved, new comments since", mkPr({ viewerApproved: true, roles: ["reviewed"], returnedToMe: true }), true],
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
  // Back to you only through comments: not a request, so the chip hides it.
  mkPr({ viewerApproved: true, roles: ["reviewed"], returnedToMe: true, title: "approved, comments since" }),
];
test("filterPrs(hideApproved): drops finished approvals, keeps the re-requested one", () =>
  assert.deepStrictEqual(
    prFilter.filterPrs(APPROVALS, st({ hideApproved: true })).map((pr) => pr.title),
    ["approved then re-requested", "still waiting on me", "mine"],
  ));
test("filterPrs(hideApproved): off by default — nothing disappears unasked", () =>
  // Five of six: the approved draft is hidden by the draft gate, not by this chip.
  assert.strictEqual(prFilter.filterPrs(APPROVALS, st()).length, 5));
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
// `reviewer` back alongside it. The segments do not overlap: a PR asked of you
// is under `To review` only, since in `Reviewed` it read as already done.
const BY_ROLE = [
  mkPr({ roles: ["author"], title: "mine" }),
  mkPr({ roles: ["reviewer"], title: "asked of me" }),
  mkPr({ roles: ["reviewed"], title: "already reviewed" }),
  mkPr({ roles: ["reviewer", "reviewed"], title: "re-requested" }),
];
const titlesFor = (role) => prFilter.filterPrs(BY_ROLE, st({ role })).map((pr) => pr.title);
test("filterPrs(role): 'reviewed' leaves out a re-requested PR — it waits on you, so To review only", () =>
  assert.deepStrictEqual(titlesFor("reviewed"), ["already reviewed"]));
test("filterPrs(role): 'reviewed' leaves out your own PR you replied in", () => {
  // creatio-ui#3985: a reply in its own thread is a "Commented" review, so
  // `reviewed-by:@me` handed the author's PR the `reviewed` role.
  const mineReplied = mkPr({ roles: ["author", "reviewed"], title: "mine, replied" });
  assert.deepStrictEqual(prFilter.filterPrs([mineReplied], st({ role: "reviewed" })), []);
  assert.deepStrictEqual(prFilter.filterPrs([mineReplied], st({ role: "author" })), [mineReplied]);
});
test("filterPrs(role): 'reviewer' still means an outstanding request, not a past review", () =>
  assert.deepStrictEqual(titlesFor("reviewer"), ["asked of me", "re-requested"]));
test("filterPrs(role): 'author' is unaffected by the new role", () =>
  assert.deepStrictEqual(titlesFor("author"), ["mine"]));

// `To review` is a review asked of you: the `reviewer` role, or your change
// request after the author acted (`myReReviewDue`), drafts excluded. A PR that
// came back to you only through new comments or a push (`returnedToMe`) is not
// asked of you: it stays under `Reviewed` — the 2026-11-03 case where two PRs
// with the user's verdict sat in `To review` because someone else commented.
const REVIEW_DUE = [
  mkPr({ roles: ["reviewer"], title: "asked of me" }),
  mkPr({ roles: ["reviewed"], returnedToMe: true, title: "back to me" }),
  mkPr({ roles: ["reviewed"], myReReviewDue: true, title: "re-review due" }),
  mkPr({ roles: ["reviewed"], title: "passive" }),
  mkPr({ roles: ["reviewer"], isDraft: true, title: "draft asked of me" }),
  mkPr({ roles: ["reviewed"], returnedToMe: true, isDraft: true, title: "draft back to me" }),
  mkPr({ roles: ["author"], title: "mine" }),
];
const reviewTitles = (over = {}) =>
  prFilter.filterPrs(REVIEW_DUE, st({ role: "reviewer", ...over })).map((pr) => pr.title);
test("filterPrs(role): 'reviewer' is a request — re-review due included, back-to-me left out", () =>
  assert.deepStrictEqual(reviewTitles(), ["asked of me", "re-review due"]));
test("filterPrs(role): 'reviewer' keeps drafts out even with the Drafts chip on", () =>
  assert.deepStrictEqual(reviewTitles({ showDrafts: true }), ["asked of me", "re-review due"]));
test("filterPrs(role): a returned PR keeps its violet accent outside 'To review'", () => {
  // The accent and the routine still read `myReview`; only the segment narrowed.
  const back = REVIEW_DUE.find((pr) => pr.title === "back to me");
  assert.strictEqual(prFilter.prSignal(back, { trackComments: true }), "myReview");
  assert.strictEqual(prFilter.isReviewDue(back), false);
});
test("filterPrs(role): 'reviewed' keeps a returned PR, not one whose re-review is due", () =>
  assert.deepStrictEqual(
    prFilter.filterPrs(REVIEW_DUE, st({ role: "reviewed" })).map((pr) => pr.title),
    ["back to me", "passive"],
  ));
test("roleFacetCounts: the 'reviewer' badge counts requests, not the role or the signal", () =>
  assert.deepStrictEqual(prFilter.roleFacetCounts(REVIEW_DUE, st({ showDrafts: true })), {
    all: 7,
    author: 1,
    reviewer: 2,
    reviewed: 3,
  }));
test("filterPrs: Hide my approvals hides an approved PR that came back through comments", () => {
  const back = mkPr({ roles: ["reviewed"], viewerApproved: true, returnedToMe: true });
  assert.deepStrictEqual(prFilter.filterPrs([back], st({ hideApproved: true })), []);
});
test("filterPrs: Hide my approvals never takes a row out of 'To review'", () => {
  const requested = mkPr({ roles: ["reviewer", "reviewed"], viewerApproved: true });
  assert.deepStrictEqual(prFilter.filterPrs([requested], st({ role: "reviewer", hideApproved: true })), [requested]);
});

// The role switch's four badges. Numbers are written out rather than derived
// from filterPrs, so the test would notice a helper that agrees with itself.
test("roleFacetCounts: each segment promises the rows it would leave", () =>
  assert.deepStrictEqual(prFilter.roleFacetCounts(BY_ROLE, st()), {
    all: 4,
    author: 1,
    // The re-requested PR carries both roles but waits on you: `To review` only.
    reviewer: 2,
    reviewed: 1,
  }));
// The badge invariant, checked against the pipeline itself: the helper counts in
// one pass over the `role: "all"` result, so this is a real comparison of two
// implementations and it proves the pass doesn't drop the other filters.
// MIXED alone has no `reviewed` PR, so it is extended with every role shape the
// segments tell apart: re-requested, re-review due, back to you through
// comments, your own PR you replied in, and drafts asked of you.
const ROLE_MIXED = [
  ...MIXED,
  ...BY_ROLE,
  ...REVIEW_DUE,
  mkPr({ roles: ["author", "reviewed"], hostLabel: "GHE", title: "mine, replied" }),
  mkPr({ roles: ["reviewed"], myReReviewDue: true, isDraft: true, title: "draft re-review due" }),
];
for (const [i, state] of FACET_STATES.entries()) {
  test(`roleFacetCounts equals filterPrs under each role [state ${i}]`, () => {
    const counts = prFilter.roleFacetCounts(ROLE_MIXED, state);
    for (const role of ["all", "author", "reviewer", "reviewed"]) {
      assert.strictEqual(counts[role], prFilter.filterPrs(ROLE_MIXED, { ...state, role }).length);
    }
  });
}
test("filterPrs(role): 'reviewer' and 'reviewed' never share a PR", () => {
  const state = st({ showDrafts: true, showIgnored: true });
  const asked = new Set(prFilter.filterPrs(ROLE_MIXED, { ...state, role: "reviewer" }));
  const shared = prFilter.filterPrs(ROLE_MIXED, { ...state, role: "reviewed" }).filter((pr) => asked.has(pr));
  assert.deepStrictEqual(shared.map((pr) => pr.title), []);
});
test("filterPrs(role): a draft asked of you is in neither review segment", () => {
  const drafts = ROLE_MIXED.filter((pr) => pr.isDraft && (pr.roles.includes("reviewer") || pr.myReReviewDue));
  const state = st({ showDrafts: true });
  for (const role of ["reviewer", "reviewed"]) {
    assert.deepStrictEqual(prFilter.filterPrs(drafts, { ...state, role }), []);
  }
  assert.strictEqual(prFilter.filterPrs(drafts, state).length, drafts.length);
});
// Hide my approvals never takes a row out of To review, over every fixture.
test("isFinishedApproval: never true for a PR in 'To review'", () => {
  for (const pr of [...ROLE_MIXED, ...APPROVALS]) {
    if (prFilter.isReviewDue(pr)) assert.strictEqual(prFilter.isFinishedApproval(pr), false, pr.title);
  }
});
test("roleFacetCounts: the reveal gate and Hide my approvals apply to the badge", () => {
  const prs = [
    mkPr({ roles: ["author"] }),
    mkPr({ roles: ["author"], isDraft: true }),
    mkPr({ roles: ["reviewed"], viewerApproved: true }),
  ];
  // The draft is hidden and the approved PR is excluded, so `all` and `author`
  // report one row each and `reviewed` none.
  assert.deepStrictEqual(prFilter.roleFacetCounts(prs, st({ hideApproved: true })), {
    all: 1,
    author: 1,
    reviewer: 0,
    reviewed: 0,
  });
  assert.deepStrictEqual(prFilter.roleFacetCounts(prs, st({ showDrafts: true })), {
    all: 3,
    author: 2,
    reviewer: 0,
    reviewed: 1,
  });
});

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
  // Two PRs are returnedToMe; the ignored one is not part of the workload.
  assert.strictEqual(stats.returned, 1);
});
test("baselineStats: all-hidden inbox reports zero, matching the header", () =>
  assert.deepStrictEqual(prFilter.baselineStats(IGNORED_DRAFTS), {
    total: 0,
    returned: 0,
  }));

// --- pr-filter: headerCountLabel --------------------------------------------
{
  const pr = (isDraft = false, isIgnored = false) => ({ isDraft, isIgnored });
  test("headerCountLabel: the whole baseline on screen is just the total", () =>
    assert.strictEqual(prFilter.headerCountLabel([pr(), pr()], 2), "2 PRs"));
  test("headerCountLabel: a filtered subset of the baseline says 'N of M shown'", () =>
    assert.strictEqual(prFilter.headerCountLabel([pr()], 3), "1 of 3 shown"));
  test("headerCountLabel: revealed drafts never produce 'of' — they are not part of M", () => {
    // 10 baseline + 3 drafts with Drafts on: "13 of 10 shown" was the bug.
    const rendered = [...Array(10)].map(() => pr()).concat([pr(true), pr(true), pr(true)]);
    assert.strictEqual(prFilter.headerCountLabel(rendered, 10), "10 PRs · 13 shown");
    assert.strictEqual(prFilter.headerCountLabel([pr(true), pr(false, true)], 0), "0 PRs · 2 shown");
  });
  test("headerCountLabel: equal counts with a revealed row swapped in still say so", () =>
    assert.strictEqual(prFilter.headerCountLabel([pr(), pr(true)], 2), "2 PRs · 2 shown"));
  test("headerCountLabel: an empty inbox is '0 PRs'", () =>
    assert.strictEqual(prFilter.headerCountLabel([], 0), "0 PRs"));
}

// --- host-status: the header host pill's dot -------------------------------
{
  const hs = require(path.join(__dirname, "../dist/main/shared/host-status.js"));
  const rl = (remaining, limit, resetAt = "2026-10-23T12:00:00Z") => ({ remaining, limit, resetAt });
  test("hostHealth: plain fetch error is red even with a reading", () =>
    assert.strictEqual(hs.hostHealth(rl(4900, 5000), { message: "boom" }), "error"));
  test("hostHealth: a spent-budget refusal is amber, with or without a reset time", () => {
    assert.strictEqual(hs.hostHealth(rl(0, 5000), { rateLimitedUntil: "2026-10-23T12:00:00Z" }), "limited");
    assert.strictEqual(hs.hostHealth(undefined, { rateLimitedUntil: "" }), "limited");
  });
  test("hostHealth: no reading yet is unknown", () =>
    assert.strictEqual(hs.hostHealth(undefined, undefined), "unknown"));
  test("hostHealth: amber below 10% of the reported limit, green at it", () => {
    assert.strictEqual(hs.hostHealth(rl(499, 5000), undefined), "limited");
    assert.strictEqual(hs.hostHealth(rl(500, 5000), undefined), "ok");
    assert.strictEqual(hs.hostHealth(rl(4963, 5000), undefined), "ok");
  });
  test("hostHealth: without a reported limit the floor is 500 points", () => {
    assert.strictEqual(hs.hostHealth(rl(499, undefined), undefined), "limited");
    assert.strictEqual(hs.hostHealth(rl(500, undefined), undefined), "ok");
  });
  test("hostHealth: a limit of 0 falls back to the 500-point floor", () => {
    assert.strictEqual(hs.hostHealth(rl(499, 0), undefined), "limited");
    assert.strictEqual(hs.hostHealth(rl(500, 0), undefined), "ok");
  });
  // A host whose responses carried no `rateLimit` (GHES with rate limiting off):
  // fetchHost still returns remaining 0 / no limit / resetAt "". That is "no
  // budget reported", not "0 points left" — amber there would be a false alarm.
  test("hostHealth: a reading without budget data is green, not amber", () => {
    assert.strictEqual(hs.hasBudgetReading(rl(0, undefined, "")), false);
    assert.strictEqual(hs.hostHealth(rl(0, undefined, ""), undefined), "ok");
    // The spent-budget reading the poller synthesises carries resetAt, so it stays amber.
    assert.strictEqual(hs.hostHealth(rl(0, 5000), undefined), "limited");
  });
}

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
test("activeFilterCount: the role switch is a scope, not a filter Clear filters resets", () =>
  assert.strictEqual(prFilter.activeFilterCount(st({ role: "reviewer" })), 0));
for (const over of [
  { search: "bump" },
  { host: "GHE" },
  { author: "octocat" },
  ...prFilter.SOURCE_CHIPS.map((chip) => ({ [chip.flag]: true })),
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
        staleOnly: true,
      }),
    ),
    2 + prFilter.SOURCE_CHIPS.length,
  ));

// --- github: mapPr past the review-thread page -------------------------------
// GitHub lists review threads oldest first. The query reads `last: 100` so the
// newest — usually the still-open — threads are the ones fetched, and any
// threads past that page count as unresolved so an oversized PR fails closed.
// Real case: usercustom-ai-skills#31, 53 threads, the 2 open ones among 51–53,
// read as 0 unresolved and painted green under `first: 50`.
{
  const tThread = (isResolved, login = "copilot") => ({
    isResolved,
    comments: { totalCount: 1, nodes: [{ author: { login }, createdAt: "2026-07-07T10:00:00Z" }] },
  });
  const mapped = (reviewThreads) => github.mapPr(rawPr({ reviewThreads }), "GH", ["author"], null);
  const sigOpts = { trackComments: true };

  test("mapPr: 53 threads, the newest 2 open, fetched in full → 2 unresolved, card blocked", () => {
    const nodes = [...Array.from({ length: 51 }, () => tThread(true)), tThread(false), tThread(false)];
    const pr = mapped({ totalCount: 53, nodes });
    assert.strictEqual(pr.unresolvedThreads, 2);
    assert.strictEqual(pr.unaddressedThreads, 2);
    assert.strictEqual(prFilter.prSignal(pr, sigOpts), "blocked");
  });

  test("mapPr: threads past the fetched page count as unresolved (fail closed)", () => {
    // 130 threads, only the newest 100 fetched and all of those resolved.
    const pr = mapped({ totalCount: 130, nodes: Array.from({ length: 100 }, () => tThread(true)) });
    assert.strictEqual(pr.unresolvedThreads, 30);
    assert.strictEqual(pr.unaddressedThreads, 30);
    assert.strictEqual(pr.hasUnaddressedComments, true);
    assert.strictEqual(prFilter.prSignal(pr, sigOpts), "blocked");
  });

  test("mapPr: every thread fetched and resolved → nothing to resolve", () => {
    const pr = mapped({ totalCount: 53, nodes: Array.from({ length: 53 }, () => tThread(true)) });
    assert.strictEqual(pr.unresolvedThreads, 0);
    assert.strictEqual(pr.unaddressedThreads, 0);
  });
}

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
  test("prSignal: an unresolved thread on your own PR blocks it with tracking on", () =>
    assert.strictEqual(
      prFilter.prSignal(sigPr({ awaitingReview: false, hasNewActivity: false, unresolvedThreads: 2 }), {
        trackComments: true,
      }),
      "blocked",
    ));
  // The one exception to the trackComments gate: an open thread on your own PR
  // stays `blocked` even with tracking off. This is deliberately ungated — see
  // the `blocked` bullet in prSignal's docblock — because a reviewing routine
  // that authenticates as the PR author leaves its own login on the thread's
  // last comment, so the thread never satisfies `hasUnaddressedComments`
  // either; without this term such a thread would never colour the card at all.
  test("prSignal: an unresolved thread on your own PR still blocks it with tracking off", () =>
    assert.strictEqual(
      prFilter.prSignal(sigPr({ awaitingReview: false, hasNewActivity: false, unresolvedThreads: 2 }), {
        trackComments: false,
      }),
      "blocked",
    ));
  test("prSignal: an unresolved thread on your own PR blocks it even while still awaiting review", () =>
    // `blocked` is checked before `waiting`, so a PR you authored that is still
    // awaiting its first review but already has an open thread returns
    // `"blocked"`, never reaching the `waiting` branch's `awaitingReview` guard
    // — exactly the invariant the `waiting` bullet in prSignal's docblock now
    // states. `sigPr`'s default `awaitingReview: true` pins that directly,
    // unlike the tests above which set it to `false`.
    assert.strictEqual(
      prFilter.prSignal(sigPr({ awaitingReview: true, hasNewActivity: false, unresolvedThreads: 2 }), {
        trackComments: false,
      }),
      "blocked",
    ));
  test("prSignal: an unresolved thread on a PR you're only reviewing (not authoring) still respects tracking off", () =>
    // The ungated term is scoped to `isAuthor` — a PR where your only role is
    // `reviewed` (not `author`) still goes quiet with tracking off, exactly as
    // before this change.
    assert.strictEqual(
      prFilter.prSignal(
        sigPr({ roles: ["reviewed"], awaitingReview: false, hasNewActivity: false, unresolvedThreads: 2 }),
        { trackComments: false },
      ),
      "idle",
    ));
  test("prSignal: an unresolved thread outranks a human approval on your own PR", () =>
    // `approved` requires no open threads; `blocked` is checked first and now
    // catches any open thread on your own PR unconditionally, so an approved-
    // but-unresolved PR you authored is `blocked`, never `approved` — it never
    // reaches the `approved` branch's own `unresolvedThreads` check at all.
    assert.strictEqual(
      prFilter.prSignal(
        sigPr({
          awaitingReview: false,
          hasHumanApproval: true,
          reviewDecision: "APPROVED",
          unresolvedThreads: 1,
        }),
        { trackComments: false },
      ),
      "blocked",
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
  // requiredReviewPending: the edges of the "waiting over attention" precedence
  // on your own PR, and the reviewer side, where it must never read green.
  {
    const pending = (o = {}) =>
      sigPr({ hasHumanApproval: true, awaitingReview: false, requiredReviewPending: true, ...o });
    for (const trackComments of [true, false]) {
      test(`prSignal: required review pending with CI still running stays waiting (trackComments=${trackComments})`, () =>
        assert.strictEqual(
          prFilter.prSignal(
            pending({ ciState: "pending", pendingChecks: [{ name: "build", kind: "check", state: "pending", url: null }] }),
            { trackComments },
          ),
          "waiting",
        ));
      test(`prSignal: required review pending with new activity reaches attention (trackComments=${trackComments})`, () =>
        assert.strictEqual(prFilter.prSignal(pending({ hasNewActivity: true }), { trackComments }), "attention"));
      test(`prSignal: required review pending on a PR you only reviewed is idle, not approved (trackComments=${trackComments})`, () =>
        assert.strictEqual(prFilter.prSignal(pending({ roles: ["reviewed"] }), { trackComments }), "idle"));
    }
  }

  // --- contract: the usercustom-ai-skills cron detectors mirror prSignal ------
  // Three headless detectors (`red-prs.cjs`, `purple-prs.cjs`, `green-prs.cjs`
  // in the sibling `usercustom-ai-skills` repo's `usercustom-dev` plugin) each
  // carry a local fallback copy of this exact function, used only when the
  // detector cannot `require` this repo's built `dist/main/shared/pr-filter.js`
  // (e.g. before a build, or against an older dist). A copy is exactly the kind
  // of thing that quietly drifts from its source — that drift is what let a
  // conflicting PR skip the red queue in the first place (missing
  // `hasConflicts`) and what will happen again to THIS change if the copies
  // aren't updated in lockstep. This test is the tripwire: it runs each
  // detector's copy against the real `prSignal` on a fixture set covering every
  // branch, so a missed update fails here — in this repo's CI — instead of
  // silently in a cron routine days later.
  //
  // Best-effort: skipped (not failed) when the sibling clone isn't present
  // locally, since it isn't a dependency of this repo and CI here has no reason
  // to check it out. It DOES run whenever the clone exists, which is the normal
  // case on the machine that also runs the cron routines.
  {
    const fsSync = require("node:fs");
    const os2 = require("node:os");
    const siblingRoot = path.join(os2.homedir(), "Projects", "usercustom-ai-skills");
    const detectors = [
      ["red-prs.cjs", path.join(siblingRoot, "plugins/usercustom-dev/skills/drive-red-prs-green/red-prs.cjs")],
      [
        "purple-prs.cjs",
        path.join(siblingRoot, "plugins/usercustom-dev/skills/review-purple-prs/purple-prs.cjs"),
      ],
      [
        "green-prs.cjs",
        path.join(siblingRoot, "plugins/usercustom-dev/skills/drive-green-prs-close/green-prs.cjs"),
      ],
    ];
    const present = detectors.filter(([, file]) => fsSync.existsSync(file));

    if (present.length === 0) {
      console.log(
        "  skip - contract: usercustom-ai-skills not found at ~/Projects/usercustom-ai-skills — clone it locally to run the detector-copy contract check",
      );
    } else {
      // One fixture per prSignal branch, plus the specific case this whole
      // change exists for (an own-PR unresolved thread, both trackComments
      // states — see `sigPr` above for why "author" is the interesting role).
      const contractFixtures = [
        ["idle", sigPr()],
        ["blocked: failing CI", sigPr({ failingChecks: [{ name: "build", kind: "check", state: "failure", url: null }] })],
        ["blocked: unaddressed change request", sigPr({ hasUnaddressedChangeRequest: true })],
        ["blocked: approval-body feedback", sigPr({ hasUnaddressedReviewFeedback: true, hasHumanApproval: true, awaitingReview: false })],
        ["blocked: approved behind base", sigPr({ isBehindBase: true, awaitingReview: false, hasHumanApproval: true })],
        ["not author: behind base", sigPr({ isBehindBase: true, roles: ["reviewed"], awaitingReview: false, hasHumanApproval: true })],
        ["blocked: merge conflict", sigPr({ hasConflicts: true })],
        ["attention: approved but waits for a lower PR of its stack", sigPr({ hasHumanApproval: true, awaitingReview: false, blockedByStack: true })],
        ["waiting: approved but a required code-owner review is pending", sigPr({ hasHumanApproval: true, awaitingReview: false, requiredReviewPending: true })],
        [
          "blocked: unresolved thread on your own PR",
          sigPr({ awaitingReview: false, unresolvedThreads: 2 }),
        ],
        [
          "not blocked: unresolved thread on a PR you only review",
          sigPr({ roles: ["reviewed"], awaitingReview: false, unresolvedThreads: 2 }),
        ],
        ["myReview: reviewer role", sigPr({ roles: ["reviewer"] })],
        ["myReview: returnedToMe", sigPr({ roles: ["reviewed"], returnedToMe: true })],
        ["myReview: myReReviewDue", sigPr({ roles: ["reviewed"], myReReviewDue: true })],
        ["waiting: awaiting review, no approval yet", sigPr()],
        [
          "approved: human approval, green CI, no open threads",
          sigPr({
            awaitingReview: false,
            hasHumanApproval: true,
            reviewDecision: "APPROVED",
          }),
        ],
        [
          "attention: new activity on a PR you're reviewing",
          sigPr({ roles: ["reviewed"], awaitingReview: false, hasNewActivity: true }),
        ],
        [
          "attention: a pending check on a PR you're reviewing",
          sigPr({
            roles: ["reviewed"],
            awaitingReview: false,
            pendingChecks: [{ name: "build", kind: "check", state: "pending", url: null }],
          }),
        ],
      ];

      for (const [detectorName, file] of present) {
        // These CLI scripts fetch live PRs from GitHub and call process.exit()
        // on failure when run standalone (`node red-prs.cjs`); requiring them
        // is meant to be side-effect-free only because each one guards its
        // network call behind `require.main === module`. That guard lives in
        // the OTHER repo, so nothing here enforces it — a version of these
        // files without the guard would make this very test fire a live
        // GitHub request (or exit the whole test process) the moment it's
        // required, before any assertion runs. Check for the guard in the raw
        // source FIRST, and refuse to `require()` the file at all if it's
        // missing, rather than trusting it.
        const source = fsSync.readFileSync(file, "utf8");
        const guarded = source.includes("require.main === module");
        test(`contract: ${detectorName} guards its CLI entry point behind require.main`, () =>
          assert.ok(
            guarded,
            `${detectorName} has no "require.main === module" guard around its network call — ` +
              `requiring it for this contract check would run that call as a side effect`,
          ));
        if (!guarded) continue;

        if (detectorName === "red-prs.cjs" || detectorName === "green-prs.cjs") {
          test(`contract: ${detectorName} selects behind PRs only for RED, then GREEN after update`, () => {
            // Evaluate the guarded CLI with only its pure fallback/config wired.
            // main() never runs: no settings reads, GitHub calls or live PR mutations.
            const sandbox = { require, module: { exports: {} }, process, console, __dirname: path.dirname(file) };
            require("node:vm").runInNewContext(source + "\nprSignal = localPrSignal; trackComments = false;", sandbox);
            const detector = sandbox.module.exports;
            const before = sigPr({ isBehindBase: true, isDraft: false, awaitingReview: false, hasHumanApproval: true });
            const after = { ...before, isBehindBase: false };
            const feedback = { ...after, hasUnaddressedReviewFeedback: true };
            if (detectorName === "red-prs.cjs") {
              assert.strictEqual(detector.isRed(feedback), true);
              assert.strictEqual(detector.redReason(feedback), "approval-body-feedback");
            } else {
              assert.strictEqual(detector.isGreen(feedback), false);
            }
            if (detectorName === "red-prs.cjs") {
              assert.strictEqual(detector.isRed(before), true);
              assert.strictEqual(detector.redReason(before), "behind-base");
              assert.strictEqual(detector.isRed(after), false);
              assert.strictEqual(detector.isRed({ ...before, isDraft: true }), false);
            } else {
              assert.strictEqual(detector.isGreen(before), false);
              assert.strictEqual(detector.isGreen(after), true);
              assert.strictEqual(detector.isGreen({ ...after, isDraft: true }), false);
            }
          });
        }

        test(`contract: ${detectorName} queue selectors match dashboard signals across roles/blockers/reveal exclusions`, () => {
          const sandbox = { require, module: { exports: {} }, process, console, __dirname: path.dirname(file), actual: prFilter.prSignal };
          require("node:vm").runInNewContext(source + "\nprSignal = actual; module.exports.setTracking = value => { trackComments = value; };", sandbox);
          const selector = detectorName === "red-prs.cjs" ? "isRed" : detectorName === "green-prs.cjs" ? "isGreen" : "isPurple";
          const target = selector === "isRed" ? "blocked" : selector === "isGreen" ? "approved" : "myReview";
          for (const trackComments of [true, false]) {
            sandbox.module.exports.setTracking(trackComments);
            for (const roles of [["author"], ["author", "reviewed"], ["reviewer"], ["reviewed"]]) {
              for (let bits = 0; bits < 128; bits++) {
                const pr = sigPr({ roles, isDraft: !!(bits & 1), isIgnored: !!(bits & 2), isBehindBase: !!(bits & 4), hasUnaddressedReviewFeedback: !!(bits & 8), unresolvedThreads: bits & 16 ? 1 : 0, hasHumanApproval: !!(bits & 32), returnedToMe: roles.includes("author") ? false : !!(bits & 64), awaitingReview: false });
                const eligible = !pr.isDraft && !pr.isIgnored && (target !== "approved" || roles.includes("author"));
                assert.strictEqual(!pr.isIgnored && sandbox.module.exports[selector](pr), eligible && prFilter.prSignal(pr, { trackComments }) === target);
                assert.strictEqual(sandbox.module.exports.localPrSignal(pr, { trackComments }), prFilter.prSignal(pr, { trackComments }));
              }
            }
          }
        });

        test(`contract: ${detectorName} shares dashboard settings validation/defaults`, () => {
          const tempDir = fsSync.mkdtempSync(path.join(os2.tmpdir(), "pr-detector-config-"));
          try {
            const configFile = path.join(tempDir, "settings.json");
            const sandbox = { require, module: { exports: {} }, process: { ...process, env: { ...process.env, PR_DASHBOARD_CONFIG: configFile } }, console, __dirname: path.dirname(file) };
            const vmSource = source + "\nloadDeps(); loadConfig(); module.exports.auditConfig = { config, trackComments };";
            for (const rawFlag of [undefined, true, false, "invalid"]) {
              const raw = { hosts: [{ label: "GH", graphqlUrl: "https://api.github.com/graphql", repos: ["a/b"] }] };
              if (rawFlag !== undefined) raw.trackComments = rawFlag;
              fsSync.writeFileSync(configFile, JSON.stringify(raw));
              const fresh = { ...sandbox, module: { exports: {} } };
              require("node:vm").runInNewContext(vmSource, fresh);
              assert.strictEqual(fresh.module.exports.auditConfig.trackComments, cfg.validateSettings(raw).trackComments);
            }
          } finally { fsSync.rmSync(tempDir, { recursive: true, force: true }); }
        });

        let mod;
        try {
          mod = require(file);
        } catch (e) {
          test(`contract: ${detectorName} loads as a module`, () => {
            throw new Error(`require("${file}") threw: ${e.message}`);
          });
          continue;
        }
        test(`contract: ${detectorName} exports localPrSignal`, () =>
          assert.strictEqual(
            typeof mod.localPrSignal,
            "function",
            `${detectorName} must export its fallback copy as { localPrSignal } so this contract check can run it`,
          ));
        if (typeof mod.localPrSignal !== "function") continue;
        for (const trackComments of [true, false]) {
          for (const [label, pr] of contractFixtures) {
            test(
              `contract: ${detectorName}.localPrSignal matches prSignal — ${label} (trackComments=${trackComments})`,
              () =>
                assert.strictEqual(
                  mod.localPrSignal(pr, { trackComments }),
                  prFilter.prSignal(pr, { trackComments }),
                  `${detectorName}'s fallback copy disagrees with prSignal for "${label}" — update the copy to match`,
                ),
            );
          }
        }
      }
    }
  }
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

  for (const trackComments of [true, false]) {
    await atest(`applyActivity: base-update attention clears after refresh (tracking=${trackComments})`, () =>
      withTempStore(async (file) => {
        const before = reviewPr({ roles: ["author"], isBehindBase: true });
        await state.applyActivity([before], file, { trackComments });
        assert.strictEqual(before.needsAttention, true);
        assert.strictEqual(prFilter.hiddenAttentionCount([before]), 1);
        const after = reviewPr({ roles: ["author"], isBehindBase: false });
        await state.applyActivity([after], file, { trackComments });
        assert.strictEqual(after.needsAttention, false);
        const reviewed = reviewPr({ roles: ["reviewed"], isBehindBase: true });
        await state.applyActivity([reviewed], file, { trackComments });
        assert.strictEqual(reviewed.needsAttention, false);
      }));
  }

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

  for (const trackComments of [true, false]) {
    await atest(`applyActivity.returnedToMe: a review on the head commit beats its later commit date (tracking=${trackComments})`, () =>
      withTempStore(async (file) => {
        const stale = reviewPr({ lastCommitPushedAt: "2026-07-06T00:00:00Z" });
        await state.applyActivity([stale], file, { trackComments });
        // committedDate 07-09 is later than my review at 07-08, yet the review
        // sits on that same head commit.
        const reviewedHead = reviewPr({
          lastCommitPushedAt: "2026-07-09T00:00:00Z",
          viewerReviewedAt: "2026-07-08T00:00:00Z",
          viewerReviewedHead: true,
        });
        await state.applyActivity([reviewedHead], file, { trackComments });
        assert.strictEqual(reviewedHead.returnedToMe, false);
      }));
  }

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
  //
  // One deliberate exception (mirrors `prSignal`'s `blocked` branch): an open
  // thread on your OWN PR claims attention regardless of `trackComments`. A
  // reviewing routine that authenticates as the PR author leaves its own login
  // on the thread's last comment, so such a thread never satisfies
  // `hasUnaddressedComments` either — without an ungated term it would never
  // surface at all, on either setting.
  await atest(
    "applyActivity(trackComments=false): an unresolved thread on your own PR still claims attention",
    () =>
      withTempStore(async (file) => {
        const threaded = (o = {}) =>
          reviewPr({ roles: ["author"], awaitingReview: false, unresolvedThreads: 3, ...o });
        await state.applyActivity([threaded()], file, { trackComments: false });
        const more = threaded({ totalComments: 9 });
        await state.applyActivity([more], file, { trackComments: false });
        assert.strictEqual(more.hasNewActivity, false, "the unread channel is still muted");
        assert.strictEqual(more.needsAttention, true, "but an open thread on your own PR is not comment noise");
      }),
  );

  await atest(
    "applyActivity(trackComments=false): an unresolved thread on a PR you're only reviewing stays quiet",
    () =>
      // The ungated exception is scoped to `isAuthor` — a passively-reviewed PR
      // (role `reviewed`, not `author`) is unaffected and behaves as before.
      withTempStore(async (file) => {
        const threaded = (o = {}) =>
          reviewPr({ roles: ["reviewed"], awaitingReview: false, unresolvedThreads: 3, ...o });
        await state.applyActivity([threaded()], file, { trackComments: false });
        const more = threaded({ totalComments: 9 });
        await state.applyActivity([more], file, { trackComments: false });
        assert.strictEqual(more.needsAttention, false);
      }),
  );

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

  for (const trackComments of [true, false]) {
    await atest(`applyActivity: approval-body feedback persists until reviewer clears it (tracking=${trackComments})`, () =>
      withTempStore(async (file) => {
        const pr = reviewPr({ roles: ["author"], hasUnaddressedReviewFeedback: true });
        await state.applyActivity([pr], file, { trackComments });
        assert.strictEqual(pr.needsAttention, true);
        await state.markSeen([{ id: pr.id, comments: pr.totalComments, updatedAt: pr.updatedAt, lastCommitPushedAt: pr.lastCommitPushedAt }], file, { trackComments });
        await state.applyActivity([pr], file, { trackComments });
        assert.strictEqual(pr.needsAttention, true);
        const after = reviewPr({ roles: ["author"], hasUnaddressedReviewFeedback: false });
        await state.applyActivity([after], file, { trackComments });
        assert.strictEqual(after.needsAttention, false);
      }));
  }

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

  // The second step of a tick: every PR the searches found is read in full by
  // id. Answers it from `pool` (every raw PR the stub's searches return), so a
  // stub only has to describe its searches. Null for an id the pool lacks, as
  // GitHub answers a PR that went away between the search and the read.
  const isHydrate = (body) => body.query.includes("hydrated: nodes(ids: $ids)");
  const hydrateResponse = (body, pool, cost = 4) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      data: {
        rateLimit: { remaining: 4990, cost, resetAt: "2026-07-07T01:00:00Z" },
        hydrated: body.variables.ids.map((id) => pool.find((pr) => pr.id === id) ?? null),
      },
    }),
  });

  // Drives fetchHost against a stubbed transport and returns both the requests it
  // sent and the PRs it produced. Every search travels as its OWN HTTP request
  // now (GitHub runs aliases inside one request serially and times the whole
  // thing out at ~10s, which is what made github.com answer 502 all afternoon),
  // so the stub answers per request and `sent` collects them all, keyed by the
  // single search alias each one carries.
  // A fresh graphqlUrl per call: team discovery is cached per host for 10
  // minutes and has no test-visible reset.
  // `teams` is the list of team slugs the viewer belongs to (org `a`, matching
  // the configured `a/b` repo, or `fetchHost` filters them out); `team0` holds
  // the nodes the first team search returns.
  async function runFetchHost(searches, hostPatch = {}) {
    const graphqlUrl = `https://api.stub${++hostSeq}.test/graphql`;
    const sent = {};
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        const teams = (searches.teams ?? []).map((slug) => ({
          slug: slug.split("/")[1],
          organization: { login: slug.split("/")[0] },
        }));
        return { ok: true, status: 200, statusText: "OK", json: async () => teams };
      }
      const body = JSON.parse(init.body);
      if (isHydrate(body)) {
        sent.hydrate = body;
        const pool = Object.entries(searches).flatMap(([k, v]) => (k === "teams" ? [] : v));
        return hydrateResponse(body, pool);
      }
      // The alias the request asked for, e.g. `reviewed: search(query: ...`.
      const alias = /\n  (\w+): search\(/.exec(body.query)[1];
      sent[alias] = body;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { remaining: 4990, cost: 4, resetAt: "2026-07-07T01:00:00Z" },
            viewer: { login: "me" },
            [alias]: { nodes: searches[alias] ?? [] },
          },
        }),
      };
    };
    const result = await github.fetchHost({
      label: "H",
      graphqlUrl,
      repos: ["a/b"],
      token: "t",
      ...hostPatch,
    });
    return { sent, result };
  }

  await atest("fetchHost: a listed host filters every search by repo, 25 per page", async () => {
    const { sent } = await runFetchHost({ teams: ["a/t1"] });
    for (const alias of ["authored", "reviewing", "reviewed", "team0"]) {
      assert.match(Object.values(sent[alias].variables)[0], / repo:a\/b /);
      assert.match(sent[alias].query, /first: 25\)/);
    }
  });

  await atest("fetchHost: an allRepos host searches without repo: and with every team", async () => {
    const { sent, result } = await runFetchHost(
      { teams: ["a/t1", "other/t2"], authored: [rawPr({ id: "PR_a" })] },
      { allRepos: true, repos: [] },
    );
    for (const alias of ["authored", "reviewing", "reviewed", "team0", "team1"]) {
      assert.ok(!Object.values(sent[alias].variables)[0].includes("repo:"), `${alias} must not filter by repo`);
    }
    assert.strictEqual(sent.authored.variables.authoredQuery, "is:open is:pr author:@me");
    assert.strictEqual(sent.team1.variables.teamQuery1, "is:open is:pr team-review-requested:other/t2");
    assert.strictEqual(result.pullRequests.length, 1);
  });

  await atest("fetchHost: searchLimit sets each search's page size", async () => {
    const { sent } = await runFetchHost({}, { searchLimit: 60 });
    for (const alias of ["authored", "reviewing", "reviewed"]) {
      assert.match(sent[alias].query, /first: 60\)/);
    }
  });

  await atest("fetchHost: reads the NEWEST review threads, with their total count", async () => {
    const { sent } = await runFetchHost({ authored: [rawPr({ id: "PR_a" })] });
    // `first:` would drop the newest threads on a long PR — the open ones.
    assert.match(sent.hydrate.query, /reviewThreads\(last: 100\) \{\s+totalCount/);
    assert.ok(!/reviewThreads\(first:/.test(sent.hydrate.query));
  });

  // The full selection is what GitHub bills for: 30 points per search carrying
  // it on github.com whatever it matched, against 1 for a search of ids. Nine
  // searches made a tick cost 270 points; the searches must stay ids-only and
  // the PRs they share must be read once.
  await atest("fetchHost: searches carry ids only, and each distinct PR is read once", async () => {
    const shared = rawPr({ id: "PR_shared" });
    const { sent, result } = await runFetchHost({
      teams: ["a/t1"],
      authored: [shared, rawPr({ id: "PR_a" })],
      reviewed: [shared],
      team0: [shared],
    });
    for (const alias of ["authored", "reviewing", "reviewed", "team0"]) {
      assert.ok(!sent[alias].query.includes("reviewThreads"), `${alias} must not carry the full selection`);
      assert.ok(!sent[alias].query.includes("PrFields"), `${alias} must not carry the fragment`);
    }
    assert.deepStrictEqual(sent.hydrate.variables.ids, ["PR_shared", "PR_a"]);
    assert.strictEqual(result.pullRequests.length, 2);
  });

  await atest("fetchHost: no PRs found means no hydrate request", async () => {
    const { sent } = await runFetchHost({});
    assert.strictEqual(sent.hydrate, undefined);
  });

  await atest("fetchHost: more PRs than one hydrate page go out as several reads", async () => {
    const many = Array.from({ length: 30 }, (_, i) => rawPr({ id: `PR_${i}` }));
    const graphqlUrl = `https://api.stub${++hostSeq}.test/graphql`;
    const reads = [];
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => [] };
      }
      const body = JSON.parse(init.body);
      if (isHydrate(body)) {
        reads.push(body.variables.ids.length);
        return hydrateResponse(body, many);
      }
      const alias = /\n  (\w+): search\(/.exec(body.query)[1];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { remaining: 4990, cost: 1, resetAt: "" },
            viewer: { login: "me" },
            [alias]: { nodes: alias === "authored" ? many.slice(0, 25) : alias === "reviewed" ? many.slice(5) : [] },
          },
        }),
      };
    };
    const result = await github.fetchHost({ label: "H", graphqlUrl, repos: ["a/b"], token: "t" });
    assert.deepStrictEqual(reads.sort((a, b) => b - a), [25, 5]);
    assert.strictEqual(result.pullRequests.length, 30);
    // 3 searches at 1 point + 2 reads at 4.
    assert.strictEqual(result.rateLimit.cost, 11);
  });

  // What github.com answers for an id it cannot resolve: a null node plus a
  // NOT_FOUND error beside the data for the rest.
  await atest("fetchHost: a NOT_FOUND beside the hydrated data does not fail the host", async () => {
    const graphqlUrl = `https://api.stub${++hostSeq}.test/graphql`;
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => [] };
      }
      const body = JSON.parse(init.body);
      if (isHydrate(body)) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: { rateLimit: { remaining: 4990, cost: 2, resetAt: "" }, hydrated: [rawPr({ id: "PR_kept" }), null] },
            errors: [{ type: "NOT_FOUND", path: ["hydrated", 1], message: "Could not resolve to a node with the global id of 'PR_gone'" }],
          }),
        };
      }
      const alias = /\n  (\w+): search\(/.exec(body.query)[1];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { remaining: 4990, cost: 1, resetAt: "" },
            viewer: { login: "me" },
            [alias]: { nodes: alias === "authored" ? [{ id: "PR_kept" }, { id: "PR_gone" }] : [] },
          },
        }),
      };
    };
    const result = await github.fetchHost({ label: "H", graphqlUrl, repos: ["a/b"], token: "t" });
    assert.deepStrictEqual(result.pullRequests.map((p) => p.id), ["PR_kept"]);
  });

  await atest("fetchHost: a PR gone between the search and the read is dropped", async () => {
    const graphqlUrl = `https://api.stub${++hostSeq}.test/graphql`;
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => [] };
      }
      const body = JSON.parse(init.body);
      if (isHydrate(body)) return hydrateResponse(body, [rawPr({ id: "PR_kept" })]);
      const alias = /\n  (\w+): search\(/.exec(body.query)[1];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { remaining: 4990, cost: 1, resetAt: "" },
            viewer: { login: "me" },
            [alias]: { nodes: alias === "authored" ? [{ id: "PR_kept" }, { id: "PR_gone" }] : [] },
          },
        }),
      };
    };
    const result = await github.fetchHost({ label: "H", graphqlUrl, repos: ["a/b"], token: "t" });
    assert.deepStrictEqual(result.pullRequests.map((p) => p.id), ["PR_kept"]);
  });

  // The searches only say which PRs exist; a "successful" host without their
  // data would blank every card, so a failed read fails the host.
  await atest("fetchHost: a failing hydrate fails the whole host", async () => {
    const graphqlUrl = `https://api.stub${++hostSeq}.test/graphql`;
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => [] };
      }
      const body = JSON.parse(init.body);
      if (isHydrate(body)) {
        return { ok: false, status: 502, statusText: "Bad Gateway", text: async () => "" };
      }
      const alias = /\n  (\w+): search\(/.exec(body.query)[1];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { remaining: 4990, cost: 1, resetAt: "" },
            viewer: { login: "me" },
            [alias]: { nodes: alias === "authored" ? [{ id: "PR_a" }] : [] },
          },
        }),
      };
    };
    await assert.rejects(
      github.fetchHost({ label: "H", graphqlUrl, repos: ["a/b"], token: "t" }),
      /HTTP 502 Bad Gateway/,
    );
  });

  // An older GitHub Enterprise Server has no `stack` on PullRequest and fails
  // the whole read naming the field; the host must still load, without stacks,
  // and stop asking for them on later polls.
  await atest("fetchHost: a host without PR stacks is read again without them, and remembered", async () => {
    const graphqlUrl = `https://api.stub${++hostSeq}.test/graphql`;
    const hydrates = [];
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => [] };
      }
      const body = JSON.parse(init.body);
      if (isHydrate(body)) {
        hydrates.push(body.query);
        if (body.query.includes("stackEntry")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ errors: [{ message: "Field 'stackEntry' doesn't exist on type 'PullRequest'" }] }),
          };
        }
        return hydrateResponse(body, [rawPr({ id: "PR_a" })]);
      }
      const alias = /\n  (\w+): search\(/.exec(body.query)[1];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { remaining: 4990, cost: 1, resetAt: "" },
            viewer: { login: "me" },
            [alias]: { nodes: alias === "authored" ? [{ id: "PR_a", author: { login: "me" } }] : [] },
          },
        }),
      };
    };
    const host = { label: "H", graphqlUrl, repos: ["a/b"], token: "t" };
    const first = await github.fetchHost(host);
    assert.strictEqual(first.pullRequests.length, 1);
    assert.strictEqual(first.pullRequests[0].stack, null);
    assert.deepStrictEqual(hydrates.map((q) => q.includes("stackEntry")), [true, false]);
    await github.fetchHost(host);
    assert.deepStrictEqual(hydrates.map((q) => q.includes("stackEntry")), [true, false, false]);
  });

  await atest("fetchHost: the read by id asks for the PR's stack", async () => {
    const { sent } = await runFetchHost({ authored: [rawPr({ id: "PR_a" })] });
    assert.match(sent.hydrate.query, /stackEntry \{ position \}/);
    assert.match(sent.hydrate.query, /entries\(first: 10\) \{ nodes \{ position pullRequest \{ number title url state \} \} \}/);
  });

  await atest("fetchHost: asks for reviewed-by:@me over the same repos, as its own alias", async () => {
    const { sent } = await runFetchHost({});
    assert.strictEqual(
      sent.reviewed.variables.reviewedQuery,
      "is:open is:pr repo:a/b reviewed-by:@me sort:updated-desc",
      // The only qualifier whose match set grows for the PR's whole open life,
      // so past the first: 25 cap the default order would hide the recent ones
      // and reshuffle between polls.
      "the reviewed search must be pinned to a recency order",
    );
    assert.ok(
      sent.reviewed.query.includes("reviewed: search(query: $reviewedQuery"),
      "the reviewed search must travel as its own request",
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

  // A team review request matches your OWN PRs too, and a `reviewer` role there
  // claims a review you can never submit: violet accent, "Reviewer" pill and a
  // "Needs attention" count on a PR that is merely waiting for other people.
  await atest("fetchHost: a team request on your own PR does not make you its reviewer", async () => {
    const mine = rawPr({ id: "PR_mine_team", author: { login: "me", avatarUrl: "" } });
    const { sent, result } = await runFetchHost({
      teams: ["a/toolkit-contributors"],
      authored: [mine],
      team0: [mine],
    });
    // Without these two the assertion below would pass vacuously — no team
    // search sent means the team branch of `addNodes` never runs at all.
    assert.strictEqual(
      sent.team0.variables.teamQuery0,
      "is:open is:pr repo:a/b team-review-requested:a/toolkit-contributors",
    );
    assert.ok(sent.team0.query.includes("team0: search(query: $teamQuery0"));
    assert.strictEqual(result.pullRequests.length, 1);
    assert.deepStrictEqual(result.pullRequests[0].roles, ["author"]);
  });

  await atest("fetchHost: a team request on someone else's PR still makes you a reviewer", async () => {
    const { result } = await runFetchHost({
      teams: ["a/toolkit-contributors"],
      team0: [rawPr({ id: "PR_theirs_team" })],
    });
    assert.deepStrictEqual(result.pullRequests[0].roles, ["reviewer"]);
  });

  // The split into one request per search must not change what the poller reads:
  // `hostIntervalMs` classifies a host by `cost`, so reporting one request's 4
  // points instead of the whole tick's would make github.com look cheap and get
  // it polled several times more often against a shared 5000/hour budget.
  await atest("fetchHost: the reported cost is the sum of every search's own cost", async () => {
    const { result } = await runFetchHost({ teams: ["a/t1", "a/t2"] });
    // authored + reviewing + reviewed + two team searches, 4 points each.
    assert.strictEqual(result.rateLimit.cost, 20);
    assert.strictEqual(result.rateLimit.remaining, 4990);
  });

  // A failed CORE search must fail the host: the poller keeps its last good PR
  // list on an error, while a "successful" truncated list would overwrite it and
  // read as PRs having disappeared.
  await atest("fetchHost: a failing core search fails the whole host", async () => {
    const graphqlUrl = `https://api.stub${++hostSeq}.test/graphql`;
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => [] };
      }
      const body = JSON.parse(init.body);
      if (body.query.includes("reviewed: search")) {
        return {
          ok: false,
          status: 502,
          statusText: "Bad Gateway",
          text: async () => "<html><head><title>502 Bad Gateway</title></head></html>",
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { remaining: 4990, cost: 4, resetAt: "" },
            viewer: { login: "me" },
            authored: { nodes: [] },
            reviewing: { nodes: [] },
          },
        }),
      };
    };
    await assert.rejects(
      github.fetchHost({ label: "H", graphqlUrl, repos: ["a/b"], token: "t" }),
      (e) => {
        // An nginx error page carries nothing the status line doesn't, and
        // pasting it made the dashboard's error strip a wall of HTML.
        assert.strictEqual(e.message, "HTTP 502 Bad Gateway");
        return true;
      },
    );
  });

  // A spent budget must reach the poller as a RateLimitedError carrying the
  // reset time, from both shapes GitHub uses: a 200 whose errors[].type is
  // RATE_LIMITED (primary hourly budget) and a 403/429 with retry-after
  // (secondary limit). Anything else stays a plain error.
  const stubSearchResponse = (response) => {
    global.fetch = async (url) => {
      if (url.includes("/user/teams")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => [] };
      }
      return response();
    };
    return github.fetchHost({
      label: "H",
      graphqlUrl: `https://api.stub${++hostSeq}.test/graphql`,
      repos: ["a/b"],
      token: "t",
    });
  };
  const headersOf = (h) => ({ get: (name) => h[name.toLowerCase()] ?? null });

  await atest("fetchHost: a RATE_LIMITED GraphQL error carries the x-ratelimit-reset time", async () => {
    await assert.rejects(
      stubSearchResponse(() => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: headersOf({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790948255" }),
        json: async () => ({
          errors: [
            { type: "RATE_LIMITED", message: "API rate limit already exceeded for user ID 12455901." },
          ],
        }),
      })),
      (e) => {
        assert.ok(e instanceof github.RateLimitedError, `got ${e && e.name}`);
        assert.strictEqual(e.message, "API rate limit already exceeded for user ID 12455901.");
        assert.strictEqual(e.resetAt, new Date(1790948255 * 1000).toISOString());
        return true;
      },
    );
  });

  // What github.com actually sends for a spent budget (seen 2026-10-05, and in
  // other clients' fixtures): `RATE_LIMIT`, not `RATE_LIMITED`. Matching only
  // the latter left 1.18.3 on a red failure strip, retrying all hour.
  await atest("fetchHost: github.com's RATE_LIMIT / graphql_rate_limit error is a RateLimitedError", async () => {
    await assert.rejects(
      stubSearchResponse(() => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: headersOf({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790948255" }),
        json: async () => ({
          errors: [
            {
              type: "RATE_LIMIT",
              code: "graphql_rate_limit",
              message: "API rate limit already exceeded for user ID 12455901.",
            },
          ],
        }),
      })),
      (e) => {
        assert.ok(e instanceof github.RateLimitedError, `got ${e && e.name}`);
        assert.strictEqual(e.resetAt, new Date(1790948255 * 1000).toISOString());
        return true;
      },
    );
  });

  await atest("fetchHost: a 403 with retry-after is a RateLimitedError resuming after it", async () => {
    const before = Date.now();
    await assert.rejects(
      stubSearchResponse(() => ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: headersOf({ "retry-after": "60" }),
        text: async () => '{"message":"You have exceeded a secondary rate limit."}',
      })),
      (e) => {
        assert.ok(e instanceof github.RateLimitedError, `got ${e && e.name}`);
        within(Date.parse(e.resetAt), before + 60_000);
        return true;
      },
    );
  });

  await atest("fetchHost: a 403 without rate-limit headers stays a plain error", async () => {
    await assert.rejects(
      stubSearchResponse(() => ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: headersOf({}),
        text: async () => '{"message":"Resource not accessible"}',
      })),
      (e) => {
        assert.ok(!(e instanceof github.RateLimitedError));
        return true;
      },
    );
  });

  await atest("fetchHost: the hourly limit is passed on with the reading", async () => {
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => [] };
      }
      const alias = /\n  (\w+): search\(/.exec(JSON.parse(init.body).query)[1];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { limit: 5000, remaining: 4990, cost: 4, resetAt: "2026-07-07T01:00:00Z" },
            viewer: { login: "me" },
            [alias]: { nodes: [] },
          },
        }),
      };
    };
    const result = await github.fetchHost({
      label: "H",
      graphqlUrl: `https://api.stub${++hostSeq}.test/graphql`,
      repos: ["a/b"],
      token: "t",
    });
    assert.strictEqual(result.rateLimit.limit, 5000);
  });

  // Each request carries its own `viewer { login }`, and `isOwnPr` needs one: a
  // null login makes a team request on your OWN PR claim a review from you —
  // violet card, "Reviewer" pill, a "Needs attention" count you can never clear.
  // The PR arrives ONLY through the team search here, and ONLY the `reviewing`
  // response carries the viewer, so the assertion fails unless the login is
  // picked up across responses: without it the role would be "reviewer".
  await atest("fetchHost: the viewer login is taken from whichever response has one", async () => {
    const graphqlUrl = `https://api.stub${++hostSeq}.test/graphql`;
    const mine = rawPr({ id: "PR_mine_team", author: { login: "me", avatarUrl: "" } });
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [{ slug: "t1", organization: { login: "a" } }],
        };
      }
      const body = JSON.parse(init.body);
      if (isHydrate(body)) return hydrateResponse(body, [mine]);
      const alias = /\n  (\w+): search\(/.exec(body.query)[1];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { remaining: 4990, cost: 4, resetAt: "" },
            viewer: alias === "reviewing" ? { login: "me" } : null,
            [alias]: { nodes: alias === "team0" ? [mine] : [] },
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
    assert.strictEqual(result.pullRequests.length, 1);
    assert.deepStrictEqual(result.pullRequests[0].roles, ["author"]);
  });

  // Past the authored search's `first: 25` cap your own PR can arrive only
  // through `reviewed-by:@me` — a reply in its own thread is a "Commented"
  // review. It must still land as `author`, or it is listed under `Reviewed`.
  await atest("fetchHost: your own PR found only by the reviewed search is still author", async () => {
    const graphqlUrl = `https://api.stub${++hostSeq}.test/graphql`;
    const mine = rawPr({ id: "PR_mine_replied", author: { login: "me", avatarUrl: "" } });
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => [] };
      }
      const body = JSON.parse(init.body);
      if (isHydrate(body)) return hydrateResponse(body, [mine]);
      const alias = /\n  (\w+): search\(/.exec(body.query)[1];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { remaining: 4990, cost: 4, resetAt: "" },
            viewer: { login: "me" },
            [alias]: { nodes: alias === "reviewed" ? [mine] : [] },
          },
        }),
      };
    };
    const result = await github.fetchHost({ label: "H", graphqlUrl, repos: ["a/b"], token: "t" });
    assert.strictEqual(result.pullRequests.length, 1);
    assert.deepStrictEqual(result.pullRequests[0].roles, ["author"]);
  });

  // A failing TEAM search is best-effort, like team discovery itself.
  await atest("fetchHost: a failing team search leaves the rest of the host intact", async () => {
    const graphqlUrl = `https://api.stub${++hostSeq}.test/graphql`;
    global.fetch = async (url, init) => {
      if (url.includes("/user/teams")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [{ slug: "t1", organization: { login: "a" } }],
        };
      }
      const body = JSON.parse(init.body);
      if (isHydrate(body)) return hydrateResponse(body, [rawPr({ id: "PR_a" })]);
      const alias = /\n  (\w+): search\(/.exec(body.query)[1];
      if (alias === "team0") {
        return { ok: false, status: 502, statusText: "Bad Gateway", text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: {
            rateLimit: { remaining: 4990, cost: 4, resetAt: "" },
            viewer: { login: "me" },
            [alias]: { nodes: alias === "authored" ? [rawPr({ id: "PR_a" })] : [] },
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
    assert.strictEqual(result.pullRequests.length, 1);
    assert.deepStrictEqual(result.pullRequests[0].roles, ["author"]);
  });

  global.fetch = realGithubFetch;

  // --- jira: fetchIssues ----------------------------------------------------
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

  await atest("fetchIssues: resolves via the API gateway (scoped token)", async () => {
    jira.clearJiraCaches();
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
    const map = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-93373", "ENG-93374"]);
    assert.strictEqual(map.get("ENG-93373").parentKey, "ENG-93367");
    assert.strictEqual(map.get("ENG-93374").parentSummary, "Analyze long app creating");
    assert.strictEqual(hitSite, false); // scoped path must never touch the site URL
  });

  await atest("fetchIssues: falls back to the site URL on 401/403 (classic token)", async () => {
    // Both statuses are "wrong token type for this base" — a regression narrowing
    // the condition to 401-only must fail here.
    for (const status of [401, 403]) {
      jira.clearJiraCaches();
      global.fetch = async (url) => {
        if (isTenant(url)) return tenantOk();
        if (url === GATEWAY) return errRes(status); // classic token → gateway rejects
        if (url === SITE)
          return okJson({ issues: [{ key: "ENG-1", fields: { parent: { key: "ENG-0", fields: { summary: "P" } } } }] });
        throw new Error("unexpected url " + url);
      };
      const map = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-1"]);
      assert.strictEqual(map.get("ENG-1").parentKey, "ENG-0");
    }
  });

  await atest("fetchIssues: a non-UUID cloudId is rejected — site only, no gateway", async () => {
    // tenant_info lives on a user-configured host; a malformed cloudId must not
    // be interpolated into the api.atlassian.com URL path.
    jira.clearJiraCaches();
    let hitGateway = false;
    global.fetch = async (url) => {
      if (isTenant(url)) return okJson({ cloudId: "../../oauth/token#" });
      if (url.startsWith("https://api.atlassian.com/")) { hitGateway = true; return errRes(401); }
      if (url === SITE)
        return okJson({ issues: [{ key: "ENG-1", fields: { parent: { key: "ENG-0" } } }] });
      throw new Error("unexpected url " + url);
    };
    const map = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(map.get("ENG-1").parentKey, "ENG-0");
    assert.strictEqual(hitGateway, false);
  });

  await atest("fetchIssues: uses site only when cloudId can't be resolved", async () => {
    jira.clearJiraCaches();
    let hitGateway = false;
    global.fetch = async (url) => {
      if (isTenant(url)) return errRes(404);
      if (url === GATEWAY) { hitGateway = true; return errRes(401); }
      if (url === SITE)
        return okJson({ issues: [{ key: "ENG-1", fields: { parent: { key: "ENG-0" } } }] });
      throw new Error("unexpected url " + url);
    };
    const map = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(map.get("ENG-1").parentKey, "ENG-0");
    assert.strictEqual(hitGateway, false); // no cloudId → gateway never attempted
  });

  await atest("fetchIssues: an issue with no parent is still returned, with its own summary", async () => {
    // "No parent" is not "no issue": the by-issue heading wants this key's summary
    // even though by-parent grouping has nothing to cluster it under. Dropping it
    // from the map (as the parent-only predecessor did) would leave every heading
    // on a non-subtask ticket showing the bare key.
    jira.clearJiraCaches();
    global.fetch = async (url) =>
      isTenant(url) ? tenantOk() : okJson({ issues: [{ key: "ENG-1", fields: { summary: "Ship the thing" } }] });
    const map = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(map.get("ENG-1").summary, "Ship the thing");
    assert.strictEqual(map.get("ENG-1").parentKey, null);
    assert.strictEqual(map.get("ENG-1").parentSummary, null);
  });

  await atest("fetchIssues: a key Jira doesn't return is absent from the map", async () => {
    // The other half of the pair above: unknown to Jira (or invisible to this
    // token) stays absent, so the enricher writes null rather than a stale value.
    jira.clearJiraCaches();
    global.fetch = async (url) => (isTenant(url) ? tenantOk() : okJson({ issues: [] }));
    const map = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-404"]);
    assert.strictEqual(map.has("ENG-404"), false);
  });

  await atest("fetchIssues: asks Jira for the summary field, not just the parent", async () => {
    // The by-issue heading is only as good as the request: `fields` must carry
    // `summary`, or every issue comes back titleless and the heading silently
    // degrades to the bare key with nothing else failing.
    jira.clearJiraCaches();
    let fields = null;
    global.fetch = async (url, init) => {
      if (isTenant(url)) return tenantOk();
      fields = JSON.parse(init.body).fields;
      return okJson({ issues: [{ key: "ENG-1", fields: { summary: "S" } }] });
    };
    await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-1"]);
    assert.ok(fields.includes("summary"), `fields were ${JSON.stringify(fields)}`);
    assert.ok(fields.includes("parent"), `fields were ${JSON.stringify(fields)}`);
    // Without `issuetype` no issue is ever a subtask and the epic link silently stops.
    assert.ok(fields.includes("issuetype"), `fields were ${JSON.stringify(fields)}`);
  });

  await atest("fetchIssues: isSubtask reads the subtask flag or a negative hierarchy level", async () => {
    // Team-managed projects' custom subtask types carry `hierarchyLevel: -1` with
    // the flag false, so each signal must be enough on its own.
    const cases = [
      [{ subtask: true }, true],
      [{ subtask: false, hierarchyLevel: -1 }, true],
      [{ subtask: false, hierarchyLevel: 0 }, false], // task
      [{ hierarchyLevel: 1 }, false], // epic
      [undefined, false], // no issuetype in the response
    ];
    for (const [issuetype, expected] of cases) {
      jira.clearJiraCaches();
      global.fetch = async (url) =>
        isTenant(url) ? tenantOk() : okJson({ issues: [{ key: "ENG-1", fields: { summary: "S", issuetype } }] });
      const map = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-1"]);
      assert.strictEqual(map.get("ENG-1").isSubtask, expected, `issuetype ${JSON.stringify(issuetype)}`);
    }
  });

  await atest("fetchIssues: a summary-less issue resolves to null, not undefined", async () => {
    // The renderer's label picks the first *non-empty* summary in a cluster, and
    // the poller hashes the field — a missing `summary` must land as null, the
    // same shape github.ts seeds, so neither sees `undefined`.
    jira.clearJiraCaches();
    global.fetch = async (url) =>
      isTenant(url) ? tenantOk() : okJson({ issues: [{ key: "ENG-1", fields: { parent: { key: "ENG-0" } } }] });
    const map = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(map.get("ENG-1").summary, null);
    assert.strictEqual(map.get("ENG-1").parentKey, "ENG-0");
  });

  await atest("fetchIssues: caches — a second call makes no request", async () => {
    jira.clearJiraCaches();
    let searchCalls = 0;
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      searchCalls++;
      return okJson({ issues: [{ key: "ENG-100", fields: { summary: "Cached title", parent: { key: "ENG-1", fields: { summary: "P" } } } }] });
    };
    await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-100"]);
    const again = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-100"]);
    assert.strictEqual(searchCalls, 1);
    assert.strictEqual(again.get("ENG-100").parentKey, "ENG-1");
    // The cached entry must carry the issue's own summary too — a cache that kept
    // only the parent would blank every by-issue heading on the second tick, with
    // no request left to notice it.
    assert.strictEqual(again.get("ENG-100").summary, "Cached title");
  });

  await atest("fetchIssues: every base answering 401 is a rejected token (JiraAuthError), not a plain HTTP error", async () => {
    jira.clearJiraCaches();
    global.fetch = async (url) => (isTenant(url) ? tenantOk() : errRes(401));
    await assert.rejects(
      () => jira.fetchIssues(JIRA_CFG, "tok", ["ENG-5"]),
      (e) => e.name === "JiraAuthError" && e.source === "token" && /rejected the API token/.test(e.message),
    );
  });

  // The site URL serves a bad API token anonymously: 200 with no issues. Only
  // this header tells it apart from "no matches", so without it an expired
  // token reads as "no parent tasks resolved".
  const anonymousSite = () => ({
    ...okJson({ issues: [], isLast: true }),
    headers: { get: (name) => (name.toLowerCase() === "x-seraph-loginreason" ? "AUTHENTICATED_FAILED" : null) },
  });

  await atest("fetchIssues: an expired classic token (gateway 401, site anonymous 200) is a JiraAuthError", async () => {
    jira.clearJiraCaches();
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      if (url === GATEWAY) return errRes(401);
      if (url === SITE) return anonymousSite();
      throw new Error("unexpected url " + url);
    };
    await assert.rejects(
      () => jira.fetchIssues(JIRA_CFG, "tok", ["ENG-7"]),
      (e) => e.name === "JiraAuthError" && e.source === "token",
    );
  });

  await atest("fetchIssues: a rejected token caches nothing — no pinned site base, no negative entries", async () => {
    // Counted as a trusted classic-token answer, the anonymous 200 would pin the
    // site base and write a negative entry per key for 10 minutes.
    jira.clearJiraCaches();
    let expired = true;
    const searches = [];
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      searches.push(url);
      if (url === GATEWAY) return errRes(401);
      if (url === SITE) {
        return expired
          ? anonymousSite()
          : okJson({ issues: [{ key: "ENG-8", fields: { summary: "Eight" } }] });
      }
      throw new Error("unexpected url " + url);
    };
    await assert.rejects(() => jira.fetchIssues(JIRA_CFG, "tok", ["ENG-8"]));
    expired = false; // a new token, same caches (as if setJiraToken had not cleared them)
    searches.length = 0;
    const map = await jira.fetchIssues(JIRA_CFG, "tok2", ["ENG-8"]);
    assert.strictEqual(map.get("ENG-8").summary, "Eight"); // no negative entry served
    assert.deepStrictEqual(searches, [GATEWAY, SITE]); // the site base was not pinned
  });

  await atest("fetchIssues: a token that expires after the site base was pinned still surfaces as JiraAuthError", async () => {
    // The steady state takes the `pinned` path with a single base and never
    // re-probes, so the header check must run there too.
    jira.clearJiraCaches();
    let expired = false;
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      if (url === GATEWAY) return errRes(401);
      if (url === SITE) {
        return expired ? anonymousSite() : okJson({ issues: [{ key: "ENG-9", fields: { summary: "Nine" } }] });
      }
      throw new Error("unexpected url " + url);
    };
    await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-9"]); // pins the site base
    expired = true;
    await assert.rejects(
      () => jira.fetchIssues(JIRA_CFG, "tok", ["ENG-99"]),
      (e) => e.name === "JiraAuthError",
    );
  });

  await atest("fetchIssues: a refusal on the site alone, with the gateway unchecked, is a plain error, not a rejection", async () => {
    // cloudId unresolved: a scoped token reaches only the site, which refuses
    // it as it refuses an expired one. That verdict can't tell the two apart.
    jira.clearJiraCaches();
    global.fetch = async (url) => {
      if (isTenant(url)) return errRes(404);
      if (url === SITE) return anonymousSite();
      throw new Error("unexpected url " + url);
    };
    await assert.rejects(
      () => jira.fetchIssues(JIRA_CFG, "tok", ["ENG-7"]),
      (e) => e.name !== "JiraAuthError" && /gateway could not be checked/.test(e.message),
    );
  });

  await atest("fetchIssues: a 401 from an already pinned gateway is a JiraAuthError", async () => {
    jira.clearJiraCaches();
    let revoked = false;
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      if (url === GATEWAY) return revoked ? errRes(401) : okJson({ issues: [{ key: "ENG-6", fields: { summary: "Six" } }] });
      throw new Error("unexpected url " + url);
    };
    await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-6"]); // pins the gateway
    revoked = true;
    await assert.rejects(
      () => jira.fetchIssues(JIRA_CFG, "tok", ["ENG-66"]),
      (e) => e.name === "JiraAuthError" && e.source === "token",
    );
  });

  await atest("fetchIssues: a site response with an OK login reason is not a rejection", async () => {
    // Only the failure values are matched — a valid token's response may carry
    // another value or omit the header.
    jira.clearJiraCaches();
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      if (url === GATEWAY) return errRes(401);
      return {
        ...okJson({ issues: [{ key: "ENG-10", fields: { summary: "Ten" } }] }),
        headers: { get: (n) => (n.toLowerCase() === "x-seraph-loginreason" ? "OK" : null) },
      };
    };
    const map = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-10"]);
    assert.strictEqual(map.get("ENG-10").summary, "Ten");
  });

  await atest("fetchIssues: recovers within the cloudId TTL after a transient blip (no 10-min negative poisoning)", async () => {
    // Regression: a transient tenant_info blip must not keep the banner 'empty'
    // for the full CACHE_TTL_MS. The failed cloudId is cached only ~60s, the
    // site-only base is left uncached, AND the untrusted 200-but-empty writes no
    // negative issueCache entries — so the first pass after the 60s TTL re-probes
    // and the scoped token reaches the gateway, long before the 10-min TTL. This
    // advances the clock only 61s to exercise that intervening window.
    jira.clearJiraCaches();
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
      const first = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-9"]);
      assert.strictEqual(first.has("ENG-9"), false);
      assert.strictEqual(gatewayHits, 0);
      // Advance just past the 60s cloudId TTL — far short of the 10-min issueCache TTL.
      clock += 61 * 1000;
      // Second pass: cloudId re-resolves, the gateway wins (site base not pinned,
      // no negatives cached), so recovery happens inside the 60s window. Recovering
      // here — well before CACHE_TTL_MS — is the proof that the blip wrote no
      // poisoning negative: a cached negative would still be fresh at +61s, keep
      // ENG-9 out of the stale set, and leave the map empty (failing the assert).
      const second = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-9"]);
      assert.strictEqual(second.get("ENG-9").parentKey, "ENG-0");
      assert.ok(gatewayHits >= 1);
    } finally {
      Date.now = realNow;
      global.fetch = realFetch;
    }
  });

  await atest("fetchIssues: a 5xx/429 on the gateway throws and does NOT fall back to the site", async () => {
    // The 401/403-only fallback is deliberate: a scoped token on the site URL
    // answers 200-but-empty, so silently retrying there on a 429/500 would mask a
    // real gateway error as "no parents found". Lock the invariant in.
    for (const status of [429, 500]) {
      jira.clearJiraCaches();
      let hitSite = false;
      global.fetch = async (url) => {
        if (isTenant(url)) return tenantOk();
        if (url === GATEWAY) return errRes(status);
        if (url === SITE) { hitSite = true; return okJson({ issues: [] }); }
        throw new Error("unexpected url " + url);
      };
      await assert.rejects(
        () => jira.fetchIssues(JIRA_CFG, "tok", ["ENG-7"]),
        new RegExp(`Jira HTTP ${status}`),
      );
      assert.strictEqual(hitSite, false);
    }
  });

  await atest("fetchIssues: a network throw on the gateway still falls back to the site", async () => {
    // A thrown fetch (timeout/DNS, or a proxy blocking the gateway host while
    // allowing the site) must advance to the site like a 401 would, so a classic
    // token behind such a proxy isn't stranded on a hard error.
    jira.clearJiraCaches();
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
    const map = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-2"]);
    assert.strictEqual(hitSite, true);
    assert.strictEqual(map.get("ENG-2").parentKey, "ENG-1");
  });

  await atest("fetchIssues: a thrown-gateway fallback neither pins the site nor caches negatives", async () => {
    // The untrusted-fallback guard (`cleanFallback`): a 200-but-empty reached
    // past a thrown gateway might be a scoped token that belongs on the gateway.
    // If the site base got pinned or negatives written here, the dashboard would
    // stay silently empty long after the gateway recovers. Mutation guard:
    // replacing resultIsTrustworthy with `bases.length > 1` must fail this test.
    jira.clearJiraCaches();
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
      const first = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-11"]);
      assert.strictEqual(first.has("ENG-11"), false);
      // Past the 60s gateway backoff but far inside the 10-min issueCache TTL: a
      // poisoning negative from pass 1 would still be fresh and keep the key out
      // of the stale set; a pinned site base would never retry the gateway.
      // Either regression leaves the map empty here.
      clock += 61 * 1000;
      const second = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-11"]);
      assert.strictEqual(second.get("ENG-11").parentKey, "ENG-10");
      assert.strictEqual(gatewayCalls, 2);
    } finally {
      Date.now = realNow;
      global.fetch = realFetch;
    }
  });

  await atest("fetchIssues: a thrown gateway is backed off, not re-probed on every pass", async () => {
    // Recurring-timeout guard: after the gateway throws (proxy blocking
    // api.atlassian.com while allowing the site), later passes inside the backoff
    // window must go straight to the site — no repeated 10s timeout per chunk per
    // tick — and the gateway is re-attempted once the window lapses.
    jira.clearJiraCaches();
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
      const first = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-21"]);
      assert.strictEqual(first.get("ENG-21").parentKey, "ENG-20");
      assert.strictEqual(gatewayAttempts, 1);
      // Inside the backoff window: the gateway must not be attempted again.
      const second = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-22"]);
      assert.strictEqual(second.get("ENG-22").parentKey, "ENG-20");
      assert.strictEqual(gatewayAttempts, 1);
      // Past the window: the gateway candidate is back (and may throw again).
      clock += 61 * 1000;
      const third = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-23"]);
      assert.strictEqual(third.get("ENG-23").parentKey, "ENG-20");
      assert.strictEqual(gatewayAttempts, 2);
    } finally {
      Date.now = realNow;
      global.fetch = realFetch;
    }
  });

  await atest("fetchIssues: a clearJiraCaches during an in-flight pass discards that pass's cache writes", async () => {
    // Token-change race: the user saves a new token while a pass built with the
    // old token is awaiting its fetch. When that pass resolves it must not re-pin
    // the base or repopulate the caches that were just cleared — otherwise the
    // new token would be sent to the old token's pinned base forever.
    jira.clearJiraCaches();
    let tenantCalls = 0;
    let searchCalls = 0;
    global.fetch = async (url) => {
      if (isTenant(url)) { tenantCalls++; return tenantOk(); }
      searchCalls++;
      if (searchCalls === 1) jira.clearJiraCaches(); // the token save lands mid-flight
      return okJson({ issues: [{ key: "ENG-31", fields: { parent: { key: "ENG-30", fields: { summary: "P" } } } }] });
    };
    // The raced pass reports empty — its result belongs to the pre-clear world.
    const first = await jira.fetchIssues(JIRA_CFG, "old-token", ["ENG-31"]);
    assert.strictEqual(first.has("ENG-31"), false);
    // The next pass must re-probe everything: nothing from the raced pass survived.
    const second = await jira.fetchIssues(JIRA_CFG, "new-token", ["ENG-31"]);
    assert.strictEqual(second.get("ENG-31").parentKey, "ENG-30");
    assert.strictEqual(tenantCalls, 2); // cloudId re-resolved → cleared cache stayed cleared
    assert.strictEqual(searchCalls, 2); // parent re-fetched → no stale positive/pin survived
  });

  await atest("fetchIssues: negatives are still cached after the base is pinned (no per-tick re-query)", async () => {
    // Regression: once the base is pinned, apiBasesFor returns a single-element
    // array. A `bases.length > 1` trust check alone would then treat every
    // steady-state call as untrusted and stop caching negatives, re-querying
    // no-parent keys on every tick. A pinned base must stay trusted.
    jira.clearJiraCaches();
    let searchCalls = 0;
    global.fetch = async (url) => {
      if (isTenant(url)) return tenantOk();
      searchCalls++; // gateway search — returns a parent only for ENG-A, never ENG-B
      return okJson({ issues: [{ key: "ENG-A", fields: { parent: { key: "ENG-P", fields: { summary: "P" } } } }] });
    };
    // Call 1 pins the gateway (bases.length === 2 here).
    await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-A"]);
    // Call 2 runs with the base already pinned (bases === [gateway]); ENG-B is not
    // returned, so its negative must still be written despite the single-element set.
    await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-B"]);
    const callsBefore = searchCalls;
    // Call 3 for the same no-parent key must make no new request — proving the
    // negative from call 2 was cached.
    const again = await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-B"]);
    assert.strictEqual(again.has("ENG-B"), false);
    assert.strictEqual(searchCalls, callsBefore);
  });

  await atest("clearJiraCaches: wipes issue + cloudId + apiBase caches (token change forces a full re-probe)", async () => {
    jira.clearJiraCaches();
    let tenantCalls = 0;
    let searchCalls = 0;
    global.fetch = async (url) => {
      if (isTenant(url)) { tenantCalls++; return tenantOk(); }
      searchCalls++;
      return okJson({ issues: [{ key: "ENG-1", fields: { parent: { key: "ENG-0", fields: { summary: "P" } } } }] });
    };
    await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(tenantCalls, 1); // cloudId resolved once
    assert.strictEqual(searchCalls, 1);
    // A repeat with everything cached hits the network for neither.
    await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(tenantCalls, 1);
    assert.strictEqual(searchCalls, 1);
    // Clearing (as setJiraToken does on a token change) forces a full re-probe.
    jira.clearJiraCaches();
    await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-1"]);
    assert.strictEqual(tenantCalls, 2); // cloudIdCache cleared → tenant_info re-probed
    assert.strictEqual(searchCalls, 2); // issueCache + apiBaseCache cleared → re-queried
  });

  await atest("fetchIssues: the tenant_info probe uses a shorter timeout than the search", async () => {
    // Cold-cache + full-outage guard: the enricher pays the cloudId probe and
    // the search as two sequential timeouts in one tick, so the lightweight
    // unauthenticated tenant_info probe must not hold the full per-request
    // budget — otherwise a total Jira outage doubles the worst-case poll stall.
    // Capture the AbortController deadline each fetch arms and assert the probe's
    // is materially shorter than the search's. Reverting the probe to the full
    // REQUEST_TIMEOUT_MS must fail here.
    jira.clearJiraCaches();
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
      await jira.fetchIssues(JIRA_CFG, "tok", ["ENG-1"]);
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

  // --- the Jira enricher, verified against a mocked Electron -----------------
  // `jira-store.ts` imports electron (`app`, `safeStorage`), so it is exercised
  // the way `tray.ts` and `main.ts` are: require the COMPILED module with a fake
  // electron in the require cache, over the same stubbed `fetch` as the cases
  // above. That reaches what the pure rules can't — the enricher's real output:
  // what it writes onto each PR, and the health it reports for a whole batch.
  const withMockedElectron = async (fn) => {
    const fsSync = require("node:fs");
    const storeJs = path.join(__dirname, "../dist/main/main/jira-store.js");
    const elPath = require.resolve("electron", { paths: [path.dirname(storeJs)] });
    const storePath = require.resolve(storeJs);
    const userData = fsSync.mkdtempSync(path.join(os.tmpdir(), "prd-jira-store-"));
    const hadElectron = require.cache[elPath];
    require.cache[elPath] = {
      id: elPath,
      filename: elPath,
      loaded: true,
      exports: {
        // A userData dir of our own, so the token file is real but disposable.
        app: { getPath: () => userData },
        // The keychain stands in as identity: setJiraToken/getJiraToken still run
        // their real file paths, which is what carries the token through to fetch.
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (text) => Buffer.from(text, "utf8"),
          decryptString: (buf) => buf.toString("utf8"),
        },
      },
    };
    delete require.cache[storePath];
    try {
      await fn(require(storeJs));
    } finally {
      delete require.cache[storePath];
      if (hadElectron) require.cache[elPath] = hadElectron;
      else delete require.cache[elPath];
      fsSync.rmSync(userData, { recursive: true, force: true });
    }
  };
  // Without an injected runner the enricher would spawn the machine's real
  // `twg` — and, where it is signed in, query real Jira. These cases exercise
  // the API-token path, so twg is "not installed" for them.
  const NO_TWG = { runTwg: async () => ({ stdout: "", stderr: "", code: null, notFound: true }) };
  // Jira answers only the keys the JQL actually asked for, with the fields each
  // case gives them — so a case controls parentage per key, and a key it omits
  // is one Jira doesn't know.
  const jiraAnswers = (byKey) => async (url, init) => {
    if (isTenant(url)) return tenantOk();
    const queried = JSON.parse(init.body).jql.match(/[A-Z]+-\d+/g) || [];
    return okJson({
      issues: queried.filter((k) => byKey[k]).map((k) => ({ key: k, fields: byKey[k] })),
    });
  };

  await atest("buildJiraEnricher: writes each PR's summary and parent, and counts only parents as resolved", async () => {
    jira.clearJiraCaches();
    global.fetch = jiraAnswers({
      "ENG-1": { summary: "One", parent: { key: "ENG-0", fields: { summary: "The parent task" } } },
      "ENG-2": { summary: "Two", parent: { key: "ENG-0", fields: { summary: "The parent task" } } },
      "ENG-3": { summary: "Three" }, // resolves, but is not a subtask
    });
    await withMockedElectron(async (store) => {
      assert.strictEqual(store.setJiraToken("tok").ok, true);
      const prs = [
        { issueKey: "ENG-1", issueSummary: null, parentKey: null, parentSummary: null },
        { issueKey: "ENG-2", issueSummary: null, parentKey: null, parentSummary: null },
        { issueKey: "ENG-3", issueSummary: null, parentKey: null, parentSummary: null },
        { issueKey: null, issueSummary: null, parentKey: null, parentSummary: null },
      ];
      const health = await store.buildJiraEnricher(() => ({ jira: JIRA_CFG }), NO_TWG)(prs);
      // The by-issue heading's input, on every PR that has a key — including the
      // parentless one, which the parent-only lookup used to drop entirely.
      assert.deepStrictEqual(
        prs.map((p) => p.issueSummary),
        ["One", "Two", "Three", null],
      );
      assert.deepStrictEqual(
        prs.map((p) => p.parentKey),
        ["ENG-0", "ENG-0", null, null],
      );
      assert.strictEqual(prs[0].parentSummary, "The parent task");
      // `resolved` is 2, not the 3 issues that resolved: the regression the
      // parent-only count exists to prevent, caught through the enricher's own
      // output rather than through its source text.
      assert.deepStrictEqual(health, { state: "ok", queried: 3, resolved: 2, source: "token" });
    });
  });

  await atest("buildJiraEnricher: every key resolves but none is a subtask -> empty health", async () => {
    // Summaries came back, so the by-issue heading is fine and needs no banner —
    // but "Group by parent task" has nothing to cluster and must say so. Counting
    // issues instead of parents would report ok here and leave that view silently
    // bare, which is the whole reason the banner exists.
    jira.clearJiraCaches();
    global.fetch = jiraAnswers({ "ENG-4": { summary: "Four" }, "ENG-5": { summary: "Five" } });
    await withMockedElectron(async (store) => {
      assert.strictEqual(store.setJiraToken("tok").ok, true);
      const prs = [
        { issueKey: "ENG-4", issueSummary: null, parentKey: null, parentSummary: null },
        { issueKey: "ENG-5", issueSummary: null, parentKey: null, parentSummary: null },
      ];
      const health = await store.buildJiraEnricher(() => ({ jira: JIRA_CFG }), NO_TWG)(prs);
      assert.deepStrictEqual(
        prs.map((p) => p.issueSummary),
        ["Four", "Five"],
      );
      assert.deepStrictEqual(health, { state: "empty", queried: 2, resolved: 0, source: "token" });
    });
  });

  await atest("buildJiraEnricher: no token -> skipped, with no request and no health", async () => {
    // The skip ordering is unit-tested pure; this pins that the enricher honours
    // it against the real token store, so a missing token can never spend a call.
    jira.clearJiraCaches();
    let calls = 0;
    const answer = jiraAnswers({ "ENG-6": { summary: "Six" } });
    global.fetch = async (...args) => {
      calls++;
      return answer(...args);
    };
    await withMockedElectron(async (store) => {
      assert.strictEqual(store.setJiraToken("").ok, true); // clears any stored token
      const prs = [{ issueKey: "ENG-6", issueSummary: null, parentKey: null, parentSummary: null }];
      const health = await store.buildJiraEnricher(() => ({ jira: JIRA_CFG }), NO_TWG)(prs);
      assert.strictEqual(health, undefined);
      assert.strictEqual(prs[0].issueSummary, null);
      assert.strictEqual(calls, 0);
    });
  });

  // The board shape behind the grandparent link: a subtask under a task under an epic.
  const blankPr = (issueKey) => ({
    issueKey, issueSummary: null, parentKey: null, parentSummary: null, grandparentKey: null, grandparentSummary: null,
  });
  const SUBTASK = { subtask: true, hierarchyLevel: -1 };
  const TASK = { subtask: false, hierarchyLevel: 0 };

  await atest("buildJiraEnricher: a subtask's PR gets the epic above its task as grandparent", async () => {
    jira.clearJiraCaches();
    const queries = [];
    const answer = jiraAnswers({
      "ENG-11": { summary: "Footer runtime", issuetype: SUBTASK, parent: { key: "ENG-10", fields: { summary: "Footer" } } },
      "ENG-12": { summary: "Other task", issuetype: TASK, parent: { key: "ENG-1", fields: { summary: "Stepper" } } },
      "ENG-10": { summary: "Footer", issuetype: TASK, parent: { key: "ENG-1", fields: { summary: "Stepper" } } },
    });
    global.fetch = async (url, init) => {
      if (!isTenant(url)) queries.push(JSON.parse(init.body).jql);
      return answer(url, init);
    };
    await withMockedElectron(async (store) => {
      assert.strictEqual(store.setJiraToken("tok").ok, true);
      const prs = [blankPr("ENG-11"), blankPr("ENG-12")];
      await store.buildJiraEnricher(() => ({ jira: JIRA_CFG }), NO_TWG)(prs);
      assert.strictEqual(prs[0].parentKey, "ENG-10");
      assert.strictEqual(prs[0].grandparentKey, "ENG-1");
      assert.strictEqual(prs[0].grandparentSummary, "Stepper");
      // A task's parent already is the epic: nothing above it is looked up.
      assert.strictEqual(prs[1].grandparentKey, null);
      assert.deepStrictEqual(queries, ["key in (ENG-11,ENG-12)", "key in (ENG-10)"]);
    });
  });

  await atest("buildJiraEnricher: a team-managed subtask (flag false, level -1) still reaches the epic", async () => {
    jira.clearJiraCaches();
    global.fetch = jiraAnswers({
      "ENG-31": { summary: "Sub", issuetype: { subtask: false, hierarchyLevel: -1 }, parent: { key: "ENG-30", fields: { summary: "Task" } } },
      "ENG-30": { summary: "Task", issuetype: TASK, parent: { key: "ENG-3", fields: { summary: "Epic" } } },
    });
    await withMockedElectron(async (store) => {
      assert.strictEqual(store.setJiraToken("tok").ok, true);
      const prs = [blankPr("ENG-31")];
      await store.buildJiraEnricher(() => ({ jira: JIRA_CFG }), NO_TWG)(prs);
      assert.strictEqual(prs[0].grandparentKey, "ENG-3");
      assert.strictEqual(prs[0].grandparentSummary, "Epic");
    });
  });

  await atest("buildJiraEnricher: a failed task lookup keeps the subtask's own summary and parent", async () => {
    jira.clearJiraCaches();
    const answer = jiraAnswers({
      "ENG-21": { summary: "Sub", issuetype: SUBTASK, parent: { key: "ENG-20", fields: { summary: "Task" } } },
    });
    global.fetch = async (url, init) => {
      if (!isTenant(url) && JSON.parse(init.body).jql.includes("ENG-20")) return errRes(500);
      return answer(url, init);
    };
    await withMockedElectron(async (store) => {
      assert.strictEqual(store.setJiraToken("tok").ok, true);
      const prs = [blankPr("ENG-21")];
      const health = await store.buildJiraEnricher(() => ({ jira: JIRA_CFG }), NO_TWG)(prs);
      assert.strictEqual(prs[0].issueSummary, "Sub");
      assert.strictEqual(prs[0].parentKey, "ENG-20");
      assert.strictEqual(prs[0].grandparentKey, null);
      assert.deepStrictEqual(health, { state: "ok", queried: 1, resolved: 1, source: "token" });
    });
  });

  await atest("buildJiraEnricher: through twg, a subtask's PR reaches the epic above its task", async () => {
    jira.clearJiraCaches();
    global.fetch = async () => {
      throw new Error("the API token must not be used while twg answers");
    };
    const twgIssues = {
      "ENG-81": { key: "ENG-81", summary: "Sub", parent: { key: "ENG-80", fields: { summary: "Task" } }, issuetype: { subtask: true } },
      "ENG-80": { key: "ENG-80", summary: "Task", parent: { key: "ENG-1", fields: { summary: "Epic" } }, issuetype: { subtask: false } },
    };
    const runTwg = async (args) => {
      const asked = args.join(" ").match(/[A-Z]+-\d+/g) || [];
      return { stdout: JSON.stringify({ data: { issues: asked.filter((k) => twgIssues[k]).map((k) => twgIssues[k]) } }), stderr: "", code: 0 };
    };
    await withMockedElectron(async (store) => {
      const prs = [{ issueKey: "ENG-81", issueSummary: null, parentKey: null, parentSummary: null }];
      const health = await store.buildJiraEnricher(() => ({ jira: { baseUrl: JIRA_CFG.baseUrl } }), { runTwg })(prs);
      assert.deepStrictEqual(health, { state: "ok", queried: 1, resolved: 1, source: "twg" });
      assert.strictEqual(prs[0].parentKey, "ENG-80");
      assert.strictEqual(prs[0].grandparentKey, "ENG-1");
      assert.strictEqual(prs[0].grandparentSummary, "Epic");
    });
  });

  await atest("buildJiraEnricher: a signed-out twg and no token is auth health naming twg", async () => {
    jira.clearJiraCaches();
    const runTwg = async () => ({ stdout: JSON.stringify({ ok: false, error: { code: "AUTH_REQUIRED", message: "sign in" } }), stderr: "", code: 1 });
    await withMockedElectron(async (store) => {
      assert.strictEqual(store.setJiraToken("").ok, true);
      const prs = [{ issueKey: "ENG-82", issueSummary: null, parentKey: null, parentSummary: null }];
      const health = await store.buildJiraEnricher(() => ({ jira: { baseUrl: JIRA_CFG.baseUrl } }), { runTwg })(prs);
      assert.strictEqual(health.state, "auth");
      assert.strictEqual(health.source, "twg");
    });
  });

  await atest("getJiraStatus: maps the twg state, the token and the email onto the setup status", async () => {
    await withMockedElectron(async (store) => {
      const site = { jira: { baseUrl: "https://org.atlassian.net" } };
      const status = async (settings, twg) => store.getJiraStatus(() => settings, twg);

      assert.strictEqual(store.setJiraToken("").ok, true);
      let s = await status(site, { state: "signed-in", account: "Ann" });
      assert.deepStrictEqual(
        { configured: s.configured, twg: s.twg, hasConfig: s.hasConfig, hasEmail: s.hasEmail, hasToken: s.hasToken, baseUrl: s.baseUrl },
        { configured: true, twg: { state: "signed-in", account: "Ann" }, hasConfig: true, hasEmail: false, hasToken: false, baseUrl: "https://org.atlassian.net" },
      );
      assert.strictEqual(s.signInSource, "twg");
      // A signed-out twg stays configured (the saved grouping survives), but can't sign in.
      s = await status(site, { state: "signed-out" });
      assert.strictEqual(s.configured, true);
      assert.strictEqual(s.signInSource, null);
      // While whoami runs the status answers at once, still configured.
      s = await status(site, { state: "checking" });
      assert.deepStrictEqual([s.configured, s.baseUrl, s.twg.state], [true, "https://org.atlassian.net", "checking"]);
      // No twg and no token: nothing is set up.
      assert.strictEqual((await status(site, { state: "not-installed" })).configured, false);
      // No twg, but a token with its email: set up through the fallback.
      assert.strictEqual(store.setJiraToken("tok").ok, true);
      s = await status({ jira: JIRA_CFG }, { state: "not-installed" });
      assert.strictEqual(s.configured, true);
      assert.strictEqual(s.hasEmail, true);
      assert.strictEqual(s.hasToken, true);
      assert.strictEqual(s.signInSource, "token");
      // A broken settings file fails closed.
      s = store.getJiraStatus(
        () => {
          throw new Error("bad settings");
        },
        { state: "signed-in" },
      );
      assert.strictEqual(s.configured, false);
      assert.strictEqual(s.hasConfig, false);
    });
  });

  await atest("createJiraStatusLoader: cached first, fresh while twg is checking; a stale answer never wins", async () => {
    const loaderMod = require(path.join(__dirname, "../dist/main/shared/jira-status.js"));
    const st = (state) => ({ twg: { state }, baseUrl: "https://org.atlassian.net" });
    const calls = [];
    const pending = [];
    const shown = [];
    const load = loaderMod.createJiraStatusLoader(
      (mode) => new Promise((resolve) => (calls.push(mode), pending.push(resolve))),
      (s) => shown.push(s.twg.state),
    );
    const first = load();
    pending.shift()(st("checking"));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(calls, ["cached", "fresh"], "a checking twg is read again, fresh");
    const slowFresh = pending.shift();
    const second = load(true); // e.g. Check again, while the first fresh read still runs
    pending.shift()(st("signed-in"));
    await second;
    slowFresh(st("signed-out")); // the older answer arrives last
    await first;
    assert.deepStrictEqual(shown, ["checking", "signed-in"], "the older answer must not overwrite the newer one");
    // A cached answer that is already known needs no second read.
    const third = load();
    pending.shift()(st("signed-in"));
    await third;
    assert.deepStrictEqual(calls, ["cached", "fresh", "fresh", "cached"]);
  });

  // --- the twg source and how a pass picks between twg and the API token ----
  // twg prints the issue fields flat on the issue (the REST search nests them
  // under `fields`) and reports failures as `{ ok: false, error: { code } }`.
  const twgOk = (issues) => ({ stdout: JSON.stringify({ apiVersion: "v2", data: { issues } }), stderr: "", code: 0 });
  const twgErr = (code, message) => ({
    stdout: JSON.stringify({ ok: false, error: { code, message } }),
    stderr: "",
    code: 1,
  });
  const TWG_NOT_INSTALLED = { stdout: "", stderr: "", code: null, notFound: true };

  test("twgQueryArgs: forces plain JSON output and targets the configured site", () => {
    const args = jiraTwg.twgQueryArgs("https://org.atlassian.net", ["ENG-1", "ENG-2"]);
    // `--mode user` overrides an inherited TWG_AGENT_DEFAULTS; `--output-summary
    // none` keeps the agent YAML envelope off stdout.
    for (const pair of [["--mode", "user"], ["--output", "json"], ["--output-summary", "none"], ["--site", "org.atlassian.net"]]) {
      const i = args.indexOf(pair[0]);
      assert.ok(i >= 0 && args[i + 1] === pair[1], `missing ${pair.join(" ")}`);
    }
    assert.strictEqual(args[args.indexOf("--jql") + 1], "key in (ENG-1,ENG-2)");
    assert.strictEqual(args[args.indexOf("--fields") + 1], "summary,parent,issuetype");
  });
  test("classifyTwgRun: success, missing binary, AUTH_* codes, other errors", () => {
    assert.strictEqual(jiraTwg.classifyTwgRun(twgOk([])), null);
    assert.deepStrictEqual(jiraTwg.classifyTwgRun(TWG_NOT_INSTALLED), { kind: "not-installed" });
    assert.deepStrictEqual(jiraTwg.classifyTwgRun(twgErr("AUTH_REQUIRED", "Run twg login")), {
      kind: "auth",
      message: "Run twg login",
    });
    assert.strictEqual(jiraTwg.classifyTwgRun(twgErr("AUTH_PROFILE_MISSING", "No profile")).kind, "auth");
    assert.deepStrictEqual(jiraTwg.classifyTwgRun(twgErr("RATE_LIMITED", "slow down")), {
      kind: "error",
      message: "twg: slow down",
    });
    assert.strictEqual(jiraTwg.classifyTwgRun({ stdout: "", stderr: "", code: null }).message, "twg: timed out");
    assert.match(jiraTwg.classifyTwgRun({ stdout: "not json", stderr: "boom\nmore", code: 2 }).message, /code 2: boom$/);
  });
  test("parseTwgAccount: the whoami display name", () => {
    assert.strictEqual(jiraTwg.parseTwgAccount(JSON.stringify({ data: { name: "Ann", email: "a@x" } })), "Ann");
    assert.strictEqual(jiraTwg.parseTwgAccount("{}"), null);
  });

  test("twgWhoamiArgs: forces user mode, JSON output and no summary envelope", () => {
    const args = jiraTwg.twgWhoamiArgs();
    assert.ok(args.includes("whoami"));
    for (const [flag, value] of [["--mode", "user"], ["--output", "json"], ["--output-summary", "none"]]) {
      assert.strictEqual(args[args.indexOf(flag) + 1], value, flag);
    }
  });
  test("twgStatusFrom: signed in (with the account), signed out, not installed, error", () => {
    const whoami = { stdout: JSON.stringify({ data: { name: "Ann" } }), stderr: "", code: 0 };
    assert.deepStrictEqual(jiraTwg.twgStatusFrom(whoami), { state: "signed-in", account: "Ann" });
    assert.deepStrictEqual(jiraTwg.twgStatusFrom({ stdout: "{}", stderr: "", code: 0 }), { state: "signed-in" });
    assert.strictEqual(jiraTwg.twgStatusFrom(twgErr("AUTH_REQUIRED", "sign in")).state, "signed-out");
    assert.deepStrictEqual(jiraTwg.twgStatusFrom(TWG_NOT_INSTALLED), { state: "not-installed" });
    assert.deepStrictEqual(jiraTwg.twgStatusFrom({ stdout: "", stderr: "", code: null }), { state: "error", message: "twg: timed out" });
  });
  await atest("createTwgStatusCache: no value before the first read; concurrent refreshes share one read", async () => {
    let reads = 0;
    let release;
    const cache = jiraTwg.createTwgStatusCache(
      () => new Promise((resolve) => (reads++, (release = () => resolve({ state: "signed-in", account: "Ann" })))),
    );
    assert.strictEqual(cache.current(), null);
    const a = cache.refresh();
    const b = cache.refresh();
    assert.strictEqual(reads, 1, "a second caller must not start another whoami");
    release();
    assert.deepStrictEqual(await a, await b);
    assert.deepStrictEqual(cache.current(), { state: "signed-in", account: "Ann" });
    const c = cache.refresh();
    assert.strictEqual(reads, 2, "once settled, a refresh reads again");
    release();
    await c;
  });
  await atest("createTwgStatusCache: a read that throws becomes an error status, never a rejection", async () => {
    const cache = jiraTwg.createTwgStatusCache(async () => {
      throw new Error("boom");
    });
    assert.deepStrictEqual(await cache.refresh(), { state: "error", message: "boom" });
    assert.strictEqual(cache.current().state, "error");
  });
  await atest("runTwg: no twg on PATH is notFound, which the status reads as not installed", async () => {
    const twgMain = require(path.join(__dirname, "../dist/main/main/twg.js"));
    const empty = require("node:fs").mkdtempSync(path.join(os.tmpdir(), "prd-no-twg-"));
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const saved = process.env[pathKey];
    process.env[pathKey] = empty;
    try {
      const run = await twgMain.runTwg(["whoami"]);
      assert.strictEqual(run.notFound, true);
      assert.deepStrictEqual(jiraTwg.twgStatusFrom(run), { state: "not-installed" });
    } finally {
      process.env[pathKey] = saved;
      require("node:fs").rmSync(empty, { recursive: true, force: true });
    }
  });

  await atest("resolveIssues(twg): reads twg's flat fields — summary, parent and its summary, subtask flag", async () => {
    jira.clearJiraCaches();
    const run = async () =>
      twgOk([
        {
          key: "ENG-41",
          summary: "Sub",
          issuetype: { subtask: true, hierarchyLevel: -1 },
          parent: { key: "ENG-40", fields: { summary: "Task" } },
        },
      ]);
    const map = await jira.resolveIssues({ kind: "twg", baseUrl: "https://org.atlassian.net", run }, ["ENG-41", "ENG-42"]);
    assert.deepStrictEqual(map.get("ENG-41"), {
      summary: "Sub",
      parentKey: "ENG-40",
      parentSummary: "Task",
      isSubtask: true,
    });
    assert.strictEqual(map.has("ENG-42"), false);
  });

  await atest("resolveIssues(twg): AUTH_* is a JiraAuthError from twg; a missing binary is TwgNotInstalledError", async () => {
    jira.clearJiraCaches();
    const lookup = (result) => ({ kind: "twg", baseUrl: "https://org.atlassian.net", run: async () => result });
    await assert.rejects(
      () => jira.resolveIssues(lookup(twgErr("AUTH_REQUIRED", "sign in")), ["ENG-1"]),
      (e) => e.name === "JiraAuthError" && e.source === "twg",
    );
    await assert.rejects(
      () => jira.resolveIssues(lookup(TWG_NOT_INSTALLED), ["ENG-1"]),
      (e) => e.name === "TwgNotInstalledError",
    );
  });

  const passDeps = (over) => ({
    runTwg: async () => TWG_NOT_INSTALLED,
    hasToken: () => true,
    readToken: () => "tok",
    ...over,
  });

  await atest("createJiraPass: twg answers first and the API token is never sent", async () => {
    jira.clearJiraCaches();
    let fetched = 0;
    global.fetch = async () => {
      fetched++;
      throw new Error("token path must not run");
    };
    const pass = jiraPass.createJiraPass(
      passDeps({ runTwg: async () => twgOk([{ key: "ENG-51", summary: "S", parent: { key: "ENG-50" } }]) }),
    );
    const result = await pass(JIRA_CFG, ["ENG-51"]);
    assert.deepStrictEqual(result.health, { state: "ok", queried: 1, resolved: 1, source: "twg" });
    assert.strictEqual(fetched, 0);
  });

  await atest("createJiraPass: twg not installed -> the API token, with no twg trace in the health", async () => {
    jira.clearJiraCaches();
    global.fetch = jiraAnswers({ "ENG-52": { summary: "S", parent: { key: "ENG-50" } } });
    const result = await jiraPass.createJiraPass(passDeps())(JIRA_CFG, ["ENG-52"]);
    assert.deepStrictEqual(result.health, { state: "ok", queried: 1, resolved: 1, source: "token" });
  });

  await atest("createJiraPass: twg signed out and a working token -> the token's result", async () => {
    jira.clearJiraCaches();
    global.fetch = jiraAnswers({ "ENG-53": { summary: "S", parent: { key: "ENG-50" } } });
    const pass = jiraPass.createJiraPass(passDeps({ runTwg: async () => twgErr("AUTH_REQUIRED", "sign in") }));
    const result = await pass(JIRA_CFG, ["ENG-53"]);
    assert.strictEqual(result.health.state, "ok");
    assert.strictEqual(result.health.source, "token");
  });

  await atest("createJiraPass: twg signed out and no token -> auth health naming twg", async () => {
    jira.clearJiraCaches();
    const pass = jiraPass.createJiraPass(
      passDeps({ runTwg: async () => twgErr("AUTH_REQUIRED", "sign in"), hasToken: () => false, readToken: () => null }),
    );
    const result = await pass({ baseUrl: JIRA_CFG.baseUrl }, ["ENG-54"]);
    assert.deepStrictEqual(result.health, { state: "auth", message: "sign in", queried: 1, resolved: 0, source: "twg" });
  });

  await atest("createJiraPass: no twg and no usable token -> undefined (nothing to do)", async () => {
    jira.clearJiraCaches();
    const noToken = jiraPass.createJiraPass(passDeps({ hasToken: () => false, readToken: () => null }));
    assert.strictEqual(await noToken(JIRA_CFG, ["ENG-55"]), undefined);
    // A token but no email can't sign in either — and the keychain isn't touched.
    let read = 0;
    const noEmail = jiraPass.createJiraPass(passDeps({ readToken: () => (read++, "tok") }));
    assert.strictEqual(await noEmail({ baseUrl: JIRA_CFG.baseUrl }, ["ENG-55"]), undefined);
    assert.strictEqual(read, 0);
  });

  await atest("createJiraPass: a rejected token is not sent again until it changes", async () => {
    jira.clearJiraCaches();
    let searches = 0;
    let tokenWorks = false;
    global.fetch = async (url, init) => {
      if (isTenant(url)) return tenantOk();
      searches++;
      if (url === GATEWAY) return errRes(401);
      return tokenWorks
        ? jiraAnswers({ "ENG-56": { summary: "S", parent: { key: "ENG-50" } } })(url, init)
        : anonymousSite();
    };
    let token = "expired";
    const pass = jiraPass.createJiraPass(passDeps({ readToken: () => token }));
    const first = await pass(JIRA_CFG, ["ENG-56"]);
    assert.strictEqual(first.health.state, "auth");
    assert.strictEqual(first.health.source, "token");
    const sent = searches;
    const second = await pass(JIRA_CFG, ["ENG-56"]);
    assert.deepStrictEqual(second.health, first.health);
    assert.strictEqual(searches, sent, "the rejected token must not reach Jira again");
    // A new token is tried at once.
    token = "fresh";
    tokenWorks = true;
    const third = await pass(JIRA_CFG, ["ENG-56"]);
    assert.strictEqual(third.health.state, "ok");
    assert.strictEqual(third.issues.get("ENG-56").parentKey, "ENG-50");
  });

  await atest("createJiraPass: a corrected email or site retries the same rejected token", async () => {
    // A wrong account email is one of the causes the rejection message names;
    // fixing it in Settings must not leave the stale rejection in force.
    for (const fix of [{ email: "right@x.com" }, { baseUrl: "https://other.atlassian.net" }]) {
      jira.clearJiraCaches();
      let searches = 0;
      global.fetch = async (url) => {
        if (isTenant(url)) return tenantOk();
        searches++;
        return url === GATEWAY ? errRes(401) : anonymousSite();
      };
      const pass = jiraPass.createJiraPass(passDeps({ readToken: () => "same-token" }));
      assert.strictEqual((await pass(JIRA_CFG, ["ENG-61"])).health.state, "auth");
      const sent = searches;
      await pass(JIRA_CFG, ["ENG-61"]);
      assert.strictEqual(searches, sent, "unchanged credential: not resent");
      await pass({ ...JIRA_CFG, ...fix }, ["ENG-61"]);
      assert.ok(searches > sent, `changed ${Object.keys(fix)[0]}: the token is sent again`);
    }
  });

  await atest("createJiraPass: both sources rejected -> the health names twg, the primary fix", async () => {
    jira.clearJiraCaches();
    global.fetch = async (url) => (isTenant(url) ? tenantOk() : url === GATEWAY ? errRes(401) : anonymousSite());
    const pass = jiraPass.createJiraPass(passDeps({ runTwg: async () => twgErr("AUTH_REQUIRED", "sign in") }));
    for (let i = 0; i < 2; i++) {
      // The second pass takes the "token already rejected" branch — same answer.
      const result = await pass(JIRA_CFG, ["ENG-58"]);
      assert.strictEqual(result.health.state, "auth");
      assert.strictEqual(result.health.source, "twg");
    }
  });

  await atest("createJiraPass: a hung twg is skipped for the next passes, however far apart they are", async () => {
    // The backoff is counted in passes: the next tick starts a whole poll
    // interval after this one ends, so a wall-clock window would already have
    // run out and the hung twg would cost every tick its timeout again.
    jira.clearJiraCaches();
    global.fetch = jiraAnswers({ "ENG-59": { summary: "S" } });
    let runs = 0;
    let hung = true;
    const pass = jiraPass.createJiraPass(
      passDeps({
        runTwg: async () => (runs++, hung ? { stdout: "", stderr: "", code: null } : twgOk([{ key: "ENG-59", summary: "S" }])),
      }),
    );
    await pass(JIRA_CFG, ["ENG-59"]);
    assert.strictEqual(runs, 1);
    for (let i = 0; i < jiraPass.TWG_BACKOFF_PASSES; i++) {
      const skipped = await pass(JIRA_CFG, ["ENG-59"]);
      assert.strictEqual(skipped.health.source, "token", "the token answers while twg is skipped");
    }
    assert.strictEqual(runs, 1, "a timed-out twg must not run again inside the backoff");
    hung = false;
    const after = await pass(JIRA_CFG, ["ENG-59"]);
    assert.strictEqual(runs, 2, "after the backoff twg is tried again");
    assert.strictEqual(after.health.source, "twg");
  });

  await atest("createJiraPass: a signed-out twg is retried every pass (no backoff)", async () => {
    jira.clearJiraCaches();
    global.fetch = jiraAnswers({ "ENG-60": { summary: "S" } });
    let runs = 0;
    const pass = jiraPass.createJiraPass(
      passDeps({ runTwg: async () => (runs++, twgErr("AUTH_REQUIRED", "sign in")) }),
    );
    await pass(JIRA_CFG, ["ENG-60"]);
    await pass(JIRA_CFG, ["ENG-60"]);
    assert.strictEqual(runs, 2, "a terminal sign-in must be picked up on the next pass");
  });

  await atest("createJiraPass: a twg that hangs only on the subtask parents is backed off too", async () => {
    // The issue itself comes from twg's cache on the next passes, so only the
    // parent lookup would run — and time out — every pass.
    jira.clearJiraCaches();
    global.fetch = async () => {
      throw new Error("the token is not used here");
    };
    let runs = 0;
    const pass = jiraPass.createJiraPass(
      passDeps({
        hasToken: () => false,
        runTwg: async (args) => {
          runs++;
          return args.join(" ").includes("ENG-71")
            ? twgOk([{ key: "ENG-71", summary: "Sub", parent: { key: "ENG-70" }, issuetype: { subtask: true } }])
            : { stdout: "", stderr: "", code: null };
        },
      }),
    );
    const first = await pass(JIRA_CFG, ["ENG-71"]);
    assert.strictEqual(first.health.state, "ok", "the resolved issues still count");
    assert.strictEqual(runs, 2);
    for (let i = 0; i < jiraPass.TWG_BACKOFF_PASSES; i++) {
      const skipped = await pass(JIRA_CFG, ["ENG-71"]);
      assert.strictEqual(skipped.health.state, "error", "no token: the backoff reports twg's failure");
      assert.strictEqual(skipped.health.source, "twg");
    }
    assert.strictEqual(runs, 2, "twg must not run during the backoff");
  });

  await atest("createJiraPass: per-source caches — the token's negative entry doesn't hide a key from twg", async () => {
    // A scoped token may see fewer issues than the account. Its "not found" for
    // a key, cached for 10 minutes, must not stop twg — once signed in — from
    // resolving that key on the very next pass.
    jira.clearJiraCaches();
    global.fetch = jiraAnswers({}); // the token sees nothing
    let twgInstalled = false;
    const pass = jiraPass.createJiraPass(
      passDeps({
        runTwg: async () =>
          twgInstalled ? twgOk([{ key: "ENG-57", summary: "Seen by twg" }]) : TWG_NOT_INSTALLED,
      }),
    );
    const first = await pass(JIRA_CFG, ["ENG-57"]);
    assert.strictEqual(first.health.source, "token");
    assert.strictEqual(first.issues.has("ENG-57"), false);
    twgInstalled = true;
    const second = await pass(JIRA_CFG, ["ENG-57"]);
    assert.strictEqual(second.health.source, "twg");
    assert.strictEqual(second.issues.get("ENG-57").summary, "Seen by twg");
  });

  global.fetch = realFetch;

  // --- poller: tick folds jiraHealth into the snapshot + change detection ----
  await atest("Poller.tick: enrichJira throw → error health; message change re-emits, no-change dedups", async () => {
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
      enrichJira: async () => {
        throw new Error(enrichError);
      },
    });

    // Tick 1: enrichJira throws → jiraHealth defaults to the error state.
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

  // --- poller: a PR closed from the app leaves at once, despite the search lag --
  await atest("Poller.forgetClosed: drops the card now and keeps a lagging search from bringing it back", async () => {
    const snapshots = [];
    const mk = (id) => ({
      id, hostLabel: "GH", repo: "a/b", number: 1, title: id, updatedAt: "2026-01-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z", roles: ["author"], failingChecks: [], pendingChecks: [], checks: [], reviewers: [],
    });
    const p = new poller.Poller({
      loadSettings: () => ({ pollIntervalSeconds: 60, hosts: [{ label: "GH", graphqlUrl: "https://api.github.com/graphql", repos: ["a/b"] }], staleAfterDays: 30 }),
      toHostConfigs: () => [{ label: "GH", graphqlUrl: "https://api.github.com/graphql", repos: ["a/b"], token: "t" }],
      statePath: path.join(os.tmpdir(), "prd-poller-state-missing.json"),
      ignoredStatePath: path.join(os.tmpdir(), "prd-poller-ignored-missing.json"),
      appVersion: "test",
      onSnapshot: (s) => snapshots.push(s),
      onConfigError: () => {},
      // The search still returns the closed PR — GitHub's index lags the close.
      fetchHostFn: async () => ({ pullRequests: [mk("A"), mk("B")], rateLimit: { hostLabel: "GH", remaining: 5000, cost: 1, resetAt: "" } }),
    });
    await p.refresh();
    assert.deepStrictEqual(p.getSnapshot().pullRequests.map((x) => x.id).sort(), ["A", "B"]);
    const before = snapshots.length;
    p.forgetClosed("A");
    assert.deepStrictEqual(p.getSnapshot().pullRequests.map((x) => x.id), ["B"]);
    assert.strictEqual(snapshots.length, before + 1, "pushed to the renderer at once");
    await p.refresh();
    assert.deepStrictEqual(p.getSnapshot().pullRequests.map((x) => x.id), ["B"], "a lagging search can't bring it back");
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

  // --- poller: a spent budget is a wait until the reset ---------------------
  // Before: the slot kept the previous reading, whose window had already reset,
  // so the host was retried on its floor all hour and the banner stayed red.
  await atest("Poller.tick: a spent budget holds the host until the reset and says when", async () => {
    const snapshots = [];
    let calls = 0;
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const p = new poller.Poller({
      loadSettings: () => cfg.defaultSettings(),
      toHostConfigs: () => [
        { label: "GitHub", graphqlUrl: "https://limited.test/graphql", token: "t", repos: ["o/r"] },
      ],
      statePath: path.join(os.tmpdir(), "prd-poller-state-missing.json"),
      ignoredStatePath: path.join(os.tmpdir(), "prd-poller-ignored-missing.json"),
      appVersion: "test",
      onSnapshot: (s) => snapshots.push(s),
      onConfigError: () => {},
      probeNotificationsFn: async () => {
        throw new Error("probe must not run in this test");
      },
      fetchHostFn: async () => {
        calls++;
        throw new github.RateLimitedError("API rate limit already exceeded for user ID 1.", resetAt);
      },
    });
    p.start();
    await p.awaitFirstTick();
    assert.strictEqual(calls, 1);
    const snap = snapshots[0];
    assert.strictEqual(snap.errors[0].rateLimitedUntil, resetAt);
    assert.strictEqual(snap.rateLimits[0].remaining, 0, "the chip shows the spent budget");
    assert.strictEqual(snap.rateLimits[0].resetAt, resetAt);

    // Window focus / resume respects spacing — it must not retry before the reset.
    await p.wake();
    assert.strictEqual(calls, 1, "wake() must not retry a spent host before its reset");
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
  test("hashSnapshot: approval-body feedback alone triggers a snapshot", () =>
    assert.notStrictEqual(poller.hashSnapshot(hsnap()), poller.hashSnapshot(hsnap({ hasUnaddressedReviewFeedback: true }))));
  // The comment count is the unread channel's raw input and renders nowhere, so
  // with the setting off a change in it alone must not drive a push. Narrow on
  // purpose: a real new comment also bumps `updatedAt`, which stays hashed
  // because the card renders it, so these cases pin the count's own contribution
  // to the hash — not a claim that comment ticks stop pushing. With the setting
  // on the count must still push, which is the whole point.
  // The group heading is rendered from `issueSummary`/`parentSummary`, and both
  // move on ticks where nothing else does: Jira resolving after an outage (or a
  // first pass whose keys weren't cached yet), and a ticket someone renamed.
  // Unhashed, either leaves the heading showing yesterday's title — or the bare
  // key — until an unrelated PR field happens to change.
  test("hashSnapshot: Jira resolving a summary changes the hash (the heading leaves the bare key)", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ issueSummary: null })),
      poller.hashSnapshot(hsnap({ issueSummary: "Retry transient network errors" })),
    ));
  test("hashSnapshot: a renamed Jira issue changes the hash (the heading doesn't go stale)", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ issueSummary: "Old title" })),
      poller.hashSnapshot(hsnap({ issueSummary: "New title" })),
    ));
  test("hashSnapshot: a totalComments-only delta changes the hash while tracking is on", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ totalComments: 2 }), { trackComments: true }),
      poller.hashSnapshot(hsnap({ totalComments: 3 }), { trackComments: true }),
    ));
  test("hashSnapshot: a newly resolved epic above a subtask's task re-emits (it moves the PR's cluster)", () =>
    assert.notStrictEqual(
      poller.hashSnapshot(hsnap({ grandparentKey: null })),
      poller.hashSnapshot(hsnap({ grandparentKey: "ENG-1" })),
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
  const CTX = { nativeSupported: true };
  const NP = (o = {}) => ({ enabled: true, native: true, sound: false, ...o });
  const CAP = notify.MAX_INDIVIDUAL_NOTIFICATIONS;

  test("planDelivery: no events -> none", () =>
    assert.strictEqual(notify.planDelivery([], NP(), CTX).mode, "none"));
  test("planDelivery: disabled -> none", () =>
    assert.strictEqual(notify.planDelivery(evs(2), NP({ enabled: false }), CTX).mode, "none"));
  // A focused window used to swallow every toast; that hid real transitions, so
  // the planner no longer takes focus into account at all. A stray `focused`
  // flag from an old caller must not bring the suppression back.
  test("planDelivery: a focused window still delivers", () =>
    assert.strictEqual(notify.planDelivery(evs(1), NP(), { ...CTX, focused: true }).mode, "individual"));
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
    const plan = idleGate.planPolling({
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
    return { plan, idleReads, actionableReads };
  };
  // `parked` keeps the old boolean shape for the branch assertions; `factor`
  // exposes the ramp the running branch now carries.
  const gate = (over) => gateWithReads(over).plan.mode === "park";
  const factor = (over) => gateWithReads(over).plan.presenceFactor;

  test("planPolling: visible, active, no notifications -> runs", () =>
    assert.strictEqual(gate({}), false));
  test("planPolling: suspended always pauses (even with notifications on)", () => {
    assert.strictEqual(gate({ systemSuspended: true }), true);
    assert.strictEqual(gate({ systemSuspended: true, notificationsActionable: true }), true);
  });
  test("planPolling: no window yet (startup/activate) -> runs", () =>
    // hasWindow false wins even if a stale windowHidden slips through.
    assert.strictEqual(gate({ hasWindow: false, windowHidden: true }), false));
  test("planPolling: hidden window WITHOUT notifications -> pauses (budget saving)", () =>
    assert.strictEqual(gate({ windowHidden: true, notificationsActionable: false }), true));
  test("planPolling: hidden window WITH notifications -> runs (the fix)", () =>
    assert.strictEqual(gate({ windowHidden: true, notificationsActionable: true }), false));
  // The regression this replaces: input-idle used to PARK the tick outright at
  // 5 minutes, so reading the dashboard hands-free looked exactly like leaving
  // the building and the window sat on arbitrarily stale data. An idle machine
  // must now keep running — only more slowly.
  test("planPolling: an idle user stretches the cadence but never parks", () => {
    const away = idleGate.PRESENCE_FULL_SECONDS + idleGate.PRESENCE_STEP_SECONDS * 8;
    assert.strictEqual(gate({ systemIdleSeconds: away }), false);
    assert.strictEqual(gate({ systemIdleSeconds: away, notificationsActionable: true }), false);
    assert.strictEqual(
      gate({ windowHidden: true, systemIdleSeconds: away, notificationsActionable: true }),
      false,
    );
    // ...and it is genuinely stretched, not merely still running.
    assert.strictEqual(factor({ systemIdleSeconds: away }), idleGate.PRESENCE_MAX_FACTOR);
  });
  test("planPolling: idle within the grace window keeps full cadence", () => {
    assert.strictEqual(factor({ systemIdleSeconds: 0 }), 1);
    assert.strictEqual(factor({ systemIdleSeconds: idleGate.PRESENCE_FULL_SECONDS }), 1);
  });
  test("planPolling: null idle (platform can't report) treated as fully present", () => {
    assert.strictEqual(gate({ systemIdleSeconds: null }), false);
    assert.strictEqual(factor({ systemIdleSeconds: null }), 1);
  });
  test("planPolling: no window yet runs at full cadence", () =>
    assert.strictEqual(factor({ hasWindow: false }), 1));

  // The costly inputs stay unread whenever a free branch already decided — the
  // ordering regression this guards against is invisible to result-only asserts.
  test("planPolling: suspended decides without reading either costly input", () => {
    const r = gateWithReads({ systemSuspended: true });
    assert.strictEqual(r.idleReads, 0);
    assert.strictEqual(r.actionableReads, 0);
  });
  test("planPolling: no window decides without reading either costly input", () => {
    const r = gateWithReads({ hasWindow: false });
    assert.strictEqual(r.idleReads, 0);
    assert.strictEqual(r.actionableReads, 0);
  });
  test("planPolling: hidden + nothing to notify decides without reading idle time", () =>
    assert.strictEqual(
      gateWithReads({ windowHidden: true, notificationsActionable: false }).idleReads,
      0,
    ));
  test("planPolling: a visible window never asks whether notifications fire", () =>
    // Only the hidden branch needs it; asking anyway would be a wasted native call.
    assert.strictEqual(gateWithReads({}).actionableReads, 0));
  test("planPolling: idle time is read once when the free branches don't decide", () => {
    assert.strictEqual(gateWithReads({}).idleReads, 1);
    assert.strictEqual(
      gateWithReads({ windowHidden: true, notificationsActionable: true }).idleReads,
      1,
    );
  });
  test("planPolling: the hidden branch reads actionability exactly once", () =>
    assert.strictEqual(
      gateWithReads({ windowHidden: true, notificationsActionable: true }).actionableReads,
      1,
    ));

  // --- computePresenceFactor: the input-idle freshness ramp -------------------
  test("computePresenceFactor: full cadence through the grace window", () => {
    assert.strictEqual(idleGate.computePresenceFactor(0), 1);
    assert.strictEqual(idleGate.computePresenceFactor(idleGate.PRESENCE_FULL_SECONDS - 1), 1);
    // The boundary itself still counts as present — the ramp starts after it.
    assert.strictEqual(idleGate.computePresenceFactor(idleGate.PRESENCE_FULL_SECONDS), 1);
  });
  test("computePresenceFactor: doubles once per step past the grace window", () => {
    const full = idleGate.PRESENCE_FULL_SECONDS;
    const step = idleGate.PRESENCE_STEP_SECONDS;
    assert.strictEqual(idleGate.computePresenceFactor(full + 1), 2);
    assert.strictEqual(idleGate.computePresenceFactor(full + step - 1), 2);
    assert.strictEqual(idleGate.computePresenceFactor(full + step), 4);
    assert.strictEqual(idleGate.computePresenceFactor(full + step * 2), 8);
  });
  test("computePresenceFactor: capped, so an overnight machine still polls", () => {
    const far = idleGate.PRESENCE_FULL_SECONDS + idleGate.PRESENCE_STEP_SECONDS * 100;
    assert.strictEqual(idleGate.computePresenceFactor(far), idleGate.PRESENCE_MAX_FACTOR);
    assert.strictEqual(idleGate.computePresenceFactor(86_400), idleGate.PRESENCE_MAX_FACTOR);
  });
  test("computePresenceFactor: unreportable idle time assumes presence", () =>
    // Failure direction must be freshness, never a silently stale dashboard.
    assert.strictEqual(idleGate.computePresenceFactor(null), 1));

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
              // planDelivery is handed a non-empty batch, so the ONLY thing left
              // that can zero it out is channel viability.
              const plan = notify.planDelivery(oneEvent, s, { nativeSupported });
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
  // Nothing else would fail if tick() passed undefined or a stale object to the
  // gate — and the gate would then read notification prefs off garbage.
  // Note: refresh() forces past the gate entirely, so this drives a plain tick.
  //
  // Beyond the argument threading, this also pins the *behavioural* contract: a
  // gate answering `park` must actually suppress the tick's side effects. The
  // argument assertions alone would survive a condition inversion on the mode
  // check in tick(), which would consult the gate with the right settings yet
  // poll anyway — so we assert no snapshot is emitted. refresh() is the only
  // other path past the gate and it forces past it, so this plain tick is the
  // sole test of the parked path.
  await atest("Poller.tick: a park plan suppresses the tick with the loaded settings", async () => {
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
      // `park` skips all network work before any is attempted.
      planPoll: (s) => {
        calls++;
        seen = s;
        return { mode: "park" };
      },
    });
    p.start();
    await p.awaitFirstTick();
    p.stop();
    assert.strictEqual(calls, 1, "the gate should be consulted exactly once per tick");
    assert.strictEqual(seen, loaded, "planPoll must receive the very object loadSettings returned");
    assert.strictEqual(seen.notifications.enabled, true);
    assert.strictEqual(snapshots.length, 0, "a parked tick must not emit a snapshot — the gate must suppress, not just be consulted");
  });


  // Returning to a stretched dashboard must be noticed promptly. Two halves,
  // both regressions found after the first cut of this feature:
  //
  //  1. The stretch must be applied when a due-time is EVALUATED, never baked
  //     into the stored one — otherwise an hour-long stretch computed while the
  //     machine was idle outlives the idleness that justified it (isHostDue
  //     tests above).
  //  2. The LOOP must keep waking while stretched. Returning to an already-
  //     focused window fires no `focus` event, so no `wake()` — the tick timer
  //     is the only thing that can notice, and a timer asleep for the full
  //     stretched hour cannot.
  test("computeNextWakeMs: a stretched schedule still rechecks every minute", () => {
    // Host fetched at 0 with a 5-min floor, deeply idle: the stretched due-time
    // is an hour out, but the loop must not sleep that long.
    const slots = [{ dueFromMs: 0, baseIntervalMs: 300_000 }];
    assert.strictEqual(poller.computeNextWakeMs(slots, 0, 16), 60_000);
    // Unstretched, the full interval is honoured — no extra wake-ups when the
    // user is present and the cadence is already tight.
    assert.strictEqual(poller.computeNextWakeMs(slots, 0, 1), 300_000);
  });
  test("computeNextWakeMs: picks the soonest host and clamps to [MIN, MAX]", () => {
    const slots = [
      { dueFromMs: 0, baseIntervalMs: 300_000 },
      { dueFromMs: 0, baseIntervalMs: 60_000 },
    ];
    assert.strictEqual(poller.computeNextWakeMs(slots, 0, 1), 60_000);
    // An overdue host never yields a negative or sub-minimum wait.
    assert.strictEqual(poller.computeNextWakeMs(slots, 999_999_999, 1), 10_000);
  });
  test("computeNextWakeMs: no hosts falls back to the configured interval", () =>
    assert.strictEqual(poller.computeNextWakeMs([], 0, 1, 60_000), 60_000));

  // A forced refresh must assemble a snapshot even with no hosts due — the
  // recheck short-circuit is for plain timer ticks only. This is what broke
  // when the short-circuit was first added without excluding forced ticks.
  await atest("Poller.refresh: forces a snapshot even when no host is due", async () => {
    const snapshots = [];
    const p = new poller.Poller({
      loadSettings: () => ({
        pollIntervalSeconds: 60, launchAtLogin: false, autoUpdate: false, theme: "system", hosts: [],
      }),
      toHostConfigs: () => [],
      statePath: path.join(os.tmpdir(), "prd-refresh-state-missing.json"),
      ignoredStatePath: path.join(os.tmpdir(), "prd-refresh-ignored-missing.json"),
      appVersion: "test",
      onSnapshot: (s) => snapshots.push(s),
      onConfigError: () => {},
      planPoll: () => ({ mode: "run", presenceFactor: 16 }),
    });
    await p.refresh();
    assert.strictEqual(snapshots.length, 1);
    p.stop();
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

  // --- launch at login, starting in the tray -----------------------------------

  test("loginItemSettingsFor: Windows passes the hidden-launch marker as an argument", () => {
    assert.deepStrictEqual(loginLaunch.loginItemSettingsFor(true, "win32"), {
      openAtLogin: true,
      args: [loginLaunch.HIDDEN_LAUNCH_ARG],
    });
    // Disabling must name the same args, or Windows reports/keeps a different entry.
    assert.deepStrictEqual(loginLaunch.loginItemSettingsFor(false, "win32").args, [loginLaunch.HIDDEN_LAUNCH_ARG]);
  });

  test("loginItemSettingsFor: macOS asks for a hidden open, no arguments", () => {
    assert.deepStrictEqual(loginLaunch.loginItemSettingsFor(true, "darwin"), { openAtLogin: true, openAsHidden: true });
  });

  test("staleLoginItemsFor: Windows removes the electron.app.PR Dashboard entry of older builds", () => {
    // The literal names what shipped builds left in the Run key; it must not
    // follow a later productName rename, or the real orphan stops being removed.
    assert.strictEqual(loginLaunch.LEGACY_WINDOWS_LOGIN_ITEM_NAME, "electron.app.PR Dashboard");
    assert.deepStrictEqual(loginLaunch.staleLoginItemsFor("win32"), [
      { openAtLogin: false, name: loginLaunch.LEGACY_WINDOWS_LOGIN_ITEM_NAME },
    ]);
    assert.deepStrictEqual(loginLaunch.staleLoginItemsFor("darwin"), []);
    assert.deepStrictEqual(loginLaunch.staleLoginItemsFor("linux"), []);
  });

  test("wasLaunchedAtLogin: the argv marker or macOS wasOpenedAtLogin, nothing else", () => {
    assert.strictEqual(loginLaunch.wasLaunchedAtLogin(["app.exe", "--hidden"], undefined), true);
    assert.strictEqual(loginLaunch.wasLaunchedAtLogin(["app"], true), true);
    assert.strictEqual(loginLaunch.wasLaunchedAtLogin(["app.exe"], undefined), false);
    assert.strictEqual(loginLaunch.wasLaunchedAtLogin(["app"], false), false);
  });

  test("main.js wiring: Save answers without waiting for the poll it starts", () => {
    const src = require("node:fs").readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
    const start = src.indexOf('"settings:save"');
    assert.ok(start !== -1, "the settings:save handler exists");
    const body = src.slice(start, src.indexOf("ipcMain.handle(", start + 1));
    assert.match(body, /void poller\?\.refresh\(\)/, "Save must start a fresh poll");
    assert.doesNotMatch(body, /await poller\?\.refresh\(\)/, "Settings closes only on the reply, so the poll must not hold it");
  });

  test("main.js wiring: a login launch starts hidden, and shows the window if no tray icon appeared", () => {
    const src = require("node:fs").readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
    assert.match(src, /loginItemSettingsFor\)\(enabled, process\.platform\)/, "the login item must carry the marker");
    const staleIdx = src.indexOf("staleLoginItemsFor)(process.platform)");
    assert.ok(staleIdx !== -1, "the legacy login item must be removed on every apply, enabled or not");
    assert.ok(staleIdx < src.indexOf("loginItemSettingsFor)(enabled, process.platform)"), "removal runs before registering");
    assert.match(src, /startInTray = launchedAtLogin && prefs\.closeToTray/, "only close-to-tray may start hidden");
    assert.match(src, /createWindow\(\{ show: !startInTray \}\)/, "the first window must honor the tray start");
    const applyIdx = src.indexOf("applyPreferences(prefs);");
    const fallback = /if \(startInTray && !trayController\.hidesToTray\(\)\)\s*focusMainWindow\(\);/.exec(src);
    assert.ok(fallback, "a missing tray icon must bring the window back");
    assert.ok(applyIdx !== -1 && applyIdx < fallback.index, "the fallback must run after the tray is created");
    assert.match(src, /mainWindow\.once\("show", restoreSavedState\)/, "maximize must wait for the first show");
  });

  // --- Claude session launcher -----------------------------------------------
  {
    const cl = require(path.join(__dirname, "../dist/main/shared/claude-launch.js"));
    const launcher = require(path.join(__dirname, "../dist/main/main/claude-launch.js"));
    const quiet = {
      roles: ["author"], failingChecks: [], pendingChecks: [], hasUnaddressedChangeRequest: false,
      hasUnaddressedReviewFeedback: false, hasUnaddressedComments: false, hasConflicts: false,
      isBehindBase: false, unresolvedThreads: 0, returnedToMe: false, myReReviewDue: false,
      awaitingReview: false, hasNewActivity: false, hasHumanApproval: false, reviewDecision: null,
      ciState: "success", canBeMerged: false, url: "https://github.com/acme/widgets/pull/7", repo: "acme/widgets",
    };
    const pick = (patch) => cl.pickClaudeLaunch({ ...quiet, ...patch }, { trackComments: true });

    test("claude launch: own blocked PR → drive, review due → review, own mergeable → close, else open", () => {
      assert.strictEqual(pick({ failingChecks: [{ name: "ci" }] }), "drive");
      assert.strictEqual(pick({ hasConflicts: true }), "drive");
      assert.strictEqual(pick({ unresolvedThreads: 1 }), "drive");
      assert.strictEqual(pick({ roles: ["reviewer"] }), "review");
      assert.strictEqual(pick({ roles: ["reviewed"], myReReviewDue: true }), "review");
      assert.strictEqual(pick({ canBeMerged: true, hasHumanApproval: true }), "close");
      assert.strictEqual(pick({ roles: ["reviewed"], canBeMerged: true }), "open", "someone else's PR is not ours to close");
      assert.strictEqual(pick({}), "open");
    });

    test("claude button: every launch kind has button text; the table widens only while it shows", () => {
      for (const k of ["drive", "review", "close", "explain", "open"]) assert.ok(cl.CLAUDE_BUTTON_TEXT[k], k);
      const tbl = require(path.join(__dirname, "../dist/main/shared/pr-table.js"));
      assert.strictEqual(tbl.actionsColumnRem(false), 5);
      assert.strictEqual(tbl.actionsColumnRem(true), 5 + tbl.CLAUDE_ACTIONS_EXTRA_REM);
    });

    test("claude launch: prompt template fills {url}, an empty one falls back to the default", () => {
      assert.strictEqual(cl.renderClaudePrompt({ drive: "fix {url} now" }, "drive", quiet), `fix ${quiet.url} now`);
      assert.strictEqual(cl.renderClaudePrompt({ review: "  " }, "review", quiet), `/creatio-code-review ${quiet.url}`);
    });

    test("claude launch: shell and AppleScript quoting survive quotes and backslashes", () => {
      const cmd = cl.posixLaunchCommand("/a b/it's", "x");
      assert.ok(cmd.endsWith(`; cd '/a b/it'\\''s' && claude 'x'`), cmd);
      assert.ok(cmd.startsWith("unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION "), "session markers are dropped before claude starts");
      assert.strictEqual(cl.appleScriptString(`say "hi" \\ there`), `"say \\"hi\\" \\\\ there"`);
    });

    test("claude launch: the launcher env drops a parent session's markers and keeps the rest", () => {
      const env = cl.launcherEnv({
        PATH: "/bin",
        HOME: "/h",
        CLAUDECODE: "1",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_SESSION_ID: "s",
        CLAUDE_AGENT_SDK_VERSION: "1",
        CLAUDE_PID: "9",
      });
      assert.deepStrictEqual(env, { PATH: "/bin", HOME: "/h" });
    });

    test("claude launch: iTerm2 and Terminal scripts carry the command, quoted once", () => {
      const it = cl.terminalScript("iterm", `cd '/x' && claude 'a "b"'`).join("\n");
      assert.match(it, /tell application id "com\.googlecode\.iterm2"/);
      assert.match(it, /create window with default profile/);
      assert.match(it, /set wasRunning to running\nactivate/, "running is read before activate starts the app");
      assert.match(it, /else if wasRunning then\nset w to current window\ntell w to create tab with default profile/, "a running iTerm2 gets a tab, not a window");
      assert.ok(it.includes(`write text "cd '/x' && claude 'a \\"b\\"'"`), it);
      const term = cl.terminalScript("terminal", "x").join("\n");
      assert.match(term, /tell application "Terminal"[\s\S]*do script "x"/);
      assert.strictEqual(cfg.validateClaude({}).terminal, "auto");
      assert.strictEqual(cfg.validateClaude({ terminal: "iterm" }).terminal, "iterm");
      assert.strictEqual(cfg.validateClaude({ terminal: "xterm" }).terminal, "auto");
      assert.strictEqual(cfg.validateClaude({ terminal: "desktop" }).terminal, "desktop");
      assert.strictEqual(
        cl.claudeDesktopUrl("/Users/me/my repo", "/drive-pr-green https://x/pull/1?a=b&c"),
        "claude://code/new?q=%2Fdrive-pr-green%20https%3A%2F%2Fx%2Fpull%2F1%3Fa%3Db%26c&folder=%2FUsers%2Fme%2Fmy%20repo",
      );
    });

    test("settings search: every section is on a real tab, every tab has a section", () => {
      const ss = require(path.join(__dirname, "../dist/main/shared/settings-search.js"));
      const tabs = new Set(ss.SETTINGS_TABS.map((t) => t.id));
      for (const sec of ss.SETTINGS_SECTIONS) assert.ok(tabs.has(sec.tab), sec.id);
      for (const t of tabs) assert.ok(ss.sectionsOfTab(t).length > 0, t);
      assert.strictEqual(ss.toSettingsTab("hosts"), "hosts");
      assert.strictEqual(ss.toSettingsTab("nope"), "general");
      assert.strictEqual(ss.toSettingsTab(null), "general");
    });

    test("settings search: all words must match, case-insensitive; blank finds nothing", () => {
      const ss = require(path.join(__dirname, "../dist/main/shared/settings-search.js"));
      const ids = (q) => ss.searchSettings(q).map((s) => s.id);
      assert.deepStrictEqual(ids("   "), []);
      assert.deepStrictEqual(ids("iTerm"), ["claude"]);
      assert.deepStrictEqual(ids("close tray"), ["behavior"], "the Claude 'close' prompt has no 'tray'");
      assert.deepStrictEqual(ids("token"), ["gh", "jira"]);
      assert.deepStrictEqual(ids("DARK"), ["appearance"]);
      assert.deepStrictEqual(ids("xyzzy"), []);
    });

    test("settings search: the Agent tab's sections are found by their own words", () => {
      const ss = require(path.join(__dirname, "../dist/main/shared/settings-search.js"));
      const ids = (q) => ss.searchSettings(q).map((s) => s.id);
      assert.deepStrictEqual(ss.sectionsOfTab("agent").map((s) => s.id), [
        "agent",
        "agentScenarios",
        "agentLimits",
        "agentPermissions",
        "agentDiagrams",
        "agentCompanion",
        "agentNotifications",
        "agentPolicy",
      ]);
      assert.deepStrictEqual(ids("mermaid"), ["agentDiagrams"]);
      assert.deepStrictEqual(ids("quiet hours"), ["agentLimits"]);
      assert.deepStrictEqual(ids("worktree"), ["agent"]);
      assert.deepStrictEqual(ids("squash"), ["agentScenarios"]);
      assert.deepStrictEqual(ids("tray icon"), ["agentCompanion"]);
      assert.deepStrictEqual(ids("signature"), ["agentPolicy"]);
      assert.deepStrictEqual(ids("triage"), ["claude"], "the agent's prompts are edited with the Claude button's");
      assert.strictEqual(ss.toSettingsTab("agent"), "agent");
    });

    test("agent settings: off by default, every posting scenario starts in shadow, merge only offers", () => {
      const ad = require(path.join(__dirname, "../dist/main/shared/agent-defaults.js"));
      const a = cfg.defaultSettings().agent;
      assert.strictEqual(a.enabled, false);
      assert.deepStrictEqual(a, cfg.validateAgent(undefined));
      assert.deepStrictEqual(a, ad.DEFAULT_AGENT_SETTINGS);
      for (const k of ["review", "rereview", "driveCi", "driveComments"]) assert.strictEqual(a.scenarios[k].mode, "shadow", k);
      assert.strictEqual(a.scenarios.merge.mode, "offer");
      assert.deepStrictEqual([a.scenarios.review.maxLines, a.scenarios.review.maxFiles, a.limits.parallel, a.limits.perDay], [400, 15, 2, 30]);
      for (const rule of a.permissions.tools.review) assert.ok(!/push|Edit|Write/.test(rule), `review must not write: ${rule}`);
    });

    test("agent settings: a settings file from before the agent reads as the defaults", () => {
      const s = cfg.validateSettings({ hosts: [], claude: { enabled: true } });
      assert.deepStrictEqual(s.agent, cfg.validateAgent(undefined));
      assert.strictEqual(s.claude.agentPrompts.triage, cfg.validateClaude(undefined).agentPrompts.triage);
    });

    test("agent settings: numbers are clamped, enums and clock times fall back, repos must be owner/name", () => {
      const a = cfg.validateAgent({
        enabled: true,
        effort: "extreme",
        repos: ["acme/widgets", "not a repo", " acme/gadgets ", 7],
        scenarios: {
          review: { mode: "auto", maxLines: 0, maxFiles: "40" },
          brief: { mode: "shadow" },
          merge: { mode: "on", method: "fast-forward" },
          driveCi: { maxAttempts: 99 },
        },
        limits: { parallel: -3, perDay: 1e6, maxMinutes: 2.6, quietHours: { enabled: true, from: "25:00", to: "07:30" } },
        policy: { signature: "   ", logRetentionDays: 0 },
      });
      assert.strictEqual(a.enabled, true);
      assert.strictEqual(a.effort, "");
      assert.deepStrictEqual(a.repos, ["acme/widgets", "acme/gadgets"]);
      assert.strictEqual(a.scenarios.review.mode, "shadow");
      assert.deepStrictEqual([a.scenarios.review.maxLines, a.scenarios.review.maxFiles], [1, 40]);
      assert.strictEqual(a.scenarios.brief.mode, "on", "a brief has no shadow mode — it posts nothing either way");
      assert.strictEqual(a.scenarios.merge.mode, "offer", "there is no mode that merges by itself");
      assert.strictEqual(a.scenarios.merge.method, "github");
      assert.strictEqual(a.scenarios.driveCi.maxAttempts, 10);
      assert.deepStrictEqual([a.limits.parallel, a.limits.perDay, a.limits.maxMinutes], [1, 500, 5]);
      assert.deepStrictEqual(a.limits.quietHours, { enabled: true, from: "20:00", to: "07:30" });
      assert.strictEqual(a.policy.signature, cfg.validateAgent(undefined).policy.signature, "the signature can't be blanked out");
      assert.strictEqual(a.policy.logRetentionDays, 1);
    });

    test("agent settings: tool rules per run kind — a missing list takes the default, a given one is kept trimmed", () => {
      const a = cfg.validateAgent({ permissions: { tools: { review: [" Read ", "", 5, "Bash(gh pr view *)"] }, pushOwnBranch: false } });
      assert.deepStrictEqual(a.permissions.tools.review, ["Read", "Bash(gh pr view *)"]);
      assert.deepStrictEqual(a.permissions.tools.drive, cfg.validateAgent(undefined).permissions.tools.drive);
      assert.strictEqual(a.permissions.pushOwnBranch, false);
    });

    test("claude settings: the agent's prompts default, keep edits, and stay out of the button's kinds", () => {
      const c = cfg.validateClaude({ agentPrompts: { rereview: "  /my-rereview {url} ", triage: "" } });
      assert.strictEqual(c.agentPrompts.rereview, "/my-rereview {url}");
      assert.strictEqual(c.agentPrompts.triage, cfg.validateClaude(undefined).agentPrompts.triage);
      for (const k of Object.keys(c.agentPrompts)) assert.ok(!cl.CLAUDE_LAUNCH_KINDS.includes(k), `${k} must not be a launch kind`);
    });

    test("claude launch: remotes normalize across https, scp and ssh:// forms", () => {
      for (const u of [
        "https://github.com/Acme/Widgets.git",
        "git@github.com:acme/widgets.git",
        "ssh://git@github.com/acme/widgets",
        "https://token@github.com/acme/widgets/",
      ]) {
        assert.strictEqual(cl.normalizeRemote(u), "github.com/acme/widgets", u);
      }
      assert.strictEqual(cl.prRemoteKey(quiet), "github.com/acme/widgets");
    });

    test("claude settings: off by default, garbage falls back, empty repo paths dropped", () => {
      assert.strictEqual(cfg.defaultSettings().claude.enabled, false);
      assert.strictEqual(cfg.validateSettings({ hosts: [] }).claude.enabled, false);
      const c = cfg.validateClaude({ enabled: true, repoPaths: { "acme/widgets": " ~/w ", bad: "x", "a/b": "" }, prompts: { drive: "" } });
      assert.deepStrictEqual(c.repoPaths, { "acme/widgets": "~/w" });
      assert.strictEqual(c.prompts.drive, "/drive-pr-green {url}");
      assert.strictEqual(c.prompts.explain, cl.DEFAULT_CLAUDE_PROMPTS.explain);
      assert.strictEqual(cfg.toPublicConfig(cfg.validateSettings({ claude: c })).claudeEnabled, true);
    });

    test("claude launch: checkout found by remote on the PR's host, explicit path wins", () => {
      const fsSync = require("node:fs");
      const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "prd-claude-"));
      const mk = (name, url) => {
        fsSync.mkdirSync(path.join(root, name, ".git"), { recursive: true });
        fsSync.writeFileSync(
          path.join(root, name, ".git", "config"),
          `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
        );
      };
      mk("other-host", "git@ghe.example.com:acme/widgets.git");
      mk("my-widgets", "https://github.com/acme/widgets.git");
      try {
        assert.strictEqual(launcher.findCheckout(quiet, { projectsRoot: root, repoPaths: {} }), path.join(root, "my-widgets"));
        assert.strictEqual(
          launcher.findCheckout(quiet, { projectsRoot: root, repoPaths: { "acme/widgets": path.join(root, "other-host") } }),
          path.join(root, "other-host"),
        );
        assert.strictEqual(
          launcher.findCheckout(quiet, { projectsRoot: root, repoPaths: { "acme/widgets": path.join(root, "missing") } }),
          null,
          "a stale explicit path must not fall through to a guess",
        );
        assert.strictEqual(launcher.findCheckout({ ...quiet, repo: "acme/none" }, { projectsRoot: root, repoPaths: {} }), null);
      } finally {
        fsSync.rmSync(root, { recursive: true, force: true });
      }
    });

    test("claude menu: only the fixed actions cross from the renderer", () => {
      const v = require(path.join(__dirname, "../dist/main/main/ipc-validation.js"));
      assert.strictEqual(v.validateClaudeKind(undefined), undefined);
      for (const k of cl.CLAUDE_LAUNCH_KINDS) assert.strictEqual(v.validateClaudeKind(k), k);
      for (const bad of ["", "merge", "close; rm -rf ~", 1, null, {}]) {
        assert.throws(() => v.validateClaudeKind(bad), /unknown action/);
      }
    });

    test("claude menu: Close PR only on your own PRs; Explain on every PR, never picked from the state", () => {
      assert.deepStrictEqual(cl.claudeKindsFor({ roles: ["author"] }), ["drive", "review", "close", "explain", "open"]);
      for (const roles of [["reviewer"], ["reviewed"], []]) {
        assert.deepStrictEqual(cl.claudeKindsFor({ roles }), ["drive", "review", "explain", "open"], roles.join());
      }
      for (const patch of [{}, { failingChecks: [{ name: "ci" }] }, { roles: ["reviewer"] }, { canBeMerged: true, hasHumanApproval: true }]) {
        assert.notStrictEqual(pick(patch), "explain");
      }
    });

    // The point of the menu: a PR whose state suggests "Drive to green" can be
    // closed on purpose. The picked kind replaces the state's pick, and its
    // prompt still comes from Settings.
    await atest("claude menu: a picked action overrides the one the PR's state suggests", async () => {
      const dir = require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "prd-claude-"));
      try {
        const blocked = { ...quiet, roles: ["author"], failingChecks: [{ name: "ci", kind: "check", state: "failure", url: null }] };
        assert.strictEqual(cl.pickClaudeLaunch(blocked, { trackComments: true }), "drive");
        const settings = { enabled: true, projectsRoot: "", repoPaths: { [blocked.repo]: dir }, prompts: {}, terminal: "desktop" };
        const opened = [];
        const openUrl = async (url) => { opened.push(decodeURIComponent(url)); };
        const picked = await launcher.launchClaude(blocked, settings, { trackComments: true, openUrl, kind: "close" });
        assert.strictEqual(picked.ok && picked.kind, "close");
        assert.match(opened[0], /\/drive-pr-close /);
        const auto = await launcher.launchClaude(blocked, settings, { trackComments: true, openUrl });
        assert.strictEqual(auto.ok && auto.kind, "drive");
        assert.match(opened[1], /\/drive-pr-green /);
        const explained = await launcher.launchClaude(blocked, settings, { trackComments: true, openUrl, kind: "explain" });
        assert.strictEqual(explained.ok && explained.kind, "explain");
        assert.match(opened[2], /\/usercustom-dev:pr-first-look https:\/\/github\.com\/acme\/widgets\/pull\/7 .*do not send a letter/);
        const notMine = { ...blocked, roles: ["reviewer"] };
        const refused = await launcher.launchClaude(notMine, settings, { trackComments: true, openUrl, kind: "close" });
        assert.strictEqual(refused.ok, false);
        assert.match(refused.error, /author/);
        assert.strictEqual(opened.length, 3, "a refused close must not open anything");
      } finally {
        require("node:fs").rmSync(dir, { recursive: true, force: true });
      }
    });

    test("main.js wiring: claude:launch looks the PR up by id in the poller snapshot", () => {
      const src = require("node:fs").readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
      assert.match(src, /"claude:launch"[\s\S]{0,300}validatePrId[\s\S]{0,200}validateClaudeKind[\s\S]{0,200}getSnapshot\(\)/);
      assert.match(src, /"claude:launch"[\s\S]{0,400}validateInTerminal\)?\(rawInTerminal\)[\s\S]{0,800}inTerminal,?\s*\}/);
    });

    // "Review in terminal": for Claude Desktop users only — with a terminal
    // chosen in Settings, "Review" already opens one.
    test("claude menu: Review in terminal follows Review only while Settings pick Claude Desktop", () => {
      const items = (roles, desktop) =>
        cl.claudeMenuItems({ roles }, desktop).map((i) => (i.inTerminal ? `${i.kind}@terminal` : i.kind));
      assert.deepStrictEqual(items(["author"], true), ["drive", "review", "review@terminal", "close", "explain", "open"]);
      assert.deepStrictEqual(items(["reviewer"], true), ["drive", "review", "review@terminal", "explain", "open"]);
      assert.deepStrictEqual(items(["author"], false), ["drive", "review", "close", "explain", "open"]);
      assert.deepStrictEqual(items(["reviewer"], false), ["drive", "review", "explain", "open"]);
    });

    test("claude menu: the in-terminal flag crosses from the renderer only as a boolean", () => {
      const v = require(path.join(__dirname, "../dist/main/main/ipc-validation.js"));
      assert.strictEqual(v.validateInTerminal(undefined), false);
      assert.strictEqual(v.validateInTerminal(true), true);
      assert.strictEqual(v.validateInTerminal(false), false);
      for (const bad of ["true", 1, null, {}]) assert.throws(() => v.validateInTerminal(bad), /boolean/);
    });

    await atest("claude menu: in terminal opens the default terminal although Settings pick Claude Desktop", async () => {
      const fs = require("node:fs");
      const terminal = require(path.join(__dirname, "../dist/main/main/terminal.js"));
      const realOpen = terminal.openTerminalWith;
      const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "prd-claude-"));
      const terminals = [];
      terminal.openTerminalWith = async (command, opts) => { terminals.push({ command, opts }); };
      try {
        const pr = { ...quiet, roles: ["reviewer"] };
        const settings = { enabled: true, projectsRoot: "", repoPaths: { [pr.repo]: dir }, prompts: {}, terminal: "desktop" };
        const opened = [];
        const openUrl = async (url) => { opened.push(url); };
        const res = await launcher.launchClaude(pr, settings, { trackComments: true, openUrl, kind: "review", inTerminal: true });
        assert.strictEqual(res.ok && res.kind, "review");
        assert.strictEqual(opened.length, 0, "Claude Desktop must not open");
        assert.strictEqual(terminals.length, 1);
        assert.strictEqual(terminals[0].opts.terminal, "auto");
        assert.match(terminals[0].command.posix, /claude '\/creatio-code-review https:\/\/github\.com\/acme\/widgets\/pull\/7'/);
        const desktop = await launcher.launchClaude(pr, settings, { trackComments: true, openUrl, kind: "review" });
        assert.strictEqual(desktop.ok, true);
        assert.strictEqual(opened.length, 1, "without the flag Claude Desktop opens as before");
        assert.strictEqual(terminals.length, 1);
      } finally {
        terminal.openTerminalWith = realOpen;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // The group heading's launches: "Explain all" (one session over the open
    // PRs) and "Review all" (a Desktop parent that nests one review session per
    // PR awaiting your review), each prompt behind a marker the scanner reads.
    test("group launches: a Jira group only; explain takes 2+ open PRs, review the ones due on you", () => {
      const pr = (n, extra = {}) => ({ id: `p${n}`, isDraft: false, roles: ["reviewer"], myReReviewDue: false, ...extra });
      assert.strictEqual(cl.groupLaunchPrs("explain", "acme/widgets", [pr(1), pr(2)]), null, "a repository group has no task");
      assert.strictEqual(cl.groupLaunchPrs("review", "__other__", [pr(1), pr(2)]), null);
      assert.strictEqual(cl.groupLaunchPrs("explain", "ENG-1", [pr(1), pr(2, { isDraft: true })]), null, "one open PR has its own Explain");
      assert.deepStrictEqual(cl.groupLaunchPrs("explain", "ENG-1", [pr(1), pr(2, { isDraft: true }), pr(3)]).map((p) => p.id), ["p1", "p3"]);
      const mixed = [
        pr(1),
        pr(2, { roles: ["author"] }),
        pr(3, { roles: ["reviewed"] }),
        pr(4, { roles: ["reviewed"], myReReviewDue: true }),
        pr(5, { isDraft: true }),
      ];
      assert.deepStrictEqual(
        cl.groupLaunchPrs("review", "ENG-1", mixed).map((p) => p.id),
        ["p1", "p4"],
        "never your own PR, a draft, or one you reviewed and nobody asked about again",
      );
      assert.deepStrictEqual(cl.groupLaunchPrs("review", "ENG-1", [pr(1)]).map((p) => p.id), ["p1"], "one due PR is enough");
      assert.strictEqual(cl.groupLaunchPrs("review", "ENG-1", [pr(2, { roles: ["author"] })]), null);
      const many = Array.from({ length: cl.MAX_GROUP_PRS + 5 }, (_, i) => pr(i));
      assert.strictEqual(cl.groupLaunchPrs("explain", "ENG-1", many).length, cl.MAX_GROUP_PRS);
      assert.strictEqual(cl.groupLaunchPrs("review", "ENG-1", many).length, cl.MAX_GROUP_PRS);
    });

    test("group launches: each prompt fills its template behind its marker", () => {
      const prs = [{ url: "https://github.com/a/b/pull/1" }, { url: "https://github.com/a/b/pull/2" }];
      const explain = cl.renderGroupPrompt({}, "explain", "ENG-83532", prs);
      assert.ok(explain.startsWith("[PR Dashboard overview of ENG-83532] "), explain);
      assert.deepStrictEqual(cl.groupMarkerOf(explain), { kind: "explain", key: "ENG-83532" });
      assert.strictEqual(cl.groupMarkerOf("https://github.com/a/b/pull/1"), null);
      assert.match(explain, /the 2 open pull requests of ENG-83532/);
      assert.match(explain, /https:\/\/github\.com\/a\/b\/pull\/1 https:\/\/github\.com\/a\/b\/pull\/2/);
      assert.match(explain, /do not send a letter/);
      const review = cl.renderGroupPrompt({ review: "/my-review {url}" }, "review", "ENG-7", prs);
      assert.ok(review.startsWith("[PR Dashboard review of ENG-7] "), review);
      assert.deepStrictEqual(cl.groupMarkerOf(review), { kind: "review", key: "ENG-7" });
      assert.match(review, /start_session/);
      const defaultReview = cl.renderGroupPrompt({}, "review", "ENG-7", prs);
      assert.match(defaultReview, /its prompt word for word/, "the parent must not paraphrase a session's prompt");
      // A request from another session is not the user's consent to publish,
      // so each review session gets the user's own words, quoted in full.
      assert.ok(
        defaultReview.includes(
          "Користувач сказав: «Публікуй рев'ю на PR: рядкові коментарі до Blocker і Major, підсумок одним рев'ю. " +
            "Подія — `REQUEST_CHANGES`, коли є Blocker або Major з високою впевненістю, інакше `COMMENT`. `APPROVE` не ставити.». " +
            "Публікуй рев'ю на PR за цим дозволом.",
        ),
        "the publishing permission is quoted word for word",
      );
      assert.match(defaultReview, /APPROVE only on my separate word for that PR/);
      assert.match(defaultReview, /low confidence is a ground for REQUEST_CHANGES only once it is checked/);
      assert.match(defaultReview, /Start your report with the link to the review you published/);
      assert.match(defaultReview, /for each PR the link to its review, its decision/);
      // A session's turn note is cut at 400 characters; the summary needs the whole report.
      assert.match(defaultReview, /Read each report whole with list_events/);
      // An answer relayed by the parent reaches a session twice (the user often answers
      // there too) and the auto mode classifier refuses it as not the user's.
      assert.match(defaultReview, /is mine to give in that PR's session/);
      assert.match(review, /1\) \/my-review https:\/\/github\.com\/a\/b\/pull\/1 2\) \/my-review https:\/\/github\.com\/a\/b\/pull\/2/, "each PR's own review prompt");
      const placed = cl.renderGroupPrompt({}, "review", "ENG-7", prs, ["C:\\Projects\\core", null]);
      assert.match(placed, /start_session's cwd/);
      assert.ok(
        placed.includes("1) in C:\\Projects\\core: /creatio-code-review https://github.com/a/b/pull/1 2) /creatio-code-review https://github.com/a/b/pull/2"),
        "a PR from another repository names its own checkout; one with none runs in the parent's folder",
      );
      for (const prompt of [explain, review]) {
        assert.ok(!/[{}]/.test(prompt), "every placeholder is filled");
        assert.ok(!/["%^&|<>]/.test(prompt), "cmd.exe could not pass the default prompt");
      }
      const custom = cl.renderGroupPrompt({ explainGroup: "/overview {key} {urls}" }, "explain", "ENG-1", prs);
      assert.strictEqual(custom, "[PR Dashboard overview of ENG-1] /overview ENG-1 https://github.com/a/b/pull/1 https://github.com/a/b/pull/2");
      // MAX_GROUP_PRS exists for cmd.exe's 8191-character command line: a full
      // group of long GHE links behind the longest key must still fit, with
      // room for `cmd /c start "" /D "<dir>" cmd /k claude "…"` around it.
      const full = Array.from({ length: cl.MAX_GROUP_PRS }, (_, i) => ({
        url: `https://creatio.ghe.com/engineering/creatio-playwright-testkit-extended/pull/${100000 + i}`,
      }));
      const longest = cl.renderGroupPrompt({}, "explain", "ENG-123456789", full);
      assert.ok(longest.length + 400 < 8191, `a ${cl.MAX_GROUP_PRS}-PR overview is ${longest.length} characters`);
      const c = cfg.validateClaude({});
      assert.strictEqual(c.prompts.explainGroup, cl.DEFAULT_CLAUDE_PROMPTS.explainGroup);
      assert.strictEqual(c.prompts.reviewGroup, cl.DEFAULT_CLAUDE_PROMPTS.reviewGroup);
      for (const old of cl.PREVIOUS_DEFAULT_PROMPTS.reviewGroup) {
        assert.notStrictEqual(old, cl.DEFAULT_CLAUDE_PROMPTS.reviewGroup);
        assert.strictEqual(
          cfg.validateClaude({ prompts: { reviewGroup: old } }).prompts.reviewGroup,
          cl.DEFAULT_CLAUDE_PROMPTS.reviewGroup,
          "a saved copy of an old default reads as the current default",
        );
      }
      assert.strictEqual(cfg.validateClaude({ prompts: { reviewGroup: "/mine {prompts}" } }).prompts.reviewGroup, "/mine {prompts}");
      const stored = cfg.toStoredSettings(cfg.validateSettings({ claude: { prompts: { review: "/mine {url}" } } }));
      assert.strictEqual(stored.claude.prompts.reviewGroup, "", "a default prompt is stored empty, so a later default reaches it");
      assert.strictEqual(stored.claude.prompts.review, "/mine {url}", "an edited prompt is stored as is");
      assert.strictEqual(cfg.validateSettings(stored).claude.prompts.reviewGroup, cl.DEFAULT_CLAUDE_PROMPTS.reviewGroup);
      assert.strictEqual(cfg.toPublicConfig(cfg.validateSettings({ claude: { ...c, terminal: "desktop" } })).claudeDesktop, true);
      assert.strictEqual(cfg.toPublicConfig(cfg.validateSettings({ claude: c })).claudeDesktop, false);
    });

    test("group launches: only a kind, a Jira key and 1..max distinct PR ids cross from the renderer", () => {
      const v = require(path.join(__dirname, "../dist/main/main/ipc-validation.js"));
      assert.deepStrictEqual(v.validateGroupLaunchArgs("review", "ENG-1", ["a", "b", "a"]), { kind: "review", key: "ENG-1", ids: ["a", "b"] });
      assert.deepStrictEqual(v.validateGroupLaunchArgs("explain", "ENG-1", ["a"]).ids, ["a"]);
      for (const kind of ["", "merge", "review; rm -rf ~", 1, null]) {
        assert.throws(() => v.validateGroupLaunchArgs(kind, "ENG-1", ["a"]), /unknown action/, String(kind));
      }
      for (const key of ["eng-1", "ENG-1; rm -rf ~", "ENG-1 ", "__other__", 1, null]) {
        assert.throws(() => v.validateGroupLaunchArgs("explain", key, ["a", "b"]), /Jira issue key/, String(key));
      }
      assert.throws(() => v.validateGroupLaunchArgs("explain", "ENG-1", "a,b"), /list of PR ids/);
      assert.throws(() => v.validateGroupLaunchArgs("explain", "ENG-1", []), /expected 1 to/);
      assert.throws(() => v.validateGroupLaunchArgs("explain", "ENG-1", Array.from({ length: cl.MAX_GROUP_PRS + 1 }, (_, i) => `p${i}`)), /expected 1 to/);
      assert.throws(() => v.validateGroupLaunchArgs("explain", "ENG-1", ["a", 5]), /PR id/);
    });

    await atest("group launches: run in the majority repository's checkout; review needs Desktop and due PRs", async () => {
      const nfs = require("node:fs");
      const root = nfs.mkdtempSync(path.join(os.tmpdir(), "prd-claude-"));
      const mk = (name, url) => {
        nfs.mkdirSync(path.join(root, name, ".git"), { recursive: true });
        nfs.writeFileSync(path.join(root, name, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
      };
      mk("ui", "https://github.com/acme/ui.git");
      mk("core", "https://github.com/acme/core.git");
      const at = (repo, n, extra = {}) => ({ ...quiet, roles: ["reviewer"], id: `${repo}#${n}`, repo, url: `https://github.com/${repo}/pull/${n}`, ...extra });
      const settings = { enabled: true, projectsRoot: root, repoPaths: {}, prompts: {}, terminal: "desktop" };
      const opened = [];
      const openUrl = async (u) => { opened.push(decodeURIComponent(u)); };
      try {
        const prs = [at("acme/core", 1), at("acme/ui", 2), at("acme/ui", 3)];
        assert.strictEqual(launcher.overviewCheckout(prs, settings), path.join(root, "ui"));
        const asked = [];
        launcher.overviewCheckout(prs, settings, (pr, s) => { asked.push(pr.repo); return launcher.findCheckout(pr, s); });
        assert.deepStrictEqual(asked, ["acme/ui"], "the lookup is asked per repository, majority first, until one is found");
        assert.strictEqual(
          launcher.overviewCheckout([at("acme/none", 1), at("acme/none", 2), at("acme/core", 3)], settings),
          path.join(root, "core"),
          "a repository with no checkout gives way to the next one",
        );
        const res = await launcher.launchGroup("explain", "ENG-7", prs, settings, { openUrl });
        assert.deepStrictEqual(res, { ok: true, count: 3, dir: path.join(root, "ui") });
        assert.ok(opened[0].includes("[PR Dashboard overview of ENG-7] Explain together the 3 open pull requests of ENG-7"), opened[0]);

        // Review: main picks the due PRs again, whatever the renderer sent.
        const withMine = [...prs, at("acme/ui", 4, { roles: ["author"] })];
        const rev = await launcher.launchGroup("review", "ENG-7", withMine, settings, { openUrl });
        assert.deepStrictEqual(rev, { ok: true, count: 3, dir: path.join(root, "ui") });
        assert.ok(opened[1].includes("[PR Dashboard review of ENG-7] Review the 3 pull requests of ENG-7"), opened[1]);
        assert.ok(!opened[1].includes("/pull/4"), "your own PR is never sent for review");
        assert.ok(
          opened[1].includes(`1) in ${path.join(root, "core")}: /creatio-code-review https://github.com/acme/core/pull/1 2) /creatio-code-review https://github.com/acme/ui/pull/2`),
          "the core PR is reviewed in core's checkout, the ui ones in the parent's folder",
        );

        const terminal = await launcher.launchGroup("review", "ENG-7", prs, { ...settings, terminal: "auto" }, { openUrl });
        assert.match(terminal.ok ? "" : terminal.error, /only Claude Desktop/);
        const notDue = await launcher.launchGroup("review", "ENG-7", [at("acme/ui", 4, { roles: ["author"] })], settings, { openUrl });
        assert.match(notDue.ok ? "" : notDue.error, /waits for your review/);
        const off = await launcher.launchGroup("explain", "ENG-7", prs, { ...settings, enabled: false }, { openUrl });
        assert.strictEqual(off.ok, false);
        const one = await launcher.launchGroup("explain", "ENG-7", prs.slice(0, 1), settings, { openUrl });
        assert.strictEqual(one.ok, false, "a PR that left the dashboard can leave fewer than two");
        const none = await launcher.launchGroup("explain", "ENG-7", [at("acme/none", 1), at("acme/none", 2)], settings, { openUrl });
        assert.match(none.ok ? "" : none.error, /No checkout of acme\/none/);
        assert.strictEqual(opened.length, 2, "a refused launch opens nothing");
      } finally {
        nfs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("main.js wiring: claude:launchGroup validates, then reads the PRs from the snapshot", () => {
      const src = require("node:fs").readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
      assert.match(src, /"claude:launchGroup"[\s\S]{0,300}validateGroupLaunchArgs[\s\S]{0,200}getSnapshot\(\)/);
    });
  }

  // --- Jira auth wiring in the main process -----------------------------------
  // The decisions are pure and tested above (shouldNotifyJiraAuth, createJiraPass,
  // getJiraStatus); these pin that main.js actually routes through them.
  {
    const readDist = (rel) => require("node:fs").readFileSync(path.join(__dirname, "../dist/main", rel), "utf8");

    test("main.js wiring: every snapshot feeds the Jira auth notification", () => {
      assert.match(readDist("main/main.js"), /onSnapshot:[\s\S]{0,1500}handleJiraAuthNotification\(snapshot\.jiraHealth\)/);
    });
    test("main.js wiring: the Jira auth notification fires on the transition, under the notification switches", () => {
      const src = readDist("main/main.js");
      const fn = src.slice(src.indexOf("function handleJiraAuthNotification"));
      assert.match(fn, /shouldNotifyJiraAuth\)?\(prevJiraHealth, health\)/);
      assert.match(fn, /notifications\.enabled[\s\S]{0,80}notifications\.native[\s\S]{0,80}isSupported\(\)/);
    });
    test("main.js wiring: jira:twgLogin opens the sign-in and reports a failure instead of throwing", () => {
      assert.match(
        readDist("main/main.js"),
        /"jira:twgLogin"[\s\S]{0,200}openTwgLogin\)?\(\)[\s\S]{0,120}ok: true[\s\S]{0,120}ok: false, error:/,
      );
    });
    test("twg.js: the sign-in terminal goes through the shared launcher, not its own spawn", () => {
      const src = readDist("main/twg.js");
      assert.match(src, /openTerminalWith\)?\(/);
      assert.doesNotMatch(src, /cmd\.exe|osascript|\bspawn\b/);
    });
  }


  // --- Running Claude sessions -----------------------------------------------
  {
    const cs = require(path.join(__dirname, "../dist/main/shared/claude-sessions.js"));
    const scanner = require(path.join(__dirname, "../dist/main/main/claude-sessions.js"));
    const ipcv = require(path.join(__dirname, "../dist/main/main/ipc-validation.js"));
    const nfs = require("node:fs");
    const SID = "b885533b-56e7-40f9-b891-5b31e77a22a1";
    const SID2 = "3527484f-1974-4a3b-b0ca-57b45c38321c";
    // A prompt line as Claude Code 2.1 writes it (trimmed to the fields read).
    const promptLine = (content, extra = {}) =>
      JSON.stringify({ type: "user", message: { role: "user", content }, origin: { kind: "human" }, sessionId: SID, ...extra });

    test("claude sessions: PR keys drop the scheme, /files, query and case", () => {
      assert.strictEqual(cs.prUrlKey("https://creatio.ghe.com/Engineering/Core/pull/1628/files?w=1"), "creatio.ghe.com/engineering/core/pull/1628");
      assert.strictEqual(cs.prUrlKey("https://github.com/acme/widgets/issues/3"), null);
      assert.deepStrictEqual(
        cs.extractPrKeys("see <https://github.com/a/b/pull/1>, https://github.com/a/b/pull/1/files and (https://x.io/c/d/pull/22)"),
        ["github.com/a/b/pull/1", "x.io/c/d/pull/22"],
      );
    });

    test("claude sessions: a group session holds none of the PRs it lists", () => {
      const cl = require(path.join(__dirname, "../dist/main/shared/claude-launch.js"));
      const urls = [{ url: "https://github.com/a/b/pull/1" }, { url: "https://github.com/a/b/pull/2" }];
      const explain = cl.renderGroupPrompt({}, "explain", "ENG-1", urls);
      const review = cl.renderGroupPrompt({}, "review", "ENG-1", urls);
      assert.deepStrictEqual(cs.promptPrKeys(promptLine(explain)), []);
      assert.deepStrictEqual(cs.promptLinks(promptLine(explain)), { prKeys: [], group: { kind: "explain", key: "ENG-1" } });
      assert.deepStrictEqual(cs.promptLinks(promptLine(review)), { prKeys: [], group: { kind: "review", key: "ENG-1" } });
      const noLinks = cl.renderGroupPrompt({ explainGroup: "/my-overview {key}" }, "explain", "ENG-1", urls);
      assert.ok(!noLinks.includes("/pull/"), noLinks);
      assert.deepStrictEqual(
        cs.promptLinks(promptLine(noLinks)),
        { prKeys: [], group: { kind: "explain", key: "ENG-1" } },
        "a custom template with no PR links still names its group",
      );
      assert.deepStrictEqual(cs.promptPrKeys(promptLine(`now fix https://github.com/a/b/pull/1`)), ["github.com/a/b/pull/1"], "a later prompt in it still counts");
      const quoted = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: explain }] }, origin: { kind: "human" } });
      assert.deepStrictEqual(cs.promptLinks(quoted), { prKeys: [], group: null }, "a quoted group prompt starts nothing");
    });

    test("claude sessions: a group heading finds its own sessions, the one that needs you first", () => {
      const s = (id, status, groups, where = "terminal") => ({ id, name: id, status, where, prKeys: [], repoKeys: [], branch: null, groups });
      const list = [
        s("idle", "idle", [{ kind: "explain", key: "ENG-1" }]),
        s("other", "waiting", [{ kind: "explain", key: "ENG-2" }]),
        s("wait", "waiting", [{ kind: "review", key: "ENG-1" }]),
        s("plain", "busy", undefined),
      ];
      assert.deepStrictEqual(cs.sessionsForGroup("ENG-1", list).map((x) => x.id), ["wait", "idle"]);
      assert.deepStrictEqual(cs.sessionsForGroup("ENG-3", list), []);
      assert.strictEqual(cs.groupKindOf(list[0], "ENG-1"), "explain");
      const onBranch = { id: "g", name: "g", status: "busy", where: "desktop", prKeys: [], repoKeys: ["github.com/acme/widgets"], branch: "feature/x" };
      const pr = { url: "https://github.com/acme/widgets/pull/7", repo: "acme/widgets", headRefName: "feature/x" };
      assert.deepStrictEqual(cs.sessionsForPr(pr, [onBranch]).map((x) => x.id), ["g"], "a plain session on the PR's branch holds it");
      assert.deepStrictEqual(
        cs.sessionsForPr(pr, [{ ...onBranch, groups: [{ kind: "review", key: "ENG-1" }] }]),
        [],
        "a group session in a checkout on one of its PRs' branches holds none of them",
      );
      assert.strictEqual(cs.groupKindOf(list[2], "ENG-1"), "review");
      // A heading's words are its kind's, not the card's: "Needs you" there
      // would read as "these reviews need you".
      for (const kind of ["explain", "review"]) {
        assert.deepStrictEqual(Object.keys(cs.GROUP_STATUS_TEXT[kind]).sort(), Object.keys(cs.SESSION_STATUS_TEXT).sort());
        for (const text of Object.values(cs.GROUP_STATUS_TEXT[kind])) assert.ok(!/needs you/i.test(text), text);
      }
      assert.strictEqual(cs.GROUP_STATUS_TEXT.explain.idle, "Overview ready");
      assert.ok(!/done|ready/i.test(cs.GROUP_STATUS_TEXT.review.idle), "an idle review parent may still be waiting for its sessions");
    });

    test("claude sessions: only a prompt the user sent counts, not what other turns quote", () => {
      const slash = "<command-message>usercustom-dev:drive-pr-close</command-message>\n<command-name>/usercustom-dev:drive-pr-close</command-name>\n<command-args>https://creatio.ghe.com/engineering/core/pull/1628</command-args>";
      assert.deepStrictEqual(cs.promptPrKeys(promptLine(slash)), ["creatio.ghe.com/engineering/core/pull/1628"]);
      const desktop = promptLine([
        { type: "text", text: "<system-reminder>\nWorktree of https://github.com/a/b/pull/9\n</system-reminder>\n\n" },
        { type: "text", text: "доведи https://github.com/a/b/pull/7" },
      ]);
      assert.deepStrictEqual(cs.promptPrKeys(desktop), ["github.com/a/b/pull/7"], "a system reminder is not what the user typed");
      const toolResult = promptLine([{ type: "tool_result", tool_use_id: "t", content: "https://github.com/a/b/pull/8" }]);
      assert.deepStrictEqual(cs.promptPrKeys(toolResult), []);
      assert.deepStrictEqual(cs.promptPrKeys(promptLine("https://github.com/a/b/pull/8", { origin: { kind: "peer" } })), []);
      assert.deepStrictEqual(cs.promptPrKeys(promptLine("https://github.com/a/b/pull/8", { origin: { kind: "task-notification" } })), []);
      assert.deepStrictEqual(cs.promptPrKeys(promptLine("https://github.com/a/b/pull/8", { isMeta: true })), []);
      assert.deepStrictEqual(cs.promptPrKeys(promptLine("https://github.com/a/b/pull/8", { isSidechain: true })), []);
      const legacy = JSON.stringify({ type: "user", message: { role: "user", content: "https://github.com/a/b/pull/5" } });
      assert.deepStrictEqual(cs.promptPrKeys(legacy), ["github.com/a/b/pull/5"], "a transcript older than `origin` is judged by content");
      const blob = JSON.stringify({ type: "api-request-blob", message: { role: "user", content: "\"type\":\"user\" https://github.com/a/b/pull/4" } });
      assert.deepStrictEqual(cs.promptPrKeys(blob), []);
      assert.deepStrictEqual(cs.promptPrKeys('{"type":"user", "/pull/ broken'), []);
    });

    const session = (patch) => ({
      id: SID, name: "s", status: "idle", where: "terminal", prKeys: [], repoKeys: [], branch: null, ...patch,
    });
    const prOf = { url: "https://github.com/acme/widgets/pull/7", repo: "acme/widgets", headRefName: "feature/x" };

    test("claude sessions: matched by the PR link or by the PR's branch in its repository", () => {
      const byLink = session({ id: "a", prKeys: ["github.com/acme/widgets/pull/7"] });
      const byBranch = session({ id: "b", repoKeys: ["github.com/acme/widgets"], branch: "feature/x" });
      const otherRepo = session({ id: "c", repoKeys: ["github.com/acme/other"], branch: "feature/x" });
      const otherPr = session({ id: "d", prKeys: ["github.com/acme/widgets/pull/70"] });
      const noBranch = session({ id: "e", repoKeys: ["github.com/acme/widgets"], branch: null });
      const ids = cs.sessionsForPr(prOf, [byLink, byBranch, otherRepo, otherPr, noBranch]).map((x) => x.id);
      assert.deepStrictEqual(ids.sort(), ["a", "b"]);
    });

    test("claude sessions: the one that needs the user comes first, a windowless one last", () => {
      const k = ["github.com/acme/widgets/pull/7"];
      const list = [
        session({ id: "idle", name: "a", status: "idle", prKeys: k }),
        session({ id: "bg", name: "b", status: "waiting", where: "background", prKeys: k }),
        session({ id: "busy", name: "c", status: "busy", prKeys: k }),
        session({ id: "wait", name: "d", status: "waiting", prKeys: k }),
      ];
      assert.deepStrictEqual(cs.sessionsForPr(prOf, list).map((x) => x.id), ["wait", "bg", "busy", "idle"]);
      assert.match(cs.describeSession(session({ name: "ENG-1 · x", status: "waiting", waitingFor: "input needed" })), /waiting for you \(input needed\), in a terminal/);
    });

    test("claude sessions: the card glows for the session the button shows, only while it works or waits", () => {
      const bgBusy = session({ id: "bg", status: "busy", where: "background" });
      const idle = session({ id: "idle", status: "idle" });
      assert.strictEqual(cs.shownSession([bgBusy, idle]).id, "idle", "a session with a window wins");
      assert.strictEqual(cs.shownSession([bgBusy]).id, "bg", "a windowless one when it is the only one");
      assert.strictEqual(cs.shownSession([]), undefined);
      assert.strictEqual(cs.sessionGlow(session({ status: "busy" })), "busy");
      assert.strictEqual(cs.sessionGlow(session({ status: "waiting" })), "waiting");
      assert.strictEqual(cs.sessionGlow(idle), null);
      assert.strictEqual(cs.sessionGlow(session({ status: "paused" })), null);
      assert.strictEqual(cs.sessionGlow(undefined), null);
    });

    test("claude sessions: the Desktop link and the terminal scripts", () => {
      assert.strictEqual(
        cs.claudeDesktopSessionUrl("local_04157f10-d434-496a-9d90-07a57b1c7479"),
        "claude://claude.ai/epitaxy/local_04157f10-d434-496a-9d90-07a57b1c7479",
      );
      const it = cs.focusTtyScript("iterm", "/dev/ttys001").join("\n");
      assert.match(it, /^if application id "com\.googlecode\.iterm2" is not running then return "missing"/, "a closed iTerm2 is not started");
      assert.match(
        it,
        /if tty of s is "\/dev\/ttys001" then\ntell t to select\ntell s to select\ntell w to select\nactivate/,
        "the window is raised last — raising it first reorders `windows` under `t` and `s`",
      );
      const term = cs.focusTtyScript("terminal", "/dev/ttys002").join("\n");
      assert.match(term, /^if application "Terminal" is not running then return "missing"/);
      assert.match(term, /if tty of t is "\/dev\/ttys002" then[\s\S]*set selected tab of w to t[\s\S]*set index of w to 1/);
    });

    test("claude sessions: a registry file is read defensively", () => {
      // Copied from a real ~/.claude/sessions/<pid>.json (Claude Code 2.1.308).
      const real = {
        pid: 91853, sessionId: SID2, cwd: "/Users/me/Projects/github-pr-manager/.claude/worktrees/x",
        startedAt: 1792699615158, procStart: "Thu Oct 22 20:06:53 2026", version: "2.1.308", kind: "interactive",
        entrypoint: "claude-desktop", hostSessionId: "local_04157f10-d434-496a-9d90-07a57b1c7479", pidDomain: "darwin",
        name: "🔍 Зворотний зв'язок PR manager для сесій", status: "busy", updatedAt: 1792699630379,
      };
      const e = scanner.parseRegistryEntry(real);
      assert.deepStrictEqual(e, {
        pid: 91853, sessionId: SID2, cwd: real.cwd, kind: "interactive", entrypoint: "claude-desktop",
        hostSessionId: real.hostSessionId, name: real.name, status: "busy",
      });
      assert.strictEqual(scanner.sessionWhere(e), "desktop");
      assert.strictEqual(scanner.sessionWhere({ kind: "interactive", entrypoint: "cli" }), "terminal");
      // `claude` with no prompt opens the session list; its sessions run in the
      // daemon's own pty and keep running after the terminal closes.
      assert.strictEqual(scanner.sessionWhere({ kind: "bg", entrypoint: "cli" }), "background");
      // Copied from a real spare (Claude Code 2.1.308): a process started ahead of the next session.
      const spare = {
        pid: 40972, sessionId: "975813af-6746-4cf3-afb8-3f77567b4f44", cwd: real.cwd, kind: "bg", entrypoint: "cli",
        name: "975813af", agent: "claude", jobId: "975813af", spare: true, status: "idle",
      };
      assert.strictEqual(scanner.parseRegistryEntry(spare), null, "a spare is no session");
      assert.strictEqual(scanner.parseRegistryEntry({ ...spare, spare: false }).kind, "bg");
      assert.strictEqual(scanner.sessionWhere({ entrypoint: "sdk-cli" }), "background");
      assert.strictEqual(scanner.sessionWhere({ entrypoint: "claude-desktop" }), "background", "no Desktop id, nothing to open");
      const waiting = scanner.parseRegistryEntry({ ...real, status: "waiting", waitingFor: "input needed", hostSessionId: "local_x\"; rm" });
      assert.strictEqual(waiting.waitingFor, "input needed");
      assert.strictEqual(waiting.hostSessionId, undefined, "an id that isn't Desktop's shape never reaches a link");
      assert.strictEqual(scanner.parseRegistryEntry({ ...real, status: "weird" }).status, "idle");
      assert.strictEqual(scanner.parseRegistryEntry({ ...real, name: "" }).name, "x", "no title → the folder's name");
      assert.strictEqual(scanner.parseRegistryEntry({ ...real, pid: "1" }), null);
      assert.strictEqual(scanner.parseRegistryEntry({ ...real, sessionId: "../../etc" }), null);
      assert.strictEqual(scanner.parseRegistryEntry(null), null);
      assert.strictEqual(scanner.projectDirName("/Users/a.kravchuk/Projects/x/.claude/worktrees/y-1"), "-Users-a-kravchuk-Projects-x--claude-worktrees-y-1");
    });

    test("claude sessions: ipc accepts only a session id", () => {
      assert.strictEqual(ipcv.validateClaudeSessionId(SID), SID);
      for (const bad of [undefined, 1, "", "local_04157f10", `${SID} ; x`]) {
        assert.throws(() => ipcv.validateClaudeSessionId(bad), /session id/);
      }
    });

    await atest("claude sessions: scan reads the registry, the transcript and the checkout's branch", async () => {
      const root = nfs.mkdtempSync(path.join(os.tmpdir(), "prd-sessions-"));
      try {
        const configDir = path.join(root, "claude");
        // A main checkout and a linked worktree of it on the PR's branch.
        const repo = path.join(root, "widgets");
        nfs.mkdirSync(path.join(repo, ".git", "worktrees", "wt"), { recursive: true });
        nfs.writeFileSync(path.join(repo, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Acme/Widgets.git\n');
        nfs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
        const wt = path.join(root, "wt");
        nfs.mkdirSync(path.join(wt, "src"), { recursive: true });
        nfs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`);
        nfs.writeFileSync(path.join(repo, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/feature/x\n");
        nfs.writeFileSync(path.join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
        assert.deepStrictEqual(scanner.gitInfo(path.join(wt, "src")), { branch: "feature/x", remotes: ["git@github.com:Acme/Widgets.git"] });
        assert.deepStrictEqual(scanner.gitInfo(repo).branch, "main");

        nfs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
        const reg = (pid, sid, cwd, extra) =>
          nfs.writeFileSync(path.join(configDir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd, entrypoint: "cli", name: `s${pid}`, status: "busy", ...extra }));
        reg(101, SID, repo, {});
        reg(102, SID2, wt, { entrypoint: "claude-desktop", hostSessionId: "local_abc", status: "waiting", waitingFor: "input needed" });
        reg(103, "11111111-2222-4333-8444-555555555555", repo, {}); // its process is gone
        nfs.writeFileSync(path.join(configDir, "sessions", "104.json"), "{not json");
        const tdir = path.join(configDir, "projects", scanner.projectDirName(repo));
        nfs.mkdirSync(tdir, { recursive: true });
        const transcript = path.join(tdir, `${SID}.jsonl`);
        nfs.writeFileSync(transcript, promptLine("/drive-pr-green https://github.com/acme/widgets/pull/7") + "\n" +
          JSON.stringify({ type: "assistant", message: { role: "assistant", content: "https://github.com/acme/widgets/pull/99" } }) + "\n");

        // An empty Desktop folder: Desktop's records are covered by the next test.
        const sc = scanner.createClaudeSessionScanner({ configDir, desktopDir: path.join(root, "desktop"), isAlive: (pid) => pid !== 103 });
        let list = await sc.scan();
        assert.deepStrictEqual(list.map((x) => x.id), [SID2, SID].sort(), "a dead pid and a broken file are dropped");
        const cli = list.find((x) => x.id === SID);
        assert.deepStrictEqual(cli.prKeys, ["github.com/acme/widgets/pull/7"], "the assistant's link is not the user's");
        assert.deepStrictEqual(cli.repoKeys, ["github.com/acme/widgets"]);
        assert.strictEqual(cli.branch, "main");
        assert.strictEqual(cli.where, "terminal");
        const desk = list.find((x) => x.id === SID2);
        assert.deepStrictEqual(
          { where: desk.where, status: desk.status, waitingFor: desk.waitingFor, branch: desk.branch, prKeys: desk.prKeys },
          { where: "desktop", status: "waiting", waitingFor: "input needed", branch: "feature/x", prKeys: [] },
          "no transcript yet, but the worktree's branch matches",
        );
        assert.deepStrictEqual(cs.sessionsForPr(prOf, list).map((x) => x.id).sort(), [SID, SID2].sort());

        // Appended later: a half-written line counts only once it is complete.
        const later = promptLine("а тепер https://github.com/acme/widgets/pull/8");
        nfs.appendFileSync(transcript, later.slice(0, 40));
        list = await sc.scan();
        assert.deepStrictEqual(list.find((x) => x.id === SID).prKeys, ["github.com/acme/widgets/pull/7"]);
        nfs.appendFileSync(transcript, later.slice(40) + "\n");
        list = await sc.scan();
        assert.deepStrictEqual(list.find((x) => x.id === SID).prKeys, ["github.com/acme/widgets/pull/7", "github.com/acme/widgets/pull/8"]);
        assert.strictEqual(list.find((x) => x.id === SID).groups, undefined);
        const cl = require(path.join(__dirname, "../dist/main/shared/claude-launch.js"));
        nfs.appendFileSync(transcript, promptLine(cl.renderGroupPrompt({}, "explain", "ENG-5", [{ url: "https://github.com/acme/widgets/pull/9" }, { url: "https://github.com/acme/widgets/pull/10" }])) + "\n");
        list = await sc.scan();
        assert.deepStrictEqual(list.find((x) => x.id === SID).groups, [{ kind: "explain", key: "ENG-5" }], "the overview prompt names its group");
        assert.deepStrictEqual(list.find((x) => x.id === SID).prKeys, ["github.com/acme/widgets/pull/7", "github.com/acme/widgets/pull/8"], "and binds none of its PRs");

        // Switching: the Desktop session by its link; refusals say why.
        const opened = [];
        const openUrl = async (url) => { opened.push(url); };
        assert.deepStrictEqual(await sc.focus(SID2, { openUrl }), { ok: true });
        assert.deepStrictEqual(opened, ["claude://claude.ai/epitaxy/local_abc"]);
        const linux = await sc.focus(SID, { openUrl, platform: "linux" });
        assert.ok(!linux.ok && /macOS only/.test(linux.error), JSON.stringify(linux));
        const gone = await sc.focus("11111111-2222-4333-8444-555555555555", { openUrl });
        assert.ok(!gone.ok && /no longer running/.test(gone.error));
        reg(105, "22222222-2222-4333-8444-555555555555", repo, { entrypoint: "sdk-cli" });
        await sc.scan();
        const bg = await sc.focus("22222222-2222-4333-8444-555555555555", { openUrl });
        assert.ok(!bg.ok && /no window/.test(bg.error));
        assert.strictEqual(opened.length, 1, "nothing else was opened");
      } finally {
        nfs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("claude sessions: a Desktop session record is read defensively", () => {
      // Trimmed from a real claude-code-sessions/<account>/<org>/local_….json (Claude Desktop, 2026-10-22).
      const real = {
        sessionId: "local_4c884773-36af-4852-9c60-ca19bcd84234", cliSessionId: "283ce799-5a56-425c-a835-69b8636676cd",
        cwd: "/Users/me/Projects/mac-setup", lastActivityAt: 1792699591065, isArchived: false, title: "✅ Drive red prs green",
        prs: [
          { prNumber: 3705, repo: "engineering/creatio-ui", host: "creatio.ghe.com", url: "https://creatio.ghe.com/engineering/creatio-ui/pull/3705", state: "MERGED" },
          { prNumber: 3750, repo: "engineering/creatio-ui", host: "creatio.ghe.com", url: "https://creatio.ghe.com/engineering/creatio-ui/pull/3750", state: "OPEN" },
        ],
        scheduledTaskId: "drive-red-prs-green",
      };
      assert.deepStrictEqual(scanner.parseDesktopRecord(real), {
        sessionId: real.sessionId, cliSessionId: real.cliSessionId, title: real.title, isArchived: false, scheduled: true,
        prKeys: ["creatio.ghe.com/engineering/creatio-ui/pull/3705", "creatio.ghe.com/engineering/creatio-ui/pull/3750"],
        lastActivityAt: 1792699591065,
      });
      const plain = scanner.parseDesktopRecord({ sessionId: "local_x", prs: [{ url: "nope" }, null, 3], cliSessionId: "../x" });
      assert.deepStrictEqual(
        { prKeys: plain.prKeys, cli: plain.cliSessionId, scheduled: plain.scheduled, title: plain.title },
        { prKeys: [], cli: null, scheduled: false, title: "local_x" },
      );
      assert.strictEqual(scanner.parseDesktopRecord({ sessionId: "local_x\"; rm" }), null);
      assert.strictEqual(scanner.parseDesktopRecord({ sessionId: "283ce799-5a56-425c-a835-69b8636676cd" }), null);
    });

    await atest("claude sessions: Desktop's records add paused sessions and drop archived ones", async () => {
      const root = nfs.mkdtempSync(path.join(os.tmpdir(), "prd-desktop-"));
      try {
        const configDir = path.join(root, "claude");
        const desktopDir = path.join(root, "desktop");
        const org = path.join(desktopDir, "claude-code-sessions", "acct", "org");
        nfs.mkdirSync(org, { recursive: true });
        nfs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
        let clock = Date.now();
        const day = 24 * 3600 * 1000;
        const pr7 = "https://github.com/acme/widgets/pull/7";
        const record = (id, fields, mtime = clock) => {
          const p = path.join(org, `${id}.json`);
          nfs.writeFileSync(p, JSON.stringify({ sessionId: id, isArchived: false, ...fields }));
          nfs.utimesSync(p, mtime / 1000, mtime / 1000);
        };
        // Live: a Desktop session whose process runs, with the title Desktop gave it.
        nfs.writeFileSync(path.join(configDir, "sessions", "201.json"), JSON.stringify({
          pid: 201, sessionId: SID2, cwd: root, entrypoint: "claude-desktop", hostSessionId: "local_live", name: "derived", status: "busy",
        }));
        record("local_live", { cliSessionId: SID2, title: "Live one", prs: [{ url: pr7 }] });
        const P1 = "33333333-3333-4333-8333-333333333333";
        const P2 = "44444444-4444-4444-8444-444444444444";
        record("local_paused1", { cliSessionId: P1, title: "Paused older", prs: [{ url: pr7 }], lastActivityAt: 100 });
        record("local_paused2", { cliSessionId: P2, title: "Paused newer", prs: [{ url: pr7 + "/files" }], lastActivityAt: 200 });
        record("local_archived", { cliSessionId: "55555555-5555-4555-8555-555555555555", title: "A", prs: [{ url: pr7 }], isArchived: true });
        record("local_routine", { cliSessionId: "66666666-6666-4666-8666-666666666666", title: "R", prs: [{ url: pr7 }], scheduledTaskId: "drive-red-prs-green" });
        record("local_old", { cliSessionId: "77777777-7777-4777-8777-777777777777", title: "O", prs: [{ url: pr7 }] }, clock - 30 * day);
        record("local_noprs", { cliSessionId: "88888888-8888-4888-8888-888888888888", title: "N" });

        const sc = scanner.createClaudeSessionScanner({ configDir, desktopDir, isAlive: () => true, now: () => clock });
        let list = await sc.scan();
        const ids = list.map((x) => x.id).sort();
        assert.deepStrictEqual(ids, [P1, P2, SID2].sort(), "archived, routine, old and PR-less records stay out");
        const live = list.find((x) => x.id === SID2);
        assert.deepStrictEqual(
          { name: live.name, status: live.status, prKeys: live.prKeys },
          { name: "Live one", status: "busy", prKeys: ["github.com/acme/widgets/pull/7"] },
          "a live Desktop session takes Desktop's title and the PRs bound to it",
        );
        assert.deepStrictEqual(
          cs.sessionsForPr(prOf, list).map((x) => `${x.name}:${x.status}`),
          ["Live one:busy", "Paused newer:paused", "Paused older:paused"],
        );

        const opened = [];
        const openUrl = async (url) => { opened.push(url); };
        assert.deepStrictEqual(await sc.focus(P2, { openUrl }), { ok: true });
        assert.deepStrictEqual(opened, ["claude://claude.ai/epitaxy/local_paused2"], "opening a paused session resumes it in Desktop");

        // Archived in Desktop: gone on the next scan, between listings too.
        record("local_paused2", { cliSessionId: P2, title: "Paused newer", prs: [{ url: pr7 }], isArchived: true }, clock + 1000);
        record("local_live", { cliSessionId: SID2, title: "Live one", prs: [{ url: pr7 }], isArchived: true }, clock + 1000);
        clock += 5000;
        list = await sc.scan();
        assert.deepStrictEqual(list.map((x) => x.id), [P1], "an archived session leaves even while its process lingers");
        const gone = await sc.focus(P2, { openUrl });
        assert.ok(!gone.ok && /no longer running/.test(gone.error));

        // A record written after the listing shows up once the folder is listed again.
        record("local_new", { cliSessionId: "99999999-9999-4999-8999-999999999999", title: "New", prs: [{ url: pr7 }] }, clock);
        assert.strictEqual((await sc.scan()).length, 1);
        clock += 61_000;
        assert.deepStrictEqual((await sc.scan()).map((x) => x.name).sort(), ["New", "Paused older"]);
      } finally {
        nfs.rmSync(root, { recursive: true, force: true });
      }
    });

    // A finished overview is idle, and Desktop pauses idle sessions: the
    // heading must keep it, and neither state may hand it the group's cards.
    await atest("claude sessions: a group session keeps its heading once Desktop pauses it", async () => {
      const root = nfs.mkdtempSync(path.join(os.tmpdir(), "prd-overview-"));
      try {
        const configDir = path.join(root, "claude");
        const desktopDir = path.join(root, "desktop");
        const org = path.join(desktopDir, "claude-code-sessions", "acct", "org");
        nfs.mkdirSync(org, { recursive: true });
        nfs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
        const pr7 = "https://github.com/acme/widgets/pull/7";
        nfs.writeFileSync(path.join(org, "local_ov.json"), JSON.stringify({ sessionId: "local_ov", cliSessionId: SID, isArchived: false, title: "Overview", prs: [{ url: pr7 }] }));
        nfs.writeFileSync(path.join(configDir, "sessions", "301.json"), JSON.stringify({
          pid: 301, sessionId: SID, cwd: root, entrypoint: "claude-desktop", hostSessionId: "local_ov", status: "idle",
        }));
        const tdir = path.join(configDir, "projects", scanner.projectDirName(root));
        nfs.mkdirSync(tdir, { recursive: true });
        const cl = require(path.join(__dirname, "../dist/main/shared/claude-launch.js"));
        nfs.writeFileSync(path.join(tdir, `${SID}.jsonl`), promptLine(cl.renderGroupPrompt({}, "review", "ENG-9", [{ url: pr7 }, { url: pr7 + "0" }])) + "\n");
        let running = true;
        const sc = scanner.createClaudeSessionScanner({ configDir, desktopDir, isAlive: () => running });
        let [ov] = await sc.scan();
        assert.deepStrictEqual({ status: ov.status, groups: ov.groups, prKeys: ov.prKeys }, { status: "idle", groups: [{ kind: "review", key: "ENG-9" }], prKeys: [] }, "Desktop's bound PRs do not reach a running group session");
        running = false;
        [ov] = await sc.scan();
        assert.deepStrictEqual({ status: ov.status, groups: ov.groups, prKeys: ov.prKeys }, { status: "paused", groups: [{ kind: "review", key: "ENG-9" }], prKeys: [] }, "nor a paused one");
        assert.deepStrictEqual(cs.sessionsForGroup("ENG-9", [ov]).map((x) => x.id), [SID]);
      } finally {
        nfs.rmSync(root, { recursive: true, force: true });
      }
    });

    // The dashboard restarts (an update, a reboot) while a group session is
    // paused: the session must come back under its heading, not bound to every
    // PR Desktop recorded for it.
    await atest("claude sessions: a paused group session survives a dashboard restart", async () => {
      const root = nfs.mkdtempSync(path.join(os.tmpdir(), "prd-restart-"));
      try {
        const configDir = path.join(root, "claude");
        const desktopDir = path.join(root, "desktop");
        const org = path.join(desktopDir, "claude-code-sessions", "acct", "org");
        nfs.mkdirSync(org, { recursive: true });
        nfs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
        const groupsFile = path.join(root, "claude-group-sessions.json");
        const pr7 = "https://github.com/acme/widgets/pull/7";
        nfs.writeFileSync(path.join(org, "local_ov.json"), JSON.stringify({ sessionId: "local_ov", cliSessionId: SID, isArchived: false, title: "Review", prs: [{ url: pr7 }] }));
        nfs.writeFileSync(path.join(configDir, "sessions", "401.json"), JSON.stringify({
          pid: 401, sessionId: SID, cwd: root, entrypoint: "claude-desktop", hostSessionId: "local_ov", status: "idle",
        }));
        const tdir = path.join(configDir, "projects", scanner.projectDirName(root));
        nfs.mkdirSync(tdir, { recursive: true });
        const cl = require(path.join(__dirname, "../dist/main/shared/claude-launch.js"));
        nfs.writeFileSync(path.join(tdir, `${SID}.jsonl`), promptLine(cl.renderGroupPrompt({}, "review", "ENG-9", [{ url: pr7 }])) + "\n");

        await scanner.createClaudeSessionScanner({ configDir, desktopDir, isAlive: () => true, groupsFile: () => groupsFile }).scan();
        assert.deepStrictEqual(JSON.parse(nfs.readFileSync(groupsFile, "utf8")), { [SID]: [{ kind: "review", key: "ENG-9" }] });

        // A new app run, the session paused meanwhile.
        const [ov] = await scanner.createClaudeSessionScanner({ configDir, desktopDir, isAlive: () => false, groupsFile: () => groupsFile }).scan();
        assert.deepStrictEqual(
          { status: ov.status, groups: ov.groups, prKeys: ov.prKeys },
          { status: "paused", groups: [{ kind: "review", key: "ENG-9" }], prKeys: [] },
        );

        // Archived in Desktop: gone from the file on the next save.
        nfs.writeFileSync(path.join(org, "local_ov.json"), JSON.stringify({ sessionId: "local_ov", cliSessionId: SID, isArchived: true, title: "Review" }));
        nfs.writeFileSync(path.join(org, "local_other.json"), JSON.stringify({ sessionId: "local_other", cliSessionId: SID2, isArchived: false, title: "Other", prs: [{ url: pr7 }] }));
        nfs.rmSync(path.join(org, "local_ov.json"));
        await scanner.createClaudeSessionScanner({ configDir, desktopDir, isAlive: () => false, groupsFile: () => groupsFile }).scan();
        assert.deepStrictEqual(JSON.parse(nfs.readFileSync(groupsFile, "utf8")), {}, "a session Desktop no longer lists is dropped");

        nfs.writeFileSync(groupsFile, "{not json");
        const list = await scanner.createClaudeSessionScanner({ configDir, desktopDir, isAlive: () => false, groupsFile: () => groupsFile }).scan();
        assert.ok(Array.isArray(list), "a broken file starts empty instead of failing the scan");
      } finally {
        nfs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("main.js wiring: sessions are scanned on a timer, pushed only while visible, focused by id", () => {
      const src = nfs.readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
      assert.match(src, /"claude:focusSession"[\s\S]{0,200}validateClaudeSessionId[\s\S]{0,300}claudeSessionScanner\.focus\(/);
      assert.match(src, /"claude:sessions"[\s\S]{0,120}refreshClaudeSessions\(\)/);
      assert.match(src, /isVisible\(\)\)\s*\{\s*sendToRenderer\("claude-sessions"/);
      assert.match(src, /claudeSessionsOn = settings\.claude\.enabled/);
    });
  }

  // --- the PR agent (stage 2: core, shadow only) ------------------------------
  {
    const nfsA = require("node:fs");
    const { PassThrough } = require("node:stream");
    const { EventEmitter } = require("node:events");
    const { spawnSync } = require("node:child_process");
    const guard = require(path.join(__dirname, "../dist/main/shared/agent-guard.js"));
    const policy = require(path.join(__dirname, "../dist/main/shared/agent-policy.js"));
    const stream = require(path.join(__dirname, "../dist/main/shared/agent-stream.js"));
    const ad = require(path.join(__dirname, "../dist/main/shared/agent-defaults.js"));
    const plugins = require(path.join(__dirname, "../dist/main/main/agent/plugins.js"));
    const runner = require(path.join(__dirname, "../dist/main/main/agent/runner.js"));
    const wt = require(path.join(__dirname, "../dist/main/main/agent/worktrees.js"));
    const agentStore = require(path.join(__dirname, "../dist/main/main/agent/store.js"));
    const agentCore = require(path.join(__dirname, "../dist/main/main/agent/index.js"));
    const idleGate = require(path.join(__dirname, "../dist/main/shared/idle-gate.js"));
    const hookJs = path.join(__dirname, "../dist/main/main/agent/hook.js");
    const hookMod = require(hookJs);
    /** A git command past its global options. */
    const gitSub = (all) => {
      let i = 0;
      for (;;) {
        if (all[i] === "-c") i += 2;
        else if (/^--(git-dir|work-tree)=/.test(all[i] ?? "")) i += 1;
        else break;
      }
      return all.slice(i);
    };

    // Not value-imported by the renderer (yet), but kept Node-free all the same;
    // the ones it does import are in the list at the top of this file.
    for (const mod of ["agent-guard.js", "agent-policy.js"]) {
      test(`${mod} compiles free of node: builtin references`, () => {
        const src = nfsA.readFileSync(path.join(__dirname, `../dist/main/shared/${mod}`), "utf8");
        const hits = src.match(/require\(["'](?:node:[^"']+|fs|path|os|crypto|child_process)["']\)|from ["']node:[^"']+["']/g) || [];
        assert.deepStrictEqual(hits, [], mod);
      });
    }

    const gpr = guard.guardPrFromUrl("https://github.com/Acme/Widgets/pull/12");
    test("agent guard: the PR a run works on is read from its URL", () => {
      assert.deepStrictEqual(gpr, { url: "https://github.com/Acme/Widgets/pull/12", repo: "acme/widgets", number: 12, host: "github.com" });
      assert.strictEqual(guard.guardPrFromUrl("https://Creatio.GHE.com/a/b/pull/3").host, "creatio.ghe.com");
      assert.strictEqual(guard.guardPrFromUrl("https://github.com/acme/widgets/issues/12"), null);
    });

    test("agent guard: reads a review needs pass", () => {
      for (const cmd of [
        "gh pr view 12 --json title,body",
        "gh pr view https://github.com/Acme/Widgets/pull/12 --json files",
        "gh pr view 12 --repo acme/widgets --json title --jq .title",
        "gh pr diff 12",
        "gh pr checks 12",
        "gh api repos/acme/widgets/pulls/12/reviews --jq '.[].state'",
        "gh api repos/Acme/Widgets/pulls/12/comments --jq '.[] | select(.user.login == \"x\") | .body'",
        "gh api /repos/acme/widgets/pulls/12/comments --paginate",
        "gh api 'repos/acme/widgets/pulls/12/files?per_page=100'",
        // A branch name with a slash: one segment, its slash written %2F — or the ref path, slashes and all.
        "gh api repos/acme/widgets/branches/integration%2Fcaadt-2.0 --jq .name",
        "gh api repos/acme/widgets/branches/release%2f2.0",
        "gh api repos/acme/widgets/git/ref/heads/integration/caadt-2.0",
        "gh pr view 12 -Racme/widgets --json title",
        "gh pr view 12 --template '{{.title}}'",
        "gh pr diff 12 --name-only",
      ]) {
        assert.deepStrictEqual(guard.checkToolUse("review", "Bash", { command: cmd }, gpr), { allow: true }, cmd);
      }
      assert.strictEqual(guard.checkToolUse("review", "Read", { file_path: "src/x.ts" }, gpr, { workDir: "C:/wt", readDirs: ["C:/wt"] }).allow, true);
      assert.strictEqual(guard.checkToolUse("review", "Skill", { skill: "x" }).allow, true);
    });

    // A review run as the app writes its guard file: the PR's worktree, the
    // payload folder, one mounted plugin, and Claude Code's folders for the session.
    const SID = "6250ec40-5c65-407c-8b04-61b1dba8fae7";
    const PLUGIN = "C:/Users/me/.claude/plugins/cache/x/creatio-development/1.7.142";
    const readRun = {
      workDir: "C:/wt",
      outDir: "C:/T/prd-agent/r/out",
      readDirs: ["C:/wt", "C:/T/prd-agent/r/out", PLUGIN],
      sessionId: SID,
      sessionRoots: ["C:/Users/me/.claude/projects", "C:/Users/me/AppData/Local/Temp/claude"],
    };

    test("agent guard: the read tools read the run's own folders — worktree, payload, plugins, the session's spill-over", () => {
      for (const [tool, input] of [
        ["Read", { file_path: "src/x.ts" }],
        ["Read", { file_path: "./src/x.ts" }],
        ["Read", { file_path: "C:\\wt\\src\\x.ts" }],
        ["Read", { file_path: "/c/wt/src/x.ts" }],
        ["Read", { file_path: "C:/WT/README.md" }],
        ["Read", { file_path: `${PLUGIN}/skills/creatio-code-review/SKILL.md` }],
        ["Read", { file_path: "C:/T/prd-agent/r/out/review.json" }],
        // A tool result too long to show, and a background Workflow's output: Claude Code tells the session to read them there.
        ["Read", { file_path: `C:\\Users\\me\\.claude\\projects\\C--wt\\${SID}\\tool-results\\b1.txt`, offset: 300, limit: 20 }],
        ["Read", { file_path: `C:/Users/me/AppData/Local/Temp/claude/C--wt/${SID.toUpperCase()}/tasks/w1.output` }],
        ["Grep", { pattern: "x" }],
        ["Grep", { pattern: "x", path: "src" }],
        ["Grep", { pattern: "x", path: "C:/wt" }],
        ["Grep", { pattern: "x", path: `C:/Users/me/.claude/projects/C--wt/${SID}/tool-results/b1.txt` }],
        ["Glob", { pattern: "**/*.ts" }],
        ["Glob", { pattern: "{CLAUDE.md,AGENTS.md,.ai/**/*.md}" }],
        ["Glob", { pattern: "src\\**\\*.ts" }],
        ["Glob", { pattern: "src/{a,{b,c}}/*.{ts,tsx}" }],
        ["Glob", { pattern: "docs/\\{literal\\}/*.md" }],
        ["Glob", { pattern: "C:\\wt\\src\\*.ts" }],
        ["Glob", { pattern: `${PLUGIN}/skills/creatio-code-review/*` }],
        ["Glob", { pattern: "*", path: "C:/T/prd-agent/r/out" }],
        ["LS", { path: "src" }],
        ["NotebookRead", { notebook_path: "C:/wt/nb/a.ipynb" }],
      ]) {
        assert.deepStrictEqual(guard.checkToolUse("review", tool, input, gpr, readRun), { allow: true }, `${tool} ${JSON.stringify(input)}`);
      }
      // The same rules for every kind of run: a drive reads what a review reads.
      assert.deepStrictEqual(guard.checkToolUse("drive", "Read", { file_path: "src/x.ts" }, gpr, readRun), { allow: true });
    });

    test("agent guard: a read outside the run's folders is refused — secrets, .. escapes, ~, another session", () => {
      for (const [tool, input] of [
        ["Read", { file_path: "C:/Users/me/.ssh/id_rsa" }],
        ["Read", { file_path: "~/.ssh/id_rsa" }],
        ["Read", { file_path: "~" }],
        ["Read", { file_path: "/home/me/.ssh/id_rsa" }],
        ["Read", { file_path: "C:/Users/me/.config/gh/hosts.yml" }],
        ["Read", { file_path: "C:/Users/me/AppData/Roaming/PR Dashboard/settings.json" }],
        ["Read", { file_path: "C:/Users/me/.claude/settings.json" }],
        ["Read", { file_path: "../../Users/me/.ssh/id_rsa" }],
        ["Read", { file_path: "src/../../Users/me/.ssh/id_rsa" }],
        ["Read", { file_path: "C:/wt/../Users/me/.ssh/id_rsa" }],
        ["Read", { file_path: "C:/wt-other/x.ts" }],
        ["Read", { file_path: "C:x.ts" }],
        ["Read", { file_path: "src/x.ts:hidden" }],
        ["Read", { file_path: "\\\\server\\share\\x" }],
        ["Read", { file_path: "//server/share/x" }],
        ["Grep", { pattern: "x", path: "\\\\?\\C:\\wt\\src" }],
        ["Glob", { pattern: "C:*" }],
        ["Glob", { pattern: "//server/share/*" }],
        // The wrapper and the run's own files sit next to the payload folder, not in it.
        ["Read", { file_path: "C:/T/prd-agent/r/bin/pr-review-publish.sh" }],
        ["Read", { file_path: `${PLUGIN}/../../other-plugin/x` }],
        // Another session's spill-over, and this session's transcript itself.
        ["Read", { file_path: "C:/Users/me/.claude/projects/C--wt/11111111-2222-3333-4444-555555555555/tool-results/b1.txt" }],
        ["Read", { file_path: `C:/Users/me/.claude/projects/C--wt/${SID}.jsonl` }],
        ["Read", { file_path: `C:/Users/me/.claude/projects/C--wt/${SID}/../../other/${SID}/x` }],
        ["Read", { file_path: `C:/Users/me/.claude/${SID}/x` }],
        ["Read", {}],
        ["Grep", { pattern: "token", path: "C:/Users/me" }],
        ["Grep", { pattern: "token", path: ".." }],
        ["Glob", { pattern: "C:/Users/me/.ssh/*" }],
        ["Glob", { pattern: "/home/me/.ssh/*" }],
        ["Glob", { pattern: "../*" }],
        ["Glob", { pattern: "src/../../*" }],
        ["Glob", { pattern: "**/../../*" }],
        // Off Windows the glob engine drops the escapes and reads `../`.
        ["Glob", { pattern: "\\.\\./*" }],
        ["Glob", { pattern: ".\\./*" }],
        ["Glob", { pattern: "src/\\.\\./\\.\\./*" }],
        ["Glob", { pattern: "{x,\\.\\./*}" }],
        // Braces join across their edges: each of these expands to a `../`.
        ["Glob", { pattern: "{.,x}./*" }],
        ["Glob", { pattern: "src/{x,.}./secret" }],
        ["Glob", { pattern: ".{.,}/*" }],
        ["Glob", { pattern: "{.}{.}/*" }],
        ["Glob", { pattern: "src/.{.,x}/.{.,y}/*" }],
        ["Glob", { pattern: "{a,.{.,b}}/*" }],
        ["Glob", { pattern: "{x,{~,y}}/.ssh/*" }],
        ["Glob", { pattern: "{x,{y,/etc/*}}" }],
        ["Glob", { pattern: `${"{a,b}".repeat(9)}/*` }],
        // What the expander doesn't model fails closed: a range by character code (`{-../}` is `-`, `.`, `/`), a single item, any `..`.
        ["Glob", { pattern: ".{-../}/*" }],
        ["Glob", { pattern: "src/{1..3}/*" }],
        ["Glob", { pattern: "{x}/*" }],
        ["Glob", { pattern: "a..b/*" }],
        ["Glob", { pattern: "{/etc/*,x}" }],
        ["Glob", { pattern: "{x,C:/Users/me/.ssh/*}" }],
        ["Glob", { pattern: "~/.ssh/*" }],
        ["Glob", { pattern: "*", path: "C:/Users/me/.claude/workflows" }],
        ["LS", { path: "C:/Users/me" }],
        ["NotebookRead", { notebook_path: "C:/Users/me/x.ipynb" }],
      ]) {
        assert.strictEqual(guard.checkToolUse("review", tool, input, gpr, readRun).allow, false, `${tool} ${JSON.stringify(input)}`);
      }
      assert.match(guard.checkToolUse("review", "Read", { file_path: "C:/Users/me/.ssh/id_rsa" }, gpr, readRun).reason, /reads only its own folders \(C:\/wt, .*\); C:\/Users\/me\/\.ssh\/id_rsa is outside them/);
      // No guard file, or one that names nothing: nothing is read.
      assert.strictEqual(guard.checkToolUse("review", "Read", { file_path: "src/x.ts" }).allow, false, "no guard file");
      assert.strictEqual(guard.checkToolUse("review", "Read", { file_path: "C:/wt/x.ts" }, gpr, { workDir: "C:/wt" }).allow, false, "no readDirs");
      assert.strictEqual(guard.checkToolUse("review", "Grep", { pattern: "x" }, gpr, { readDirs: ["C:/wt"] }).allow, false, "no working folder to search");
      assert.strictEqual(guard.checkToolUse("review", "Read", { file_path: "C:/x/y" }, gpr, { workDir: "C:/wt", readDirs: ["", "x", "C:/wt"] }).allow, false, "an empty or relative folder grants nothing");
      const { sessionId, ...noSession } = readRun;
      assert.strictEqual(guard.checkToolUse("review", "Read", { file_path: `C:/Users/me/.claude/projects/C--wt/${sessionId}/tool-results/b1.txt` }, gpr, noSession).allow, false, "no session id, no spill-over");
    });

    test("agent guard: a link is judged by where it leads, when the check is handed the disk's answer", () => {
      // What a link in the PR's branch would do: C:/wt/docs/k leads to ~/.ssh/id_rsa.
      const links = { "C:/wt/docs/k": "C:/Users/me/.ssh/id_rsa", "C:/wt/docs/dir": "C:/Users/me/.config/gh" };
      const real = (p) => {
        const g = p.replace(/\\/g, "/");
        for (const [from, to] of Object.entries(links)) if (g === from || g.startsWith(`${from}/`)) return to + g.slice(from.length);
        return g === "C:/wt/docs/dangling" ? null : g;
      };
      assert.strictEqual(guard.checkToolUse("review", "Read", { file_path: "docs/k" }, gpr, readRun, real).allow, false, "a link to a secret");
      assert.match(guard.checkToolUse("review", "Read", { file_path: "C:/wt/docs/k" }, gpr, readRun, real).reason, /it really is C:\/Users\/me\/\.ssh\/id_rsa/);
      assert.strictEqual(guard.checkToolUse("review", "Grep", { pattern: "oauth", path: "docs/dir" }, gpr, readRun, real).allow, false, "a link to a folder");
      assert.strictEqual(guard.checkToolUse("review", "Glob", { pattern: "*", path: "docs/dir" }, gpr, readRun, real).allow, false);
      assert.match(guard.checkToolUse("review", "Read", { file_path: "docs/dangling" }, gpr, readRun, real).reason, /link to nowhere/);
      assert.deepStrictEqual(guard.checkToolUse("review", "Read", { file_path: "docs/plain.md" }, gpr, readRun, real), { allow: true });
    });

    test("agent guard: a tool the guard doesn't name is refused — every tool the default lists grant is named", () => {
      for (const tool of ["Skill", "Agent", "ToolSearch", "TaskCreate", "TaskUpdate", "StructuredOutput"]) {
        assert.deepStrictEqual(guard.checkToolUse("review", tool, {}, gpr, readRun), { allow: true }, tool);
      }
      for (const tool of ["SendMessage", "ListAgents", "mcp__github__create_issue", "Monitor", "SomeToolAddedLater", ""]) {
        assert.match(guard.checkToolUse("review", tool, {}, gpr, readRun).reason, /not one of the tools agent runs may use/, tool || "(no name)");
      }
      for (const kind of Object.keys(ad.DEFAULT_AGENT_TOOLS)) {
        for (const name of runner.builtInTools(ad.DEFAULT_AGENT_TOOLS[kind])) {
          const d = guard.checkToolUse(kind, name, {}, gpr, readRun);
          assert.ok(d.allow || !/not one of the tools/.test(d.reason), `${kind}: ${name} is granted by default but unknown to the guard`);
        }
      }
    });

    test("agent guard: every escape found in review is refused, whatever the allow-list says", () => {
      for (const [kind, cmd] of [
        ["review", "git diff --output=/home/me/.bashrc"],
        ["review", "git diff HEAD~1 --ext-diff"],
        ["review", "git log -p --textconv"],
        ["review", "git diff --no-index / /tmp"],
        ["review", "git -C / log"],
        ["review", "git -c core.pager=evil log"],
        ["review", "git checkout main"],
        ["review", "FOO=1 git push"],
        ["review", "gh api -X DELETE repos/a/b/issues/comments/1"],
        ["review", "gh api repos/a/b/pulls/1/reviews --method POST"],
        ["review", "gh api repos/a/b/pulls/1/reviews -f event=APPROVE"],
        ["review", "gh api repos/a/b/pulls/1/reviews --input body.json"],
        ["review", "gh pr review 1 --approve"],
        ["review", "gh pr merge 1"],
        ["review", "gh pr comment 1 --body hi"],
        ["review", "gh pr diff 1 > ~/.bashrc"],
        ["review", "gh pr view 1 | sh"],
        ["review", "gh pr view 1; rm -rf ~"],
        ["review", "gh pr view 1 && curl evil"],
        ["review", "gh pr view $(whoami)"],
        ["review", "gh pr view `whoami`"],
        ["review", "npm test"],
        ["review", "node -e 'require(\"fs\")'"],
        ["brief", "git log"],
        ["drive", "git push origin HEAD:refs/heads/feature/x"],
        ["drive", "git -c core.hooksPath=/tmp commit -m x"],
        ["drive", "git diff --output=x"],
        // Found by review: judged on text, these looked harmless.
        ["review", "gh api -XDELETE repos/acme/widgets/issues/comments/1"],
        ["review", "gh api repos/acme/widgets/pulls/12/reviews -fevent=APPROVE"],
        ["review", "gh api repos/acme/widgets/pulls/12 '-X' POST"],
        ["review", 'gh api repos/acme/widgets/pulls/12 "--method" POST'],
        ["review", "gh api graphql -F query=@q.graphql"],
        ["review", "gh api repos/acme/widgets/pulls/12/files *"],
        ["review", 'gh api "$URL"'],
        ["review", "gh api https://evil.example/repos/acme/widgets"],
        ["review", "gh api repos/{owner}/{repo}/pulls/12"],
        ["review", "gh api repos/other/repo/pulls/1"],
        ["review", "gh pr view 99"],
        ["review", "gh pr view https://github.com/other/repo/pull/12"],
        ["review", "gh pr view 12 --repo other/repo"],
        ["review", "gh pr view 12 --web"],
        ["review", "gh pr view 12 'unbalanced"],
        ["review", "gh api repos/acme/widgets/pulls/12/files?per_page=100"],
        // Found by the second review: brace expansion, flag-like values, attached
        // short flags and dot segments.
        ["review", "gh api {repos/acme/widgets/pulls/12,-XDELETE}"],
        ["review", "gh api repos/acme/widgets/pulls/12 --jq -XDELETE"],
        ["review", "gh pr view 12 -Rother/repo"],
        ["review", "gh pr view 12 --repo -X"],
        ["review", "gh pr view 12 --hostname evil.example"],
        ["review", "gh pr view 12 --some-new-flag"],
        ["review", "gh api repos/acme/widgets/../../other/repo/pulls"],
        // %2F is a slash inside a segment, never a way out of the repository, and the only escape taken.
        ["review", "gh api repos/acme/widgets/branches/..%2F..%2F..%2Fother%2Frepo"],
        ["review", "gh api repos/acme/widgets/x/..%2f..%2f..%2fother/repo/pulls"],
        ["review", "gh api repos/acme%2Fwidgets/pulls/12"],
        ["review", "gh api repos/acme/widgets%2F..%2F..%2Fother/repo/pulls"],
        ["review", "gh api repos/acme/widgets/%2E%2E/%2E%2E/other/repo/pulls"],
        ["review", "gh api repos/acme/widgets/branches/a%252Fb"],
        ["review", "gh api repos/other/repo/branches/a%2Fb"],
        ["review", "gh pr view 12 ~"],
        ["review", "gh pr view 12 #--repo other/repo"],
        ["drive", "git diff '--output'=x"],
        ["drive", "git '-c' core.pager=x log"],
        ["drive", "git lg"],
      ]) {
        assert.strictEqual(guard.checkToolUse(kind, "Bash", { command: cmd }, gpr).allow, false, `${kind}: ${cmd}`);
      }
      for (const tool of ["Edit", "Write", "NotebookEdit"]) assert.strictEqual(guard.checkToolUse("review", tool, {}).allow, false, tool);
      for (const tool of ["WebFetch", "WebSearch", "PowerShell"]) assert.strictEqual(guard.checkToolUse("drive", tool, {}).allow, false, tool);
      assert.strictEqual(guard.checkToolUse("review", "Bash", {}).allow, false, "an empty command");
    });

    // A drive's folders as the app writes them into its guard file.
    const driveRun = { workDir: "C:/wt", outDir: "C:/T/prd-agent/r/out", readDirs: ["C:/wt", "C:/T/prd-agent/r/out"] };

    test("agent guard: a git flag reads only a file the Read tool may read — not ~/.ssh into a commit", () => {
      const key = "C:/Users/me/.ssh/id_rsa";
      for (const cmd of [
        `git commit -F ${key}`,
        `git commit --file=${key}`,
        `git commit --file ${key}`,
        `git commit -F${key}`,
        `git commit -aF ${key}`,
        `git commit -aF${key}`,
        `git commit -t ${key}`,
        `git commit --template=${key}`,
        `git commit '--file'=${key}`,
        `git commit --amend -F "${key}"`,
        // git expands an unambiguous prefix of a long option.
        `git commit --fil=${key}`,
        `git commit --templ=${key}`,
        `git merge origin/main -F ${key}`,
        `git merge --file=${key} origin/main`,
        `git blame --contents ${key} src/x.ts`,
        `git blame --cont=${key} src/x.ts`,
        `git blame -S ${key} src/x.ts`,
        `git blame -wS ${key} src/x.ts`,
        `git blame --ignore-revs-file=${key} src/x.ts`,
        `git add --pathspec-from-file=${key}`,
        `git restore --pathspec-from-file=${key}`,
        `git rm --pathspec-from-file ${key}`,
        `git stash push --pathspec-from-file=${key}`,
        `git diff -O${key}`,
        `git log -p -O ${key}`,
        `git show -pO${key}`,
        `git ls-files --exclude-from=${key}`,
        `git ls-files -X ${key}`,
        "git commit -F /home/me/.config/gh/hosts.yml",
        // Out of the folders by name, or not judged at all.
        "git commit -F C:/wt/../Users/me/.ssh/id_rsa",
        "git commit -F '~/.ssh/id_rsa'",
        "git commit -F msg.txt",
        "git commit -F -",
        "git commit -F",
        "git commit --file",
        // The older flags are matched by their abbreviations too.
        "git diff --outp=C:/wt/x",
        "git log --ext-dif",
      ]) {
        assert.strictEqual(guard.checkToolUse("drive", "Bash", { command: cmd }, gpr, driveRun).allow, false, cmd);
      }
      assert.match(guard.checkToolUse("drive", "Bash", { command: `git commit -F ${key}` }, gpr, driveRun).reason, /would read .*outside them/);
      assert.match(guard.checkToolUse("drive", "Bash", { command: "git commit -F msg.txt" }, gpr, driveRun).reason, /absolute path/);
      assert.strictEqual(guard.checkToolUse("drive", "Bash", { command: "git commit -F C:/T/prd-agent/r/out/msg.txt" }, gpr, null).allow, false, "no guard file, no folders to read");
      // A link in the worktree is judged by where it leads, as a Read is.
      const real = (p) => (p === "C:/wt/notes.txt" ? key : p);
      assert.strictEqual(guard.checkToolUse("drive", "Bash", { command: "git commit -F C:/wt/notes.txt" }, gpr, driveRun, real).allow, false, "a link out of the worktree");
    });

    test("agent guard: a drive commits with a message file in its own folders, as real runs do", () => {
      for (const cmd of [
        // Taken from real drive runs: the message is written into the payload folder.
        'git commit -F "C:/T/prd-agent/r/out/msg1.txt"',
        'git commit --amend -F "C:/T/prd-agent/r/out/msg1.txt"',
        "git commit -FC:/T/prd-agent/r/out/msg2.txt",
        "git commit -aF C:/T/prd-agent/r/out/msg3.txt",
        "git commit --file=C:/T/prd-agent/r/out/msg.txt",
        "git commit -t C:/wt/.gitmessage",
        "git blame --contents C:/wt/src/x.ts src/x.ts",
        "git add --pathspec-from-file=C:/T/prd-agent/r/out/paths.txt",
        "git diff -O C:/wt/order.txt",
      ]) {
        assert.deepStrictEqual(guard.checkToolUse("drive", "Bash", { command: cmd }, gpr, driveRun), { allow: true }, cmd);
      }
    });

    test("agent guard: drive's everyday git keeps working next to the file-reading flags", () => {
      for (const cmd of [
        "git commit -m fix",
        "git commit -mFix",
        "git commit -am 'Fix the build'",
        "git commit -sm 'Fix the build'",
        "git commit --amend --no-edit",
        "git commit --fixup=HEAD",
        "git commit -C HEAD",
        "git add -A",
        "git add -- src/x.ts",
        "git add --pathspec-file-nul src/x.ts",
        "git merge origin/main -m 'Merge the base'",
        "git merge --continue",
        "git merge --no-ff -X theirs origin/main",
        "git log -3",
        "git log --oneline -20",
        "git log -SFoo -p",
        "git log -F --grep=fix",
        "git log --exclude='refs/stash' --all",
        "git diff -U5 --stat",
        "git diff --text src/x.ts",
        "git diff --no-ext-diff --no-textconv",
        "git show -M50% HEAD",
        "git blame -L 1,5 src/x.ts",
        "git blame --ignore-rev abc123 src/x.ts",
        "git ls-files -x '*.log' --others",
        "git stash show -p",
        "git branch -t topic origin/main",
      ]) {
        assert.deepStrictEqual(guard.checkToolUse("drive", "Bash", { command: cmd }, gpr), { allow: true }, cmd);
      }
    });

    test("agent guard: a refused gh api read says what to change — not \"another repository\" for this one", () => {
      const why = (cmd) => guard.checkToolUse("drive", "Bash", { command: cmd }, gpr).reason;
      assert.match(why("gh api repos/acme/widgets/branches/a%2Eb"), /takes letters, digits, '\.', '_', '-' and %2F/, "this PR's repository, an escape it doesn't take");
      assert.match(why("gh api repos/other/repo/branches/a%2Eb"), /Only GitHub REST reads of this PR's repository/);
      assert.match(why("gh api repos/other/repo/pulls/1"), /reads acme\/widgets only/);
      assert.match(why("gh api repos/acme/widgets/branches/..%2Fx"), /Dot segments/);
      assert.match(why("gh api repos/acme/widgets/contents?ref=release"), /Quote the word/, "a query string is a wildcard to the shell");
      assert.strictEqual(guard.checkToolUse("drive", "Bash", { command: "gh api 'repos/acme/widgets/contents?ref=release'" }, gpr).allow, true, "quoted, it reads");
    });

    test("agent guard: drive may build, test and commit on its own PR", () => {
      for (const cmd of ["npm test", "npm run typecheck", "git status", "git add src/x.ts", "git commit -m fix", "git log -3"]) {
        assert.strictEqual(guard.checkToolUse("drive", "Bash", { command: cmd }).allow, true, cmd);
      }
      const run = { workDir: "C:/wt", outDir: "C:/T/prd-agent/r/out", wrapperPath: "C:/T/prd-agent/r/bin/pr-review-publish.sh", subs: ["reply"] };
      assert.strictEqual(guard.checkToolUse("drive", "Edit", { file_path: "C:\\wt\\src\\x.ts" }, null, run).allow, true, "its own worktree");
      assert.strictEqual(guard.checkToolUse("drive", "Write", { file_path: "C:/T/prd-agent/r/out/reply.txt" }, null, run).allow, true, "a reply file for its wrapper");
      assert.strictEqual(guard.checkToolUse("drive", "Edit", { file_path: "x" }).allow, false, "no guard file, no edits");
      for (const file of ["C:/elsewhere/a.ts", "C:/wt/.git/hooks/pre-push", "C:/wt/.github/workflows/ci.yml", "C:/wt/.claude/settings.json", "C:/wt/.husky/pre-commit", "C:/wt/.npmrc", "C:/wt/sub/.gitattributes"]) {
        assert.strictEqual(guard.checkToolUse("drive", "Edit", { file_path: file }, null, run).allow, false, file);
      }
      assert.strictEqual(guard.checkToolUse("drive", "Bash", { command: "git rebase origin/main" }).allow, false, "a rebase is never a fast-forward");
      assert.strictEqual(guard.checkToolUse("drive", "Bash", { command: "git fetch origin main" }).allow, false, "the app fetches the base; the session's git has no network");
      for (const file of ["C:/wt/lefthook.yml", "C:/wt/.pre-commit-config.yaml", "C:/wt/.huskyrc.json"]) {
        assert.strictEqual(guard.checkToolUse("drive", "Edit", { file_path: file }, null, run).allow, false, file);
      }
      const w = "/c/T/prd-agent/r/bin/pr-review-publish.sh";
      assert.strictEqual(guard.checkBash("drive", `${w} reply acme/widgets 12 77 C:/T/prd-agent/r/out/reply.txt`, gpr, run).allow, true);
      assert.match(guard.checkBash("drive", `${w} resolve PRRT_x`, gpr, run).reason, /may not resolve/);
      assert.match(guard.checkBash("drive", `${w} review acme/widgets 12 C:/T/prd-agent/r/out/r.json`, gpr, run).reason, /may not review/);
    });

    test("agent defaults: reads carry no git rule (its output and exec flags write and run)", () => {
      for (const kind of ["review", "brief", "rereview", "afterMerge"]) {
        for (const rule of ad.DEFAULT_AGENT_TOOLS[kind]) assert.ok(!/git /.test(rule) && !/Edit|Write/.test(rule), `${kind}: ${rule}`);
      }
    });

    test("agent guard: shell words — quotes, escapes, and what the shell would do instead of running one program", () => {
      assert.deepStrictEqual(guard.shellWords(`gh api 'a b' "c \\"d\\"" e\\ f`), { words: ["gh", "api", "a b", 'c "d"', "e f"] });
      assert.deepStrictEqual(guard.shellWords("x '.[] | .a; $b'"), { words: ["x", ".[] | .a; $b"] }, "single quotes are literal");
      for (const cmd of ["a | b", "a > f", "a; b", "a && b", "a $(b)", "a `b`", 'a "$HOME"', "a $HOME", "a *", "a ?", "a [x]", "a\nb", "a 'b", 'a "b', "a \\"]) {
        assert.ok("error" in guard.shellWords(cmd), cmd);
      }
    });

    test("agent guard hook: a refused call exits 2 with the reason, an allowed one exits 0", () => {
      const url = "https://github.com/acme/widgets/pull/1";
      const run = (kind, call, prUrl = url) => spawnSync(process.execPath, [hookJs, kind, prUrl], { input: JSON.stringify(call), encoding: "utf8" });
      const bad = run("review", { tool_name: "Bash", tool_input: { command: "gh pr diff 1 > x" } });
      assert.strictEqual(bad.status, 2);
      assert.match(bad.stderr, /Shell operators/);
      assert.strictEqual(run("review", { tool_name: "Bash", tool_input: { command: "gh pr view 1" } }).status, 0);
      assert.strictEqual(run("review", { tool_name: "Bash", tool_input: { command: "gh pr view 2" } }).status, 2, "another PR");
      assert.strictEqual(run("nonsense", { tool_name: "Read", tool_input: {} }).status, 2, "an unknown kind refuses everything");
      assert.strictEqual(run("review", { tool_name: "Read", tool_input: {} }, "not a pr url").status, 2, "an unreadable PR refuses everything");
      assert.strictEqual(spawnSync(process.execPath, [hookJs, "review", url], { input: "not json", encoding: "utf8" }).status, 2);
    });

    const agentOn = (extra = {}) => cfg.validateAgent({ enabled: true, ...extra });
    const reviewPr = (over = {}) => ({
      ...github.mapPr(
        rawPr({
          id: over.id ?? "PR_R",
          number: over.number ?? 7,
          url: "https://github.com/a/b/pull/7",
          additions: over.additions ?? 50,
          deletions: 10,
          changedFiles: over.changedFiles ?? 3,
          createdAt: over.createdAt ?? "2026-07-07T00:00:00Z",
          commits: { nodes: [{ commit: { oid: over.headOid ?? "aaa111", pushedDate: "2026-07-07T00:00:00Z", committedDate: "2026-07-07T00:00:00Z", statusCheckRollup: null } }] },
        }),
        "GH",
        [over.role ?? "reviewer"],
        "me",
      ),
      requestedOfMe: over.requestedOfMe ?? true,
      viewerHasReviewed: over.viewerHasReviewed ?? false,
      isDraft: over.isDraft ?? false,
      isIgnored: over.isIgnored ?? false,
    });
    const noSessions = { hasOwnSession: () => false };

    test("agent policy: off plans nothing and says so", () => {
      const r = policy.planJobs([reviewPr()], cfg.validateAgent(undefined), noSessions);
      assert.deepStrictEqual(r.jobs, []);
      assert.strictEqual(r.idle.get("PR_R"), "The agent is off");
    });

    test("agent policy: a review asked of you, within the limit, is a shadow review keyed on the head", () => {
      const r = policy.planJobs([reviewPr()], agentOn(), noSessions);
      assert.strictEqual(r.jobs.length, 1);
      assert.deepStrictEqual(
        [r.jobs[0].scenario, r.jobs[0].kind, r.jobs[0].mode, r.jobs[0].key],
        ["review", "review", "shadow", "PR_R|review|aaa111"],
      );
      assert.notStrictEqual(policy.jobKey({ id: "PR_R", headOid: "bbb222" }, "review"), r.jobs[0].key, "a new head is a new key");
    });

    test("agent policy: over the limit is a brief first — it never posts — and then the review, on its own", () => {
      const r = policy.planJobs([reviewPr({ additions: 900 }), reviewPr({ id: "PR_F", changedFiles: 40 })], agentOn(), noSessions);
      assert.deepStrictEqual(r.jobs.map((j) => [j.scenario, j.mode]), [["brief", "on"], ["brief", "on"]]);
      // The brief of this head is written: the review follows — no click in between.
      const briefed = { ...noSessions, briefDone: (pr) => pr.id === "PR_R" };
      const next = policy.planJobs([reviewPr({ additions: 900 }), reviewPr({ id: "PR_F", changedFiles: 40 })], agentOn(), briefed);
      assert.deepStrictEqual(next.jobs.map((j) => [j.prId, j.scenario, j.mode, j.key]), [["PR_R", "review", "shadow", "PR_R|review|aaa111"], ["PR_F", "brief", "on", "PR_F|brief|aaa111"]]);
      assert.strictEqual(policy.planJobs([reviewPr({ additions: 900 })], agentOn({ scenarios: { review: { mode: "on" } } }), briefed).jobs[0].mode, "on", "the review in its own mode");
      // Briefs off: a big PR goes straight to the review.
      const noBrief = policy.planJobs([reviewPr({ additions: 900 })], agentOn({ scenarios: { brief: { mode: "off" } } }), noSessions);
      assert.deepStrictEqual(noBrief.jobs.map((j) => j.scenario), ["review"]);
      // Reviews off: the brief is all a big PR gets.
      const reviewsOff = agentOn({ scenarios: { review: { mode: "off" } } });
      assert.deepStrictEqual(policy.planJobs([reviewPr({ additions: 900 })], reviewsOff, noSessions).jobs.map((j) => j.scenario), ["brief"]);
      const done = policy.planJobs([reviewPr({ additions: 900 })], reviewsOff, briefed);
      assert.deepStrictEqual(done.jobs, []);
      assert.strictEqual(done.idle.get("PR_R"), "Reviews are off — a big PR gets its brief only");
      const both = policy.planJobs([reviewPr({ additions: 900 })], agentOn({ scenarios: { review: { mode: "off" }, brief: { mode: "off" } } }), noSessions);
      assert.deepStrictEqual([both.jobs, both.idle.get("PR_R")], [[], "Reviews are off"]);
    });

    test("agent policy: team requests, drafts, ignored, reviewed, your own session and other repos are left alone", () => {
      const cases = [
        [reviewPr({ requestedOfMe: false }), /team/],
        [reviewPr({ isDraft: true }), /Draft/],
        [reviewPr({ isIgnored: true }), /Ignored/],
        [reviewPr({ viewerHasReviewed: true, role: "reviewed", requestedOfMe: false }), /nothing new from the author/],
        [reviewPr({ role: "author", isDraft: true }), /Yours — draft/],
      ];
      for (const [pr, why] of cases) {
        const r = policy.planJobs([pr], agentOn(), noSessions);
        assert.deepStrictEqual(r.jobs, [], String(why));
        assert.match(r.idle.get(pr.id), why);
      }
      assert.match(policy.planJobs([reviewPr()], agentOn(), { hasOwnSession: () => true }).idle.get("PR_R"), /Your Claude session/);
      assert.match(policy.planJobs([reviewPr()], agentOn({ repos: ["x/y"] }), noSessions).idle.get("PR_R"), /repositories/);
      assert.strictEqual(policy.planJobs([reviewPr({ requestedOfMe: false })], agentOn({ scenarios: { review: { teamRequests: true } } }), noSessions).jobs.length, 1);
      assert.strictEqual(policy.planJobs([reviewPr({ isDraft: true })], agentOn({ scenarios: { review: { drafts: true } } }), noSessions).jobs.length, 1);
    });

    test("agent policy: the queue runs oldest first", () => {
      const r = policy.planJobs(
        [reviewPr({ id: "NEW", createdAt: "2026-07-09T00:00:00Z" }), reviewPr({ id: "OLD", createdAt: "2026-07-01T00:00:00Z" })],
        agentOn(),
        noSessions,
      );
      assert.deepStrictEqual(r.jobs.map((j) => j.prId), ["OLD", "NEW"]);
    });

    // Events recorded from a real `claude -p` session (2.1.270), trimmed.
    const recorded = [
      { type: "system", subtype: "init", session_id: "s-1", tools: ["Read"] },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1793899800 } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: { query: "select:TaskCreate" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "TaskCreate", input: { subject: "alpha", description: "First" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "Task #1 created successfully: alpha" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "TaskCreate", input: { subject: "beta" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: [{ type: "text", text: "Task #2 created successfully: beta" }] }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t4", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t5", name: "Bash", input: { command: "gh pr diff 7" } }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Reviewing the diff." }] } },
    ];
    test("agent stream: the plan comes from TaskCreate/TaskUpdate, the live line from the last real tool", () => {
      let p = stream.initialProgress();
      for (const ev of recorded) p = stream.applyStreamEvent(p, ev);
      assert.strictEqual(p.sessionId, "s-1");
      assert.deepStrictEqual(p.steps, [
        { id: "1", subject: "alpha", status: "in_progress" },
        { id: "2", subject: "beta", status: "pending" },
      ]);
      assert.strictEqual(p.activity, "$ gh pr diff 7", "ToolSearch and the plan tools are not the live line");
      assert.strictEqual(p.lastText, "Reviewing the diff.");
      assert.deepStrictEqual(p.rateLimit, { status: "allowed", resetsAt: 1793899800 });
      assert.strictEqual(stream.currentStep(p).subject, "alpha");
      assert.strictEqual(p.result, null);
      p = stream.applyStreamEvent(p, { type: "result", subtype: "success", is_error: false, result: "LGTM", permission_denials: [{}, {}] });
      assert.deepStrictEqual(p.result, { subtype: "success", isError: false, text: "LGTM", denials: 2 });
    });
    test("agent stream: a result carries Claude's turns, cost, time, tokens and the refused tools by name", () => {
      const p = stream.applyStreamEvent(stream.initialProgress(), {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        num_turns: 12,
        total_cost_usd: 0.4321,
        duration_ms: 95000,
        usage: { input_tokens: 10, output_tokens: 2000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 3000 },
        permission_denials: [{ tool_name: "Bash", tool_use_id: "a" }, { tool_name: "Bash", tool_use_id: "b" }, { tool_name: "Edit", tool_use_id: "c" }],
      });
      assert.deepStrictEqual(p.result, {
        subtype: "success",
        isError: false,
        text: "ok",
        denials: 3,
        deniedTools: ["Bash", "Edit"],
        turns: 12,
        costUsd: 0.4321,
        durationMs: 95000,
        tokens: { input: 10, output: 2000, cacheRead: 50000, cacheWrite: 3000 },
      });
    });
    test("agent stream: junk lines and unknown events change nothing; TodoWrite still reads", () => {
      assert.strictEqual(stream.parseStreamLine("not json"), null);
      assert.strictEqual(stream.parseStreamLine("{broken"), null);
      const p0 = stream.initialProgress();
      assert.strictEqual(stream.applyStreamEvent(p0, { type: "control_response" }), p0);
      const p = stream.applyStreamEvent(p0, {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "x", name: "TodoWrite", input: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] } }] },
      });
      assert.deepStrictEqual(p.steps.map((s) => `${s.subject}:${s.status}`), ["a:completed", "b:pending"]);
    });

    test("agent plugins: a bare skill one plugin owns is qualified; others stay as written", () => {
      const cat = [
        { name: "creatio-development", installPath: "/p/cd", skills: ["creatio-code-review", "code-delivery", "validate-and-fix-review-comments"] },
        { name: "other", installPath: "/p/o", skills: ["code-delivery-x", "shared"] },
        { name: "third", installPath: "/p/t", skills: ["shared"] },
      ];
      const r = plugins.resolveSkillRefs("/creatio-code-review https://x/pull/1", cat);
      assert.deepStrictEqual(r, { prompt: "/creatio-development:creatio-code-review https://x/pull/1", pluginDirs: ["/p/cd"] });
      const q = plugins.resolveSkillRefs("/creatio-development:code-delivery fix it, check with /validate-and-fix-review-comments", cat);
      assert.strictEqual(q.prompt, "/creatio-development:code-delivery fix it, check with /creatio-development:validate-and-fix-review-comments");
      assert.deepStrictEqual(q.pluginDirs, ["/p/cd"]);
      assert.strictEqual(plugins.resolveSkillRefs("/shared x", cat).prompt, "/shared x", "two owners: left as written");
      assert.deepStrictEqual(plugins.resolveSkillRefs("see https://x/y/z and /nope", cat), { prompt: "see https://x/y/z and /nope", pluginDirs: [] });
    });
    test("agent plugins: read from Claude Code's registry, skills from each install", () => {
      const dir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-plugins-"));
      const inst = path.join(dir, "cache", "cd", "1.0");
      nfsA.mkdirSync(path.join(inst, "skills", "creatio-code-review"), { recursive: true });
      nfsA.mkdirSync(path.join(dir, "plugins"), { recursive: true });
      nfsA.writeFileSync(
        path.join(dir, "plugins", "installed_plugins.json"),
        JSON.stringify({ version: 2, plugins: { "creatio-development@creatio-engineering": [{ scope: "user", installPath: inst }], "bad@x": "nope" } }),
      );
      assert.deepStrictEqual(plugins.readInstalledPlugins(dir), [{ name: "creatio-development", installPath: inst, skills: ["creatio-code-review"] }]);
      assert.deepStrictEqual(plugins.readInstalledPlugins(path.join(dir, "missing")), []);
    });

    const spec = (over = {}) => ({
      cwd: "/wt",
      sessionId: "11111111-1111-4111-8111-111111111111",
      kind: "review",
      prompt: "/x https://x/pull/1",
      appendSystemPrompt: "rules",
      allowedTools: ["Read", "Bash(gh pr view *)", "mcp__jira__get", "TaskCreate"],
      pluginDirs: ["/p/cd"],
      model: "",
      effort: "low",
      settingsFile: "/s/settings.json",
      timeoutMs: 60_000,
      ...over,
    });
    test("agent runner: the isolation flags are always there, and --allowedTools comes last", () => {
      const a = runner.buildClaudeArgs(spec());
      for (const flag of ["-p", "--verbose", "--restricted", "--strict-mcp-config"]) assert.ok(a.includes(flag), flag);
      const at = (f) => a[a.indexOf(f) + 1];
      assert.strictEqual(at("--input-format"), "stream-json");
      assert.strictEqual(at("--output-format"), "stream-json");
      assert.strictEqual(at("--permission-prompts"), "none");
      assert.strictEqual(at("--settings"), "/s/settings.json");
      assert.strictEqual(at("--plugin-dir"), "/p/cd");
      assert.strictEqual(at("--tools"), "Read,Bash,TaskCreate", "MCP tools aren't built-in tools");
      assert.ok(!a.includes("--model"), "no model flag means Claude Code's default");
      assert.deepStrictEqual(a.slice(a.indexOf("--allowedTools")), ["--allowedTools", "Read", "Bash(gh pr view *)", "mcp__jira__get", "TaskCreate"]);
      assert.strictEqual(
        runner.hookCommand("C:\\App\\PR Dashboard.exe", "C:\\App\\hook.js", "review", "https://github.com/a/b/pull/7"),
        '"C:/App/PR Dashboard.exe" "C:/App/hook.js" review "https://github.com/a/b/pull/7"',
      );
    });

    const fakeChild = () => {
      const c = new EventEmitter();
      c.stdin = new PassThrough();
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.written = "";
      c.stdin.on("data", (d) => (c.written += d.toString()));
      c.ended = false;
      c.stdin.on("finish", () => (c.ended = true));
      c.kill = () => setImmediate(() => c.emit("exit", null));
      return c;
    };
    const emit = (c, ev) => c.stdout.write(`${JSON.stringify(ev)}\n`);
    const tickOnce = () => new Promise((r) => setImmediate(r));

    await atest("agent runner: the prompt goes in first, stdin closes after a finished turn, not after an interrupt", async () => {
      const c = fakeChild();
      let env = null;
      const h = runner.startRun(spec(), () => {}, (_a, _cwd, e) => ((env = e), c));
      await tickOnce();
      assert.match(c.written, /"type":"user"[\s\S]*https:\/\/x\/pull\/1/);
      assert.strictEqual(env.ELECTRON_RUN_AS_NODE, "1");
      assert.ok(!Object.keys(env).some((k) => k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")), "launcherEnv scrubs the parent session");
      h.interrupt();
      await tickOnce();
      assert.match(c.written, /"subtype":"interrupt"/);
      emit(c, { type: "result", subtype: "error_during_execution", is_error: true });
      await tickOnce();
      assert.strictEqual(c.ended, false, "an interrupted turn keeps the session");
      h.hint("check the migration");
      await tickOnce();
      assert.match(c.written, /check the migration/);
      emit(c, { type: "result", subtype: "success", is_error: false, result: "done" });
      await tickOnce();
      assert.strictEqual(c.ended, true);
      c.emit("exit", 0);
      const out = await h.done;
      assert.deepStrictEqual([out.exitCode, out.timedOut, out.progress.result.text], [0, false, "done"]);
    });

    await atest("agent runner: past its time a run is killed and says so", async () => {
      const c = fakeChild();
      const h = runner.startRun(spec({ timeoutMs: 20 }), () => {}, () => c);
      const out = await h.done;
      assert.strictEqual(out.timedOut, true);
    });

    test("agent worktrees: the PR's remote is found by URL; the head is fetched by pull ref and checked out detached", () => {
      const cfgText = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:a/b.git\n[remote "origin"]\n\turl = https://github.com/me/b.git\n[branch "main"]\n\tremote = origin\n';
      assert.deepStrictEqual(wt.parseRemotes(cfgText), [
        { name: "upstream", url: "git@github.com:a/b.git" },
        { name: "origin", url: "https://github.com/me/b.git" },
      ]);
      const dir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-wt-"));
      nfsA.mkdirSync(path.join(dir, ".git"));
      nfsA.writeFileSync(path.join(dir, ".git", "config"), cfgText);
      assert.strictEqual(wt.remoteFor(dir, { url: "https://github.com/a/b/pull/7", repo: "a/b" }), "upstream");
      assert.strictEqual(wt.remoteFor(dir, { url: "https://github.com/x/y/pull/7", repo: "x/y" }), null);
      const target = wt.worktreeDir("/base", { repo: "a/b", number: 7, headOid: "abcdef0123456789" });
      assert.strictEqual(path.basename(target), "agent-b-7-abcdef0123");
      assert.strictEqual(
        path.basename(wt.worktreeDir("/base", { repo: "a/b", number: 7, headOid: "abcdef0123456789" }, "1a2b3c4d-5e6f-4000-8000-000000000000")),
        "agent-b-7-abcdef0123-1a2b3c4d",
        "each run its own folder: a second run on the same head never touches the first one's",
      );
      const cmds = wt.prepareCommands("upstream", { number: 7, headOid: "abcdef0123456789" }, target, "/nohooks");
      assert.deepStrictEqual(cmds.map(gitSub), [
        ["fetch", "--no-tags", "upstream", "pull/7/head"],
        ["worktree", "add", "--detach", "--force", target, "abcdef0123456789"],
      ]);
      for (const c of cmds) {
        // worktree add runs post-checkout from the new worktree: hooks of the PR's own, with a relative hooksPath.
        assert.ok(c.join(" ").includes("-c core.hooksPath=/nohooks"), c.join(" "));
        assert.ok(c.join(" ").includes("-c core.fsmonitor=false"), c.join(" "));
      }
      assert.throws(() => wt.prepareCommands("o", { number: 7, headOid: null }, target, "/nohooks"));
      assert.strictEqual(wt.worktreeBase("", "/co"), path.join("/co", ".claude", "worktrees"));
      assert.strictEqual(wt.worktreeBase(" /mine ", "/co"), "/mine");
    });

    test("agent store: atomic writes, a broken file starts empty, the log keeps only its retention", () => {
      const dir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-store-"));
      const file = path.join(dir, "state.json");
      nfsA.writeFileSync(file, "{ broken");
      assert.deepStrictEqual(agentStore.readStore(file, "2026-11-05"), agentStore.emptyStore("2026-11-05"));
      agentStore.writeFileAtomic(file, JSON.stringify({ ...agentStore.emptyStore("2026-11-05"), runsToday: 3 }));
      assert.strictEqual(agentStore.readStore(file, "x").runsToday, 3);
      assert.deepStrictEqual(nfsA.readdirSync(dir), ["state.json"], "no temp file left behind");
      const old = JSON.stringify({ at: "2026-01-01T00:00:00Z" });
      const recent = JSON.stringify({ at: "2026-11-04T00:00:00Z" });
      assert.strictEqual(agentStore.pruneLog(`${old}\n${recent}\nnot json\n`, Date.parse("2026-10-01T00:00:00Z")), `${recent}\n`);
    });

    test("agent rules: shadow and briefs tell the session to post nothing and to keep a plan", () => {
      for (const [scenario, mode] of [["review", "shadow"], ["review", "on"], ["brief", "on"]]) {
        const r = agentCore.agentRules(scenario, mode);
        assert.match(r, /TaskCreate/);
        assert.match(r, /[Pp]ost (NOTHING|nothing)/, `${scenario}/${mode}`);
        assert.match(r, /Never push/);
      }
    });

    test("agent: a host whose fetch failed or whose budget is nearly spent is held", () => {
      const snap = { pullRequests: [], errors: [{ hostLabel: "A", message: "x" }], rateLimits: [{ hostLabel: "B", remaining: 10, limit: 5000, cost: 1, resetAt: "" }, { hostLabel: "C", remaining: 4000, limit: 5000, cost: 1, resetAt: "" }] };
      assert.strictEqual(agentCore.hostHeld(snap, "A"), "Host unreachable");
      assert.strictEqual(agentCore.hostHeld(snap, "B"), "Waiting for the GitHub budget");
      assert.strictEqual(agentCore.hostHeld(snap, "C"), null);
    });

    test("idle gate: a hidden window keeps polling while the agent is on", () => {
      const base = { systemSuspended: false, hasWindow: true, windowHidden: true, systemIdleSeconds: () => 0, notificationsActionable: () => false };
      assert.deepStrictEqual(idleGate.planPolling(base), { mode: "park" });
      assert.strictEqual(idleGate.planPolling({ ...base, agentActive: () => true }).mode, "run");
      assert.deepStrictEqual(idleGate.planPolling({ ...base, systemSuspended: true, agentActive: () => true }), { mode: "park" }, "asleep still parks");
    });

    const until = async (cond, ms = 3000) => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const agentFixture = ({ checkout = true, script, pr = reviewPr(), enabled = true, openResume, agent: agentOver = {}, captureScript, fetchPr, gh, notify, git: gitImpl, home, onChange, tickMs = 1e9, sessions = [], checkMermaid, now } = {}) => {
      // `home`: the folder of an earlier fixture — the same app started again.
      const dir = home ?? nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-agent-"));
      const co = path.join(dir, "checkout");
      nfsA.mkdirSync(path.join(co, ".git"), { recursive: true });
      nfsA.writeFileSync(path.join(co, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/a/b.git\n');
      const snapshot = { pullRequests: [pr], errors: [], rateLimits: [], fetchedAt: "", version: "" };
      // The commands as git reads them past the app's global options (-c …,
      // --git-dir, --work-tree) — and as they were passed, options and all.
      const gitCalls = [];
      const rawGitCalls = [];
      const children = [];
      // Diagrams and re-approve off unless a test asks: both call gh of their own.
      const quiet = (over) => ({ diagrams: { enabled: false }, ...over, scenarios: { reapprove: { mode: "off", askReviewers: true }, ...(over.scenarios ?? {}) } });
      let settings = cfg.validateSettings({ hosts: [], agent: quiet({ enabled, ...agentOver }) });
      const agent = agentCore.createAgent({
        onChange,
        openResume,
        captureScript,
        fetchPr,
        gh,
        notify,
        checkMermaid,
        // Not your real ~/.claude/skills: what a test mounts must not depend on the machine.
        userSkillsDir: path.join(dir, "no-skills"),
        dir: path.join(dir, "agent"),
        loadSettings: () => settings,
        getSnapshot: () => snapshot,
        // Your live Claude sessions; a test changes the array in place.
        getSessions: () => sessions,
        // `checkout`: a flag, or a function when a test clones the repository midway.
        findCheckout: () => ((typeof checkout === "function" ? checkout() : checkout) ? co : null),
        hookScript: hookJs,
        execPath: process.execPath,
        plugins: () => [],
        git: async (args, cwd) => (rawGitCalls.push(args), gitCalls.push(gitSub(args)), gitImpl ? gitImpl(args, cwd) : ""),
        spawner: (args, cwd, env) => {
          const c = fakeChild();
          c.args = args;
          c.cwd = cwd;
          c.env = env;
          children.push(c);
          setImmediate(() => script(c));
          return c;
        },
        tickMs,
        // A test that waits out a delay sets the clock.
        ...(now ? { now } : {}),
      });
      // Settings › Agent saved anew.
      const setAgent = (over) => {
        settings = cfg.validateSettings({ hosts: [], agent: quiet(over) });
      };
      return { agent, snapshot, gitCalls, rawGitCalls, children, dir, setAgent };
    };

    const captureJs = path.join(__dirname, "../dist/main/main/agent/capture.js");
    // A review session as the skill runs it: write the review JSON, hand it to
    // the run's wrapper (the real capture script), finish.
    const reviewWithPlan = (event = "REQUEST_CHANGES", resultExtra = {}) => (c) => {
      const outDir = c.args[c.args.indexOf("--add-dir") + 1];
      const runDir = path.dirname(outDir);
      const run = JSON.parse(nfsA.readFileSync(path.join(runDir, "run.json"), "utf8"));
      const file = path.join(outDir, "review.json");
      nfsA.writeFileSync(file, JSON.stringify({ event, body: "Summary", comments: [{ path: "x.ts", line: 3, side: "RIGHT", body: "Major" }] }));
      const r = spawnSync(process.execPath, [captureJs, runDir, "review", run.repo, String(run.number), file], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
      emit(c, { type: "system", subtype: "init", session_id: "s" });
      emit(c, { type: "result", subtype: "success", is_error: false, result: "Prepared the review.", ...resultExtra });
      setImmediate(() => c.emit("exit", 0));
    };

    await atest("agent: a review request becomes a shadow review waiting for you, run once per head", async () => {
      const f = agentFixture({ script: reviewWithPlan(), captureScript: captureJs });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.agent.getState().items.some((i) => i.state === "needsYou"));
        const item = f.agent.getState().items[0];
        assert.strictEqual(item.headline, "Would post: request changes, 1 inline comment");
        assert.match(item.output, /Prepared the review/);
        assert.ok(f.gitCalls.some((a) => a[0] === "fetch" && a[3] === "pull/7/head"));
        assert.ok(f.children[0].args.includes("--restricted"));
        const settingsFile = f.children[0].args[f.children[0].args.indexOf("--settings") + 1];
        assert.match(nfsA.readFileSync(settingsFile, "utf8"), /PreToolUse[\s\S]*hook\.js[\s\S]*review/, "the run carries the guard hook");
        f.agent.onSnapshot(f.snapshot);
        f.agent.onSnapshot(f.snapshot);
        assert.strictEqual(f.agent.getState().items.length, 1, "the ledger keeps the same head from running again");
        assert.strictEqual(f.children.length, 1);
        const state = JSON.parse(nfsA.readFileSync(path.join(f.dir, "agent", "state.json"), "utf8"));
        assert.strictEqual(state.ledger["PR_R|review|aaa111"].state, "prepared");
        assert.match(nfsA.readFileSync(path.join(f.dir, "agent", "log.jsonl"), "utf8"), /"event":"started"/);
      } finally {
        f.agent.stop();
      }
    });

    const readLog = (f) =>
      nfsA
        .readFileSync(path.join(f.dir, "agent", "log.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));

    await atest("agent log: a run's story — queued, started, its end with Claude's stats, every item state, the card's moves, your click", async () => {
      const stats = { num_turns: 7, total_cost_usd: 0.21, duration_ms: 4000, usage: { input_tokens: 5, output_tokens: 600, cache_read_input_tokens: 9000, cache_creation_input_tokens: 100 } };
      const f = agentFixture({ script: reviewWithPlan("COMMENT", stats), captureScript: captureJs });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.agent.getState().items.some((i) => i.state === "needsYou"));
        const item = f.agent.getState().items[0];
        assert.deepStrictEqual(await f.agent.act({ type: "skip", runId: item.runId }), { ok: true });
        const log = readLog(f);
        assert.ok(log.every((l) => typeof l.kind === "string" && typeof l.at === "string"), "every line says what it is about");
        assert.deepStrictEqual(log[0].kind + ":" + log[0].event, "agent:start");

        const run = log.filter((l) => l.kind === "run").map((l) => l.event);
        assert.deepStrictEqual(run.slice(0, 3), ["queued", "started", "needsYou"]);
        const queued = log.find((l) => l.kind === "run" && l.event === "queued");
        assert.deepStrictEqual([queued.prNumber, queued.repo, queued.data.mode, queued.data.asked, queued.data.size], [7, "a/b", "shadow", false, { additions: 50, deletions: 10, files: 3 }]);
        const started = log.find((l) => l.kind === "run" && l.event === "started");
        assert.ok(started.sessionId && started.data.cwd && typeof started.data.waitedMs === "number", "where it ran and how long it waited");
        const end = log.find((l) => l.kind === "run" && l.event === "needsYou");
        assert.deepStrictEqual(
          [end.data.turns, end.data.costUsd, end.data.claudeMs, end.data.tokens, end.data.exitCode, end.data.comments, typeof end.ms],
          [7, 0.21, 4000, { input: 5, output: 600, cacheRead: 9000, cacheWrite: 100 }, 0, 1, "number"],
        );

        const states = log.filter((l) => l.kind === "item").map((l) => `${l.from}>${l.to}`);
        assert.deepStrictEqual(states, ["null>queued", "queued>working", "working>needsYou", "needsYou>done"]);

        const board = log.filter((l) => l.kind === "board").map((l) => [l.event, l.from, l.to, l.data.action]);
        assert.deepStrictEqual(board, [
          ["seen", null, "you", "review"],
          ["move", "you", "agent", null],
          ["move", "agent", "you", "send"],
          ["action", "you", "you", "review"],
        ]);

        const click = log.find((l) => l.kind === "action");
        assert.deepStrictEqual([click.event, click.runId, click.from, click.to, click.data.ok], ["skip", item.runId, "needsYou", "done", true]);
        const state = JSON.parse(nfsA.readFileSync(path.join(f.dir, "agent", "state.json"), "utf8"));
        assert.deepStrictEqual([state.board.PR_R.column, state.board.PR_R.action], ["you", "review"], "the Board's marks are saved with the state");

        // A refused click is logged with the refusal.
        assert.strictEqual((await f.agent.act({ type: "publish", runId: item.runId })).ok, false);
        const refused = readLog(f).filter((l) => l.kind === "action").pop();
        assert.deepStrictEqual([refused.event, refused.data.ok, typeof refused.detail], ["publish", false, "string"]);

        // Switched off: one line with what changed; the Board is no longer logged.
        f.setAgent({ enabled: false });
        f.agent.onSnapshot(f.snapshot);
        const off = readLog(f).pop();
        assert.deepStrictEqual([off.kind, off.event, off.data.changed.enabled], ["agent", "off", [true, false]]);
        // Saved through the write chain: on disk a moment later.
        await until(() => JSON.parse(nfsA.readFileSync(path.join(f.dir, "agent", "state.json"), "utf8")).board === undefined);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent log: the Board's marks outlive a restart — the same Board logs nothing again; a held queue says why", async () => {
      const f = agentFixture({ script: () => {} });
      // Paused before the first run starts: the queue is held, and says so once.
      await f.agent.act({ type: "pauseAgent" });
      f.agent.onSnapshot(f.snapshot);
      assert.deepStrictEqual(readLog(f).filter((l) => l.kind === "plan" && l.event === "held").map((l) => l.to), ["paused"]);
      f.agent.stop();
      const g = agentFixture({ home: f.dir, script: () => {} });
      try {
        const before = readLog(g).length;
        g.agent.onSnapshot(g.snapshot);
        const fresh = readLog(g).slice(before);
        assert.deepStrictEqual(fresh.filter((l) => l.kind === "board").map((l) => [l.event, l.from, l.to]), [], "no burst of 'seen' after a restart");
        const holds = readLog(g).filter((l) => l.kind === "plan" && (l.event === "held" || l.event === "released"));
        assert.deepStrictEqual(holds.map((l) => [l.event, l.to]).slice(-1), [["held", "paused"]]);
        await g.agent.act({ type: "resumeAgent" });
        assert.deepStrictEqual(readLog(g).filter((l) => l.kind === "plan" && l.event === "released").map((l) => l.from), ["paused"]);
      } finally {
        g.agent.stop();
      }
    });

    await atest("agent: without a checkout the PR waits and says why — nothing queued, failed or notified, and asking for a run is refused", async () => {
      let cloned = false;
      const notices = [];
      const f = agentFixture({ checkout: () => cloned, script: () => {}, notify: (n) => notices.push(n.kind) });
      try {
        f.agent.onSnapshot(f.snapshot);
        f.agent.onSnapshot(f.snapshot);
        await new Promise((r) => setTimeout(r, 30));
        assert.deepStrictEqual(f.agent.getState().items, []);
        assert.strictEqual(f.agent.getState().idle.PR_R, "No checkout of a/b — set its folder in Settings › Claude");
        assert.deepStrictEqual([f.children.length, notices], [0, []], "nothing started, no toast");
        assert.deepStrictEqual(await f.agent.act({ type: "enqueue", prId: "PR_R" }), { ok: false, error: "No checkout of a/b — set its folder in Settings › Claude." });
        assert.deepStrictEqual(f.agent.getState().items, [], "a refused ask leaves no failed card behind");
        // The repository cloned (or its folder set): the next plan picks the PR up.
        cloned = true;
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.children.length === 1);
        assert.strictEqual(f.agent.getState().items[0].scenario, "review");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent: a run that fails reports it and drops its worktree", async () => {
      const f = agentFixture({
        script: (c) => {
          c.stderr.write("boom\n");
          emit(c, { type: "result", subtype: "error_max_turns", is_error: true, result: "" });
          setImmediate(() => c.emit("exit", 1));
        },
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.agent.getState().items.some((i) => i.state === "error"));
        assert.strictEqual(f.agent.getState().items[0].headline, "The run failed");
        await until(() => f.gitCalls.some((a) => a[0] === "worktree" && a[1] === "remove"));
      } finally {
        f.agent.stop();
      }
    });

    // --- stage 3: what you can do with a run, and how the dashboard shows it ---
    const view = require(path.join(__dirname, "../dist/main/shared/agent-view.js"));
    /** The words of a result's one button on its Board card; null when it asks nothing. */
    const actionLabel = (item) => view.resultAction(item, view.laneOfScenario(item.scenario))?.label ?? null;
    const succeed = (text) => (c) => {
      emit(c, { type: "system", subtype: "init", session_id: "s" });
      emit(c, { type: "result", subtype: "success", is_error: false, result: text });
      setImmediate(() => c.emit("exit", 0));
    };
    // A run that starts and then keeps working until it is told otherwise.
    const keepWorking = (c) => emit(c, { type: "system", subtype: "init", session_id: "s" });
    const only = (f) => f.agent.getState().items;

    await atest("agent: a run the agent planned that fails is tried once more by itself, ten minutes on — a second failure is yours", async () => {
      let t = Date.parse("2026-11-10T10:00:00Z");
      const titles = [];
      const f = agentFixture({
        now: () => new Date(t),
        notify: (n) => titles.push([n.kind, view.agentNoticeTitle(n.kind, n.item)]),
        script: (c) => {
          c.stderr.write("fatal: unable to access the remote\n");
          setImmediate(() => c.emit("exit", 1));
        },
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "error"));
        const first = only(f)[0];
        assert.strictEqual(first.retryAt, new Date(t + agentCore.RETRY_AFTER_MS).toISOString());
        // Said as the run ends, not at the next poll.
        await until(() => /^Its last run on this head failed \(The run failed\) — it tries again by itself at \d\d:\d\d$/.test(f.agent.getState().idle.PR_R ?? ""));
        assert.match(titles.find(([k]) => k === "failed")[1], /^The agent couldn't finish #7 — it tries again at \d\d:\d\d$/);
        // Not before its time.
        t += agentCore.RETRY_AFTER_MS - 1000;
        f.agent.onSnapshot(f.snapshot);
        assert.strictEqual(f.children.length, 1);
        t += 1000;
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).filter((i) => i.state === "error").length === 1 && only(f).length === 2 && f.children.length === 2);
        const [old, again] = only(f);
        assert.deepStrictEqual([old.state, old.headline, old.retryAt], ["done", view.AGENT_CLOSED.superseded, undefined], "the failed card leaves for the new run");
        assert.deepStrictEqual([again.key, again.retryOf], [first.key, first.runId], "the same head's job, marked as its try again");
        await until(() => only(f)[1].state === "error");
        assert.strictEqual(only(f)[1].retryAt, undefined, "a try again isn't tried a third time");
        await until(() => f.agent.getState().idle.PR_R === "Its run on this head failed twice (The run failed) — over to you");
        t += 10 * agentCore.RETRY_AFTER_MS;
        f.agent.onSnapshot(f.snapshot);
        assert.strictEqual(f.children.length, 2);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent: a failure you asked for, or one the PR no longer wants, isn't tried again", async () => {
      let t = Date.parse("2026-11-10T10:00:00Z");
      const f = agentFixture({ pr: reviewPr({ requestedOfMe: false }), now: () => new Date(t), script: (c) => setImmediate(() => c.emit("exit", 1)) });
      try {
        assert.deepStrictEqual(await f.agent.act({ type: "enqueue", prId: "PR_R" }), { ok: true });
        await until(() => only(f).some((i) => i.state === "error"));
        assert.strictEqual(only(f)[0].retryAt, undefined, "your own ask is yours to repeat");
      } finally {
        f.agent.stop();
      }
      let t2 = Date.parse("2026-11-10T10:00:00Z");
      const g = agentFixture({ now: () => new Date(t2), script: (c) => setImmediate(() => c.emit("exit", 1)) });
      try {
        g.agent.onSnapshot(g.snapshot);
        await until(() => only(g).some((i) => i.state === "error"));
        assert.ok(only(g)[0].retryAt);
        // You reviewed it yourself meanwhile: the plan wants nothing, and the card stops promising a try again.
        g.snapshot.pullRequests[0] = { ...g.snapshot.pullRequests[0], roles: ["reviewed"], viewerHasReviewed: true, requestedOfMe: false };
        t2 += 2 * agentCore.RETRY_AFTER_MS;
        g.agent.onSnapshot(g.snapshot);
        assert.deepStrictEqual([only(g)[0].retryAt, g.children.length], [undefined, 1]);
      } finally {
        g.agent.stop();
      }
    });

    await atest("agent: an idle PR says how its head's run ended — at once, and never 'Running' with no run live", async () => {
      const f = agentFixture({ script: succeed("Looked at it; nothing to say.") });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "done"));
        // Without waiting for the next poll.
        await until(() => f.agent.getState().idle.PR_R === "Its last run on this head ended: Reviewed — nothing to post");
      } finally {
        f.agent.stop();
      }
      // A run the app's closing cut short and that went on as another, asked run: the head's ledger entry still reads "started".
      const home = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-agent-"));
      const at = (m) => `2026-11-10T09:${String(m).padStart(2, "0")}:00.000Z`;
      const base = { prId: "PR_R", prNumber: 7, repo: "a/b", url: "https://github.com/a/b/pull/7", title: "t", hostLabel: "GH", scenario: "review", mode: "shadow" };
      nfsA.mkdirSync(path.join(home, "agent"), { recursive: true });
      nfsA.writeFileSync(
        path.join(home, "agent", "state.json"),
        JSON.stringify({
          version: 1,
          ledger: { "PR_R|review|aaa111": { state: "started", at: at(0), runId: "r1" } },
          day: "2026-11-10",
          runsToday: 0,
          items: [
            { ...base, runId: "r1", key: "PR_R|review|aaa111", state: "done", headline: view.AGENT_CLOSED.rerun, queuedAt: at(0), finishedAt: at(5) },
            { ...base, runId: "r2", key: "PR_R|review|aaa111|asked", state: "done", headline: "Stopped by you", queuedAt: at(5), finishedAt: at(9) },
          ],
          acceptedUnchanged: 0,
          drive: {},
          pushedHeads: {},
          paused: false,
        }),
      );
      const g = agentFixture({ home, script: keepWorking });
      try {
        g.agent.onSnapshot(g.snapshot);
        assert.strictEqual(g.agent.getState().idle.PR_R, "Its last run on this head ended: Stopped by you");
        assert.strictEqual(g.children.length, 0);
      } finally {
        g.agent.stop();
      }
    });

    await atest("agent: a drive's result from before a restart is marked to run again — what it would push and answer was checked in memory", async () => {
      const home = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-agent-"));
      const at = "2026-11-10T09:00:00.000Z";
      const base = { prId: "PR_R", prNumber: 7, repo: "a/b", url: "https://github.com/a/b/pull/7", title: "t", hostLabel: "GH", mode: "shadow", queuedAt: at, finishedAt: at };
      const wt = path.join(home, "wt");
      nfsA.mkdirSync(wt, { recursive: true });
      nfsA.mkdirSync(path.join(home, "agent"), { recursive: true });
      nfsA.writeFileSync(
        path.join(home, "agent", "state.json"),
        JSON.stringify({
          version: 1,
          ledger: {},
          day: "2026-11-10",
          runsToday: 0,
          items: [
            { ...base, runId: "d1", key: "PR_R|drive|aaa111|comments@-", scenario: "drive", state: "needsYou", headline: "No commits — see what it found", reasons: ["comments"], sessionId: "s", worktree: wt },
            { ...base, runId: "r1", key: "PR_R|review|aaa111", scenario: "review", state: "needsYou", headline: "Would post: comment" },
            { ...base, runId: "d2", key: "PR_R|drive|aaa111|ci", scenario: "drive", state: "done", headline: "Pushed" },
          ],
          acceptedUnchanged: 0,
          drive: {},
          pushedHeads: {},
          paused: false,
        }),
      );
      const f = agentFixture({ home, script: keepWorking });
      try {
        assert.deepStrictEqual(only(f).map((i) => [i.runId, i.needsRerun ?? false]), [["d1", true], ["r1", false], ["d2", false]]);
        // The refusal its card no longer leads you into.
        assert.deepStrictEqual(await f.agent.act({ type: "answer", runId: "d1", text: "eng1" }), { ok: false, error: "Since the app restarted, a drive starts over — run it again, or answer in a session." });
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent: a re-review you asked for covers the author's answers before it — only a later answer starts another", async () => {
      const iso = (min) => new Date(Date.now() + min * 60_000).toISOString();
      const pr = { ...reviewPr({ viewerHasReviewed: true, role: "reviewed", requestedOfMe: false }), viewerReviewedAt: iso(-60), viewerReviewedHead: true, authorRepliedAt: null };
      const f = agentFixture({ pr, script: succeed("Re-reviewed.") });
      try {
        f.agent.onSnapshot(f.snapshot);
        assert.strictEqual(only(f).length, 0, "nothing new from the author: no re-review of its own");
        assert.deepStrictEqual(await f.agent.act({ type: "enqueue", prId: pr.id }), { ok: true });
        await until(() => only(f).length === 1 && !["queued", "working"].includes(only(f)[0].state));
        // The dashboard learns of an answer the author gave before you asked: your run already saw it.
        f.snapshot.pullRequests[0] = { ...pr, authorRepliedAt: iso(-30) };
        f.agent.onSnapshot(f.snapshot);
        assert.strictEqual(only(f).length, 1);
        assert.strictEqual(f.agent.getState().idle[pr.id], "You asked the agent about this head yourself");
        // An answer after your ask is new work.
        f.snapshot.pullRequests[0] = { ...pr, authorRepliedAt: iso(1) };
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).length === 2);
        assert.match(only(f).find((i) => !i.key.endsWith("|asked")).key, /\|rereview\|aaa111\|reply@/);
      } finally {
        f.agent.stop();
      }
    });


    await atest("agent act: pause, hint and resume reach the running session; Stop leaves a note, not a decision", async () => {
      const f = agentFixture({ script: keepWorking });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.agent.getState().running.length === 1);
        const runId = only(f)[0].runId;
        const c = f.children[0];
        assert.deepStrictEqual(await f.agent.act({ type: "pause", runId }), { ok: true });
        await tickOnce();
        assert.match(c.written, /"subtype":"interrupt"/, "pause is an interrupt on stdin, not a kill");
        assert.strictEqual(f.agent.getState().running[0].paused, true);
        assert.strictEqual(only(f)[0].headline, "Paused");
        assert.strictEqual((await f.agent.act({ type: "pause", runId })).ok, false, "a paused run can't be paused again");

        assert.deepStrictEqual(await f.agent.act({ type: "hint", runId, text: "look at retry.ts first" }), { ok: true });
        await tickOnce();
        assert.match(c.written, /A note from the user while you work: look at retry\.ts first/);
        assert.ok(f.agent.getState().running[0].recent.some((r) => r.text === "You: look at retry.ts first"));

        assert.deepStrictEqual(await f.agent.act({ type: "resume", runId }), { ok: true });
        assert.strictEqual(f.agent.getState().running[0].paused, false);
        assert.strictEqual((await f.agent.act({ type: "skip", runId })).ok, false, "a running run is stopped before it is dismissed");

        assert.deepStrictEqual(await f.agent.act({ type: "stop", runId }), { ok: true });
        await until(() => only(f)[0].state === "done");
        assert.strictEqual(only(f)[0].headline, "Stopped by you");
        await until(() => f.gitCalls.some((a) => a[0] === "worktree" && a[1] === "remove"));
        assert.strictEqual((await f.agent.act({ type: "hint", runId, text: "x" })).ok, false, "a hint needs a running session");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent act: Take over stops the run and opens its session in your terminal", async () => {
      const opened = [];
      const f = agentFixture({ script: keepWorking, openResume: async (dir, sid) => void opened.push([dir, sid]) });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.agent.getState().running.length === 1);
        const item = only(f)[0];
        assert.deepStrictEqual(await f.agent.act({ type: "takeOver", runId: item.runId }), { ok: true });
        await until(() => only(f)[0].state === "done");
        assert.strictEqual(only(f)[0].headline, "You took it over in your terminal");
        assert.deepStrictEqual(opened, [[only(f)[0].worktree, item.sessionId]]);
        assert.ok(!f.gitCalls.some((a) => a[0] === "worktree" && a[1] === "remove"), "your session goes on in its folder");
        assert.ok(f.children[0].args.includes(item.sessionId), "it resumes the very session the run used");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent act: Run again replaces a result, Dismiss closes it", async () => {
      const opened = [];
      const f = agentFixture({ script: reviewWithPlan(), captureScript: captureJs, openResume: async (dir, sid) => void opened.push([dir, sid]) });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const first = only(f)[0];

        assert.strictEqual((await f.agent.act({ type: "continue", runId: first.runId })).ok, false, "no worktree on disk, nothing to continue");
        nfsA.mkdirSync(first.worktree, { recursive: true });
        assert.deepStrictEqual(await f.agent.act({ type: "continue", runId: first.runId }), { ok: true });
        assert.deepStrictEqual(opened, [[first.worktree, first.sessionId]]);

        assert.deepStrictEqual(await f.agent.act({ type: "retry", runId: first.runId }), { ok: true });
        await until(() => only(f).filter((i) => i.state === "needsYou").length === 1 && only(f).length === 2);
        const [old, again] = only(f);
        assert.strictEqual(old.state, "done");
        assert.strictEqual(old.headline, view.AGENT_CLOSED.rerun);
        assert.match(again.key, /\|asked$/, "your own ask has its own ledger key, so the head's entry doesn't stop it");
        assert.strictEqual(f.children.length, 2);

        assert.deepStrictEqual(await f.agent.act({ type: "skip", runId: again.runId }), { ok: true });
        assert.strictEqual(only(f)[1].headline, view.AGENT_CLOSED.dismissed);
        assert.ok(f.gitCalls.some((a) => a[0] === "worktree" && a[1] === "remove"), "a dismissed result drops its worktree");
        assert.strictEqual(view.boardStage(f.snapshot.pullRequests[0], only(f), { today: view.todayKey(new Date()) }).item, null, "the card shows nothing of the agent once it's all closed");
        assert.deepStrictEqual(await f.agent.act({ type: "skip", runId: "00000000-0000-4000-8000-000000000999" }), { ok: false, error: "That run is gone." });
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent act: Review anyway turns a brief no review followed (reviews off) into a review; a review can't be turned again", async () => {
      const f = agentFixture({ pr: reviewPr({ additions: 1200 }), script: succeed("Problem: … Decisions for you: …"), agent: { scenarios: { review: { mode: "off" } } } });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const brief = only(f)[0];
        assert.strictEqual(brief.scenario, "brief");
        assert.strictEqual(actionLabel(brief), "Draft a review");
        assert.deepStrictEqual(await f.agent.act({ type: "reviewAnyway", runId: brief.runId }), { ok: true });
        await until(() => only(f).length === 2 && only(f)[1].state === "done");
        assert.strictEqual(only(f)[1].headline, "Reviewed — nothing to post", "nothing captured to post: a note, not a decision");
        assert.strictEqual(only(f)[0].headline, view.AGENT_CLOSED.reviewed, "the brief leaves Your move");
        assert.strictEqual(only(f)[1].scenario, "review");
        assert.ok(f.children[1].args.includes("--settings"));
        const settingsFile = f.children[1].args[f.children[1].args.indexOf("--settings") + 1];
        assert.match(nfsA.readFileSync(settingsFile, "utf8"), /hook\.js[\s\S]*review/, "the review runs under the review guard, not the brief's");
        assert.strictEqual((await f.agent.act({ type: "reviewAnyway", runId: only(f)[1].runId })).ok, false);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent act: you can queue a PR you review, not your own, not twice, and not with the agent off", async () => {
      const f = agentFixture({ pr: reviewPr({ requestedOfMe: false }), script: keepWorking });
      try {
        f.agent.onSnapshot(f.snapshot);
        assert.strictEqual(only(f).length, 0, "a team request isn't picked up on its own");
        const prId = f.snapshot.pullRequests[0].id;
        assert.deepStrictEqual(await f.agent.act({ type: "enqueue", prId }), { ok: true });
        await until(() => f.agent.getState().running.length === 1);
        assert.strictEqual(only(f)[0].headline, "Reviewing");
        assert.deepStrictEqual(await f.agent.act({ type: "enqueue", prId }), { ok: false, error: "The agent is already on this PR." });
        assert.strictEqual((await f.agent.act({ type: "enqueue", prId: "PR_GONE" })).ok, false);
      } finally {
        f.agent.stop();
      }
      const mine = agentFixture({ pr: reviewPr({ role: "author" }), script: keepWorking });
      try {
        // A clean PR of yours is queued for a self-review of its head.
        assert.deepStrictEqual(await mine.agent.act({ type: "enqueue", prId: mine.snapshot.pullRequests[0].id }), { ok: true });
        assert.deepStrictEqual(mine.agent.getState().items.map((i) => [i.scenario, i.reasons]), [["drive", ["self"]]], "a clean PR of yours gets a self-review");
      } finally {
        mine.agent.stop();
      }
      const off = agentFixture({ enabled: false, script: keepWorking });
      try {
        assert.match((await off.agent.act({ type: "enqueue", prId: off.snapshot.pullRequests[0].id })).error, /The agent is off/);
        assert.strictEqual(off.agent.getState().enabled, false);
      } finally {
        off.agent.stop();
      }
    });

    const ipcAgent = require(path.join(__dirname, "../dist/main/main/ipc-validation.js"));
    test("ipc: an agent action is a known type on a run id; a hint is trimmed and bounded", () => {
      const RID = "00000000-0000-4000-8000-000000000001";
      const v = ipcAgent.validateAgentAction;
      assert.deepStrictEqual(v({ type: "pause", runId: RID, extra: "dropped" }), { type: "pause", runId: RID });
      assert.deepStrictEqual(v({ type: "hint", runId: RID, text: "  look at x.ts  " }), { type: "hint", runId: RID, text: "look at x.ts" });
      assert.deepStrictEqual(v({ type: "enqueue", prId: "PR_kwDOA" }), { type: "enqueue", prId: "PR_kwDOA" });
      assert.deepStrictEqual(v({ type: "approveAgain", prId: "PR_kwDOA", body: "anything", commit: "x" }), { type: "approveAgain", prId: "PR_kwDOA" }, "only the PR is named — what goes out is main's");
      assert.throws(() => v({ type: "approveAgain", prId: 7 }));
      for (const t of ["skip", "retry", "continue", "reviewAnyway", "pause", "resume", "stop", "takeOver"]) {
        assert.strictEqual(v({ type: t, runId: RID }).type, t);
      }
      for (const gone of ["later", "ack", "resumeSession"]) assert.throws(() => v({ type: gone, runId: RID }), /unknown action/, gone);
      for (const bad of [
        null,
        "pause",
        {},
        { type: "merge", runId: RID, method: "fast-forward" },
        { type: "publishAll", runId: RID },
        { type: "pause", runId: "../../etc" },
        { type: "pause" },
        { type: "hint", runId: RID, text: "   " },
        { type: "hint", runId: RID, text: "x".repeat(ipcAgent.AGENT_HINT_MAX + 1) },
        { type: "enqueue", prId: 3 },
        { type: "enqueue", prId: "" },
      ]) {
        assert.throws(() => v(bad), /agentAction|PR id/, JSON.stringify(bad));
      }
    });

    const vItem = (o) => ({
      runId: o.runId ?? `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`,
      key: `${o.prId}|review|h`,
      prNumber: 1,
      repo: "a/b",
      url: "https://github.com/a/b/pull/1",
      title: "t",
      hostLabel: "GH",
      scenario: "review",
      mode: "shadow",
      headline: o.state,
      queuedAt: "2026-11-05T08:00:00.000Z",
      ...o,
    });
    // --- boardStage: the column is whose move it is -------------------------------
    const sNow = Date.now();
    const sAgo = (min) => new Date(sNow - min * 60_000).toISOString();
    const sToday = view.todayKey(new Date(sNow));
    const sPr = (o = {}) => ({
      id: "P",
      number: 1,
      repo: "a/b",
      roles: ["author"],
      isDraft: false,
      canBeMerged: false,
      awaitingReview: true,
      ciState: "success",
      hasConflicts: false,
      hasUnaddressedChangeRequest: false,
      hasUnaddressedComments: false,
      myReReviewDue: false,
      viewerHasReviewed: false,
      viewerApproved: false,
      viewerReviewedAt: null,
      createdAt: sAgo(3000),
      updatedAt: sAgo(120),
      lastCommitPushedAt: sAgo(240),
      ...o,
    });
    const rPr = (o = {}) => sPr({ roles: ["reviewer"], ...o });
    const sIt = (o) => vItem({ prId: "P", finishedAt: o.state === "queued" || o.state === "working" ? undefined : sAgo(5), ...o });
    const plan = (event = "REQUEST_CHANGES", replies = 0) => ({ event, body: "b", comments: [{ path: "x.ts", line: 1, body: "c" }], replies: Array.from({ length: replies }, (_, i) => ({ replyTo: i + 1, body: "r" })), resolves: 0, escalations: [] });
    const drive = (n) => ({ base: "a", head: "b", reasons: ["self"], commits: Array.from({ length: n }, (_, i) => ({ oid: `c${i}`, subject: `fix ${i}` })), stat: "", patch: "" });
    /** A drive's plan: only its answers to the reviewers, no review of its own. */
    const answers = (n) => ({ event: null, body: "", comments: [], replies: Array.from({ length: n }, (_, i) => ({ replyTo: i + 1, body: "r" })), resolves: 0, escalations: [] });
    const stage = (pr, items = [], ctx = {}) => view.boardStage(pr, items, { today: sToday, ...ctx });
    const where = (s) => (s ? [s.lane, s.column, s.action?.kind ?? null, s.action?.label ?? null, s.ready] : null);

    // --- the Board in plain words (agent-explain) ---------------------------------
    const ex = require(path.join(__dirname, "../dist/main/shared/agent-explain.js"));
    const xPr = (o = {}) => sPr({ reviewers: [], unresolvedThreads: 0, requestedOfMe: false, title: `PR ${o.id ?? "P"}`, url: "https://github.com/a/b/pull/1", ...o });
    const xState = (items, o = {}) => ({ items, enabled: true, running: [], ...o });
    const xBoard = (prs, items = [], o = {}) => ex.explainBoard(prs, prs, xState(items, o), { today: sToday });
    const xOne = (pr, items = [], o = {}) => xBoard([pr], items, o).entries[0];
    const choice = (e, label) => e.choices.find((c) => c.label === label);

    test("agent board words: Your turn first and readiest first, then the agent's, the others', done", () => {
      const prs = [
        xPr({ id: "R", roles: ["reviewer"], requestedOfMe: true }),
        xPr({ id: "X" }),
        xPr({ id: "M", canBeMerged: true, awaitingReview: false }),
        xPr({ id: "A", roles: ["reviewer"] }),
        xPr({ id: "W" }),
      ];
      const items = [
        sIt({ prId: "X", scenario: "drive", state: "error", headline: "No checkout of a/b", error: "git said no" }),
        sIt({ prId: "M", scenario: "merge", state: "needsYou", key: "M|merge|h" }),
        sIt({ prId: "A", scenario: "review", state: "working" }),
      ];
      const b = xBoard(prs, items);
      assert.deepStrictEqual(
        b.entries.map((e) => [e.prId, e.owner]),
        [
          ["M", "you"],
          ["X", "you"],
          ["R", "you"],
          ["A", "agent"],
          ["W", "others"],
        ],
        "a merge in one click, then a failure, then a review nobody started",
      );
      const x = b.entries[1];
      assert.strictEqual(x.now, "The agent couldn't finish: no checkout of a/b.");
      assert.strictEqual(x.read.error, "git said no", "what went wrong is there to read");
      assert.deepStrictEqual(x.choices.map((c) => [c.label, c.act?.type, Boolean(c.primary)]), [
        ["Try again", "retry", true],
        ["Leave it", "skip", false],
      ]);
    });

    test("agent board words: a prepared review says what goes out, under whose name, and what comes after", () => {
      const e = xOne(xPr({ roles: ["reviewer"] }), [sIt({ state: "needsYou", plan: plan("APPROVE"), result: { summary: "Looks right.", asks: [], findings: [{ severity: "minor", text: "a nit", where: "x.ts:1" }], authorQuestions: [], structured: true } })]);
      assert.deepStrictEqual([e.owner, e.laneLabel, e.now, e.ask], ["you", "You review", "The agent reviewed the latest commit and suggests approving.", "Read the summary, then approve — or discard it."]);
      assert.deepStrictEqual([e.read.summary, e.read.findings.length, e.read.plan.event], ["Looks right.", 1, "APPROVE"]);
      const send = e.choices[0];
      assert.deepStrictEqual([send.label, send.act.type, send.primary], ["Approve", "publish", true]);
      assert.match(send.does, /^Posts an approval on GitHub under your name, signed by the agent/);
      assert.match(e.next, /author can merge/);
      assert.ok(choice(e, "Discard"), "and a way out");
      // Request changes, with the comments counted, and the re-review after.
      const rc = xOne(xPr({ roles: ["reviewer"] }), [sIt({ state: "needsYou", plan: plan("REQUEST_CHANGES") })]);
      assert.strictEqual(rc.now, "The agent drafted a review that requests changes: 1 inline comment.");
      assert.match(rc.choices[0].does, /Posts the review with 1 comment/);
      assert.match(rc.next, /re-review/);
    });

    test("agent board words: your reviewers' answers with nothing to push go out by themselves — or as they are, next to a question", () => {
      const mine = xPr();
      const e = xOne(mine, [sIt({ scenario: "drive", reasons: ["comments"], state: "needsYou", drive: drive(0), plan: answers(2), sessionId: "s", worktree: "/w" })]);
      assert.deepStrictEqual([e.owner, e.now], ["you", "The agent answered the reviewers without changing the code: 2 replies, nothing to push."]);
      assert.deepStrictEqual(e.choices.map((c) => [c.label, c.act?.type, Boolean(c.primary)]), [
        ["Send 2 replies", "publish", true],
        ["Open in Claude", "continue", false],
        ["Discard", "skip", false],
      ]);
      assert.match(e.choices[0].does, /in the reviewers' threads under your name, signed by the agent\. Nothing is pushed\.$/);
      const ask = { summary: "", asks: [{ question: "Retarget?", options: [] }], findings: [], authorQuestions: [], structured: true };
      const d = xOne(mine, [sIt({ scenario: "drive", reasons: ["comments"], state: "needsYou", drive: drive(0), plan: answers(1), result: ask })]);
      assert.deepStrictEqual(d.choices.map((c) => [c.label, c.act?.type]), [["Send 1 reply as it is", "publish"], ["Discard", "skip"]], "answering is the question's own form");
      const noAnswers = xOne(mine, [sIt({ scenario: "drive", reasons: ["comments"], state: "needsYou", drive: drive(0), result: ask })]);
      assert.deepStrictEqual(noAnswers.choices.map((c) => c.label), ["Discard"]);
    });

    test("agent board words: a drive's question or commits from before a restart offer Run again — never an answer or a push that would be refused", () => {
      const mine = xPr();
      const ask = { summary: "", asks: [{ question: "Which stand?", options: ["eng1", "eng2"] }], findings: [], authorQuestions: [], structured: true };
      const asked = xOne(mine, [sIt({ scenario: "drive", reasons: ["comments"], state: "needsYou", drive: drive(0), result: ask, sessionId: "s", worktree: "/w", needsRerun: true })]);
      assert.deepStrictEqual([asked.owner, asked.stage.action.kind], ["you", "decide"]);
      assert.strictEqual(asked.now, "The app restarted after this run, so it can't push anything or go on with your answer any more.");
      assert.deepStrictEqual(asked.choices.map((c) => [c.label, c.act?.type, Boolean(c.primary)]), [
        ["Run again", "retry", true],
        ["Open in Claude", "continue", false],
        ["Discard", "skip", false],
      ]);
      assert.deepStrictEqual(asked.read.asks.map((a) => a.question), ["Which stand?"], "its question still reads, as what the new run will ask");
      const commits = xOne(mine, [sIt({ scenario: "drive", reasons: ["ci"], state: "needsYou", drive: drive(2), needsRerun: true })]);
      assert.strictEqual(commits.stage.action.kind, "push");
      assert.match(commits.now, /can't push its 2 commits/);
      assert.deepStrictEqual(commits.choices.map((c) => c.label), ["Run again", "Discard"], "no Push, no session to open");
      // The same run before any restart: its own question and push, as ever.
      const live = xOne(mine, [sIt({ scenario: "drive", reasons: ["ci"], state: "needsYou", drive: drive(2) })]);
      assert.strictEqual(live.choices[0].label, "Push 2 fixes");
    });

    test("agent board words: a review nobody started is the agent's to start — unless the agent is off", () => {
      const pr = xPr({ id: "P", roles: ["reviewer"], requestedOfMe: true });
      const e = xOne(pr);
      assert.deepStrictEqual([e.owner, e.choices[0].label, e.choices[0].act], ["you", "Let the agent review", { type: "enqueue", prId: "P" }]);
      assert.ok(e.choices.some((c) => c.url && !c.act), "or on GitHub yourself");
      const off = xOne(pr, [], { enabled: false });
      assert.deepStrictEqual([off.choices.length, Boolean(off.choices[0].url), off.ask], [1, true, "Review it on GitHub."], "nothing that needs the agent while it is off");
      // Your PR with red CI: the agent fixes it, on your say-so.
      const red = xOne(xPr({ ciState: "failure", failingChecks: [{ name: "build" }] }));
      assert.strictEqual(red.choices[0].label, "Let the agent fix it");
      assert.match(red.now, /^CI failing: build\./);
    });

    test("agent board words: the agent's own, the others' and done each say what happens next and what you could do", () => {
      const runId = "00000000-0000-4000-8000-0000000000aa";
      const working = xOne(xPr({ roles: ["reviewer"] }), [sIt({ runId, state: "working", scenario: "rereview" })], {
        running: [{ runId, paused: false, progress: { steps: [{ id: "1", subject: "Read the diff", status: "completed" }, { id: "2", subject: "Check the answers", status: "in_progress" }], activity: "Read x.ts" } }],
      });
      assert.deepStrictEqual([working.owner, working.now, working.progress], ["agent", "The agent is re-reviewing it.", { step: "Check the answers", done: 1, total: 2, activity: "Read x.ts" }]);
      assert.deepStrictEqual(working.choices.map((c) => c.act.type), ["stop"]);
      assert.match(working.next, /Nothing is posted on GitHub until you send it/);
      const queued = xBoard([xPr({ id: "Q1", roles: ["reviewer"] }), xPr({ id: "Q2", roles: ["reviewer"] })], [sIt({ prId: "Q1", state: "queued", queuedAt: sAgo(10) }), sIt({ prId: "Q2", state: "queued", queuedAt: sAgo(5) })]).entries;
      assert.deepStrictEqual(queued.map((e) => [e.prId, e.place, e.now]), [
        ["Q1", 1, "The agent starts reviewing it next."],
        ["Q2", 2, "The agent starts reviewing it after 1 other."],
      ]);
      const author = xOne(xPr({ roles: ["reviewed"], viewerHasReviewed: true, unresolvedThreads: 2, awaitingReview: false }));
      assert.deepStrictEqual([author.owner, author.waitingOn, author.now], ["others", "The author", "You asked for changes · 2 threads open — the author's turn."]);
      assert.deepStrictEqual(author.choices.map((c) => c.label), ["Re-review now"]);
      const reviewers = xOne(xPr({ reviewers: [{ login: "anna", reviewState: "pending" }, { login: "oleg", reviewState: "approved" }] }));
      assert.deepStrictEqual([reviewers.owner, reviewers.waitingOn, reviewers.now], ["others", "anna", "Waiting for anna to review."]);
      const asked = xOne(xPr({ roles: ["reviewer", "reviewed"], requestedOfMe: true, viewerHasReviewed: true, viewerApproved: true, viewerReviewedHead: true, viewerReviewedAt: sAgo(60), authorRepliedAt: null }));
      assert.deepStrictEqual([asked.owner, asked.choices[0].label, asked.choices[0].act.type], ["done", "Approve again", "approveAgain"]);
    });

    // --- the journal: what the agent did, and where each card went --------------
    const journal = require(path.join(__dirname, "../dist/main/main/agent/journal.js"));
    const jAt = (min) => new Date(Date.UTC(2026, 10, 6, 12, min)).toISOString();

    test("agent journal: an item's state change is one line with how long the old state lasted; no change, no line", () => {
      const a = sIt({ runId: "00000000-0000-4000-8000-00000000000a", state: "queued", headline: "Queued: review" });
      let r = journal.diffItems(new Map(), [a], jAt(0));
      assert.deepStrictEqual(r.entries.map((e) => [e.kind, e.event, e.from, e.to, e.prId, e.runId, e.scenario]), [["item", "state", null, "queued", "P", a.runId, "review"]]);
      const same = journal.diffItems(r.marks, [a], jAt(1));
      assert.deepStrictEqual(same.entries, []);
      a.state = "working";
      a.headline = "Drafting your review";
      r = journal.diffItems(same.marks, [a], jAt(3));
      assert.deepStrictEqual(r.entries.map((e) => [e.from, e.to, e.ms, e.detail]), [["queued", "working", 180_000, "Drafting your review"]], "timed from when it was queued, not from the last look");
      assert.deepStrictEqual(journal.diffItems(r.marks, [], jAt(4)).entries, [], "pruned items leave without a line");
    });

    test("agent journal: a card's way across the Board — seen, moved with its time in the column, a new button, left; a failed host moves nothing", () => {
      const pr = rPr({ hostLabel: "GH" });
      const ctx = { today: sToday };
      const look = (prev, prs, items, min, failed) => journal.diffBoard(prev, journal.boardNow(prs, items, ctx), jAt(min), failed);
      const row = (e) => [e.kind, e.event, e.from, e.to, e.data?.lane, e.data?.action ?? null, e.ms ?? null];

      let r = look(null, [pr], [], 0);
      assert.deepStrictEqual(r.entries.map(row), [["board", "seen", null, "you", "review", "review", null]], "the first look ever: where each card stands");
      assert.deepStrictEqual(look(r.marks, [pr], [], 1).entries, [], "nothing moved, nothing written");

      const it = sIt({ state: "working", startedAt: jAt(2) });
      r = look(r.marks, [pr], [it], 2);
      assert.deepStrictEqual(r.entries.map(row), [["board", "move", "you", "agent", "review", null, 120_000]]);
      assert.deepStrictEqual([r.entries[0].runId, r.entries[0].detail, r.entries[0].data.itemState], [it.runId, "Drafting your review", "working"]);

      Object.assign(it, { state: "needsYou", finishedAt: jAt(9), plan: plan("COMMENT") });
      r = look(r.marks, [pr], [it], 9);
      assert.deepStrictEqual(r.entries.map(row), [["board", "move", "agent", "you", "review", "send", 420_000]]);
      assert.deepStrictEqual([r.entries[0].detail, r.entries[0].data.ready], ["Comment · 1 comment", true]);

      // The same column, another button: dismissed, the card is GitHub's again.
      Object.assign(it, { state: "done", headline: "Dismissed" });
      const before = r.marks.P.at;
      r = look(r.marks, [pr], [], 12);
      assert.deepStrictEqual(r.entries.map((e) => [e.event, e.data.fromAction, e.data.action, e.ms ?? null]), [["action", "send", "review", null]]);
      assert.strictEqual(r.marks.P.at, before, "a new button isn't a new column: its time there goes on");

      assert.deepStrictEqual(look(r.marks, [], [], 20, new Set(["GH"])).entries, [], "its host failed to load: the card didn't move");
      const gone = look(r.marks, [], [], 20);
      assert.deepStrictEqual(gone.entries.map(row), [["board", "left", "you", null, "review", null, 660_000]]);
      assert.deepStrictEqual(gone.marks, {});
    });

    test("agent journal: why the agent leaves a PR alone, the settings that changed, a run's stats, an action's arguments", () => {
      const prs = new Map([["A", { number: 1, repo: "a/b" }]]);
      const idle = journal.diffIdle({}, { A: "Waiting for reviewers" }, jAt(0), prs);
      assert.deepStrictEqual(idle.map((e) => [e.kind, e.event, e.prNumber, e.from, e.to]), [["plan", "idle", 1, null, "Waiting for reviewers"]]);
      assert.deepStrictEqual(journal.diffIdle({ A: "x" }, { A: "x" }, jAt(0), prs), []);
      assert.deepStrictEqual(journal.diffIdle({ A: "x" }, {}, jAt(0), prs), [], "taken up: its queued line says so");
      assert.deepStrictEqual(journal.diffIdle({ A: "x" }, { A: "y" }, jAt(0), prs).map((e) => [e.from, e.to]), [["x", "y"]]);

      const base = cfg.validateAgent({ enabled: true });
      assert.strictEqual(journal.settingsDiff(base, cfg.validateAgent({ enabled: true })), null);
      assert.deepStrictEqual(journal.settingsDiff(base, cfg.validateAgent({ enabled: true, scenarios: { review: { mode: "on" } } })), { "scenarios.review.mode": ["shadow", "on"] });

      const progress = { ...stream.initialProgress(), toolCalls: 31, steps: [{ id: "1", subject: "a", status: "completed" }, { id: "2", subject: "b", status: "in_progress" }] };
      const ok = journal.runStats({ startedAt: jAt(0) }, { progress: { ...progress, result: { subtype: "success", isError: false, text: "", denials: 1, deniedTools: ["Edit"], turns: 9, costUsd: 0.5, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } }, exitCode: 0, timedOut: false, stopped: false, stderr: "noise" }, jAt(4));
      assert.deepStrictEqual(ok, { ms: 240_000, exitCode: 0, subtype: "success", turns: 9, costUsd: 0.5, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, toolCalls: 31, denials: 1, deniedTools: ["Edit"], steps: "1/2" });
      const bad = journal.runStats({ startedAt: jAt(0) }, { progress, exitCode: 1, timedOut: true, stopped: false, stderr: "a\nb\nboom\n" }, jAt(1));
      assert.deepStrictEqual([bad.timedOut, bad.stderr, "subtype" in bad], [true, "a\nb\nboom", false], "a failed run keeps the end of stderr");
      assert.strictEqual(journal.runStats({}, { progress, exitCode: null, timedOut: false, stopped: true, stderr: "" }, jAt(1), { takeOver: true }).takenOver, true);

      assert.deepStrictEqual(journal.actionArgs({ type: "hint", runId: "r", text: "x".repeat(600) }), { text: `${"x".repeat(499)}…` });
      assert.deepStrictEqual(journal.actionArgs({ type: "merge", runId: "r", method: "squash" }), { method: "squash" });
      assert.strictEqual(journal.actionArgs({ type: "skip", runId: "r" }), undefined);
    });

    test("boardStage: your PR without an orchestrator — each step of the journey in its column, with one button", () => {
      const rows = [
        ["a draft is yours, quietly", sPr({ isDraft: true }), [], ["mine", "you", "draft", "Open on GitHub", false]],
        ["the self-review runs", sPr(), [sIt({ scenario: "drive", reasons: ["self"], state: "working", startedAt: sAgo(2) })], ["mine", "agent", null, null, false]],
        ["a clean self-review: waiting on reviewers", sPr(), [sIt({ scenario: "drive", reasons: ["self"], state: "done", headline: "Self-review: clean" })], ["mine", "waiting", null, null, false]],
        ["fixes ready to push", sPr(), [sIt({ scenario: "drive", reasons: ["self"], state: "needsYou", drive: drive(2) })], ["mine", "you", "push", "Push 2 fixes", true]],
        ["one fix", sPr(), [sIt({ scenario: "drive", reasons: ["ci"], state: "needsYou", drive: drive(1) })], ["mine", "you", "push", "Push 1 fix", true]],
        ["fixes and answers to reviewers", sPr(), [sIt({ scenario: "drive", reasons: ["comments"], state: "needsYou", drive: drive(2), plan: plan("COMMENT", 1) })], ["mine", "you", "push", "Push & reply", true]],
        ["answers to reviewers, nothing to push", sPr(), [sIt({ scenario: "drive", reasons: ["comments"], state: "needsYou", drive: drive(0), plan: answers(2), sessionId: "s" })], ["mine", "you", "send", "Send 2 replies", true]],
        ["one answer, nothing to push", sPr(), [sIt({ scenario: "drive", reasons: ["comments"], state: "needsYou", drive: drive(0), plan: answers(1) })], ["mine", "you", "send", "Send reply", true]],
        ["a product decision", sPr(), [sIt({ scenario: "drive", state: "needsYou", drive: drive(1), result: { summary: "s", asks: [{ question: "q", options: [] }], findings: [], authorQuestions: [], structured: true } })], ["mine", "you", "decide", "Your call", true]],
        ["waiting on reviewers", sPr(), [], ["mine", "waiting", null, null, false]],
        ["reviewer comments, the agent queued", sPr({ hasUnaddressedComments: true }), [sIt({ scenario: "drive", reasons: ["comments"], state: "queued" })], ["mine", "agent", null, null, false]],
        ["it couldn't: no commits", sPr({ ciState: "failure" }), [sIt({ scenario: "drive", reasons: ["ci"], state: "needsYou", drive: drive(0), sessionId: "s" })], ["mine", "you", "fix", "Open in Claude", true]],
        ["it failed", sPr({ ciState: "failure" }), [sIt({ scenario: "drive", state: "error" })], ["mine", "you", "fix", "Try again", true]],
        ["red CI with the agent not on it", sPr({ ciState: "failure" }), [], ["mine", "you", "fixYourself", "Open on GitHub", false]],
        ["a conflict with the agent not on it", sPr({ hasConflicts: true }), [], ["mine", "you", "fixYourself", "Open on GitHub", false]],
        ["the agent offers the merge", sPr({ canBeMerged: true, awaitingReview: false }), [sIt({ scenario: "merge", state: "needsYou" })], ["mine", "you", "merge", "Merge", true]],
        ["ready on GitHub, no offer", sPr({ canBeMerged: true, awaitingReview: false }), [], ["mine", "you", "merge", "Merge on GitHub", false]],
        ["ready but waits for the PR below", sPr({ canBeMerged: false, awaitingReview: false, blockedByStack: true }), [], ["mine", "waiting", null, null, false]],
        ["merged by the agent, gone from the dashboard", null, [sIt({ scenario: "merge", state: "done", headline: "Merged (squash)" })], ["mine", "done", null, null, false]],
        ["merged, the Jira dry run waits", null, [sIt({ scenario: "afterMerge", state: "needsYou", sessionId: "s" })], ["mine", "done", "updateJira", "Update Jira…", false]],
      ];
      for (const [name, pr, items, want] of rows) assert.deepStrictEqual(where(stage(pr, items)), want, name);
    });

    test("boardStage: a PR you review — requested, drafted, sent, answered, re-reviewed, approved", () => {
      const sent = sIt({ state: "done", headline: "Published: request changes, 2 inline comments", published: true });
      const rows = [
        ["the agent drafts it", rPr(), [sIt({ state: "working", startedAt: sAgo(3) })], ["review", "agent", null, null, false]],
        ["asked of you, the agent not on it", rPr(), [], ["review", "you", "review", "Open on GitHub", false]],
        ["the draft is ready", rPr(), [sIt({ state: "needsYou", plan: plan() })], ["review", "you", "send", "Send review", true]],
        ["a big PR's brief", rPr(), [sIt({ scenario: "brief", state: "needsYou", output: "brief" })], ["review", "you", "draftReview", "Draft a review", true]],
        ["sent: the author's move", rPr({ roles: ["reviewed"], viewerHasReviewed: true, viewerReviewedAt: sAgo(4), updatedAt: sAgo(4) }), [sent], ["review", "waiting", null, null, false]],
        ["sent, the snapshot not caught up yet", rPr({ updatedAt: sAgo(60) }), [sent], ["review", "waiting", null, null, false]],
        ["the author answered, the agent queued", rPr({ roles: ["reviewed"], myReReviewDue: true, viewerHasReviewed: true }), [sIt({ scenario: "rereview", state: "queued" })], ["review", "agent", null, null, false]],
        ["the re-review is ready", rPr({ roles: ["reviewed"], myReReviewDue: true }), [sIt({ scenario: "rereview", state: "needsYou", plan: plan("COMMENT") })], ["review", "you", "send", "Send re-review", true]],
        ["everything fixed: approve", rPr({ roles: ["reviewed"], myReReviewDue: true }), [sIt({ scenario: "rereview", state: "needsYou", plan: plan("APPROVE") })], ["review", "you", "send", "Approve", true]],
        ["the author answered, the agent not on it", rPr({ roles: ["reviewed"], myReReviewDue: true, viewerHasReviewed: true }), [], ["review", "you", "rereview", "Open on GitHub", false]],
        ["asked again after your review", rPr({ viewerHasReviewed: true }), [], ["review", "you", "rereview", "Open on GitHub", false]],
        ["a draft you were asked on: still the author's", rPr({ isDraft: true }), [], ["review", "waiting", null, null, false]],
        ["you approved today", rPr({ roles: ["reviewed"], viewerApproved: true, viewerHasReviewed: true, viewerReviewedAt: sAgo(30) }), [], ["review", "done", null, null, false]],
        ["it failed", rPr(), [sIt({ state: "error" })], ["review", "you", "fix", "Try again", true]],
        ["gone from the dashboard after the agent's review today", null, [sent], ["review", "done", null, null, false]],
      ];
      for (const [name, pr, items, want] of rows) assert.deepStrictEqual(where(stage(pr, items)), want, name);
      const old = stage(rPr({ roles: ["reviewed"], viewerApproved: true, viewerReviewedAt: "2026-01-02T10:00:00Z" }));
      assert.deepStrictEqual([old.column, old.earlier], ["done", true], "an approval from an earlier day folds into +N earlier");
    });

    test("boardStage: a run that asks nothing is a note on its card, not a decision", () => {
      for (const headline of ["Stopped by you", "You took it over in your terminal", "Stopped after 30 min", "Review ready — nothing to post"]) {
        const s = stage(rPr(), [sIt({ state: "needsYou", headline })]);
        assert.deepStrictEqual([s.column, s.action.kind, s.ready, s.note], ["you", "review", false, headline], headline);
      }
      const cut = stage(sPr(), [sIt({ scenario: "drive", state: "needsYou", interrupted: true, drive: drive(2), headline: "Interrupted — the app closed while it ran" })]);
      assert.deepStrictEqual([cut.column, cut.ready, cut.note], ["waiting", false, "Interrupted — the app closed while it ran"]);
      const published = stage(rPr(), [sIt({ state: "needsYou", plan: plan(), published: true })]);
      assert.strictEqual(published.ready, false, "a plan already sent asks nothing");
      // Housekeeping and yesterday say nothing.
      assert.strictEqual(stage(sPr(), [sIt({ state: "done", headline: view.AGENT_CLOSED.superseded })]).note, null);
      assert.strictEqual(stage(sPr(), [sIt({ state: "done", headline: "Pushed 2 commits", finishedAt: "2026-01-02T10:00:00Z" })]).note, null);
      assert.strictEqual(stage(null, [sIt({ state: "done", headline: view.AGENT_CLOSED.offDashboard })]), null, "a PR that left with nothing done today has no card");
      assert.strictEqual(stage(null, []), null);
    });

    test("boardStage: live work comes first; the agent's own why and the SDLC run's badge ride on the card", () => {
      const both = stage(rPr(), [sIt({ state: "needsYou", plan: plan(), finishedAt: sAgo(10) }), sIt({ scenario: "rereview", state: "queued" })]);
      assert.deepStrictEqual([both.column, both.item.state], ["agent", "queued"]);
      const two = stage(sPr(), [sIt({ scenario: "drive", state: "queued", rank: 5 }), sIt({ scenario: "drive", state: "working", startedAt: sAgo(1) })]);
      assert.strictEqual(two.item.state, "working");
      assert.strictEqual(stage(sPr({ ciState: "failure" }), [], { idle: { P: "Your Claude session is on it" } }).why, "Your Claude session is on it");
      assert.strictEqual(stage(sPr(), [], { idle: { P: "Yours — waiting for reviewers" } }).why, null, "only a card in Your move says why");
      const sdlc = { P: { key: "ENG-93412", stage: "fixing review" } };
      const rows = [
        ["the run's work", sPr({ hasUnaddressedChangeRequest: true }), ["mine", "agent", null, null, false]],
        ["a draft the run builds", sPr({ isDraft: true }), ["mine", "agent", null, null, false]],
        ["with reviewers", sPr(), ["mine", "waiting", null, null, false]],
        ["ready: the run waits for someone to merge", sPr({ canBeMerged: true, awaitingReview: false }), ["mine", "you", "merge", "Merge on GitHub", false]],
      ];
      for (const [name, pr, want] of rows) {
        const s = stage(pr, [], { orchestrated: sdlc });
        assert.deepStrictEqual(where(s), want, name);
        assert.deepStrictEqual(s.sdlc, sdlc.P, name);
      }
    });

    test("stageLine: a card says what goes out, what waits and what happened — in your words", () => {
      const line = (pr, items) => view.stageLine(stage(pr, items), pr);
      const esc = { ...plan("REQUEST_CHANGES", 1), escalations: [{ replyTo: 9, body: "b" }] };
      assert.strictEqual(line(rPr(), [sIt({ state: "needsYou", plan: esc })]), "Request changes · 1 comment · 1 reply · 1 pushed back");
      assert.strictEqual(line(sPr(), [sIt({ scenario: "drive", reasons: ["self"], state: "needsYou", drive: drive(2) })]), "Self-review: 2 fixes ready to push");
      assert.strictEqual(
        line(sPr(), [sIt({ scenario: "drive", reasons: ["comments"], state: "needsYou", drive: drive(1), plan: plan("COMMENT", 2) })]),
        "Reviewers' comments: 1 fix and 2 answers ready to push",
      );
      assert.strictEqual(
        line(sPr(), [sIt({ scenario: "drive", reasons: ["comments"], state: "needsYou", drive: drive(0), plan: answers(2) })]),
        "Reviewers' comments: 2 replies ready to send, nothing to push",
      );
      const asks = [{ question: "Configurable?", options: [] }, { question: "Rename it?", options: [] }];
      assert.strictEqual(line(sPr(), [sIt({ scenario: "drive", state: "needsYou", drive: drive(0), result: { summary: "", asks, findings: [], authorQuestions: [], structured: true } })]), "Your call: Configurable? (+1 more)");
      const reviewers = [{ login: "anna", avatarUrl: "", reviewState: "approved" }, { login: "ivan", avatarUrl: "", reviewState: "pending" }];
      assert.strictEqual(line(sPr({ canBeMerged: true, awaitingReview: false, reviewers: reviewers.slice(0, 1) }), []), "Approved by anna · CI green");
      assert.strictEqual(line(sPr({ reviewers }), []), "anna ✓ · ivan pending");
      assert.strictEqual(line(sPr({ reviewers: [] }), []), "Waiting for reviewers");
      assert.strictEqual(
        line(sPr({ ciState: "failure", failingChecks: [{ name: "lint" }, { name: "unit" }], hasConflicts: true }), []),
        "CI failing: lint, unit · Conflicts with the base branch",
      );
      assert.strictEqual(line(rPr({ roles: ["reviewed"], viewerHasReviewed: true, unresolvedThreads: 3 }), []), "You asked for changes · 3 threads open");
      assert.strictEqual(line(rPr({ requestedOfMe: false }), []), "Review requested of your team");
      assert.strictEqual(view.workLine({ scenario: "drive", reasons: ["ci", "comments"] }), "Fixing CI · Answering reviewers' comments");
      assert.strictEqual(view.workLine({ scenario: "rereview" }), "Re-reviewing — the author answered");
      const run = sPr({ hasUnaddressedChangeRequest: true });
      assert.strictEqual(view.stageLine(stage(run, [sIt({ scenario: "drive", reasons: ["comments"], state: "done", headline: "Stopped by you" })], { orchestrated: { P: { key: "ENG-1", stage: null } } }), run), "The SDLC run is on it", "not the agent: its last run is over");
    });

    test("one vocabulary: the tray's verb, a place in line and a notification's title say what the Board says", () => {
      assert.deepStrictEqual(
        [
          view.itemVerb({ scenario: "review" }),
          view.itemVerb({ scenario: "drive", reasons: ["self"] }),
          view.itemVerb({ scenario: "drive", reasons: ["ci"] }),
          view.itemVerb({ scenario: "drive", reasons: ["conflicts"] }),
          view.itemVerb({ scenario: "drive", reasons: ["comments"] }),
          view.itemVerb({ scenario: "drive", reasons: ["ci", "comments"] }),
        ],
        ["Drafting review", "Self-reviewing", "Fixing CI on", "Resolving the conflict on", "Answering reviewers on", "Fixing"],
      );
      assert.deepStrictEqual([1, 2, 3, 4, 11, 21, 112].map(view.inLine), ["Up next", "2nd in line", "3rd in line", "4th in line", "11th in line", "21st in line", "112th in line"]);
      const t = (kind, o) => view.agentNoticeTitle(kind, sIt({ prNumber: 929, ...o }));
      assert.strictEqual(t("needsYou", { state: "needsYou", plan: plan() }), "Review ready to send: #929");
      assert.strictEqual(t("needsYou", { state: "needsYou", scenario: "rereview", plan: plan("COMMENT") }), "Re-review ready to send: #929");
      assert.strictEqual(t("needsYou", { state: "needsYou", plan: plan("APPROVE") }), "Approval ready to send: #929");
      assert.strictEqual(t("needsYou", { state: "needsYou", scenario: "drive", drive: drive(2) }), "2 fixes ready to push: #929");
      assert.strictEqual(t("needsYou", { state: "needsYou", scenario: "drive", drive: drive(1), plan: plan("COMMENT", 1) }), "Fixes and replies ready to push: #929");
      assert.strictEqual(t("needsYou", { state: "needsYou", scenario: "drive", drive: drive(0), plan: answers(2) }), "Replies to reviewers ready to send: #929");
      assert.strictEqual(t("needsYou", { state: "needsYou", scenario: "drive", drive: drive(0), plan: answers(1) }), "Reply to reviewers ready to send: #929");
      assert.strictEqual(t("finished", { state: "done", scenario: "drive", drive: drive(0), plan: answers(2), published: true }), "Replies sent: #929");
      assert.strictEqual(t("needsYou", { state: "needsYou", scenario: "merge" }), "Ready to merge: #929");
      const ask = { summary: "", asks: [{ question: "q", options: [] }], findings: [], authorQuestions: [], structured: true };
      assert.strictEqual(t("needsYou", { state: "needsYou", scenario: "drive", drive: drive(0), result: ask }), "Your call on #929");
      assert.strictEqual(t("needsYou", { state: "needsYou", scenario: "brief", output: "b" }), "Brief ready: #929");
      assert.strictEqual(t("failed", { state: "error" }), "The agent couldn't finish #929");
      assert.strictEqual(t("finished", { state: "done", published: true }), "Review sent: #929");
      assert.strictEqual(t("finished", { state: "done", scenario: "drive", pushed: true }), "Fixes pushed: #929");
    });

    test("stageColumns: one card per PR, in its lane and column; filters hide cards but not the count of what's ready", () => {
      const prs = [
        sPr({ id: "D", isDraft: true }),
        sPr({ id: "M", canBeMerged: true, awaitingReview: false }),
        sPr({ id: "W1", lastCommitPushedAt: sAgo(600) }),
        sPr({ id: "W2", lastCommitPushedAt: sAgo(6000) }),
        rPr({ id: "R1" }),
        rPr({ id: "R2" }),
        rPr({ id: "R3" }),
        rPr({ id: "A1", roles: ["reviewed"], viewerApproved: true, viewerReviewedAt: sAgo(10) }),
        rPr({ id: "A0", roles: ["reviewed"], viewerApproved: true, viewerReviewedAt: "2026-01-02T10:00:00Z" }),
        rPr({ id: "H", roles: ["reviewer"] }),
      ];
      const items = [
        sIt({ prId: "M", scenario: "merge", state: "needsYou" }),
        sIt({ prId: "R1", state: "needsYou", plan: plan() }),
        sIt({ prId: "R2", state: "queued", rank: 2 }),
        sIt({ prId: "R3", state: "queued", rank: 1 }),
        sIt({ prId: "R3", state: "done", headline: "Published: comment", published: true, finishedAt: sAgo(300) }),
        sIt({ prId: "H", state: "needsYou", plan: plan() }),
        sIt({ prId: "GONE", scenario: "merge", state: "done", headline: "Merged (squash)", finishedAt: sAgo(1) }),
        sIt({ prId: "GONE2", state: "done", headline: "Published: approve", finishedAt: sAgo(50) }),
      ];
      const shown = prs.filter((p) => p.id !== "H");
      const b = view.stageColumns(shown, prs, { items }, { today: sToday });
      const ids = (cards) => cards.map((c) => c.prId);
      assert.deepStrictEqual(ids(b.mine.you), ["M", "D"], "the merge first, the draft last");
      assert.deepStrictEqual(ids(b.mine.waiting), ["W2", "W1"], "the longest wait first");
      assert.deepStrictEqual(ids(b.mine.done), ["GONE"]);
      assert.deepStrictEqual(ids(b.review.you), ["R1"]);
      assert.deepStrictEqual(ids(b.review.agent), ["R3", "R2"], "the queue in its order");
      assert.deepStrictEqual(ids(b.review.done), ["A1", "GONE2"], "newest first");
      assert.strictEqual(b.review.earlier, 1);
      assert.strictEqual(b.hiddenReady, 1, "H's draft review is hidden by the filters, and said so");
      const every = [b.mine, b.review].flatMap((l) => view.BOARD_COLUMNS.flatMap((c) => ids(l[c])));
      assert.strictEqual(new Set(every).size, every.length, "a PR is in one column only");
      assert.ok(!every.includes("H"));
    });

    test("agent view: todayKey is the local day, and finishedOn compares on it", () => {
      // Built from local parts, so the answer is the same in every time zone.
      const lateEvening = new Date(2026, 10, 5, 23, 30);
      assert.strictEqual(view.todayKey(lateEvening), "2026-11-05");
      assert.strictEqual(view.finishedOn({ finishedAt: lateEvening.toISOString() }, "2026-11-05"), true);
      assert.strictEqual(view.finishedOn({ finishedAt: new Date(2026, 10, 4, 23, 59).toISOString() }, "2026-11-05"), false);
      assert.strictEqual(view.finishedOn({}, "2026-11-05"), false);
      assert.strictEqual(view.finishedOn({ finishedAt: "not a date" }, "2026-11-05"), false);
    });
    test("agent view: the one button names what a result asks of you; a result that asks nothing has none", () => {
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "error" })), "Try again");
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "error", scenario: "drive", sessionId: "s" })), "Open in Claude", "your PR: carry on in the session");
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "needsYou", scenario: "brief", output: "x" })), "Draft a review");
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "needsYou", sessionId: "s" })), null, "a review with nothing to send");
      const asks = { summary: "s", asks: [{ question: "q?", options: [] }], findings: [], structured: true };
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "needsYou", scenario: "drive", sessionId: "s", result: asks })), "Your call", "a question on your PR");
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "working", sessionId: "s" })), null);
    });

    // --- stage 4: the publish wrapper, the app's own posting, merge, notifications ---
    const pub = require(path.join(__dirname, "../dist/main/shared/agent-publish.js"));
    const publishMod = require(path.join(__dirname, "../dist/main/main/agent/publish.js"));
    const mergeMod = require(path.join(__dirname, "../dist/main/main/agent/merge.js"));
    const SHA = "a".repeat(40);

    test("publish plan: a review is rebuilt from the allowed fields only, the way the skill's own wrapper checks it", () => {
      const r = pub.parseReview({ event: "APPROVE", body: "ok", commit_id: SHA, extra: 1, comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "x", junk: true }] });
      assert.deepStrictEqual(r, { ok: true, value: { kind: "review", event: "APPROVE", body: "ok", commitId: SHA, comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "x" }] } });
      for (const [bad, why] of [
        [{ event: "DISMISS" }, /event must be/],
        [{ event: "COMMENT", body: 3 }, /body must be a string/],
        [{ event: "COMMENT", commit_id: "abc" }, /40-hex/],
        [{ event: "COMMENT", comments: {} }, /must be an array/],
        [{ event: "COMMENT", comments: [{ path: "a", body: "x", side: "UP" }] }, /side must be/],
        [{ event: "COMMENT", comments: [{ path: "", body: "x" }] }, /needs a path/],
        ["[]", /JSON object/],
      ]) {
        const p = pub.parseReview(bad);
        assert.strictEqual(p.ok, false, JSON.stringify(bad));
        assert.match(p.error, why);
      }
      assert.match(pub.parseFileComment({ path: "a.ts", body: "x", subject_type: "file" }).error, /needs commit_id/);
      assert.strictEqual(pub.parseFileComment({ path: "a.ts", body: "x", subject_type: "file", commit_id: SHA }).ok, true);
    });

    test("publish plan: the wrapper's four calls, with its own argument checks", () => {
      assert.deepStrictEqual(pub.parsePublishCall(["review", "a/b", "7", "/x/r.json"]).value, { sub: "review", repo: "a/b", number: 7, file: "/x/r.json" });
      assert.deepStrictEqual(pub.parsePublishCall(["reply", "a/b", "7", "123", "/x/t.txt"]).value, { sub: "reply", repo: "a/b", number: 7, replyTo: 123, file: "/x/t.txt" });
      assert.deepStrictEqual(pub.parsePublishCall(["resolve", "PRRT_abc"]).value, { sub: "resolve", threadId: "PRRT_abc" });
      for (const bad of [[], ["delete", "a/b"], ["review", "a/b", "7"], ["review", "a/../b", "7", "f"], ["review", "a/b", "07", "f"], ["reply", "a/b", "7", "x", "f"], ["resolve", "MDU6abc"], ["resolve", "PRRT_a b"]]) {
        assert.strictEqual(pub.parsePublishCall(bad).ok, false, bad.join(" "));
      }
    });

    test("publish plan: paths compare in Git Bash form, and a payload must sit inside the run's folder", () => {
      assert.strictEqual(pub.gitBashPath("C:\\Users\\me\\x.sh"), "/c/Users/me/x.sh");
      assert.strictEqual(pub.gitBashPath("/usr/x"), "/usr/x");
      assert.ok(pub.samePath("C:\\A\\b.sh", "/c/a/b.sh"));
      assert.ok(pub.isInsideDir("C:/T/run/out/review.json", "C:\\T\\run\\out"));
      assert.ok(!pub.isInsideDir("C:/T/run/outside/x.json", "C:\\T\\run\\out"), "a sibling with the same prefix is outside");
      assert.ok(!pub.isInsideDir("C:/T/run/out/../settings.json", "C:\\T\\run\\out"));
      assert.ok(!pub.isInsideDir("C:/T/run/out", "C:\\T\\run\\out"), "the folder itself is not a file in it");
      assert.ok(pub.isUsableWrapperPath("C:\\Users\\v.kuvarzin\\AppData\\Local\\Temp\\prd-agent\\1\\bin\\pr-review-publish.sh"));
      assert.ok(!pub.isUsableWrapperPath("C:\\Users\\VB641~1.KUV\\Temp\\bin\\pr-review-publish.sh"), "an 8.3 name with ~");
      assert.ok(!pub.isUsableWrapperPath("/Users/me/Library/Application Support/PR Dashboard/bin/pr-review-publish.sh"), "a space");
      assert.ok(!pub.isUsableWrapperPath("/tmp/bin/other.sh"));
    });

    test("publish plan: every posted body ends with the signature; a held approve becomes a comment", () => {
      const steps = [
        { kind: "comment", comment: { path: "f.ts", body: "file note", subjectType: "file" }, commitId: SHA },
        { kind: "review", event: "APPROVE", body: "LGTM", commitId: SHA, comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "nit" }] },
        { kind: "reply", replyTo: 42, body: "still applies" },
        { kind: "resolve", threadId: "PRRT_x" },
      ];
      const ctx = { repo: "a/b", number: 7, signature: "— sig", holdApprove: false };
      const reqs = pub.planRequests(steps, ctx);
      assert.deepStrictEqual(reqs.map((r) => r.endpoint), ["repos/a/b/pulls/7/comments", "repos/a/b/pulls/7/reviews", "repos/a/b/pulls/7/comments/42/replies", "graphql"]);
      assert.strictEqual(reqs[0].body.body, "file note\n\n— sig");
      assert.strictEqual(reqs[0].body.commit_id, SHA);
      assert.strictEqual(reqs[0].body.subject_type, "file");
      assert.strictEqual(reqs[1].body.event, "APPROVE");
      assert.strictEqual(reqs[1].body.body, "LGTM\n\n— sig");
      assert.deepStrictEqual(reqs[1].body.comments, [{ path: "a.ts", line: 3, side: "RIGHT", body: "nit" }], "inline comments sit under the signed review body");
      assert.strictEqual(reqs[2].body.body, "still applies\n\n— sig");
      assert.match(reqs[3].body.query, /^mutation\(\$id:ID!\)\{ resolveReviewThread/);
      assert.deepStrictEqual(reqs[3].body.variables, { id: "PRRT_x" });
      const held = pub.planRequests(steps, { ...ctx, holdApprove: true })[1];
      assert.strictEqual(held.body.event, "COMMENT");
      assert.ok(held.body.body.includes(pub.HELD_APPROVE_NOTE) && held.body.body.endsWith("— sig"));
      assert.strictEqual(pub.signedBody("", "— sig"), "— sig");
      assert.strictEqual(pub.describePlan(pub.summarizePlan(steps)), "approve, 2 inline comments, 1 reply, 1 resolve");
      assert.deepStrictEqual(pub.readPlanLines(`${steps.map((x) => JSON.stringify(x)).join("\n")}\n{torn`), steps, "the plan file reads back as written; a torn line is dropped");
    });

    test("agent guard: the reads the review skill needs — gh api user, GraphQL reads of its PR, --hostname, Accept, auth status, twg", () => {
      const ok = (cmd) => assert.deepStrictEqual(guard.checkBash("review", cmd, gpr), { allow: true }, cmd);
      ok("gh api user --jq .login");
      ok("gh api repos/acme/widgets/pulls/12/files --paginate --hostname github.com");
      ok("gh api -H 'Accept: application/vnd.github.raw' 'repos/acme/widgets/contents/a.md?ref=abc'");
      ok("gh api graphql --hostname github.com -f query='query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){ reviewThreads(first:100){ nodes{ id isResolved } } } } }' -F owner=Acme -F repo=Widgets -F number=12");
      ok("gh api graphql -f query='{ viewer { login } }'");
      // The review skill's own thread query, as its Context phase sends it.
      ok("gh api graphql --hostname github.com -f query='query($owner:String!,$repo:String!,$number:Int!,$cursor:String){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){ reviewThreads(first:100, after:$cursor){ pageInfo{ hasNextPage endCursor } nodes{ id isResolved isOutdated viewerCanResolve path line originalLine head: comments(first:1){ nodes{ databaseId author{login} body createdAt } } tail: comments(last:10){ nodes{ author{login} body createdAt } } } } } } }' -F owner=Acme -F repo=Widgets -F number=12");
      ok("gh api graphql -f query='query { repository(owner:\"acme\",name:\"widgets\"){ pullRequest(number:12){ reviews(last:5){ nodes{ author{ ... on User { login } } state submittedAt commit{ oid } } } } } rateLimit{ remaining } }'");
      ok("gh auth status --hostname github.com");
      ok("twg jira workitem get ENG-123 -o json --output-summary none");
      ok("twg confluence content get 3895230648 --detail full --format md -o json --output-summary none");
      ok("twg help describe 'jira workitem get'");
      ok("twg jira workitem query --jql 'key = ENG-1' -o json");
      ok("twg rovo search --query 'retry budget'");
    });

    test("agent guard: what a review must not do with those — write, read elsewhere, see the token, change Jira", () => {
      const no = (cmd, why) => {
        const d = guard.checkBash("review", cmd, gpr);
        assert.strictEqual(d.allow, false, cmd);
        if (why) assert.match(d.reason, why, cmd);
      };
      no(`gh api graphql -f query='mutation{ addComment(input:{subjectId:"x",body:"y"}){ clientMutationId } }'`, /only read/);
      no(`gh api graphql -f query='query{ repository(owner:"evil",name:"secrets"){ id } }'`, /acme\/widgets only/);
      no(`gh api graphql -f query='query($o:String!){ repository(owner:$o,name:"widgets"){ id } }' -F o=evil`, /acme\/widgets only/);
      no(`gh api graphql -f query='{ search(query:"x",type:REPOSITORY,first:5){ nodes{ __typename } } }'`, /not from search/);
      no("gh api graphql -f query='query($ids:[ID!]!){ nodes(ids:$ids){ ... on PullRequestReviewThread { id } } }' -F 'ids[]=PRRT_1'", /not from nodes/);
      // Nested selections are walked too: nothing leads out of the PR.
      no("gh api graphql -f query='{ viewer { repositories(first:5){ nodes{ name } } } }'", /viewer gives only/);
      no(`gh api graphql -f query='{ user(login:"boss"){ login repositories(privacy:PRIVATE){ nodes{ name } } } }'`, /user gives only/);
      no("gh api graphql -f query='query($o:String!,$r:String!){ repository(owner:$o,name:$r){ owner { ... on Organization { repositories(first:5){ nodes{ name } } } } } }' -F o=acme -F r=widgets", /not owner/);
      no("gh api graphql -f query='query($o:String!,$r:String!){ repository(owner:$o,name:$r){ pullRequest(number:13){ title } } }' -F o=acme -F r=widgets", /PR #12 only/);
      no("gh api graphql -f query='query($o:String!,$r:String!){ repository(owner:$o,name:$r){ pullRequest(number:12){ headRepository{ name } } } }' -F o=acme -F r=widgets", /headRepository is not one of the fields/);
      no("gh api graphql -f query='{ ... on Query { search(query:\"x\",type:REPOSITORY,first:1){ nodes{ __typename } } } }'", /not from search/);
      no("gh api graphql -f query='{ viewer @include(if:true) { login } }'", /directives/);
      no(`gh api graphql -f query='{ viewer { login } } """ " mutation { x } " """'`, /couldn't be read/);
      no("gh api graphql -f query='{ viewer { name(x:\"a\\\"b\") } }'", /couldn't be read/);
      no("gh api graphql -f query='query{ ...F } fragment F on Query { viewer { login } }'", /fragment/i);
      no("gh api graphql -F query=@q.graphql", /reads a file/);
      no("gh api graphql --input q.json");
      no("gh api repos/acme/widgets/issues/12/comments -f body=hi", /request body/);
      no("gh api repos/acme/widgets/pulls --hostname evil.example.com", /github\.com only/);
      no("gh api -H 'Authorization: token x' repos/acme/widgets/pulls", /Accept headers/);
      no("gh api users/someone");
      no("gh auth status --show-token");
      no("gh auth token");
      no("twg jira workitem update ENG-1 --summary x");
      no("twg jira workitem transition ENG-1 Done");
      no("twg api /rest/api/3/issue/ENG-1");
      no("twg login");
      no("twg jira workitem get ENG-1 --output-file /tmp/x", /writes or opens/);
      no("twg jira workitem get -o json comment create ENG-1", /reads like a subcommand/);
      no("twg jira workitem get ENG-1 --bogus", /not one of the flags/);
      no("twg jira workitem get ENG-1 -o", /needs a value/);
      no("twg help --output-file x", /writes or opens/);
      no("twg help describe -x", /not one of the flags/);
      no("twg jira workitem get ENG-1 -ojson", /short flags go on their own/);
      no("twg jira workitem get ENG-1 --detail create", /reads like a subcommand/);
      no("twg jira workitem query --fields summary", /reads like a subcommand/);
      assert.deepStrictEqual(guard.checkBash("review", "twg jira workitem query --fields=summary --jql='key = ENG-1'", gpr), { allow: true }, "anything goes attached");
      no("twg jira workitem comment create ENG-1 --body x");
      no("twg confluence content update 123 --body x");
      no("twg jira workitem get transition ENG-1", /not one of the reads/);
    });

    test("agent guard: a review writes only its payload files and calls only its own wrapper", () => {
      const run = { wrapperPath: "C:\\T\\prd-agent\\r1\\bin\\pr-review-publish.sh", outDir: "C:\\T\\prd-agent\\r1\\out" };
      const w = "/c/T/prd-agent/r1/bin/pr-review-publish.sh";
      assert.deepStrictEqual(guard.checkBash("review", `${w} review acme/widgets 12 C:/T/prd-agent/r1/out/review.json`, gpr, run), { allow: true });
      assert.deepStrictEqual(guard.checkBash("review", `${w} resolve PRRT_abc`, gpr, run), { allow: true });
      assert.match(guard.checkBash("review", `${w} review acme/other 12 C:/T/prd-agent/r1/out/r.json`, gpr, run).reason, /acme\/widgets#12 only/);
      assert.match(guard.checkBash("review", `${w} review acme/widgets 12 C:/Users/me/.bashrc`, gpr, run).reason, /under/);
      assert.match(guard.checkBash("review", `${w} delete acme/widgets 12 x`, gpr, run).reason, /PUBLISH-REJECTED/);
      assert.strictEqual(guard.checkBash("review", `${w} review acme/widgets 12 C:/T/prd-agent/r1/out/r.json`, gpr, null).allow, false, "no run, no wrapper");
      assert.deepStrictEqual(guard.checkToolUse("review", "Write", { file_path: "C:\\T\\prd-agent\\r1\\out\\review.json" }, gpr, run), { allow: true });
      for (const file of ["C:\\T\\prd-agent\\r1\\bin\\pr-review-publish.sh", "C:\\T\\prd-agent\\r1\\run.json", "C:\\work\\src\\a.ts"]) {
        assert.strictEqual(guard.checkToolUse("review", "Write", { file_path: file }, gpr, run).allow, false, file);
      }
      assert.strictEqual(guard.checkToolUse("review", "Edit", { file_path: "C:\\T\\prd-agent\\r1\\out\\review.json" }, gpr, run).allow, false, "new files only: no Edit");
      assert.strictEqual(guard.checkToolUse("brief", "Write", { file_path: "C:\\T\\prd-agent\\r1\\out\\x" }, gpr, null).allow, false);
    });

    test("agent guard hook: a review's guard file lets its payload files through, and nothing else", () => {
      const runDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-hook-"));
      const outDir = path.join(runDir, "out");
      const guardFile = path.join(runDir, "guard.json");
      runner.writeGuardFile(guardFile, { outDir, wrapperPath: path.join(runDir, "bin", "pr-review-publish.sh"), workflowDirs: [] });
      const write = (file, withRun = true) =>
        spawnSync(process.execPath, [hookJs, "review", "https://github.com/a/b/pull/7", ...(withRun ? [guardFile] : [])], {
          input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } }),
          encoding: "utf8",
        }).status;
      assert.strictEqual(write(path.join(outDir, "review.json")), 0);
      assert.strictEqual(write(guardFile), 2, "not its own guard file");
      assert.strictEqual(write(path.join(outDir, "x.json"), false), 2, "without the guard file nothing is writable");
      assert.deepStrictEqual(hookMod.readGuardFile(path.join(runDir, "missing.json")), null);
    });

    test("agent guard hook: a drive's guard file survives the round trip — edits in its worktree, replies only", () => {
      const pubG = require(path.join(__dirname, "../dist/main/shared/agent-publish.js"));
      const runDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-hookd-"));
      const workDir = path.join(runDir, "wt");
      const outDir = path.join(runDir, "out");
      const outside = path.join(runDir, "elsewhere");
      for (const d of [path.join(workDir, "src"), path.join(workDir, ".git"), outDir, outside]) nfsA.mkdirSync(d, { recursive: true });
      const wrapperPath = path.join(runDir, "bin", "pr-review-publish.sh");
      const guardFile = path.join(runDir, "guard.json");
      const written = {
        wrapperPath,
        outDir,
        subs: ["reply"],
        workDir,
        workflowDirs: [],
        readDirs: [workDir, outDir],
        sessionId: "6250ec40-5c65-407c-8b04-61b1dba8fae7",
        sessionRoots: [path.join(runDir, "projects")],
      };
      runner.writeGuardFile(guardFile, written);
      assert.deepStrictEqual(hookMod.readGuardFile(guardFile), written, "everything the app wrote comes back");
      const call = (tool_name, tool_input) =>
        spawnSync(process.execPath, [hookJs, "drive", "https://github.com/a/b/pull/7", guardFile], {
          input: JSON.stringify({ tool_name, tool_input }),
          encoding: "utf8",
        }).status;
      assert.strictEqual(call("Edit", { file_path: path.join(workDir, "src", "x.ts") }), 0, "its own worktree");
      assert.strictEqual(call("Write", { file_path: path.join(workDir, "src", "new", "y.ts") }), 0, "a new file in a new folder");
      assert.strictEqual(call("Edit", { file_path: path.join(workDir, ".git", "hooks", "pre-push") }), 2);
      assert.strictEqual(call("Edit", { file_path: path.join(outside, "a.ts") }), 2);
      const w = pubG.gitBashPath(wrapperPath);
      const reply = pubG.gitBashPath(path.join(outDir, "reply.txt"));
      assert.strictEqual(call("Bash", { command: `'${w}' reply a/b 7 77 '${reply}'` }), 0);
      assert.strictEqual(call("Bash", { command: `'${w}' resolve PRRT_x` }), 2, "a drive only replies");
      assert.strictEqual(call("Bash", { command: `'${w}' review a/b 7 '${pubG.gitBashPath(path.join(outDir, "r.json"))}'` }), 2);

      // A link the branch carries leads the write elsewhere: followed, and refused.
      nfsA.symlinkSync(outside, path.join(workDir, "src", "docs"), "junction");
      assert.strictEqual(call("Write", { file_path: path.join(workDir, "src", "docs", "evil.txt") }), 2, "out of the worktree through a link");
      nfsA.symlinkSync(path.join(workDir, ".git"), path.join(workDir, "src", "g"), "junction");
      assert.strictEqual(call("Write", { file_path: path.join(workDir, "src", "g", "hooks", "pre-commit") }), 2, "into git's folder through a link");
      nfsA.symlinkSync(path.join(runDir, "missing"), path.join(workDir, "src", "dangling"), "junction");
      assert.strictEqual(call("Write", { file_path: path.join(workDir, "src", "dangling", "z.txt") }), 2, "a link to nowhere");

      // A guard file that names its subcommands wrongly gives nothing beyond reading: absent would mean all of them.
      for (const bad of [
        { subs: "reply" },
        { subs: ["reply", "merge"] },
        { subs: [1] },
        { workDir: "" },
        { workDir: 7 },
        { workDir: "relative/wt" },
        { readDirs: workDir },
        { sessionId: "../../x" },
        { sessionId: "" },
        { sessionId: 7 },
        { sessionRoots: path.join(runDir, "projects") },
      ]) {
        runner.writeGuardFile(guardFile, { ...written, ...bad });
        assert.strictEqual(hookMod.readGuardFile(guardFile), null, JSON.stringify(bad));
      }
      runner.writeGuardFile(guardFile, { ...written, subs: [] });
      assert.deepStrictEqual(hookMod.readGuardFile(guardFile).subs, [], "an empty list stays empty — no subcommand");
      runner.writeGuardFile(guardFile, { ...written, readDirs: ["", "relative", 7, workDir], sessionRoots: ["."] });
      const kept = hookMod.readGuardFile(guardFile);
      assert.deepStrictEqual([kept.readDirs, kept.sessionRoots], [[workDir], []], "a folder list keeps absolute folders only — '' or '.' would be the hook's own folder");
    });

    test("agent guard hook: reads follow links on disk — the run's folders and its session's spill-over, nothing else", () => {
      const base = nfsA.realpathSync.native(nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-hookr-")));
      const workDir = path.join(base, "wt");
      const outDir = path.join(base, "run", "out");
      const plugin = path.join(base, "plugins", "creatio-development");
      const home = path.join(base, "home");
      const sid = "6250ec40-5c65-407c-8b04-61b1dba8fae7";
      const spill = path.join(home, ".claude", "projects", "proj", sid, "tool-results");
      const tasks = path.join(base, "temp", "claude", "proj", sid, "tasks");
      const other = path.join(home, ".claude", "projects", "proj", "11111111-2222-3333-4444-555555555555", "tool-results");
      for (const d of [path.join(workDir, "src"), outDir, path.join(plugin, "skills", "s"), path.join(home, ".ssh"), spill, tasks, other]) nfsA.mkdirSync(d, { recursive: true });
      const files = {
        code: path.join(workDir, "src", "x.ts"),
        payload: path.join(outDir, "review.json"),
        skill: path.join(plugin, "skills", "s", "SKILL.md"),
        key: path.join(home, ".ssh", "id_rsa"),
        spilled: path.join(spill, "b1.txt"),
        task: path.join(tasks, "w1.output"),
        otherSession: path.join(other, "b1.txt"),
      };
      for (const f of Object.values(files)) nfsA.writeFileSync(f, "x");
      const guardFile = path.join(base, "run", "guard.json");
      runner.writeGuardFile(guardFile, {
        workDir,
        outDir,
        wrapperPath: path.join(base, "run", "bin", "pr-review-publish.sh"),
        readDirs: [workDir, outDir, plugin],
        sessionId: sid,
        sessionRoots: [path.join(home, ".claude", "projects"), path.join(base, "temp", "claude")],
        workflowDirs: [plugin],
      });
      const call = (tool_name, tool_input, kind = "review") =>
        spawnSync(process.execPath, [hookJs, kind, "https://github.com/a/b/pull/7", guardFile], { input: JSON.stringify({ tool_name, tool_input }), encoding: "utf8" });
      for (const f of [files.code, files.payload, files.skill, files.spilled, files.task]) assert.strictEqual(call("Read", { file_path: f }).status, 0, f);
      assert.strictEqual(call("Read", { file_path: "src/x.ts" }).status, 0, "relative to the worktree");
      assert.strictEqual(call("Grep", { pattern: "x" }).status, 0, "no path: the worktree");
      assert.strictEqual(call("Glob", { pattern: `${plugin.replace(/\\/g, "/")}/skills/*` }).status, 0, "an absolute pattern inside a plugin");
      assert.strictEqual(call("Read", { file_path: files.code }, "drive").status, 0, "a drive reads its worktree too");

      const refused = (tool_name, tool_input, why) => {
        const r = call(tool_name, tool_input);
        assert.strictEqual(r.status, 2, `${why}: ${r.stderr}`);
        assert.match(r.stderr, /^PR agent guard: /, why);
      };
      refused("Read", { file_path: files.key }, "a key outside every folder");
      refused("Read", { file_path: `${workDir}/../home/.ssh/id_rsa` }, "a .. escape");
      refused("Read", { file_path: "../home/.ssh/id_rsa" }, "a relative .. escape");
      refused("Read", { file_path: files.otherSession }, "another session's spill-over");
      refused("Read", { file_path: guardFile }, "the run's own guard file");
      refused("Glob", { pattern: `${path.join(home, ".ssh").replace(/\\/g, "/")}/*` }, "an absolute pattern outside");
      refused("SendMessage", { to: "x", message: "y" }, "a tool the guard doesn't name");

      // Links the PR's branch could carry: followed to where they lead, and refused.
      nfsA.symlinkSync(path.join(home, ".ssh"), path.join(workDir, "src", "docs"), "junction");
      refused("Read", { file_path: path.join(workDir, "src", "docs", "id_rsa") }, "out of the worktree through a link");
      // As written it is the worktree's own src/x.ts; the system follows `docs` out first and steps up from there.
      refused("Read", { file_path: `${path.join(workDir, "src", "docs")}${path.sep}..${path.sep}x.ts` }, "a .. after a link out");
      refused("Grep", { pattern: "x", path: `src/docs/../` }, "a search root with a .. after a link out");
      refused("Grep", { pattern: "PRIVATE KEY", path: path.join(workDir, "src", "docs") }, "a search through a link");
      refused("Glob", { pattern: "*", path: "src/docs" }, "a listing through a link");
      nfsA.symlinkSync(path.join(home, ".ssh"), path.join(spill, "k"), "junction");
      refused("Read", { file_path: path.join(spill, "k", "id_rsa") }, "out of the session's folder through a link");
      nfsA.symlinkSync(path.join(base, "missing"), path.join(workDir, "src", "dangling"), "junction");
      refused("Read", { file_path: path.join(workDir, "src", "dangling", "x") }, "a link to nowhere");
      // A link that stays inside the worktree reads as usual.
      nfsA.symlinkSync(path.join(workDir, "src"), path.join(workDir, "alias"), "junction");
      assert.strictEqual(call("Read", { file_path: path.join(workDir, "alias", "x.ts") }).status, 0);
      if (process.platform === "win32") {
        // Claude Code reads Git Bash's /c/… as C:\… — and so does the check.
        const bash = `/${base[0].toLowerCase()}/${base.slice(3).replace(/\\/g, "/")}`;
        assert.strictEqual(call("Read", { file_path: `${bash}/wt/src/x.ts` }).status, 0, "Git Bash spelling");
        assert.strictEqual(call("Read", { file_path: `${bash}/home/.ssh/id_rsa` }).status, 2);
        // A glob right after the drive starts at the drive's root — `C:` as written is the hook's own folder, here the worktree.
        const top = base.slice(3).split(path.sep)[0];
        const fromWorktree = spawnSync(process.execPath, [hookJs, "review", "https://github.com/a/b/pull/7", guardFile], {
          cwd: workDir,
          input: JSON.stringify({ tool_name: "Glob", tool_input: { pattern: `${base[0]}:/{${top[0]},Q}${top.slice(1)}/**/id_rsa` } }),
          encoding: "utf8",
        });
        assert.strictEqual(fromWorktree.status, 2, `a glob from the drive's root: ${fromWorktree.stderr}`);
      }
    });

    test("agent runner: Claude Code's session folders — projects in its config folder, its temp folder", () => {
      const home = os.homedir();
      assert.deepStrictEqual(runner.claudeSessionRoots({ TEMP: "C:\\T" }, "win32"), [path.join(home, ".claude", "projects"), path.join("C:\\T", "claude")]);
      assert.deepStrictEqual(runner.claudeSessionRoots({ CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_CODE_TMPDIR: "/ct" }, "darwin"), [path.join("/cfg", "projects"), path.join("/ct", "claude")]);
      assert.ok(runner.claudeSessionRoots({}, "darwin").includes(path.join("/tmp", "claude")), "off Windows /tmp too");
    });

    await atest("agent worktrees: setting a run's worktree up runs no hook — not even one the PR brings through a relative hooksPath", async () => {
      const base = nfsA.realpathSync.native(nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-wthook-")));
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
      const g = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env });
      const origin = path.join(base, "origin");
      nfsA.mkdirSync(origin);
      g(origin, "init", "-q");
      nfsA.writeFileSync(path.join(origin, "a.txt"), "1\n");
      g(origin, "add", "a.txt");
      g(origin, "commit", "-q", "-m", "base");
      // The PR: hooks in husky's folder, which write where the test can see.
      const marker = path.join(base, "hook-ran").replace(/\\/g, "/");
      g(origin, "checkout", "-q", "-b", "pr");
      nfsA.mkdirSync(path.join(origin, ".husky", "_"), { recursive: true });
      for (const hook of ["post-checkout", "reference-transaction"]) {
        nfsA.writeFileSync(path.join(origin, ".husky", "_", hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 });
      }
      g(origin, "add", ".husky");
      g(origin, "update-index", "--chmod=+x", ".husky/_/post-checkout", ".husky/_/reference-transaction");
      g(origin, "commit", "-q", "-m", "pr");
      const head = g(origin, "rev-parse", "HEAD").stdout.trim();
      g(origin, "update-ref", "refs/pull/7/head", head);
      g(origin, "checkout", "-q", "-");
      const clone = path.join(base, "clone");
      g(base, "clone", "-q", "--no-local", origin, clone);
      // husky v9's setting: relative, so a worktree's own .husky/_ is what runs there.
      g(clone, "config", "core.hooksPath", ".husky/_");
      // Sanity: plain git does run the PR's hook here — else this test proves nothing.
      const probe = path.join(base, "probe");
      g(clone, "fetch", "-q", "--no-tags", "origin", "pull/7/head");
      g(clone, "worktree", "add", "-q", "--detach", probe, head);
      const hooksRun = nfsA.existsSync(marker);
      g(clone, "worktree", "remove", "--force", probe);
      nfsA.rmSync(marker, { force: true });
      const dir = await wt.prepareWorktree(wt.runGit, { checkout: clone, remote: "origin", base: path.join(base, "wts"), pr: { repo: "a/b", number: 7, headOid: head }, runId: "r1" });
      assert.strictEqual(g(dir, "rev-parse", "HEAD").stdout.trim(), head, "the PR's head is checked out");
      await wt.removeWorktree(wt.runGit, clone, dir);
      assert.ok(!nfsA.existsSync(dir));
      assert.ok(hooksRun, "the sanity check: plain git runs the PR's post-checkout here");
      assert.ok(!nfsA.existsSync(marker), `a hook ran: ${nfsA.existsSync(marker) ? nfsA.readFileSync(marker, "utf8") : ""}`);
    });

    test("agent guard: a Workflow runs only a skill's own script from a mounted plugin — never the PR's, never by name", () => {
      const plugin = "C:/Users/me/.claude/plugins/cache/x/creatio-development/1.7.142";
      const run = { workflowDirs: [plugin] };
      assert.deepStrictEqual(guard.checkToolUse("review", "Workflow", { scriptPath: `${plugin}/skills/creatio-code-review/creatio-code-review-workflow.workflow.js`, args: "{}" }, gpr, run), { allow: true });
      assert.deepStrictEqual(guard.checkToolUse("review", "Workflow", { scriptPath: "C:\\Users\\ME\\.claude\\plugins\\cache\\x\\creatio-development\\1.7.142\\w.js" }, gpr, run), { allow: true }, "the Windows spelling of the same folder");
      assert.strictEqual(guard.checkToolUse("review", "Workflow", { scriptPath: "C:/work/pr/evil.workflow.js" }, gpr, run).allow, false, "a script the PR brings");
      assert.strictEqual(guard.checkToolUse("review", "Workflow", { scriptPath: `${plugin}/../../evil.js` }, gpr, run).allow, false, "no stepping out of the plugin");
      assert.match(guard.checkToolUse("review", "Workflow", { name: "creatio-code-review-workflow" }, gpr, run).reason, /by its script path/, "a name could be the PR's .claude/workflows");
      assert.strictEqual(guard.checkToolUse("review", "Workflow", { scriptPath: "C:/x.js" }, gpr, null).allow, false, "no guard file, no workflow");
    });

    test("capture: the review's wrapper records a checked call and posts nothing", () => {
      const runDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-cap-"));
      const outDir = path.join(runDir, "out");
      nfsA.mkdirSync(outDir);
      nfsA.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ repo: "a/b", number: 7, outDir, wrapperPath: "x" }));
      const review = path.join(outDir, "review.json");
      nfsA.writeFileSync(review, JSON.stringify({ event: "COMMENT", body: "hi", commit_id: SHA, comments: [], extra: true }));
      const r = spawnSync(process.execPath, [captureJs, runDir, "review", "a/b", "7", review], { encoding: "utf8" });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /Nothing was posted from here/);
      const reply = path.join(outDir, "reply.txt");
      nfsA.writeFileSync(reply, "still applies");
      assert.strictEqual(spawnSync(process.execPath, [captureJs, runDir, "reply", "a/b", "7", "55", reply], { encoding: "utf8" }).status, 0);
      const outside = path.join(runDir, "outside.json");
      nfsA.writeFileSync(outside, "{}");
      for (const args of [["review", "a/b", "7", outside], ["review", "a/c", "7", review], ["review", "a/b", "8", review], ["comment", "a/b", "7", review], ["resolve", "nope"]]) {
        const bad = spawnSync(process.execPath, [captureJs, runDir, ...args], { encoding: "utf8" });
        assert.strictEqual(bad.status, 2, args.join(" "));
        assert.match(bad.stderr, /^PUBLISH-REJECTED: /, args.join(" "));
      }
      assert.deepStrictEqual(publishMod.readPlan(runDir), [
        { kind: "review", event: "COMMENT", body: "hi", commitId: SHA, comments: [] },
        { kind: "reply", replyTo: 55, body: "still applies" },
      ]);
    });

    test("publish: a review run's folder — under a root the skill accepts, fresh, with a wrapper that only hands over", () => {
      const base = nfsA.realpathSync.native(nfsA.mkdtempSync(path.join(os.tmpdir(), "prdroot")));
      const bad = path.join(base, "with space");
      const good = path.join(base, "ok");
      const runId = "11111111-1111-4111-8111-111111111111";
      const f = publishMod.prepareRunFolder([bad, good], runId, { repo: "a/b", number: 7 }, "C:\\Program Files\\PR Dashboard\\PR Dashboard.exe", "C:\\app\\capture.js");
      assert.ok(f && f.runDir.startsWith(good), "a root with a space is skipped");
      assert.ok(pub.isUsableWrapperPath(f.wrapperPath));
      const script = nfsA.readFileSync(f.wrapperPath, "utf8");
      assert.match(script, /^#!\/bin\/sh\n/);
      assert.ok(script.includes(`ELECTRON_RUN_AS_NODE=1 exec 'C:/Program Files/PR Dashboard/PR Dashboard.exe' 'C:/app/capture.js' '${f.runDir.replace(/\\/g, "/")}' "$@"`), script);
      assert.deepStrictEqual(JSON.parse(nfsA.readFileSync(path.join(f.runDir, "run.json"), "utf8")), { repo: "a/b", number: 7, outDir: f.outDir, wrapperPath: f.wrapperPath });
      nfsA.writeFileSync(path.join(f.outDir, "stale.json"), "{}");
      const again = publishMod.prepareRunFolder([good], runId, { repo: "a/b", number: 7 }, "node", "c.js");
      assert.ok(!nfsA.existsSync(path.join(again.outDir, "stale.json")), "nothing from before is kept");
      assert.strictEqual(publishMod.prepareRunFolder([bad], "x", { repo: "a/b", number: 7 }, "node", "c.js"), null);
    });

    await atest("publish: the plan goes out one write at a time, and a retry carries on where it stopped", async () => {
      const runDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-pub-"));
      const steps = [
        { kind: "review", event: "COMMENT", body: "b", commitId: SHA, comments: [] },
        { kind: "reply", replyTo: 9, body: "r" },
        { kind: "resolve", threadId: "PRRT_z" },
      ];
      nfsA.writeFileSync(path.join(runDir, "plan.jsonl"), `${steps.map((x) => JSON.stringify(x)).join("\n")}\n`);
      const calls = [];
      let failAt = 1;
      const gh = async (args, opts = {}) => {
        // The ownership checks before anything is posted.
        if (args[1] === "graphql" && opts.input.includes("node(id:$id)")) {
          return { code: 0, stdout: JSON.stringify({ data: { node: { isResolved: false, pullRequest: { number: 7, repository: { nameWithOwner: "a/b" } }, comments: { nodes: [{ author: { login: "Me" } }] } } } }), stderr: "" };
        }
        if (/^repos\/a\/b\/pulls\/comments\/\d+$/.test(args[1])) return { code: 0, stdout: JSON.stringify({ pull_request_url: "https://creatio.ghe.com/api/v3/repos/a/b/pulls/7", user: { login: "me" } }), stderr: "" };
        calls.push({ args, input: JSON.parse(opts.input) });
        return calls.length - 1 === failAt ? { code: 1, stdout: "", stderr: "HTTP 422: line is not part of the diff" } : { code: 0, stdout: "{}", stderr: "" };
      };
      const ctx = { repo: "a/b", number: 7, signature: "sig", holdApprove: false };
      const url = "https://creatio.ghe.com/a/b/pull/7";
      const first = await publishMod.publishPlan(runDir, url, ctx, { viewer: "me", mine: true }, gh);
      assert.deepStrictEqual([first.ok, first.posted, first.total], [false, 1, 3]);
      assert.match(first.error, /reply to comment 9: HTTP 422/);
      assert.deepStrictEqual(calls[0].args, ["api", "repos/a/b/pulls/7/reviews", "--method", "POST", "--input", "-", "--hostname", "creatio.ghe.com"]);
      assert.strictEqual(calls[0].input.body, "b\n\nsig");
      failAt = -1;
      calls.length = 0;
      const second = await publishMod.publishPlan(runDir, url, ctx, { viewer: "me", mine: true }, gh);
      assert.deepStrictEqual([second.ok, second.posted], [true, 3]);
      assert.deepStrictEqual(calls.map((c) => c.args[1]), ["repos/a/b/pulls/7/comments/9/replies", "graphql"], "the review is not posted twice");
      calls.length = 0;
      await publishMod.publishPlan(runDir, url, ctx, { viewer: "me", mine: true }, gh);
      assert.strictEqual(calls.length, 0, "an all-posted plan posts nothing");
      assert.deepStrictEqual(publishMod.ghApiArgs({ endpoint: "graphql" }, "https://github.com/a/b/pull/1"), ["api", "graphql", "--method", "POST", "--input", "-"]);
    });

    await atest("publish: a thread or comment of another PR stops the whole plan before anything is posted", async () => {
      const runDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-pub-"));
      const steps = [
        { kind: "review", event: "COMMENT", body: "b", comments: [] },
        { kind: "resolve", threadId: "PRRT_elsewhere" },
      ];
      nfsA.writeFileSync(path.join(runDir, "plan.jsonl"), `${steps.map((x) => JSON.stringify(x)).join("\n")}\n`);
      const posted = [];
      const gh = async (args, opts = {}) => {
        if (args[1] === "graphql" && opts.input.includes("node(id:$id)")) return { code: 0, stdout: JSON.stringify({ data: { node: { pullRequest: { number: 99, repository: { nameWithOwner: "x/secret" } } } } }), stderr: "" };
        posted.push(args);
        return { code: 0, stdout: "{}", stderr: "" };
      };
      const out = await publishMod.publishPlan(runDir, "https://github.com/a/b/pull/7", { repo: "a/b", number: 7, signature: "s", holdApprove: false }, { viewer: "me", mine: true }, gh);
      assert.deepStrictEqual([out.ok, out.posted], [false, 0]);
      assert.match(out.error, /PRRT_elsewhere is not on a\/b#7/);
      assert.strictEqual(posted.length, 0, "not even the review goes out");
      const reply = await publishMod.checkPlanTargets([{ kind: "reply", replyTo: 5, body: "x" }], "https://github.com/a/b/pull/7", "a/b", 7, { viewer: "me", mine: true }, async () => ({ code: 0, stdout: JSON.stringify({ pull_request_url: "https://api.github.com/repos/a/b/pulls/8" }), stderr: "" }));
      assert.match(reply, /comment 5 is not on a\/b#7/);
    });

    test("merge: the method you pick, else Settings', else GitHub's — only if the repository allows it", () => {
      const pr = { mergeMethods: { suggested: "squash", allowed: ["merge", "squash"] } };
      assert.strictEqual(mergeMod.chooseMergeMethod(pr, "github"), "squash");
      assert.strictEqual(mergeMod.chooseMergeMethod(pr, "merge"), "merge");
      assert.strictEqual(mergeMod.chooseMergeMethod(pr, "rebase"), "squash", "a method the repository forbids falls back to GitHub's");
      assert.strictEqual(mergeMod.chooseMergeMethod(pr, "github", "merge"), "merge");
      assert.strictEqual(mergeMod.chooseMergeMethod(pr, "github", "rebase"), "squash");
      assert.strictEqual(mergeMod.chooseMergeMethod({ mergeMethods: { suggested: null, allowed: [] } }, "github"), null);
      assert.deepStrictEqual(mergeMod.mergeArgs("https://github.com/a/b/pull/7", "squash", SHA, true), ["pr", "merge", "https://github.com/a/b/pull/7", "--squash", "--match-head-commit", SHA, "--delete-branch"]);
      assert.ok(!mergeMod.mergeArgs("u", "merge", SHA, false).includes("--delete-branch"));
    });

    test("agent merge: the branch other open PRs build on stays — stack layers above, or a PR based on it", () => {
      const base = { id: "P1", repo: "a/b", hostLabel: "h", headRefName: "feat/x", stack: null };
      assert.deepStrictEqual(mergeMod.builtOn(base, [{ id: "P1", repo: "a/b", hostLabel: "h", baseRefName: "main", number: 1 }]), []);
      const onTop = [
        { id: "P2", repo: "A/B", hostLabel: "h", baseRefName: "feat/x", number: 2 },
        { id: "P3", repo: "a/b", hostLabel: "other", baseRefName: "feat/x", number: 3 },
        { id: "P4", repo: "a/c", hostLabel: "h", baseRefName: "feat/x", number: 4 },
      ];
      assert.deepStrictEqual(mergeMod.builtOn(base, onTop), [2], "same host and repository only");
      const layered = {
        ...base,
        stack: { number: 9, position: 1, size: 3, baseRefName: "main", entries: [
          { number: 1, position: 1, state: "OPEN" },
          { number: 5, position: 2, state: "OPEN" },
          { number: 6, position: 3, state: "MERGED" },
        ] },
      };
      assert.deepStrictEqual(mergeMod.builtOn(layered, onTop), [2, 5], "an open layer above; a merged one isn't");
    });

    test("agent policy: your PR is offered for merge only when ready, and each switch only narrows it", () => {
      const mine = (o = {}) => ({ ...reviewPr({ role: "author" }), ...o });
      assert.strictEqual(policy.mergeBlocker(mine(), agentOn()), null, "the fixture is a clean, approved, green PR");
      const r = policy.planJobs([mine()], agentOn(), noSessions);
      assert.deepStrictEqual(r.merges.map((j) => [j.scenario, j.key]), [["merge", "PR_R|merge|aaa111"]]);
      assert.strictEqual(r.jobs.length, 0);
      for (const [o, why] of [
        [{ isDraft: true }, /Draft/],
        [{ blockedByStack: true }, /stack/],
        [{ hasConflicts: true }, /conflicts/],
        [{ ciState: "failure" }, /red/],
        [{ ciState: "pending" }, /running/],
        [{ awaitingReview: true }, /reviewers/],
        [{ canBeMerged: false }, /Not mergeable/],
      ]) {
        assert.match(policy.mergeBlocker(mine(o), agentOn()), why, JSON.stringify(o));
      }
      const pendingReviewer = mine({ reviewers: [{ login: "x", avatarUrl: "", reviewState: "pending" }] });
      assert.match(policy.mergeBlocker(pendingReviewer, agentOn()), /every requested reviewer/);
      assert.strictEqual(policy.mergeBlocker(pendingReviewer, agentOn({ scenarios: { merge: { requireAllReviewers: false } } })), null);
      assert.match(policy.mergeBlocker(mine({ unresolvedThreads: 2 }), agentOn()), /2 unresolved threads/);
      assert.strictEqual(policy.mergeBlocker(mine({ unresolvedThreads: 2 }), agentOn({ scenarios: { merge: { requireThreadsResolved: false } } })), null);
      assert.match(policy.planJobs([mine({ isDraft: true })], agentOn(), noSessions).idle.get("PR_R"), /^Yours — draft/);
      assert.match(policy.planJobs([mine()], agentOn({ scenarios: { merge: { mode: "off" } } }), noSessions).idle.get("PR_R"), /merge offers are off/);
    });

    test("agent stream: a skill's Workflow — its phases are the plan, and it counts as a background task", () => {
      let p = stream.initialProgress();
      p = stream.applyStreamEvent(p, { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w1" }] });
      assert.strictEqual(p.backgroundTasks, 1);
      p = stream.applyStreamEvent(p, {
        type: "system",
        subtype: "task_progress",
        description: "Review: security",
        workflow_progress: [
          { type: "workflow_phase", index: 1, title: "Context" },
          { type: "workflow_phase", index: 2, title: "Review" },
          { type: "workflow_phase", index: 3, title: "Publish" },
          { type: "workflow_agent", index: 1, phaseIndex: 1, state: "done" },
          { type: "workflow_agent", index: 2, phaseIndex: 2, state: "start" },
          { type: "workflow_agent", index: 3, phaseIndex: 2, state: "done" },
        ],
      });
      assert.deepStrictEqual(p.steps.map((s) => [s.subject, s.status]), [["Context", "completed"], ["Review", "in_progress"], ["Publish", "pending"]]);
      assert.strictEqual(p.activity, "Review: security");
      assert.strictEqual(stream.currentStep(p).subject, "Review");
      assert.strictEqual(stream.describeToolUse("Workflow", { scriptPath: "C:\\x\\creatio-code-review-workflow.workflow.js" }), "Running the creatio-code-review-workflow workflow");
      p = stream.applyStreamEvent(p, { type: "system", subtype: "background_tasks_changed", tasks: [] });
      assert.strictEqual(p.backgroundTasks, 0);
    });

    await atest("agent runner: a result while a workflow runs keeps stdin open; the one after it closes it", async () => {
      const c = fakeChild();
      const h = runner.startRun(spec(), () => {}, () => c);
      emit(c, { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w" }] });
      emit(c, { type: "result", subtype: "success", is_error: false, result: "launched" });
      await tickOnce();
      assert.strictEqual(c.ended, false, "the workflow's notification starts another turn");
      emit(c, { type: "system", subtype: "background_tasks_changed", tasks: [] });
      emit(c, { type: "result", subtype: "success", is_error: false, result: "the review" });
      await tickOnce();
      assert.strictEqual(c.ended, true);
      c.emit("exit", 0);
      const out = await h.done;
      assert.strictEqual(out.progress.result.text, "the review", "the last result is the run's");
      const a = runner.buildClaudeArgs(spec({ addDirs: ["/o", "/p"] }));
      assert.deepStrictEqual(a.slice(a.indexOf("--add-dir"), a.indexOf("--add-dir") + 4), ["--add-dir", "/o", "--add-dir", "/p"]);
      assert.ok(a.indexOf("--add-dir") < a.indexOf("--allowedTools"), "--allowedTools stays last");
    });

    await atest("agent runner: a process ended before its session finished is cut short — Ctrl+C, a signal, or a workflow still running", async () => {
      // A review launched its workflow in the background, ended that turn, and
      // Windows restarted under it: the result it left is the waiting turn's.
      const c = fakeChild();
      const h = runner.startRun(spec(), () => {}, () => c);
      emit(c, { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w" }] });
      emit(c, { type: "result", subtype: "success", is_error: false, result: "The review workflow is running in the background. I'll report once it completes." });
      await tickOnce();
      c.emit("exit", runner.STATUS_CONTROL_C_EXIT, null);
      const out = await h.done;
      assert.strictEqual(out.exitCode, 3221225786);
      assert.match(runner.cutShort(out), /process was ended/);

      const fin = { subtype: "success", isError: false, text: "the review", denials: 0 };
      const at = (over, exitCode, signal = null) => runner.cutShort({ progress: { ...out.progress, ...over }, exitCode, signal });
      assert.strictEqual(at({ backgroundTasks: 0, result: fin }, 0), null, "finished");
      assert.strictEqual(at({ backgroundTasks: 0, result: fin }, runner.STATUS_CONTROL_C_EXIT), null, "its answer came before the end");
      assert.match(at({ backgroundTasks: 0, result: null }, runner.STATUS_CONTROL_C_EXIT), /Ctrl\+C, or Windows shutting down/);
      assert.match(at({ backgroundTasks: 0, result: null }, null, "SIGTERM"), /\(SIGTERM\)/);
      assert.match(at({ backgroundTasks: 1 }, 0), /workflow was still running/, "it exited by itself with its workflow unfinished");
      assert.strictEqual(at({ backgroundTasks: 0, result: null }, 1), null, "a failure of its own stays a failure");
      assert.strictEqual(at({ backgroundTasks: 0, result: { ...fin, subtype: "error_during_execution", isError: true } }, 1), null);

      const d = fakeChild();
      const h2 = runner.startRun(spec(), () => {}, () => d);
      d.emit("exit", null, "SIGINT");
      assert.strictEqual((await h2.done).signal, "SIGINT", "the signal is kept on the outcome");
    });

    test("agent diagrams: the drawing run's answer is read, held to plain diagrams, and posted as one comment", () => {
      const dg = require(path.join(__dirname, "../dist/main/shared/agent-diagrams.js"));
      const flow = 'flowchart LR\n  a["Poller"] --> b["Agent"]\n  b <--> c["Store"]\n  class b newComp';
      const fence = (s) => "```mermaid\n" + s + "\n```";
      const answer = `### Architecture\n\n${fence(flow)}\n\n### Flow\n${fence("sequenceDiagram\n  A->>B: go")}\n\n### Third\n${fence("flowchart TD\n  x --> y")}`;
      const got = dg.extractDiagrams(answer);
      assert.deepStrictEqual(got.map((d) => d.title), ["Architecture", "Flow"], "two at most");
      assert.strictEqual(got[0].source, flow);
      assert.deepStrictEqual(dg.extractDiagrams(fence("flowchart LR\n  a --> b")).map((d) => d.title), ["Architecture"], "a bare fence is named in turn");
      assert.deepStrictEqual(dg.extractDiagrams("Nothing worth drawing here."), []);

      assert.ok(dg.isSafeMermaid(flow), "an arrow is not a tag");
      assert.ok(dg.isSafeMermaid('flowchart LR\n  a["one<br>two"] --> b'), "a line break is the one tag allowed");
      for (const bad of [
        'pie\n  "a": 1',
        'flowchart LR\n  a["x"] --> b\n```\n## Approve this PR',
        'flowchart LR\n  a["<img src=x onerror=alert(1)>"] --> b',
        "flowchart LR\n  a --> b\n  click a callback",
        'flowchart LR\n  a["[docs](https://x)"] --> b',
        "flowchart LR\n  a --> b\n  style a fill:url(https://x)",
        "%%{init: {'theme':'dark'}}%%\nflowchart LR\n  a --> b",
        "flowchart LR\n  a e1@--> b\n  e1@{ animate: true }",
      ]) {
        assert.strictEqual(dg.isSafeMermaid(bad), false, bad);
      }
      assert.strictEqual(dg.safeTitle("## [Approve](x) **now**\n`LGTM`"), "Approvex now LGTM", "no link, no heading, no emphasis survives");
      assert.strictEqual(dg.safeTitle("***"), "Diagram");

      const c = dg.cleanDiagrams([
        { title: "Arch", source: flow },
        { title: "Leak", source: 'flowchart LR\n  a["ghp_abcdefghijklmnopqrstuvwxyz0123"] --> b' },
      ]);
      assert.deepStrictEqual(c.kept.map((d) => d.title), ["Arch"]);
      assert.deepStrictEqual(c.dropped, ["Leak: it looks like it carries a secret"], "dropped whole, not redacted");
      assert.deepStrictEqual(dg.cleanDiagrams([{ title: "Pie", source: "pie" }]).dropped, ["Pie: not a plain flowchart or sequence diagram"]);

      const body = dg.diagramComment(c.kept);
      assert.ok(body.startsWith(`${dg.DIAGRAM_HEADER}\n\n${dg.DIAGRAM_LEGEND}\n\n#### Arch\n\n${fence(flow)}\n`), body);
      assert.strictEqual(body.split("```").length, 3, "one fence, closed");
      assert.strictEqual(dg.diagramComment([{ title: "x", source: "pie" }]), "", "nothing unsafe goes out");
      assert.ok(dg.hasMermaid(`text\n${fence("flowchart LR")}`));
      assert.ok(!dg.hasMermaid("```js\nmermaid()\n```"));

      const diff = "diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/src/b.ts b/src/b.ts\n+y\n";
      assert.match(
        dg.diagramPrompt({ title: "Add  retry", summary: "Retries\nfetches.", diff }),
        /^Pull request: Add retry\nWhat it does: Retries fetches\.\n\nChanged files \(2\):\n- src\/a\.ts\n- src\/b\.ts\n\nDiff:\n/,
      );
      assert.match(dg.diagramPrompt({ title: "t", diff: "x".repeat(dg.DIAGRAM_DIFF_MAX + 5) }), /\nDiff \(cut\):\n/);

      const on = { enabled: true, minLines: 100, post: true, model: "" };
      assert.strictEqual(dg.wantsDiagrams("review", { additions: 90, deletions: 10 }, on), true);
      assert.strictEqual(dg.wantsDiagrams("review", { additions: 90, deletions: 9 }, on), false, "below the threshold");
      assert.strictEqual(dg.wantsDiagrams("brief", { additions: 900, deletions: 0 }, on), true);
      assert.strictEqual(dg.wantsDiagrams("rereview", { additions: 900, deletions: 0 }, on), false, "a re-review's PR was drawn with its first review");
      assert.strictEqual(dg.wantsDiagrams("review", { additions: 900, deletions: 0 }, { ...on, enabled: false }), false);
    });

    test("agent diagrams: on by default from 100 lines and posted with the review; the model is a name only", () => {
      assert.deepStrictEqual(cfg.validateAgent(undefined).diagrams, { enabled: true, minLines: 100, post: true, model: "sonnet" });
      assert.deepStrictEqual(cfg.validateAgent({ diagrams: { enabled: false, minLines: -5, post: false, model: "" } }).diagrams, {
        enabled: false,
        minLines: 0,
        post: false,
        model: "",
      });
      assert.strictEqual(cfg.validateAgent({ diagrams: { model: "--dangerously-skip-permissions" } }).diagrams.model, "sonnet", "it goes on a command line");
      assert.strictEqual(cfg.validateAgent({ diagrams: { model: "claude-sonnet-5-5" } }).diagrams.model, "claude-sonnet-5-5");
    });

    test("agent diagrams: the drawing run answers once, with no tools and nothing of yours loaded or saved", () => {
      const md = require(path.join(__dirname, "../dist/main/main/agent/diagrams.js"));
      const a = md.diagramArgs("sonnet");
      for (const flag of ["-p", "--no-session-persistence", "--restricted", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(a.includes(flag), flag);
      assert.strictEqual(a[a.indexOf("--tools") + 1], "", "no tools at all");
      assert.strictEqual(a[a.indexOf("--output-format") + 1], "json");
      assert.deepStrictEqual(a.slice(-2), ["--model", "sonnet"]);
      assert.ok(!md.diagramArgs("").includes("--model"));
    });

    test("agent publish: a note is a comment in the PR's conversation, signed — never one a session records", () => {
      const pubM = require(path.join(__dirname, "../dist/main/shared/agent-publish.js"));
      const steps = [{ kind: "note", body: "### Diagrams of this change", label: "diagrams comment" }];
      assert.deepStrictEqual(pubM.planRequests(steps, { repo: "a/b", number: 7, signature: "— sig", holdApprove: false }), [
        { label: "diagrams comment", endpoint: "repos/a/b/issues/7/comments", body: { body: "### Diagrams of this change\n\n— sig" } },
      ]);
      assert.strictEqual(pubM.summarizePlan(steps).resolves, 0, "not counted as a resolve");
      assert.strictEqual(pubM.describePlan({ ...pubM.summarizePlan([]), event: "COMMENT", diagrams: 2 }), "comment, 2 diagrams");
      assert.deepStrictEqual(pubM.readPlanLines(JSON.stringify(steps[0])), [], "the plan file never yields one");
    });

    // --- re-approve: approvals a base-only push dismissed ---
    const ra = require(path.join(__dirname, "../dist/main/shared/agent-reapprove.js"));
    // A review's id is its author and submission time here; a dismissal names the review it dismissed by that id.
    const review = (login, state, at, oid) => ({ __typename: "PullRequestReview", id: `R:${login}:${at}`, author: { login }, state, submittedAt: at, commit: { oid } });
    const dismissal = (login, previousReviewState, at, oid) => ({ __typename: "ReviewDismissedEvent", previousReviewState, review: { id: `R:${login}:${at}`, author: { login }, commit: { oid } } });
    // git as the base-only check calls it: the subcommand after the safeGit "-c" pairs.
    const gitCmd = (args) => {
      let i = 0;
      while (args[i] === "-c") i += 2;
      return args.slice(i);
    };
    // A clone where the approved head was followed by one clean merge of the base.
    const cleanMergeGit = (o = {}) => async (args) => {
      const a = gitCmd(args);
      switch (a[0]) {
        case "ls-remote":
          return `base1\trefs/heads/${o.base ?? "master"}\n${o.head ?? "aaa111"}\trefs/pull/7/head\n`;
        case "merge-base":
          if (o.rewritten) throw new Error("git merge-base: exit 1");
          return "";
        case "rev-list":
          return a[1] === "--parents" ? (o.own ?? "m1 old111 base1\n") : (o.chain ?? "m1\n");
        case "rev-parse":
          return "tree1\n";
        case "merge-tree":
          if (o.conflict) throw new Error("git merge-tree: CONFLICT (content): Merge conflict in a.txt");
          return `${o.clean ?? "tree1"}\nAuto-merging a.txt\n`;
        default:
          return "";
      }
    };

    test("agent re-approve: a dismissed approval is told from a dismissed change request, a later word and the current head", () => {
      const t = [
        review("Anna", "DISMISSED", "2026-11-01T10:00:00Z", "old111"),
        dismissal("Anna", "APPROVED", "2026-11-01T10:00:00Z", "old111"),
        review("ivan", "DISMISSED", "2026-11-01T11:00:00Z", "old111"),
        dismissal("ivan", "CHANGES_REQUESTED", "2026-11-01T11:00:00Z", "old111"),
        // An approval dismissed, then a change request on the same commit, dismissed too:
        // the latest is the change request — author and commit alone would match the approval.
        review("zoe", "DISMISSED", "2026-11-01T08:00:00Z", "old111"),
        dismissal("zoe", "APPROVED", "2026-11-01T08:00:00Z", "old111"),
        review("zoe", "DISMISSED", "2026-11-01T12:00:00Z", "old111"),
        dismissal("zoe", "CHANGES_REQUESTED", "2026-11-01T12:00:00Z", "old111"),
        review("olga", "DISMISSED", "2026-11-01T09:00:00Z", "old111"),
        dismissal("olga", "APPROVED", "2026-11-01T09:00:00Z", "old111"),
        review("olga", "COMMENTED", "2026-11-02T09:00:00Z", "new222"),
        review("petr", "DISMISSED", "2026-11-01T09:00:00Z", "new222"),
        dismissal("petr", "APPROVED", "2026-11-01T09:00:00Z", "new222"),
        review("author1", "DISMISSED", "2026-11-01T09:00:00Z", "old111"),
        dismissal("author1", "APPROVED", "2026-11-01T09:00:00Z", "old111"),
        { __typename: "PullRequestReview", id: "R:draft", author: { login: "draft" }, state: "PENDING", submittedAt: null, commit: { oid: "old111" } },
      ];
      assert.deepStrictEqual(
        ra.dismissedApprovals(t, "new222", ["AUTHOR1"]),
        [{ login: "Anna", head: "old111" }],
        "ivan's and zoe's latest were change requests, olga spoke since, petr's was on this head, the author is out",
      );
      assert.deepStrictEqual(ra.dismissedApprovals([], "new222"), []);
    });

    test("agent re-approve: the commits since the approval decide — merges of the base on the branch's own walk, nothing else", () => {
      const chain = (...shas) => new Set(shas);
      assert.deepStrictEqual(ra.baseMerges([["m2", "m1", "b2"], ["m1", "old", "b1"]], chain("m2", "m1")), {
        merges: [
          { sha: "m2", parents: ["m1", "b2"] },
          { sha: "m1", parents: ["old", "b1"] },
        ],
      });
      assert.deepStrictEqual(ra.baseMerges([], chain()), { why: "nothing new on the branch since the approval" });
      assert.deepStrictEqual(ra.baseMerges([["m1", "old", "b1"], ["c1", "old"]], chain("m1")), { why: "the author pushed commits of their own since the approval" });
      assert.deepStrictEqual(ra.baseMerges([["m1", "old", "b1", "x1"]], chain("m1")), { why: "an octopus merge since the approval" });
      assert.deepStrictEqual(ra.baseMerges([["m1", "old", "x1"], ["x1", "old", "y1"]], chain("m1")), { why: "a merge brought in commits that aren't the base's" }, "a second parent that isn't the base's shows up as a commit of its own");
      assert.deepStrictEqual(ra.baseMerges([["m1", "b9", "b1"]], chain("m1", "b9")), { why: "the branch took base commits without a merge" });
      assert.strictEqual(ra.reapprovalBody("0123456789abcdef"), "Re-approved: only the base branch changed since my approval at `0123456` — the PR's own changes are the same.");
    });

    await atest("agent re-approve: in a real clone a clean merge of the base passes; a merge with changes of its own, an own commit, a rewrite and a conflict don't", async () => {
      const md = require(path.join(__dirname, "../dist/main/main/agent/reapprove.js"));
      const wt = require(path.join(__dirname, "../dist/main/main/agent/worktrees.js"));
      const { execFileSync } = require("node:child_process");
      const root = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-reapprove-"));
      const remote = path.join(root, "remote.git");
      const co = path.join(root, "co");
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
      const g = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: co, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      const write = (file, text) => nfsA.writeFileSync(path.join(co, file), text);
      const lines = (over = {}) => Array.from({ length: 12 }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
      execFileSync("git", ["init", "--bare", "-b", "master", remote], { env, stdio: "ignore" });
      execFileSync("git", ["clone", remote, co], { env, stdio: "ignore" });
      g("checkout", "-b", "master");
      write("a.txt", lines());
      g("add", ".");
      g("commit", "-m", "base");
      g("push", "origin", "master");
      g("checkout", "-b", "feature");
      write("a.txt", lines({ 2: "the PR's line" }));
      g("commit", "-am", "the PR");
      const old = g("rev-parse", "HEAD");
      const pushPr = () => {
        g("push", "-f", "origin", "HEAD:refs/pull/1/head");
        return g("rev-parse", "HEAD");
      };
      pushPr();
      // The base moves, away from the PR's line, and is merged in cleanly.
      g("checkout", "master");
      write("b.txt", "the base's file\n");
      g("add", ".");
      g("commit", "-m", "base moves");
      g("push", "origin", "master");
      g("checkout", "feature");
      g("merge", "--no-edit", "master");
      const clean = pushPr();
      const local = { git: wt.runGit, checkout: co, remote: "origin" };
      const check = (head) => md.baseOnlyPush(local, { number: 1, baseRefName: "master" }, old, head);
      assert.strictEqual(await check(clean), null, "a clean merge of the base");

      // The same merge with one more change folded into it.
      write("a.txt", lines({ 2: "the PR's line", 11: "slipped into the merge" }));
      g("commit", "--amend", "-a", "--no-edit");
      assert.strictEqual(await check(pushPr()), "a merge carries changes of its own");

      // A commit of the author's after the clean merge.
      g("reset", "--hard", clean);
      write("c.txt", "more\n");
      g("add", ".");
      g("commit", "-m", "more");
      assert.strictEqual(await check(pushPr()), "the author pushed commits of their own since the approval");

      // The branch rebased onto the base instead of merging it.
      g("checkout", "-B", "rebased", old);
      g("rebase", "master");
      assert.strictEqual(await check(pushPr()), "the branch was rewritten since the approval");

      // The base changes the PR's line too; the conflict is resolved by hand.
      g("checkout", "master");
      write("a.txt", lines({ 2: "the base's own line 2" }));
      g("commit", "-am", "base touches line 2");
      g("push", "origin", "master");
      g("checkout", "-B", "conflict", old);
      try {
        g("merge", "--no-edit", "master");
      } catch {
        // The conflict, as expected.
      }
      write("a.txt", lines({ 2: "the PR's line" }));
      g("add", ".");
      g("commit", "--no-edit");
      const conflicted = pushPr();
      assert.strictEqual(await check(conflicted), "a merge had conflicts resolved by hand");

      await assert.rejects(check(clean), /newer head/, "the PR moved on since the dashboard saw it");
      // Your clone behind the remote: the check fetches what it needs and moves none of its refs.
      g("update-ref", "refs/remotes/origin/master", old);
      assert.strictEqual(await check(conflicted), "a merge had conflicts resolved by hand");
      assert.strictEqual(g("rev-parse", "refs/remotes/origin/master"), old, "the remote-tracking branch stays where it was");
      assert.ok(!nfsA.existsSync(path.join(co, ".git", "FETCH_HEAD")), "and no FETCH_HEAD is written");
    });

    test("agent re-approve: the policy holds someone's PR while its head is checked, and re-asks beside driving your own", () => {
      const s = agentOn();
      assert.deepStrictEqual(s.scenarios.reapprove, { mode: "shadow", askReviewers: true }, "a scenario that posts starts in Shadow");
      const theirs = reviewPr({ role: "reviewed" });
      const at = (state) => policy.planJobs([theirs], s, { ...noSessions, reapproveState: () => state });
      let r = at("unchecked");
      assert.deepStrictEqual(r.reapprovals.map((j) => [j.scenario, j.key, j.mode]), [["reapprove", "PR_R|reapprove|aaa111", "shadow"]]);
      assert.strictEqual(r.idle.get("PR_R"), "Checking whether only the base changed since your approval");
      assert.strictEqual(at("same").idle.get("PR_R"), "Only the base changed since your approval");
      r = at("pass");
      assert.deepStrictEqual(r.reapprovals, []);
      assert.notStrictEqual(r.idle.get("PR_R"), "Only the base changed since your approval", "the other rules decide");
      assert.deepStrictEqual(policy.planJobs([theirs], s, noSessions).reapprovals, [], "no hook: pass");
      assert.deepStrictEqual(policy.planJobs([{ ...theirs, viewerHasReviewed: true }], s, { ...noSessions, reapproveState: () => "unchecked" }).reapprovals, [], "your approval stands");
      assert.deepStrictEqual(policy.planJobs([theirs], agentOn({ scenarios: { reapprove: { mode: "off" } } }), { ...noSessions, reapproveState: () => "unchecked" }).reapprovals, []);

      // The fixture's PR carries an approval; the base took it away.
      const mine = { ...reviewPr({ role: "author" }), hasHumanApproval: false };
      r = policy.planJobs([mine], s, { ...noSessions, reapproveState: () => "unchecked" });
      assert.deepStrictEqual(r.reapprovals.map((j) => j.scenario), ["reask"]);
      assert.strictEqual(r.jobs.length + r.merges.length + (r.idle.has("PR_R") ? 1 : 0) > 0, true, "your PR still goes through its own rules");
      assert.deepStrictEqual(policy.planJobs([mine], agentOn({ scenarios: { reapprove: { mode: "shadow", askReviewers: false } } }), { ...noSessions, reapproveState: () => "unchecked" }).reapprovals, []);
      assert.deepStrictEqual(policy.planJobs([{ ...mine, hasHumanApproval: true }], s, { ...noSessions, reapproveState: () => "unchecked" }).reapprovals, [], "an approval stands");
    });

    await atest("agent re-approve: the check reads the timeline once, checks the push in your clone, and passes on whatever isn't a base-only push", async () => {
      const md = require(path.join(__dirname, "../dist/main/main/agent/reapprove.js"));
      const timeline = [review("me", "DISMISSED", "2026-11-01T10:00:00Z", "old111"), dismissal("me", "APPROVED", "2026-11-01T10:00:00Z", "old111")];
      const fake = (o = {}) => {
        const calls = [];
        const gh = async (args, opts) => {
          calls.push(args);
          assert.strictEqual(args[1], "graphql", "nothing but the timeline is read from the API");
          assert.match(JSON.parse(opts.input).query, /REVIEW_DISMISSED_EVENT/);
          return { code: 0, stdout: JSON.stringify({ data: { viewer: { login: "me" }, node: { state: o.state ?? "OPEN", headRefOid: o.head ?? "aaa111", baseRefName: "release/8.3", author: { login: "author1" }, timelineItems: { nodes: o.timeline ?? timeline } } } }), stderr: "" };
        };
        return { gh, calls };
      };
      const gitCalls = [];
      const local = (o = {}) => ({ git: async (args) => (gitCalls.push(gitCmd(args)), cleanMergeGit({ base: "release/8.3", ...o })(args)), checkout: "/co", remote: "origin" });
      const target = { id: "PR_R", url: "https://github.com/a/b/pull/7", repo: "a/b", number: 7, headOid: "aaa111" };
      const ok = fake();
      assert.deepStrictEqual(await md.checkReapproval(ok.gh, target, "reapprove", local()), { verdict: "same", logins: ["me"], oldHead: "old111", note: "only merges of the base since old111" });
      assert.deepStrictEqual(gitCalls.find((a) => a[0] === "fetch"), ["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", "origin", "refs/heads/release/8.3", "refs/pull/7/head"]);
      assert.deepStrictEqual(gitCalls.find((a) => a[0] === "merge-tree"), ["merge-tree", "--write-tree", "old111", "base1"]);
      const note = async (o, l = local()) => (await md.checkReapproval(fake(o).gh, target, "reapprove", l)).note;
      assert.strictEqual(await note({}, local({ own: "c1 old111\n", chain: "c1\n" })), "the author pushed commits of their own since the approval");
      assert.strictEqual(await note({}, local({ clean: "tree2" })), "a merge carries changes of its own");
      assert.strictEqual(await note({}, local({ conflict: true })), "a merge had conflicts resolved by hand");
      assert.strictEqual(await note({}, local({ rewritten: true })), "the branch was rewritten since the approval");
      assert.strictEqual(await note({}, null), "no clone of the repository to check the push in");
      assert.strictEqual((await md.checkReapproval(fake().gh, target, "reask", local())).note, "no dismissed approvals", "on your PR, your own approval is no reviewer's");
      assert.strictEqual((await md.checkReapproval(fake({ state: "MERGED" }).gh, target, "reapprove", local())).verdict, "pass");
      await assert.rejects(md.checkReapproval(fake({ head: "bbb222" }).gh, target, "reapprove", local()), /newer head/, "the dashboard is behind: checked again later");
      await assert.rejects(md.checkReapproval(fake().gh, target, "reapprove", local({ head: "ccc333" })), /newer head/, "so is the remote");
      assert.deepStrictEqual(md.reapproveRequest("a/b", 7, "aaa111", "old111", "— sig"), {
        label: "approval",
        endpoint: "repos/a/b/pulls/7/reviews",
        body: { event: "APPROVE", commit_id: "aaa111", body: `${ra.reapprovalBody("old111")}\n\n— sig` },
      });
      assert.deepStrictEqual(md.reaskRequest("a/b", 7, ["anna"]).body, { reviewers: ["anna"] });
    });

    test("agent plugins: your own skills a prompt names are mounted as a plugin of the run's own", () => {
      const home = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-skills-"));
      const skills = path.join(home, "skills");
      nfsA.mkdirSync(path.join(skills, "twg-jira-resolve-merged-work"), { recursive: true });
      nfsA.writeFileSync(path.join(skills, "twg-jira-resolve-merged-work", "SKILL.md"), "---\nname: twg-jira-resolve-merged-work\n---\n");
      nfsA.mkdirSync(path.join(skills, "creatio-code-review"), { recursive: true });
      nfsA.writeFileSync(path.join(skills, "creatio-code-review", "SKILL.md"), "x");
      const owned = [{ name: "creatio-development", installPath: "/p", skills: ["creatio-code-review"] }];
      const mount = path.join(home, "mount");
      const r = plugins.mountUserSkills("/twg-jira-resolve-merged-work {url} and /creatio-code-review and /nope", owned, mount, skills);
      assert.strictEqual(r.prompt, "/prd-user-skills:twg-jira-resolve-merged-work {url} and /creatio-code-review and /nope", "a plugin's skill and an unknown one stay as written");
      assert.deepStrictEqual(r.pluginDirs, [mount]);
      assert.strictEqual(JSON.parse(nfsA.readFileSync(path.join(mount, ".claude-plugin", "plugin.json"), "utf8")).name, "prd-user-skills");
      assert.ok(nfsA.existsSync(path.join(mount, "skills", "twg-jira-resolve-merged-work", "SKILL.md")));
      assert.ok(!nfsA.existsSync(path.join(mount, "skills", "creatio-code-review")), "only what the prompt names");
      assert.deepStrictEqual(plugins.mountUserSkills("/nope", owned, mount, skills), { prompt: "/nope", pluginDirs: [] });
    });

    await atest("agent publish: a shadow review's writes are captured, then posted on your Publish — signed, once, at the head it saw", async () => {
      const posted = [];
      const notices = [];
      let head = "aaa111";
      const f = agentFixture({
        script: reviewWithPlan(),
        captureScript: captureJs,
        fetchPr: async () => ({ pr: { ...reviewPr(), headOid: head }, state: "OPEN", viewer: "me" }),
        gh: async (args, opts) => (posted.push({ args, body: JSON.parse(opts.input) }), { code: 0, stdout: "{}", stderr: "" }),
        notify: (n) => notices.push([n.kind, n.item.headline]),
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const item = only(f)[0];
        assert.strictEqual(item.headline, "Would post: request changes, 1 inline comment");
        assert.strictEqual(actionLabel(item), "Send review");
        assert.strictEqual(posted.length, 0, "Shadow posts nothing by itself");
        assert.deepStrictEqual(notices, [["needsYou", item.headline]]);
        const args = f.children[0].args;
        assert.ok(args.includes("Write") && args.some((a) => /^Bash\(\/.*pr-review-publish\.sh \*\)$/.test(a)), "the wrapper's rule and Write are granted");
        assert.match(args[args.indexOf("--append-system-prompt") + 1], /publishCommand: "\/.*pr-review-publish\.sh"/);
        const sf = args[args.indexOf("--settings") + 1];
        const g = JSON.parse(nfsA.readFileSync(path.join(path.dirname(sf), "guard.json"), "utf8"));
        assert.ok(g.wrapperPath && g.outDir && Array.isArray(g.workflowDirs), "the guard knows the run's wrapper and payload folder");
        assert.strictEqual(g.workDir, item.worktree, "a review's guard knows its worktree too");
        assert.deepStrictEqual(g.readDirs.slice(0, 2), [item.worktree, g.outDir], "it reads its worktree and payload folder");
        assert.strictEqual(g.sessionId, args[args.indexOf("--session-id") + 1], "and its own session's spill-over");
        assert.ok(g.sessionRoots.length >= 2);
        assert.match(nfsA.readFileSync(sf, "utf8"), /guard\.json/, "and the hook is handed that file");
        head = "bbb222";
        assert.match((await f.agent.act({ type: "publish", runId: item.runId })).error, /new commits/);
        assert.strictEqual(posted.length, 0);
        head = "aaa111";
        assert.deepStrictEqual(await f.agent.act({ type: "publish", runId: item.runId }), { ok: true });
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].args[1], `repos/${item.repo}/pulls/7/reviews`);
        assert.strictEqual(posted[0].body.event, "REQUEST_CHANGES");
        assert.ok(posted[0].body.body.endsWith(ad.DEFAULT_AGENT_SIGNATURE), "the signature is the app's");
        assert.deepStrictEqual([only(f)[0].state, only(f)[0].published], ["done", true]);
        assert.strictEqual(f.agent.getState().acceptedUnchanged, 1);
        assert.strictEqual((await f.agent.act({ type: "publish", runId: item.runId })).ok, false, "never twice");
        assert.strictEqual(posted.length, 1);
        const state = JSON.parse(nfsA.readFileSync(path.join(f.dir, "agent", "state.json"), "utf8"));
        assert.strictEqual(state.ledger[item.key].state, "published");
        assert.match(nfsA.readFileSync(path.join(f.dir, "agent", "log.jsonl"), "utf8"), /"event":"published"/);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent publish: in On the app posts right after the run, and holds an approve while someone else asks for changes", async () => {
      const posted = [];
      const f = agentFixture({
        agent: { scenarios: { review: { mode: "on", holdApproveOnChangeRequest: true } } },
        script: reviewWithPlan("APPROVE"),
        captureScript: captureJs,
        fetchPr: async () => ({
          pr: { ...reviewPr(), reviewers: [{ login: "other", avatarUrl: "", reviewState: "changes_requested" }, { login: "me", avatarUrl: "", reviewState: "approved" }] },
          state: "OPEN",
          viewer: "me",
        }),
        gh: async (_args, opts) => (posted.push(JSON.parse(opts.input)), { code: 0, stdout: "", stderr: "" }),
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "done"));
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].event, "COMMENT");
        assert.ok(posted[0].body.includes(pub.HELD_APPROVE_NOTE));
        assert.match(only(f)[0].headline, /^Published: comment, 1 inline comment \(approve held\)$/);
        assert.strictEqual(f.agent.getState().acceptedUnchanged, 0, "only your own Publish counts toward the On hint");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent merge: your ready PR gets an offer; the click merges that head only, then the Jira dry run runs", async () => {
      const ghCalls = [];
      const notices = [];
      const mine = { ...reviewPr({ role: "author" }), mergeMethods: { suggested: "squash", allowed: ["squash", "merge"] } };
      const f = agentFixture({
        pr: mine,
        script: succeed("Would resolve ENG-1."),
        fetchPr: async () => ({ pr: mine, state: "OPEN", viewer: "me" }),
        gh: async (args) => (ghCalls.push(args), { code: 0, stdout: "✓ Squashed and merged", stderr: "" }),
        notify: (n) => notices.push(n.kind),
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        const offer = only(f)[0];
        assert.deepStrictEqual([offer.scenario, offer.state, offer.headline, offer.mergeMethod], ["merge", "needsYou", "Ready to merge — squash", "squash"]);
        assert.strictEqual(f.children.length, 0, "an offer starts no session");
        f.agent.onSnapshot(f.snapshot);
        assert.strictEqual(only(f).length, 1, "one offer per head");
        assert.deepStrictEqual(await f.agent.act({ type: "merge", runId: offer.runId, method: "merge" }), { ok: true });
        assert.deepStrictEqual(ghCalls[0], ["pr", "merge", mine.url, "--merge", "--match-head-commit", "aaa111", "--delete-branch"]);
        assert.match(only(f)[0].headline, /^Merged \(merge\), branch deleted$/);
        // The PR leaves the dashboard; its Jira dry run still runs and still shows.
        f.snapshot.pullRequests = [];
        await until(() => only(f).some((i) => i.scenario === "afterMerge" && i.state === "needsYou"));
        const dry = only(f).find((i) => i.scenario === "afterMerge");
        assert.strictEqual(dry.headline, "Jira dry run ready — apply it in a session");
        assert.strictEqual(actionLabel(dry), "Update Jira…");
        const settingsFile = f.children[0].args[f.children[0].args.indexOf("--settings") + 1];
        assert.match(nfsA.readFileSync(settingsFile, "utf8"), /hook\.js[\s\S]*afterMerge/, "the dry run runs under the read-only guard");
        assert.match(f.children[0].args[f.children[0].args.indexOf("--append-system-prompt") + 1], /change nothing in Jira/);
        assert.ok(notices.includes("needsYou") && notices.includes("finished"));
        const board = view.stageColumns([], [], f.agent.getState(), { today: view.todayKey(new Date()) });
        assert.ok(board.mine.done.some((c) => c.stage.item?.runId === dry.runId && c.stage.action?.kind === "updateJira"), "it shows under Merged today though its PR is gone");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent merge: a push since the offer, or a PR no longer ready, merges nothing", async () => {
      const ghCalls = [];
      const mine = { ...reviewPr({ role: "author" }), mergeMethods: { suggested: "squash", allowed: ["squash"] } };
      let fresh = { ...mine, headOid: "ccc333" };
      const f = agentFixture({
        pr: mine,
        script: succeed("x"),
        fetchPr: async () => ({ pr: fresh, state: "OPEN", viewer: "me" }),
        gh: async (args) => (ghCalls.push(args), { code: 0, stdout: "", stderr: "" }),
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        const offer = only(f)[0];
        assert.match((await f.agent.act({ type: "merge", runId: offer.runId })).error, /new commits/);
        fresh = { ...mine, ciState: "failure" };
        assert.match((await f.agent.act({ type: "merge", runId: offer.runId })).error, /CI is red/);
        assert.strictEqual(ghCalls.length, 0);
        assert.strictEqual(only(f)[0].state, "needsYou");
      } finally {
        f.agent.stop();
      }
    });

    test("ipc: Publish names a run; Merge may name a method the app knows", () => {
      const RID = "00000000-0000-4000-8000-000000000001";
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "publish", runId: RID }), { type: "publish", runId: RID });
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "merge", runId: RID }), { type: "merge", runId: RID });
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "merge", runId: RID, method: "rebase", extra: 1 }), { type: "merge", runId: RID, method: "rebase" });
    });

    test("agent view: the first button of a prepared review is Publish, of an offer Merge", () => {
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "needsYou", plan: { event: "COMMENT" }, sessionId: "s" })), "Send review");
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "needsYou", plan: { event: "COMMENT" }, published: true, sessionId: "s" })), null, "sent: nothing left to do");
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "needsYou", scenario: "merge" })), "Merge");
    });

    // --- stage 5: re-review (threads, escalations) and drive (commits, the app's push) ---
    const driveMod = require(path.join(__dirname, "../dist/main/main/agent/drive.js"));
    const captureMod = require(captureJs);

    test("publish plan: an escalation holds back the reply to its thread and is listed for you; re-review switches drop resolves and approves", () => {
      assert.deepStrictEqual(pub.parsePublishCall(["escalate", "a/b", "7", "55", "/x/why.txt"]).value, { sub: "escalate", repo: "a/b", number: 7, replyTo: 55, file: "/x/why.txt" });
      const steps = [
        { kind: "review", event: "APPROVE", body: "b", comments: [] },
        { kind: "reply", replyTo: 55, body: "still applies" },
        { kind: "reply", replyTo: 56, body: "still applies too" },
        { kind: "escalate", replyTo: 55, body: "design call" },
        { kind: "resolve", threadId: "PRRT_a" },
      ];
      const ctx = { repo: "a/b", number: 7, signature: "s", holdApprove: false };
      assert.deepStrictEqual(pub.planRequests(steps, ctx).map((r) => r.endpoint), ["repos/a/b/pulls/7/reviews", "repos/a/b/pulls/7/comments/56/replies", "graphql"], "no reply where the thread was handed back");
      const off = pub.planRequests(steps, { ...ctx, allowResolve: false, allowApprove: false });
      assert.deepStrictEqual(off.map((r) => r.endpoint), ["repos/a/b/pulls/7/reviews", "repos/a/b/pulls/7/comments/56/replies"]);
      assert.strictEqual(off[0].body.event, "COMMENT", "approve is off for re-reviews");
      const sum = pub.summarizePlan(steps);
      assert.deepStrictEqual(sum.replies.map((r) => r.replyTo), [56]);
      assert.deepStrictEqual(sum.escalations, [{ replyTo: 55, body: "design call" }]);
      assert.strictEqual(pub.describePlan(sum), "approve, 1 reply, 1 resolve, 1 dispute for you");
      assert.deepStrictEqual(pub.readPlanLines(steps.map((x) => JSON.stringify(x)).join("\n")), steps);
    });

    test("capture: a run's own list of subcommands — a drive only replies", () => {
      const runDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-cap-"));
      const outDir = path.join(runDir, "out");
      nfsA.mkdirSync(outDir);
      const run = { repo: "a/b", number: 7, outDir, wrapperPath: "x", subs: ["reply"] };
      const file = path.join(outDir, "r.txt");
      nfsA.writeFileSync(file, "fixed in abc123");
      assert.deepStrictEqual(captureMod.captureCall(run, ["reply", "a/b", "7", "9", file]), { step: { kind: "reply", replyTo: 9, body: "fixed in abc123" } });
      assert.match(captureMod.captureCall(run, ["resolve", "PRRT_x"]).error, /may not resolve/);
      assert.match(captureMod.captureCall(run, ["escalate", "a/b", "7", "9", file]).error, /may not escalate/);
      assert.deepStrictEqual(captureMod.captureCall({ ...run, subs: undefined }, ["escalate", "a/b", "7", "9", file]), { step: { kind: "escalate", replyTo: 9, body: "fixed in abc123" } });
    });

    await atest("publish: a review answers and resolves only in your threads; your own PR's drive answers reviewers and resolves nothing", async () => {
      const gh = async (args) => {
        if (args[1] === "graphql") {
          return { code: 0, stdout: JSON.stringify({ data: { node: { isResolved: false, pullRequest: { number: 7, repository: { nameWithOwner: "a/b" } }, comments: { nodes: [{ author: { login: "colleague" } }] } } } }), stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ pull_request_url: "https://api.github.com/repos/a/b/pulls/7", user: { login: "colleague" } }), stderr: "" };
      };
      const url = "https://github.com/a/b/pull/7";
      assert.match(await publishMod.checkPlanTargets([{ kind: "resolve", threadId: "PRRT_c" }], url, "a/b", 7, { viewer: "me", mine: true }, gh), /not yours/);
      assert.match(await publishMod.checkPlanTargets([{ kind: "reply", replyTo: 3, body: "x" }], url, "a/b", 7, { viewer: "me", mine: true }, gh), /colleague's thread/);
      assert.strictEqual(await publishMod.checkPlanTargets([{ kind: "reply", replyTo: 3, body: "x" }], url, "a/b", 7, { viewer: "me", mine: false }, gh), null, "a drive answers a reviewer in theirs");
      const myReplyInTheirs = async () => ({ code: 0, stdout: JSON.stringify({ pull_request_url: "https://api.github.com/repos/a/b/pulls/7", user: { login: "me" }, in_reply_to_id: 1 }), stderr: "" });
      assert.match(await publishMod.checkPlanTargets([{ kind: "reply", replyTo: 4, body: "x" }], url, "a/b", 7, { viewer: "me", mine: true }, myReplyInTheirs), /not the start of a thread/, "your reply in a colleague's thread is still theirs");
      assert.match(await publishMod.checkPlanTargets([{ kind: "resolve", threadId: "PRRT_c" }], url, "a/b", 7, { viewer: "me", mine: false }, gh), /doesn't resolve/);
      assert.match(await publishMod.checkPlanTargets([{ kind: "resolve", threadId: "PRRT_c" }], url, "a/b", 7, { viewer: null, mine: true }, gh), /login on the host is unknown/);
    });

    test("mapPr: the author's latest thread answer, a reviewer's latest open-thread comment, and whether the branch is in a fork", () => {
      const thread = (login, at, isResolved = false) => ({ isResolved, comments: { totalCount: 2, nodes: [{ author: { login }, createdAt: at }] } });
      const pr = github.mapPr(
        rawPr({
          isCrossRepository: true,
          reviewThreads: {
            totalCount: 4,
            nodes: [thread("auth", "2026-07-08T00:00:00Z"), thread("auth", "2026-07-09T00:00:00Z"), thread("rev", "2026-07-10T00:00:00Z"), thread("rev", "2026-07-11T00:00:00Z", true)],
          },
        }),
        "GH",
        ["reviewed"],
        "me",
      );
      assert.strictEqual(pr.authorRepliedAt, "2026-07-09T00:00:00Z");
      assert.strictEqual(pr.reviewerRepliedAt, "2026-07-10T00:00:00Z", "a resolved thread asks nothing of the author");
      assert.strictEqual(pr.isCrossRepository, true);
      assert.strictEqual(github.mapPr(rawPr(), "GH", ["author"], "me").isCrossRepository, false);
    });

    test("agent policy: a re-review once the author answers after your review — a push, a thread reply — or asks you again", () => {
      const at = (h) => `2026-07-0${h}T00:00:00Z`;
      const rv = (o = {}) => ({ ...reviewPr({ viewerHasReviewed: true, role: "reviewed", requestedOfMe: false }), viewerReviewedAt: at(5), viewerReviewedHead: false, lastCommitPushedAt: at(4), authorRepliedAt: null, ...o });
      assert.strictEqual(policy.authorActivitySince(rv()), null);
      assert.strictEqual(policy.authorActivitySince(rv({ lastCommitPushedAt: at(6) })), at(6));
      assert.strictEqual(policy.authorActivitySince(rv({ lastCommitPushedAt: at(6), viewerReviewedHead: true })), null, "your review is on the head: no push since");
      assert.strictEqual(policy.authorActivitySince(rv({ authorRepliedAt: at(7), lastCommitPushedAt: at(6) })), at(7));
      assert.strictEqual(policy.authorActivitySince(rv({ viewerReviewedAt: null, authorRepliedAt: at(7) })), null, "after a plain Comment there is nothing to compare with");
      assert.match(policy.planJobs([rv()], agentOn(), noSessions).idle.get("PR_R"), /nothing new from the author/);
      const replied = policy.planJobs([rv({ authorRepliedAt: at(7) })], agentOn(), noSessions).jobs;
      assert.deepStrictEqual(replied.map((j) => [j.scenario, j.kind, j.mode, j.key]), [["rereview", "rereview", "shadow", `PR_R|rereview|aaa111|reply@${at(7)}`]]);
      const later = policy.planJobs([rv({ authorRepliedAt: at(8) })], agentOn(), noSessions).jobs[0].key;
      assert.notStrictEqual(later, replied[0].key, "a later reply without a push is new work");
      const asked = policy.planJobs([rv({ roles: ["reviewer"], requestedOfMe: true })], agentOn(), noSessions).jobs[0];
      assert.match(asked.key, /\|asked@-$/);
      // Asked again on the very head your approval stands on, with no answer from the author: a re-review could only approve again.
      const approved = policy.planJobs([rv({ roles: ["reviewer"], requestedOfMe: true, viewerReviewedHead: true, viewerApproved: true })], agentOn(), noSessions);
      assert.deepStrictEqual(approved.jobs, []);
      assert.strictEqual(approved.idle.get("PR_R"), "Asked again — your approval stands on this head and the author hasn't answered since");
      // …after a change request on that head, the request itself is the author's "look again": the re-review runs, once per head and request.
      const same = policy.planJobs([rv({ roles: ["reviewer"], requestedOfMe: true, viewerReviewedHead: true, viewerApproved: false })], agentOn(), noSessions);
      assert.deepStrictEqual(same.jobs.map((j) => [j.scenario, j.mode, j.key]), [["rereview", "shadow", "PR_R|rereview|aaa111|asked@-"]]);
      assert.strictEqual(same.idle.get("PR_R"), undefined);
      assert.deepStrictEqual(policy.planJobs([rv({ roles: ["reviewed"], requestedOfMe: false, viewerReviewedHead: true })], agentOn(), noSessions).jobs, [], "not asked again: nothing new, nothing runs");
      const answered = policy.planJobs([rv({ roles: ["reviewer"], requestedOfMe: true, viewerReviewedHead: true, authorRepliedAt: at(7) })], agentOn(), noSessions).jobs[0];
      assert.strictEqual(answered.key, `PR_R|rereview|aaa111|asked@${at(7)}`, "an answer in a thread since your review is new work on the same head");
      assert.match(policy.planJobs([rv({ authorRepliedAt: at(7) })], agentOn({ scenarios: { rereview: { mode: "off" } } }), noSessions).idle.get("PR_R"), /re-reviews are off/);
    });

    test("agent policy: a PR with no clone of its repository gets no run — it waits and says why; offers need none", () => {
      const none = { ...noSessions, noCheckout: (pr) => `No checkout of ${pr.repo} — set its folder in Settings › Claude` };
      const r = policy.planJobs([reviewPr()], agentOn(), none);
      assert.deepStrictEqual(r.jobs, []);
      assert.match(r.idle.get("PR_R"), /^No checkout of .+ — set its folder in Settings › Claude$/);
      const mergeOnly = policy.planJobs([reviewPr({ role: "author" })], agentOn(), none);
      assert.deepStrictEqual([mergeOnly.jobs.length, mergeOnly.merges.map((m) => m.scenario)], [0, ["merge"]], "a merge offer doesn't depend on a clone");
      const why = policy.planJobs([reviewPr()], agentOn(), { ...noSessions, noCheckout: () => null });
      assert.strictEqual(why.jobs.length, 1, "with a clone the review is planned as before");
      assert.match(policy.planJobs([reviewPr({ isIgnored: true })], agentOn(), none).idle.get("PR_R"), /Ignored/, "the reason a PR is skipped anyway comes first");
    });

    test("agent policy: your PR is driven for red CI, conflicts or review comments — not a draft, not a fork, not past its attempts", () => {
      const mine = (o = {}) => ({ ...reviewPr({ role: "author" }), ciState: "failure", ...o });
      assert.deepStrictEqual(policy.driveReasons(mine({ hasConflicts: true, hasUnaddressedComments: true }), agentOn()), ["ci", "conflicts", "comments"]);
      assert.deepStrictEqual(policy.driveReasons(mine(), agentOn({ scenarios: { driveCi: { mode: "off" } } })), []);
      const job = policy.planJobs([mine()], agentOn(), noSessions).jobs[0];
      assert.deepStrictEqual([job.scenario, job.kind, job.mode, job.reasons, job.key], ["drive", "drive", "shadow", ["ci"], "PR_R|drive|aaa111|ci"]);
      const both = policy.planJobs([mine({ hasUnaddressedComments: true, reviewerRepliedAt: "2026-07-09T00:00:00Z" })], agentOn({ scenarios: { driveCi: { mode: "on" } } }), noSessions).jobs[0];
      assert.strictEqual(both.mode, "shadow", "one Shadow reason keeps the run in Shadow");
      assert.strictEqual(both.key, "PR_R|drive|aaa111|ci+comments@2026-07-09T00:00:00Z");
      assert.strictEqual(policy.planJobs([mine()], agentOn({ scenarios: { driveCi: { mode: "on" } } }), noSessions).jobs[0].mode, "on");
      assert.match(policy.planJobs([mine({ isDraft: true })], agentOn(), noSessions).idle.get("PR_R"), /draft/);
      assert.match(policy.planJobs([mine({ isCrossRepository: true })], agentOn(), noSessions).idle.get("PR_R"), /fork/);
      assert.match(policy.planJobs([mine()], agentOn(), { ...noSessions, driveExhausted: () => "Yours — the agent tried 2 times; over to you" }).idle.get("PR_R"), /tried 2 times/);
      assert.strictEqual(policy.planJobs([mine()], agentOn(), noSessions).merges.length, 0, "a red PR is not offered for merge");
    });

    // --- three processes: your PR an orchestrator run drives (A), your PR without one (B), a PR you review (C) ---
    test("agent policy B: your PR, not ready and nothing broken, gets a self-review per head — not one already self-reviewed, nor the agent's own push", () => {
      const mine = (o = {}) => ({ ...reviewPr({ role: "author" }), awaitingReview: true, ...o });
      const s = agentOn();
      assert.ok(policy.mergeBlocker(mine(), s), "the fixture PR isn't ready to merge");
      const job = policy.planJobs([mine()], s, noSessions).jobs[0];
      assert.deepStrictEqual([job.scenario, job.kind, job.mode, job.reasons, job.key], ["drive", "drive", "shadow", ["self"], "PR_R|drive|aaa111|self"]);
      const done = policy.planJobs([mine()], s, { ...noSessions, selfReviewed: () => true });
      assert.deepStrictEqual(done.jobs, []);
      assert.match(done.idle.get("PR_R"), /^Yours — self-reviewed; /, "waiting for reviewers, and says what it waits for");
      assert.match(policy.planJobs([mine({ isDraft: true })], s, noSessions).idle.get("PR_R"), /^Yours — /, "a draft gets none");
      assert.deepStrictEqual(policy.planJobs([mine()], agentOn({ scenarios: { selfReview: { mode: "off" } } }), noSessions).jobs, []);
      assert.strictEqual(policy.planJobs([mine({ ciState: "failure" })], s, noSessions).jobs[0].reasons[0], "ci", "broken comes first: a drive, not a self-review");
    });

    test("agent policy A: your PR an SDLC orchestrator run drives is left alone — no self-review, no drive; once ready, only a Merge button", () => {
      const mine = (o = {}) => ({ ...reviewPr({ role: "author" }), ...o });
      const ctx = { ...noSessions, orchestrated: () => "the SDLC orchestrator runs ENG-1 (stage review) — the agent leaves it to it" };
      for (const pr of [mine({ awaitingReview: true }), mine({ ciState: "failure" }), mine({ hasUnaddressedComments: true, awaitingReview: true })]) {
        const r = policy.planJobs([pr], agentOn(), ctx);
        assert.deepStrictEqual([r.jobs, r.merges], [[], []]);
        assert.strictEqual(r.idle.get("PR_R"), "Yours — the SDLC orchestrator runs ENG-1 (stage review) — the agent leaves it to it");
      }
      // The run waits for someone to merge: a ready PR gets the offer — no session, the merge on your click.
      const ready = policy.planJobs([mine()], agentOn(), ctx);
      assert.deepStrictEqual([ready.jobs.length, ready.merges.map((m) => m.scenario)], [0, ["merge"]]);
      assert.deepStrictEqual(policy.planJobs([mine()], agentOn({ scenarios: { merge: { mode: "off" } } }), ctx).merges, [], "offers off: none");
      // C: someone else's PR is reviewed whoever drives it.
      assert.strictEqual(policy.planJobs([reviewPr()], agentOn(), ctx).jobs[0].scenario, "review");
    });

    test("agent prompts: each run on your PR starts from its own prompt; a review from yours", () => {
      const claude = cfg.validateSettings({ hosts: [] }).claude;
      assert.match(agentCore.promptFor({ scenario: "drive", reasons: ["self"] }, claude), /creatio-code-review .*dryRun: true[\s\S]*validate-and-fix-review-comments/);
      assert.match(agentCore.promptFor({ scenario: "drive", reasons: ["comments"] }, claude), /^\/validate-and-fix-review-comments /);
      assert.strictEqual(agentCore.promptFor({ scenario: "drive", reasons: ["ci", "comments"] }, claude), claude.prompts.drive, "broken: your «PR is blocked» prompt");
      assert.strictEqual(agentCore.promptFor({ scenario: "review" }, claude), claude.prompts.review);
      const mineSet = { ...claude, agentPrompts: { ...claude.agentPrompts, selfReview: "/my-self-review {url}" } };
      assert.strictEqual(agentCore.promptFor({ scenario: "drive", reasons: ["self"] }, mineSet), "/my-self-review {url}");
      const rules = agentCore.agentRules("drive", "shadow", null, { repo: "a/b", number: 7, reasons: ["self"] });
      assert.match(rules, /self-review of the user's own PR[\s\S]*dryRun: true — it must post nothing/);
      assert.match(agentCore.agentRules("drive", "shadow", null, { repo: "a/b", number: 7, reasons: ["comments"] }), /business, product or design decision/);
      assert.strictEqual(view.itemVerb({ scenario: "drive", reasons: ["self"] }), "Self-reviewing");
    });

    test("agent sdlc: a live orchestrator run is found by the PR it published, in the checkout or a worktree; an ended one and a lookalike URL aren't", () => {
      const sdlc = require(path.join(__dirname, "../dist/main/main/agent/sdlc.js"));
      const co = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-sdlc-"));
      const url = "https://creatio.ghe.com/eng/core/pull/37";
      const write = (dir, name, o) => {
        nfsA.mkdirSync(dir, { recursive: true });
        nfsA.writeFileSync(path.join(dir, name), JSON.stringify(o, null, 2));
      };
      assert.strictEqual(sdlc.orchestratorRunFor(co, url), null, "no .sdlc at all");
      write(path.join(co, ".sdlc", "state"), "ENG-9.json", { lifecycle_status: "in_progress", current_stage: "review", outputs: { published_pr_reference: { url: url + "1" } } });
      assert.strictEqual(sdlc.orchestratorRunFor(co, url), null, "…/pull/371 is another PR");
      write(path.join(co, ".sdlc", "state"), "ENG-8.change_set.json", { url });
      assert.strictEqual(sdlc.orchestratorRunFor(co, url), null, "a side file isn't a run");
      write(path.join(co, ".sdlc", "state"), "ENG-7.json", { lifecycle_status: "completed", current_stage: "done", outputs: { published_pr_reference: { url } } });
      assert.strictEqual(sdlc.orchestratorRunFor(co, url), null, "an ended run lets the PR go");
      write(path.join(co, ".claude", "worktrees", "w1", ".sdlc", "state"), "ENG-6.json", { lifecycle_status: "blocked", current_stage: "fix_findings", outputs: { published_pr_reference: { url } } });
      assert.deepStrictEqual(sdlc.orchestratorRunFor(co, url), { key: "ENG-6", stage: "fix_findings", status: "blocked" }, "found in a worktree; blocked still holds it");
      assert.strictEqual(sdlc.describeOrchestratorRun({ key: "ENG-6", stage: "fix_findings", status: "blocked" }), "the SDLC orchestrator runs ENG-6 (stage fix findings) — the agent leaves it to it");
      // A metarepo's run keeps its state at home and publishes to a member repository.
      const projects = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-projects-"));
      const meta = path.join(projects, "meta");
      const member = path.join(projects, "member");
      nfsA.mkdirSync(member, { recursive: true });
      const memberPr = "https://creatio.ghe.com/eng/member/pull/22";
      write(path.join(meta, ".sdlc", "state"), "ENG-4.json", { lifecycle_status: "blocked", current_stage: "publish_pr", outputs: { published_pr_reference: { url: memberPr } } });
      assert.strictEqual(sdlc.orchestratorRunFor(member, memberPr), null, "not in the PR's own checkout");
      const roots = sdlc.orchestratorRoots(member, { projectsRoot: projects, repoPaths: {} });
      assert.ok(roots.includes(meta) && roots.includes(member));
      assert.strictEqual(sdlc.orchestratorRunFor(roots, memberPr).key, "ENG-4", "found at the metarepo's home");
    });

    await atest("agent: your PR an orchestrator run published gets no run, says why on the Board, wears its badge, and refuses a hand-over", async () => {
      const mine = { ...reviewPr({ role: "author" }), awaitingReview: true };
      const f = agentFixture({ pr: mine, script: succeed("done") });
      try {
        // The fixture's checkout carries the orchestrator's state for this very PR.
        const state = path.join(f.dir, "checkout", ".sdlc", "state");
        nfsA.mkdirSync(state, { recursive: true });
        nfsA.writeFileSync(path.join(state, "ENG-5.json"), JSON.stringify({ lifecycle_status: "in_progress", current_stage: "review", outputs: { published_pr_reference: { url: mine.url } } }));
        f.agent.onSnapshot(f.snapshot);
        await tickOnce();
        assert.strictEqual(f.children.length, 0);
        assert.match(f.agent.getState().idle[mine.id], /SDLC orchestrator runs ENG-5/);
        assert.deepStrictEqual(f.agent.getState().orchestrated, { [mine.id]: { key: "ENG-5", stage: "review" } }, "the badge, as data");
        assert.match((await f.agent.act({ type: "enqueue", prId: mine.id })).error, /SDLC orchestrator runs ENG-5/);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent: your PR without an orchestrator run gets its self-review, from the self-review prompt", async () => {
      const mine = { ...reviewPr({ role: "author" }), awaitingReview: true };
      // A drive reads its git place before the session; this stands in for git.
      const common = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-common-"));
      nfsA.writeFileSync(path.join(common, "config"), "[core]\n");
      const gitImpl = async (all) => {
        let i = 0;
        for (;;) {
          if (all[i] === "-c") i += 2;
          else if (/^--(git-dir|work-tree)=/.test(all[i] ?? "")) i += 1;
          else break;
        }
        const args = all.slice(i);
        if (args[0] === "config") return `file:${common}/config\0core.bare\0`;
        if (args[0] === "rev-parse") return `${common}\n`;
        if (args[0] === "remote") return "https://github.com/a/b.git\n";
        return "";
      };
      const f = agentFixture({ pr: mine, script: succeed("Nothing to fix."), git: gitImpl });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.children.length === 1);
        assert.match(f.children[0].written, /creatio-code-review/);
        assert.match(f.children[0].written, /dryRun: true/);
        const item = only(f)[0];
        assert.deepStrictEqual([item.scenario, item.reasons], ["drive", ["self"]]);
      } finally {
        f.agent.stop();
      }
    });

    test("agent tools: a self-review reads Jira, so drive lists twg; a list saved before gets it", () => {
      assert.ok(ad.DEFAULT_AGENT_TOOLS.drive.includes("Bash(twg *)"));
      const migrated = cfg.validateAgent({ permissions: { tools: { drive: ["Read"] }, toolsVersion: 2 } });
      assert.deepStrictEqual(migrated.permissions.tools.drive, ["Read", "Bash(twg *)"], "only what came after the version it was saved at");
      assert.strictEqual(cfg.validateAgent(undefined).scenarios.selfReview.mode, "shadow");
    });

    await atest("drive: commits on top of the head are read oldest first; a rewritten history is not a fast-forward", async () => {
      const repo = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-drive-"));
      const g = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
      g("init", "-q");
      nfsA.writeFileSync(path.join(repo, "a.txt"), "1\n");
      g("add", "a.txt");
      g("commit", "-q", "-m", "base");
      const base = g("rev-parse", "HEAD").stdout.trim();
      for (const [n, msg] of [["2", "fix: one"], ["3", "fix: two"]]) {
        nfsA.writeFileSync(path.join(repo, "a.txt"), `${n}\n`);
        g("commit", "-q", "-am", msg);
      }
      const read = await driveMod.withNoHooks((h) => driveMod.collectDrive(wt.runGit, repo, base, ["ci"], h));
      assert.deepStrictEqual(read.drive.commits.map((c) => c.subject), ["fix: one", "fix: two"]);
      assert.strictEqual(read.fastForward, true);
      assert.strictEqual(read.merges, 0);
      assert.strictEqual(read.drive.head, g("rev-parse", "HEAD").stdout.trim(), "the commit a Push would send");
      assert.match(read.drive.stat, /a\.txt/);
      assert.match(read.drive.patch, /^\+3$/m);
      // A merge among the run's commits is counted — a stack's layer must not get one.
      const fixes = g("rev-parse", "HEAD").stdout.trim();
      g("checkout", "-q", "-b", "side", base);
      nfsA.writeFileSync(path.join(repo, "b.txt"), "side\n");
      g("add", "b.txt");
      g("commit", "-q", "-m", "side");
      g("checkout", "-q", "-");
      g("checkout", "-q", fixes);
      g("merge", "-q", "--no-edit", "side");
      const merged = await driveMod.withNoHooks((h) => driveMod.collectDrive(wt.runGit, repo, base, ["ci"], h));
      assert.deepStrictEqual([merged.merges, merged.fastForward], [1, true], "a merge is still a fast-forward — but it is one");
      g("reset", "-q", "--hard", base);
      nfsA.writeFileSync(path.join(repo, "a.txt"), "amended\n");
      g("commit", "-q", "--amend", "-am", "base, amended");
      assert.strictEqual((await driveMod.withNoHooks((h) => driveMod.collectDrive(wt.runGit, repo, base, [], h))).fastForward, false, "an amended base is not a fast-forward");
      g("reset", "-q", "--hard", base);
      assert.deepStrictEqual((await driveMod.withNoHooks((h) => driveMod.collectDrive(wt.runGit, repo, base, [], h))).drive.commits, []);
      await assert.rejects(driveMod.withNoHooks((h) => driveMod.collectDrive(wt.runGit, repo, "HEAD~1", [], h)), /no head commit/);
    });

    test("drive: the app pushes the exact commit you saw, to the URL read before the run — no --force, no hooks", () => {
      const oid = "c".repeat(40);
      const args = driveMod.pushArgs("https://github.com/a/b.git", oid, "feature/x-1", "/nohooks");
      assert.deepStrictEqual(args.slice(-4), ["push", "--no-verify", "https://github.com/a/b.git", `${oid}:refs/heads/feature/x-1`]);
      assert.ok(args.includes("core.hooksPath=/nohooks") && args.includes("core.fsmonitor=false"));
      assert.ok(!args.includes("--force") && !args.some((a) => a.startsWith("+")), "never a forced update");
      for (const [url, o, branch] of [
        ["https://h/a.git", oid, "--force"],
        ["https://h/a.git", oid, "a..b"],
        ["https://h/a.git", oid, "x.lock"],
        ["https://h/a.git", "HEAD", "main"],
        ["-u", oid, "main"],
        ["/local/path", oid, "main"],
        ["https://h/a.git", oid, "a b"],
      ]) {
        assert.throws(() => driveMod.pushArgs(url, o, branch, "/nohooks"), /isn't a/, `${url} ${o} ${branch}`);
      }
      // The session's git: no hooks, no network, no credentials.
      const configOf = (env) => Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
      const NO = runner.sessionGitEnv("/run/no-hooks", true);
      const keys = configOf(NO);
      for (const prefix of ["https://", "http://", "git@", "ssh://", "git://"]) {
        assert.ok(keys.some(([k, v]) => k === "url.pr-agent-no-push://.insteadOf" && v === prefix), prefix);
      }
      assert.ok(keys.some(([k, v]) => k === "credential.helper" && v === ""), "the credential helpers are reset");
      assert.ok(keys.some(([k, v]) => k === "core.hooksPath" && v === "/run/no-hooks"), "a commit runs no hook of the repository");
      assert.ok(keys.some(([k, v]) => k === "core.fsmonitor" && v === "false"));
      assert.strictEqual(NO.GIT_SSH_COMMAND, "pr-agent-no-ssh");
      assert.strictEqual(NO.GIT_TERMINAL_PROMPT, "0");
      // A review's session runs no git of its own, but Claude Code's own `git status` may write the index (post-index-change).
      const review = runner.sessionGitEnv("/run/no-hooks", false);
      assert.deepStrictEqual(configOf(review), [["core.hooksPath", "/run/no-hooks"], ["core.fsmonitor", "false"]]);
      assert.strictEqual(review.GIT_SSH_COMMAND, undefined, "a review keeps its network");
      const runDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-run-"));
      nfsA.mkdirSync(path.join(runDir, "no-hooks"));
      nfsA.writeFileSync(path.join(runDir, "no-hooks", "pre-commit"), "#!/bin/sh\n");
      const fresh = runner.freshHooksDir(runDir);
      assert.deepStrictEqual(nfsA.readdirSync(fresh), [], "made afresh: nothing put there before survives");
    });

    await atest("drive: a fingerprint of everything git reads for a push — config files and includes, hooks, the worktree's links", async () => {
      const base = nfsA.realpathSync.native(nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-fp-")));
      const repo = path.join(base, "repo");
      nfsA.mkdirSync(repo);
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
      const g = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env });
      g(repo, "init", "-q");
      nfsA.writeFileSync(path.join(repo, "a.txt"), "1\n");
      g(repo, "add", "a.txt");
      g(repo, "commit", "-q", "-m", "base");
      const wtDir = path.join(base, "wt");
      g(repo, "worktree", "add", "-q", "--detach", wtDir);
      const gitDir = path.resolve(wtDir, g(wtDir, "rev-parse", "--git-dir").stdout.trim());
      const commonDir = path.resolve(wtDir, g(wtDir, "rev-parse", "--git-common-dir").stdout.trim());
      const place = { workTree: wtDir, gitDir };
      const url = "https://github.com/a/b.git";
      const fp = () => driveMod.gitFingerprint(wt.runGit, place, commonDir, url);
      const a = await fp();
      assert.strictEqual(await fp(), a, "stable");
      // An include: the file it names is read too, so a change in it shows.
      const extra = path.join(base, "extra.cfg");
      nfsA.writeFileSync(extra, "[user]\n\tname = x\n");
      nfsA.appendFileSync(path.join(commonDir, "config"), `[include]\n\tpath = ${extra.replace(/\\/g, "/")}\n`);
      const b = await fp();
      assert.notStrictEqual(b, a, "a config change shows");
      nfsA.writeFileSync(extra, "[core]\n\tfsmonitor = evil\n");
      const c = await fp();
      assert.notStrictEqual(c, b, "a change in an included file shows");
      nfsA.writeFileSync(path.join(commonDir, "hooks", "reference-transaction"), "#!/bin/sh\n");
      const d = await fp();
      assert.notStrictEqual(d, c, "a new hook shows");
      nfsA.appendFileSync(path.join(wtDir, ".git"), "\n");
      assert.notStrictEqual(await fp(), d, "a rewritten .git link shows");
    });

    test("drive: config origins are read NUL-separated, unquoted; an SSH push reads only a snapshot of your SSH settings", () => {
      const cwd = path.resolve("/w");
      const out = ["file:C:/Program Files/Git/etc/gitconfig", "core.symlinks", "file:.git/config", "core.bare", "command line:", "core.pager", "file:/odd \"name\"\tx", "user.name", ""].join("\0");
      assert.deepStrictEqual(driveMod.parseConfigOrigins(out, cwd), [path.resolve(cwd, ".git/config"), path.resolve(cwd, "/odd \"name\"\tx"), path.resolve(cwd, "C:/Program Files/Git/etc/gitconfig")].sort());
      // An SSH push reads only the app's snapshot of your SSH settings, resolved by ssh before the session.
      assert.deepStrictEqual(driveMod.sshTarget("git@github.com:a/b.git"), { user: "git", host: "github.com" });
      assert.deepStrictEqual(driveMod.sshTarget("ssh://git@h.example:2222/a/b.git"), { host: "h.example", user: "git", port: "2222" });
      assert.strictEqual(driveMod.sshTarget("https://github.com/a/b.git"), null);
      const snapDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-sshsnap-"));
      const asked = [];
      const snapshot = driveMod.snapshotSsh("git@github-work:a/b.git", (args) => (asked.push(args), "host github-work\nhostname github.com\nuser git\n"));
      assert.deepStrictEqual(asked, [["-G", "-l", "git", "github-work"]]);
      assert.match(snapshot, /^hostname github\.com$/m, "kept in memory, as text");
      assert.strictEqual(driveMod.snapshotSsh("https://github.com/a/b.git", () => ""), null, "nothing to snapshot for HTTPS");
      assert.throws(() => driveMod.snapshotSsh("git@h:a/b", () => "garbage"), /couldn't resolve/);
      assert.throws(() => driveMod.snapshotSsh("ssh://-oProxyCommand=x@h/a", () => "host h"), /isn't an SSH address|couldn't resolve/);
      const withSsh = driveMod.pushArgs("git@github.com:a/b.git", "c".repeat(40), "main", "/h", undefined, "C:\\Users\\Me\\PR Dashboard\\agent\\runs\\r\\ssh_config");
      assert.ok(withSsh.includes('core.sshCommand=ssh -F "C:/Users/Me/PR Dashboard/agent/runs/r/ssh_config"'), withSsh.join(" "));
      assert.throws(() => driveMod.pushArgs("git@h:a", "c".repeat(40), "main", "/h", undefined, 'C:/x"y'), /can't be quoted/);
      const sg = driveMod.safeGit("/h");
      for (const c of ["log.showSignature=false", "core.pager=cat", "gpg.program=pr-agent-no-gpg", "core.fsmonitor=false"]) assert.ok(sg.includes(c), c);
    });

    await atest("drive: the SSH snapshot is a file only for the length of one push, and what a push is checked against never reaches disk", async () => {
      let seen = null;
      await driveMod.withSshSnapshot("host h\nhostname h\n", async (file) => {
        seen = file;
        assert.strictEqual(nfsA.readFileSync(file, "utf8"), "host h\nhostname h\n");
      });
      assert.ok(seen && !nfsA.existsSync(seen), "gone after the push");
      await driveMod.withSshSnapshot(undefined, async (file) => assert.strictEqual(file, undefined, "HTTPS: no file"));
      const dir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-store-"));
      const st = agentStore.openStore(dir, "2026-11-05");
      st.data.items.push({ runId: "r", key: "k", prId: "p", prNumber: 1, repo: "a/b", url: "u", title: "t", hostLabel: "GH", scenario: "drive", mode: "shadow", state: "needsYou", headline: "h", queuedAt: "", pushTo: { url: "https://h/a.git", commonDir: "c", worktreeGitDir: "g", fingerprint: "f", sshSnapshot: "host h" } });
      await st.save();
      assert.ok(!nfsA.readFileSync(path.join(dir, "state.json"), "utf8").includes("pushTo"), "a file a session could rewrite is never what a push trusts");
      // Nor read back: a pushTo planted in the file is dropped on load.
      const planted = JSON.parse(nfsA.readFileSync(path.join(dir, "state.json"), "utf8"));
      planted.items[0].pushTo = { url: "https://evil/x.git", commonDir: "c", worktreeGitDir: "g", fingerprint: "f" };
      nfsA.writeFileSync(path.join(dir, "state.json"), JSON.stringify(planted));
      assert.strictEqual(agentStore.readStore(path.join(dir, "state.json"), "2026-11-05").items[0].pushTo, undefined);
    });

    await atest("drive: each app git operation gets a fresh, empty hooks folder, gone afterwards", async () => {
      let seen = null;
      await driveMod.withNoHooks(async (dir) => {
        seen = dir;
        assert.deepStrictEqual(nfsA.readdirSync(dir), []);
        assert.deepStrictEqual(driveMod.safeGit(dir, { workTree: "/w", gitDir: "/g" }).slice(0, 2), ["--git-dir=/g", "--work-tree=/w"], "the git folder is named, not discovered");
      });
      assert.ok(seen && !nfsA.existsSync(seen));
      let other = null;
      await driveMod.withNoHooks(async (dir) => (other = dir));
      assert.notStrictEqual(other, seen, "never the same folder twice");
      assert.ok(driveMod.isSshUrl("git@github.com:a/b.git") && driveMod.isSshUrl("ssh://git@h/a/b") && !driveMod.isSshUrl("https://h/a/b"));
    });

    await atest("agent drive: your red PR is driven in a session that can't push; on your Push the app pushes a fast-forward and counts the attempt", async () => {
      const mine = { ...reviewPr({ role: "author" }), ciState: "failure", headRefName: "feature/x", baseRefName: "main" };
      let freshHead = "aaa111";
      let worktreeHead = "2222222222222222222222222222222222222222";
      const commonDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-common-"));
      nfsA.writeFileSync(path.join(commonDir, "config"), "[core]\n");
      const pushes = [];
      const f = agentFixture({
        pr: mine,
        script: succeed("Fixed the failing test."),
        fetchPr: async () => ({ pr: { ...mine, headOid: freshHead }, state: "OPEN", viewer: "me" }),
        git: async (all) => {
          let i = 0;
          for (;;) {
            if (all[i] === "-c") i += 2;
            else if (/^--(git-dir|work-tree)=/.test(all[i] ?? "")) i += 1;
            else break;
          }
          const args = all.slice(i);
          if (args[0] === "config") return `file:${commonDir}/config\0core.bare\0`;
          // Newest first, as git log prints it.
          if (args[0] === "log") return "2222222222222222222222222222222222222222\tfix: the failing test\n1111111111111111111111111111111111111111\ttest: cover it\n";
          if (args[0] === "diff") return args.includes("--stat") ? " a.ts | 2 +-" : "+fixed";
          if (args[0] === "rev-parse") return args.includes("HEAD") ? `${worktreeHead}\n` : `${commonDir}\n`;
          if (args[0] === "remote") return "https://github.com/a/b.git\n";
          if (args[0] === "push") pushes.push(all);
          return "";
        },
      });
      // The fixture's head is "aaa111" — too short for a real oid; give the item a real one.
      f.snapshot.pullRequests[0] = { ...mine, headOid: "a".repeat(40) };
      freshHead = "a".repeat(40);
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const item = only(f)[0];
        assert.deepStrictEqual([item.scenario, item.reasons, item.headline], ["drive", ["ci"], "Would push 2 commits: fix: the failing test"]);
        assert.strictEqual(actionLabel(item), "Push 2 fixes");
        assert.deepStrictEqual(item.drive.commits.map((c) => c.subject), ["fix: the failing test", "test: cover it"].reverse());
        assert.strictEqual(pushes.length, 0, "Shadow pushes nothing by itself");
        const c = f.children[0];
        assert.strictEqual(c.env.GIT_SSH_COMMAND, "pr-agent-no-ssh", "the session's git has no network and no credentials");
        const rules = c.args[c.args.indexOf("--append-system-prompt") + 1];
        assert.match(rules, /Never push and never rewrite history/);
        assert.match(rules, /fetched for you as origin\/main/);
        assert.ok(f.gitCalls.some((a) => a[0] === "fetch" && a.includes("+refs/heads/main:refs/remotes/origin/main")), "the app fetches the base before the session");
        assert.strictEqual(item.pushTo.url, "https://github.com/a/b.git");
        assert.match(rules, /Co-Authored-By: Claude/);
        const guardFile = JSON.parse(nfsA.readFileSync(path.join(path.dirname(c.args[c.args.indexOf("--settings") + 1]), "guard.json"), "utf8"));
        assert.ok(guardFile.workDir, "the guard knows its worktree");
        // The fake git made no checkout on disk; the push wants the run's.
        nfsA.mkdirSync(item.worktree, { recursive: true });
        freshHead = "b".repeat(40);
        assert.match((await f.agent.act({ type: "push", runId: item.runId })).error, /someone pushed/);
        assert.strictEqual(pushes.length, 0);
        freshHead = "a".repeat(40);
        // Commits you weren't shown: back to you, nothing pushed.
        worktreeHead = "3333333333333333333333333333333333333333";
        assert.match((await f.agent.act({ type: "push", runId: item.runId })).error, /commits you haven't seen/);
        assert.strictEqual(pushes.length, 0);
        worktreeHead = "2222222222222222222222222222222222222222";
        only(f)[0].state = "needsYou";
        only(f)[0].drive.head = worktreeHead;
        // The repository's git config changed during the run: nothing pushed.
        nfsA.writeFileSync(path.join(commonDir, "config"), "[core]\n\tfsmonitor = evil\n");
        assert.match((await f.agent.act({ type: "push", runId: item.runId })).error, /git config, hooks or links changed/);
        nfsA.writeFileSync(path.join(commonDir, "config"), "[core]\n");
        only(f)[0].state = "needsYou";
        assert.deepStrictEqual(await f.agent.act({ type: "push", runId: item.runId }), { ok: true });
        assert.strictEqual(pushes.length, 1);
        assert.deepStrictEqual(pushes[0].slice(-4), ["push", "--no-verify", "https://github.com/a/b.git", "2222222222222222222222222222222222222222:refs/heads/feature/x"]);
        assert.ok(pushes[0].some((a) => a.startsWith("core.hooksPath=")), "no hook runs in the app's push");
        assert.ok(pushes[0].some((a) => a.startsWith("--git-dir=")), "the git folder is named, not discovered from the worktree");
        assert.deepStrictEqual([only(f)[0].state, only(f)[0].pushed, only(f)[0].headline], ["done", true, "Pushed 2 commits"]);
        const state = JSON.parse(nfsA.readFileSync(path.join(f.dir, "agent", "state.json"), "utf8"));
        assert.deepStrictEqual(state.drive["PR_R"], { attempts: 1, agentHead: "2222222222222222222222222222222222222222" });
        assert.strictEqual((await f.agent.act({ type: "push", runId: item.runId })).ok, false, "never twice");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent re-review: a review you gave, answered by the author, is re-reviewed under the re-review guard with the thread rules", async () => {
      const at = "2026-07-09T00:00:00Z";
      const rv = { ...reviewPr({ viewerHasReviewed: true, role: "reviewed", requestedOfMe: false }), viewerReviewedAt: "2026-07-08T00:00:00Z", viewerReviewedHead: true, authorRepliedAt: at };
      const f = agentFixture({ pr: rv, script: reviewWithPlan("COMMENT"), captureScript: captureJs });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const item = only(f)[0];
        assert.strictEqual(item.scenario, "rereview");
        assert.match(item.key, /\|reply@2026-07-09T00:00:00Z$/);
        const args = f.children[0].args;
        assert.match(nfsA.readFileSync(args[args.indexOf("--settings") + 1], "utf8"), /hook\.js[\s\S]*rereview/);
        const rules = args[args.indexOf("--append-system-prompt") + 1];
        assert.match(rules, /review-not-posted/);
        assert.match(rules, /escalate a\/b 7 <replyTo> <file>/);
        assert.match(rules, /don't argue with your colleague/);
        f.agent.onSnapshot(f.snapshot);
        assert.strictEqual(only(f).length, 1, "the same answer is re-reviewed once");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent drive: a session that changed the repository's git config gets nothing read, let alone pushed", async () => {
      const mine = { ...reviewPr({ role: "author" }), ciState: "failure", headRefName: "feature/x", baseRefName: "main", headOid: "a".repeat(40) };
      const commonDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-common-"));
      nfsA.writeFileSync(path.join(commonDir, "config"), "[core]\n");
      const reads = [];
      const f = agentFixture({
        pr: mine,
        // The session rewrites the config, then finishes.
        script: (c) => {
          nfsA.writeFileSync(path.join(commonDir, "config"), "[log]\n\tshowSignature = true\n[gpg]\n\tprogram = evil\n");
          succeed("done")(c);
        },
        git: async (all) => {
          let i = 0;
          for (;;) {
            if (all[i] === "-c") i += 2;
            else if (/^--(git-dir|work-tree)=/.test(all[i] ?? "")) i += 1;
            else break;
          }
          const args = all.slice(i);
          if (args[0] === "config") return `file:${commonDir}/config\0core.bare\0`;
          if (args[0] === "rev-parse") return `${commonDir}\n`;
          if (args[0] === "remote") return "https://github.com/a/b.git\n";
          if (args[0] === "log" || args[0] === "diff") reads.push(args[0]);
          return "";
        },
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "error"));
        assert.match(only(f)[0].error, /changed during the run — the app read nothing/);
        assert.deepStrictEqual(reads, [], "not even git log ran");
      } finally {
        f.agent.stop();
      }
    });

    // A drive session that finds nothing to fix in the code and answers the reviewers instead — through the run's wrapper.
    const answerThreads = (ids) => (c) => {
      const outDir = c.args[c.args.indexOf("--add-dir") + 1];
      const runDir = path.dirname(outDir);
      const run = JSON.parse(nfsA.readFileSync(path.join(runDir, "run.json"), "utf8"));
      for (const id of ids) {
        const file = path.join(outDir, `reply-${id}.md`);
        nfsA.writeFileSync(file, `Answer to ${id}.`);
        const r = spawnSync(process.execPath, [captureJs, runDir, "reply", run.repo, String(run.number), String(id), file], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(r.stderr);
      }
      emit(c, { type: "system", subtype: "init", session_id: "s" });
      emit(c, { type: "result", subtype: "success", is_error: false, result: "Answered the threads; nothing to change in the code." });
      setImmediate(() => c.emit("exit", 0));
    };
    const noCommitsGit = (commonDir, head) => async (all) => {
      let i = 0;
      for (;;) {
        if (all[i] === "-c") i += 2;
        else if (/^--(git-dir|work-tree)=/.test(all[i] ?? "")) i += 1;
        else break;
      }
      const args = all.slice(i);
      if (args[0] === "config") return `file:${commonDir}/config\0core.bare\0`;
      if (args[0] === "rev-parse") return args.includes("HEAD") ? `${head}\n` : `${commonDir}\n`;
      if (args[0] === "remote") return "https://github.com/a/b.git\n";
      // `git log base..HEAD`: nothing on top of the head.
      return "";
    };

    await atest("agent drive: answers to reviewers with nothing to commit wait for your Send, then go out in their threads — signed, once, at the head it saw", async () => {
      const A = "a".repeat(40);
      const mine = { ...reviewPr({ role: "author", headOid: A }), headOid: A, ciState: "failure", headRefName: "feature/x", baseRefName: "main" };
      const commonDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-common-"));
      nfsA.writeFileSync(path.join(commonDir, "config"), "[core]\n");
      let freshHead = A;
      const posted = [];
      const checked = [];
      const f = agentFixture({
        pr: mine,
        script: answerThreads([101, 102]),
        captureScript: captureJs,
        git: noCommitsGit(commonDir, A),
        fetchPr: async () => ({ pr: { ...mine, headOid: freshHead }, state: "OPEN", viewer: "me" }),
        gh: async (args, opts) => {
          if (!opts) {
            // Whose comment it is: a colleague's thread on this PR — a drive answers reviewers in theirs.
            checked.push(args[1]);
            return { code: 0, stdout: JSON.stringify({ pull_request_url: "https://api.github.com/repos/a/b/pulls/7", user: { login: "colleague" }, in_reply_to_id: null }), stderr: "" };
          }
          posted.push({ args, body: JSON.parse(opts.input) });
          return { code: 0, stdout: "{}", stderr: "" };
        },
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const item = only(f)[0];
        assert.deepStrictEqual([item.scenario, item.drive.commits.length, item.headline], ["drive", 0, "Would post: 2 replies"]);
        assert.deepStrictEqual(item.plan.replies.map((r) => r.replyTo), [101, 102]);
        assert.strictEqual(actionLabel(item), "Send 2 replies", "not \"see what it found\": there is something to send");
        assert.strictEqual(posted.length, 0, "Shadow posts nothing by itself");
        const rules = f.children[0].args[f.children[0].args.indexOf("--append-system-prompt") + 1];
        assert.match(rules, /posts it after the push — or, when you commit nothing, on its own once the user sends it/);
        freshHead = "b".repeat(40);
        assert.match((await f.agent.act({ type: "publish", runId: item.runId })).error, /new commits since this run/);
        assert.strictEqual(posted.length, 0);
        freshHead = A;
        only(f)[0].state = "needsYou";
        assert.deepStrictEqual(await f.agent.act({ type: "publish", runId: item.runId }), { ok: true });
        assert.deepStrictEqual(checked, ["repos/a/b/pulls/comments/101", "repos/a/b/pulls/comments/102"], "each comment is checked to be this PR's first");
        assert.deepStrictEqual(
          posted.map((p) => p.args[1]),
          ["repos/a/b/pulls/7/comments/101/replies", "repos/a/b/pulls/7/comments/102/replies"],
        );
        assert.ok(posted.every((p) => p.body.body.startsWith("Answer to ") && p.body.body.endsWith(ad.DEFAULT_AGENT_SIGNATURE)), "signed by the app");
        assert.deepStrictEqual([only(f)[0].state, only(f)[0].published, only(f)[0].headline], ["done", true, "Published: 2 replies"]);
        assert.strictEqual((await f.agent.act({ type: "publish", runId: item.runId })).ok, false, "never twice");
        assert.strictEqual(posted.length, 2);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent drive: in On, answers with nothing to commit go out right after the run — but not while it asks you something", async () => {
      const A = "a".repeat(40);
      const mine = { ...reviewPr({ role: "author", headOid: A }), headOid: A, ciState: "failure", headRefName: "feature/x", baseRefName: "main" };
      const run = async (resultExtra, settled) => {
        const commonDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-common-"));
        nfsA.writeFileSync(path.join(commonDir, "config"), "[core]\n");
        const posted = [];
        const f = agentFixture({
          pr: mine,
          agent: { scenarios: { driveCi: { mode: "on" } } },
          script: (c) => {
            const outDir = c.args[c.args.indexOf("--add-dir") + 1];
            const runDir = path.dirname(outDir);
            const file = path.join(outDir, "reply.md");
            nfsA.writeFileSync(file, "Not a defect: by design.");
            const r = spawnSync(process.execPath, [captureJs, runDir, "reply", "a/b", "7", "101", file], { encoding: "utf8" });
            if (r.status !== 0) throw new Error(r.stderr);
            emit(c, { type: "system", subtype: "init", session_id: "s" });
            emit(c, { type: "result", subtype: "success", is_error: false, result: resultExtra });
            setImmediate(() => c.emit("exit", 0));
          },
          captureScript: captureJs,
          git: noCommitsGit(commonDir, A),
          fetchPr: async () => ({ pr: mine, state: "OPEN", viewer: "me" }),
          gh: async (args, opts) => {
            if (!opts) return { code: 0, stdout: JSON.stringify({ pull_request_url: "https://api.github.com/repos/a/b/pulls/7", user: { login: "colleague" } }), stderr: "" };
            posted.push(args[1]);
            return { code: 0, stdout: "{}", stderr: "" };
          },
        });
        try {
          f.agent.onSnapshot(f.snapshot);
          await until(() => only(f).some((i) => i.state === settled));
          return { item: only(f)[0], posted };
        } finally {
          f.agent.stop();
        }
      };
      const sent = await run("Answered.", "done");
      assert.deepStrictEqual([sent.item.mode, sent.posted, sent.item.state, sent.item.published], ["on", ["repos/a/b/pulls/7/comments/101/replies"], "done", true]);
      const asking = await run('Done.\n\n```prd-result\n{"summary":"s","asks":[{"question":"Retarget the PR?","options":["Yes","No"]}],"findings":[]}\n```', "needsYou");
      assert.deepStrictEqual([asking.posted, asking.item.state, actionLabel(asking.item)], [[], "needsYou", "Your call"], "the answers may hang on the question: they wait");
    });

    test("ipc and view: Push names a run; a drive's one button pushes its fixes", () => {
      const RID = "00000000-0000-4000-8000-000000000001";
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "push", runId: RID }), { type: "push", runId: RID });
      const drive = { base: "a".repeat(40), reasons: ["ci"], commits: [{ oid: "b".repeat(40), subject: "fix" }], stat: "", patch: "" };
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "needsYou", scenario: "drive", drive, sessionId: "s" })), "Push 1 fix");
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "needsYou", scenario: "drive", drive: { ...drive, commits: [] }, sessionId: "s" })), "Open in Claude", "nothing to push: it couldn't");
    });

    test("main.js wiring: the agent's state is pulled and acted on over IPC, and pushed only to a visible window", () => {
      const src = nfsA.readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
      assert.match(src, /ipcMain\.handle\("agent:get", \(\) => agent\?\.getState\(\) \?\? null\)/);
      assert.match(src, /ipcMain\.handle\("agent:action"[\s\S]{0,300}validateAgentAction\)\(raw\)[\s\S]{0,200}return agent\.act\(action\)/);
      assert.match(src, /mainWindow\.isVisible\(\)\) \{\s*sendToRenderer\("agent-state", agent\.getState\(\)\)/);
      assert.match(src, /onChange: scheduleAgentPush/);
      const preload = nfsA.readFileSync(path.join(__dirname, "../dist/main/main/preload.js"), "utf8");
      assert.match(preload, /"agent:get"/);
      assert.match(preload, /"agent:action"/);
      assert.match(preload, /"agent-state"/);
      // The log's path is main's own: the renderer asks to see it and sends nothing.
      assert.match(src, /ipcMain\.handle\("agent:revealLog", async \(\) =>[\s\S]{0,200}"log\.jsonl"/);
      assert.match(preload, /revealAgentLog: \(\) => electron_1\.ipcRenderer\.invoke\("agent:revealLog"\)/);
      // Diagrams are parsed in the renderer: sources go over, one yes/no each comes back, validated.
      assert.match(src, /ipcMain\.handle\("agent:diagramsChecked"[\s\S]{0,200}validateDiagramsChecked\)\(rawId, rawResults\)/);
      assert.match(src, /webContents\.send\("agent-check-diagrams", \{ requestId, sources \}\)/);
      assert.match(src, /onChange: scheduleAgentPush,\s*checkMermaid,/);
      assert.match(preload, /"agent-check-diagrams"/);
      assert.match(preload, /invoke\("agent:diagramsChecked", requestId, results\)/);
      const iv = require(path.join(__dirname, "../dist/main/main/ipc-validation.js"));
      const id = "00000000-0000-4000-8000-000000000001";
      assert.deepStrictEqual(iv.validateDiagramsChecked(id, [true, false]), { requestId: id, results: [true, false] });
      assert.throws(() => iv.validateDiagramsChecked(id, ["flowchart LR"]), /yes\/no/, "never text");
      assert.throws(() => iv.validateDiagramsChecked("x", [true]), /request's id/);
      assert.deepStrictEqual(iv.validateAgentAction({ type: "reapprove", runId: id }), { type: "reapprove", runId: id });
    });

    test("main.js wiring: the agent hears every snapshot, keeps hidden polling alive and stops on quit", () => {
      const src = nfsA.readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
      assert.match(src, /agent\?\.onSnapshot\(snapshot\);\s*handleNotifications\(snapshot\.pullRequests\)/, "the agent takes its triggers before the toasts are decided");
      assert.match(src, /agentActive: \(\) => agent\?\.isActive\(\)/);
      assert.match(src, /if \(!\(0, mock_1\.isMockMode\)\(\)\) \{\s*agent = \(0, agent_1\.createAgent\)/);
      assert.match(src, /hookScript: unpackedScript\("hook\.js"\)/);
      assert.match(src, /captureScript: unpackedScript\("capture\.js"\)/);
      assert.ok(src.includes('.replace(/app\\.asar([\\\\/])/, "app.asar.unpacked$1")'), "the scripts are read from outside app.asar");
      assert.match(src, /fetchPr: async \(pr\) =>/);
      assert.match(src, /notify: handleAgentNotice/);
      const pkg = JSON.parse(nfsA.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
      assert.deepStrictEqual(pkg.build.asarUnpack, ["dist/main/main/agent/**", "dist/main/shared/**"], "Claude Code runs the hook and capture scripts as Node — they and what they require must be on disk");
      assert.match(src, /agent\?\.ownSessionIds\(\)/);
      assert.match(src, /markQuitting\(\);\s*agent\?\.stop\(\)/);
      // Windows shutdown, restart or sign-out never emits before-quit: the
      // window's session-end is the only word the agent gets of it.
      assert.match(src, /mainWindow\.on\("session-end", \(\) => \{\s*trayController\.markQuitting\(\);\s*agent\?\.stop\(\);/);
    });

    // --- stage 6: quiet hours, the tray line, toasts, the whole-agent pause, Interrupted + Resume ---
    test("agent quiet hours: a span may wrap past midnight; its end is when runs start again", () => {
      const at = (h, m) => new Date(2026, 10, 5, h, m);
      const night = { enabled: true, from: "20:00", to: "08:00" };
      assert.strictEqual(view.quietUntil(at(23, 30), night), "08:00");
      assert.strictEqual(view.quietUntil(at(7, 59), night), "08:00");
      assert.strictEqual(view.quietUntil(at(20, 0), night), "08:00", "from is inside");
      assert.strictEqual(view.quietUntil(at(8, 0), night), null, "to is outside");
      assert.strictEqual(view.quietUntil(at(12, 0), night), null);
      const lunch = { enabled: true, from: "12:00", to: "13:30" };
      assert.strictEqual(view.quietUntil(at(12, 45), lunch), "13:30");
      assert.strictEqual(view.quietUntil(at(13, 30), lunch), null);
      assert.strictEqual(view.quietUntil(at(23, 30), { ...night, enabled: false }), null);
      assert.strictEqual(view.quietUntil(at(23, 30), { enabled: true, from: "09:00", to: "09:00" }), null, "an empty span holds nothing");
      assert.strictEqual(view.quietUntil(at(23, 30), { enabled: true, from: "25:00", to: "08:00" }), null);
    });

    test("agent tray line: what runs with its plan's progress, else why nothing does, plus what waits for you", () => {
      const base = { enabled: true, items: [], running: [], idle: {}, runsToday: 0, perDay: 30, parallel: 2, heldUntil: null, headerChip: true, trayState: true, paused: false, quietUntil: null, acceptedUnchanged: 0, suggestOn: false };
      const progress = (steps) => ({ steps: steps.map((status, i) => ({ id: String(i), subject: "s", status })) });
      const a = vItem({ prId: "A", state: "working", prNumber: 911 });
      a.prNumber = 911;
      const b = vItem({ prId: "B", state: "working", scenario: "drive" });
      const run = (item, steps) => ({ runId: item.runId, progress: progress(steps), recent: [], paused: false });
      assert.strictEqual(view.agentTrayLine(base), "Idle");
      assert.strictEqual(view.agentTrayLine({ ...base, items: [a], running: [run(a, ["completed", "completed", "in_progress", "pending"])] }), "Drafting review #911 · 3/4", "the step it is on — as the popover shows it");
      assert.strictEqual(view.agentTrayLine({ ...base, items: [a], running: [{ ...run(a, ["in_progress"]), paused: true }] }), "Drafting review #911 (paused)");
      assert.strictEqual(view.agentTrayLine({ ...base, runsToday: 30, items: [vItem({ prId: "Q", state: "queued" })] }), "Daily limit reached (30) · 1 in line");
      assert.strictEqual(view.agentTrayLine({ ...base, items: [a, b], running: [run(a, []), run(b, [])] }), "Drafting review #911 +1");
      const toSend = { event: "COMMENT", body: "b", comments: [], replies: [], resolves: 0, escalations: [] };
      const waiting = [vItem({ prId: "C", state: "needsYou", plan: toSend }), vItem({ prId: "D", state: "error" }), vItem({ prId: "E", state: "needsYou" })];
      assert.strictEqual(view.agentTrayLine({ ...base, items: waiting }), "Idle · 2 ready for you", "a result that asks nothing isn't counted");
      assert.strictEqual(view.agentTrayLine({ ...base, paused: true, items: [a], running: [run(a, [])] }), "Paused");
      const queued = [vItem({ prId: "F", state: "queued" })];
      assert.strictEqual(view.agentTrayLine({ ...base, quietUntil: "08:00", items: queued }), "Quiet hours until 08:00 · 1 in line");
      assert.strictEqual(view.agentTrayLine({ ...base, items: queued }), "1 in line");
      assert.match(view.agentTrayLine({ ...base, heldUntil: new Date(2026, 10, 5, 14, 5).toISOString() }), /^Usage limit — waits until 14:05$/);
    });

    test("agent toasts: a trigger the agent took in On is left to the agent; Shadow, other PRs and other triggers still toast", () => {
      const on = (o) => vItem({ mode: "on", state: "queued", ...o });
      const items = [on({ prId: "R", scenario: "review" }), on({ prId: "D", scenario: "drive", reasons: ["ci"] }), vItem({ prId: "S", scenario: "review", mode: "shadow", state: "working" })];
      assert.strictEqual(view.agentTakesToast(items, { prId: "R", kind: "review_requested" }), true);
      assert.strictEqual(view.agentTakesToast(items, { prId: "R", kind: "approved" }), false, "no run stands in for that");
      assert.strictEqual(view.agentTakesToast(items, { prId: "D", kind: "ci_failed" }), true);
      assert.strictEqual(view.agentTakesToast(items, { prId: "D", kind: "unanswered_comment" }), false, "a drive for CI doesn't answer comments");
      assert.strictEqual(view.agentTakesToast(items, { prId: "S", kind: "review_requested" }), false, "Shadow leaves the trigger to you");
      assert.strictEqual(view.agentTakesToast(items, { prId: "X", kind: "review_requested" }), false);
      assert.strictEqual(view.agentTakesToast([on({ prId: "R", scenario: "review", state: "done" })], { prId: "R", kind: "review_requested" }), false, "only a run that is on it now");
      assert.strictEqual(view.agentTakesToast([on({ prId: "B", scenario: "brief" })], { prId: "B", kind: "review_requested" }), true, "a brief stands in too");
      assert.strictEqual(view.agentTakesToast([on({ prId: "Q", scenario: "rereview" })], { prId: "Q", kind: "returned_to_me" }), true);
    });

    test("ipc: the whole agent is paused and resumed with nothing riding along", () => {
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "pauseAgent", runId: "../x", path: "/etc" }), { type: "pauseAgent" });
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "resumeAgent" }), { type: "resumeAgent" });
    });

    await atest("agent pause: the whole agent holds its queue, pauses the run in flight, and resumes only what it paused", async () => {
      const f = agentFixture({ script: keepWorking });
      try {
        assert.deepStrictEqual(await f.agent.act({ type: "pauseAgent" }), { ok: true });
        f.agent.onSnapshot(f.snapshot);
        await tickOnce();
        assert.strictEqual(only(f)[0].state, "queued");
        assert.strictEqual(f.children.length, 0, "nothing starts while paused");
        assert.strictEqual(f.agent.getState().paused, true);
        assert.strictEqual(JSON.parse(nfsA.readFileSync(path.join(f.dir, "agent", "state.json"), "utf8")).paused, true, "it stays paused across a restart");
        assert.deepStrictEqual(await f.agent.act({ type: "resumeAgent" }), { ok: true });
        await until(() => f.agent.getState().running.length === 1);
        const c = f.children[0];
        const runId = only(f)[0].runId;
        await f.agent.act({ type: "pauseAgent" });
        await tickOnce();
        assert.match(c.written, /"subtype":"interrupt"/, "the run pauses at its next safe point");
        assert.strictEqual(f.agent.getState().running[0].paused, true);
        await f.agent.act({ type: "resumeAgent" });
        await tickOnce();
        assert.match(c.written, /Continue where you stopped/);
        assert.strictEqual(f.agent.getState().running[0].paused, false);
        assert.strictEqual(only(f)[0].headline, "Reviewing");
        // One you paused yourself stays paused when the agent resumes.
        await f.agent.act({ type: "pause", runId });
        await f.agent.act({ type: "pauseAgent" });
        await f.agent.act({ type: "resumeAgent" });
        assert.strictEqual(f.agent.getState().running[0].paused, true);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent pause: an On review that finishes while the agent is paused waits for your Publish", async () => {
      const posted = [];
      const f = agentFixture({
        agent: { scenarios: { review: { mode: "on" } } },
        script: (c) => {
          emit(c, { type: "system", subtype: "init", session_id: "s" });
          c.finish = () => reviewWithPlan("REQUEST_CHANGES")(c);
        },
        captureScript: captureJs,
        fetchPr: async () => ({ pr: reviewPr(), state: "OPEN", viewer: "me" }),
        gh: async (_args, opts) => (posted.push(JSON.parse(opts.input)), { code: 0, stdout: "{}", stderr: "" }),
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.agent.getState().running.length === 1);
        await until(() => typeof f.children[0]?.finish === "function");
        await f.agent.act({ type: "pauseAgent" });
        f.children[0].finish();
        await until(() => only(f).some((i) => i.state === "needsYou"));
        assert.strictEqual(posted.length, 0, "paused, nothing goes out on its own");
        assert.match(only(f)[0].headline, /^Would post: .* — held: the agent is paused$/);
        assert.strictEqual(actionLabel(only(f)[0]), "Send review");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent quiet hours: what the agent found itself waits; what you ask for runs", async () => {
      const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const night = { enabled: true, from: hm(new Date(Date.now() - 3600e3)), to: hm(new Date(Date.now() + 3600e3)) };
      const f = agentFixture({ script: keepWorking, agent: { limits: { quietHours: night } } });
      try {
        f.agent.onSnapshot(f.snapshot);
        await tickOnce();
        assert.strictEqual(only(f)[0].state, "queued");
        assert.strictEqual(f.children.length, 0);
        assert.strictEqual(f.agent.getState().quietUntil, night.to);
        // Yours: asked by you, it runs — the automatic one leaves the queue for it.
        await f.agent.act({ type: "skip", runId: only(f)[0].runId });
        assert.deepStrictEqual(await f.agent.act({ type: "enqueue", prId: "PR_R" }), { ok: true });
        await until(() => f.children.length === 1);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent: a run the app's closing cut short goes on by itself at the next start — the same session, in its worktree", async () => {
      const f = agentFixture({ script: keepWorking });
      f.agent.onSnapshot(f.snapshot);
      await until(() => f.agent.getState().running.length === 1);
      const { runId, sessionId, worktree, key } = only(f)[0];
      f.agent.stop();
      const saved = JSON.parse(nfsA.readFileSync(path.join(f.dir, "agent", "state.json"), "utf8"));
      const was = saved.items.find((i) => i.runId === runId);
      assert.deepStrictEqual([was.state, was.interrupted, was.headline], ["needsYou", true, "Interrupted — the app closed while it ran"], "written down before the app goes");
      assert.strictEqual(saved.ledger[key].state, "failed");

      // The app starts again.
      nfsA.mkdirSync(worktree, { recursive: true });
      const g = agentFixture({ home: f.dir, script: keepWorking });
      try {
        assert.ok(only(g).find((i) => i.runId === runId).interrupted, "held until the PRs are known");
        g.agent.onSnapshot(g.snapshot);
        await until(() => g.children.length === 1);
        const c = g.children[0];
        assert.strictEqual(c.args[c.args.indexOf("--resume") + 1], sessionId, "the very session it ran");
        assert.ok(!c.args.includes("--session-id"));
        assert.strictEqual(c.cwd, worktree, "in the worktree it worked in");
        assert.ok(!g.gitCalls.some((a) => a[0] === "worktree" && a[1] === "add"), "no new worktree");
        await tickOnce();
        assert.match(c.written, /closed while you worked/);
        assert.strictEqual(only(g).find((i) => i.runId === runId).state, "working");
        assert.match(nfsA.readFileSync(path.join(f.dir, "agent", "log.jsonl"), "utf8"), /"event":"resumed"/);
      } finally {
        g.agent.stop();
      }
    });

    // The drawing run as Claude Code answers in print mode: one JSON result on stdout.
    const DRAWN_FLOW = 'flowchart LR\n  a["Poller"] --> b["Agent"]\n  class b newComp';
    const drawing = (c) => {
      c.stdout.write(
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "### Architecture\n```mermaid\n" + DRAWN_FLOW + "\n```", total_cost_usd: 0.02 }),
      );
      setImmediate(() => c.emit("close", 0));
    };
    const reviewOrDrawing = (c) => (c.args.includes("--no-session-persistence") ? drawing(c) : reviewWithPlan()(c));
    const diagramGh = (state) => async (args, opts) => {
      if (args.includes("--paginate")) return { code: 0, stdout: state.existing ? `${state.existing}\n` : "", stderr: "" };
      if (args.includes("Accept: application/vnd.github.v3.diff")) return { code: 0, stdout: "diff --git a/src/poller.ts b/src/poller.ts\n+agent.onSnapshot()\n", stderr: "" };
      state.posted.push({ endpoint: args[1], body: JSON.parse(opts.input) });
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const DIAGRAMS_ON = { diagrams: { enabled: true, minLines: 100, post: true, model: "sonnet" } };

    await atest("agent diagrams: a big review is drawn before it reaches you, and its diagrams go out with it as one comment", async () => {
      const dg = require(path.join(__dirname, "../dist/main/shared/agent-diagrams.js"));
      const state = { existing: null, posted: [] };
      const checked = [];
      const f = agentFixture({
        pr: reviewPr({ additions: 300 }),
        agent: DIAGRAMS_ON,
        script: reviewOrDrawing,
        captureScript: captureJs,
        fetchPr: async () => ({ pr: reviewPr({ additions: 300 }), state: "OPEN", viewer: "me" }),
        gh: diagramGh(state),
        checkMermaid: async (sources) => (checked.push(sources), sources.map(() => true)),
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const item = only(f)[0];
        assert.strictEqual(item.headline, "Would post: request changes, 1 inline comment, 1 diagram");
        assert.deepStrictEqual(item.diagrams, { list: [{ title: "Architecture", source: DRAWN_FLOW }], checked: true });
        assert.strictEqual(f.children.length, 2, "the review, then the drawing run");
        const draw = f.children[1];
        assert.strictEqual(draw.cwd, path.join(f.dir, "agent", "runs", item.runId, "diagrams"), "a folder of the app's own, not the PR's checkout");
        assert.match(draw.written, /^Pull request: .+\nWhat it does: Prepared the review\./);
        assert.match(draw.written, /src\/poller\.ts/);
        assert.deepStrictEqual(checked, [[DRAWN_FLOW]], "parsed in the renderer before it may go out");
        await until(() => readLog(f).some((l) => l.event === "diagrams"));
        const line = readLog(f).find((l) => l.event === "diagrams");
        assert.deepStrictEqual([line.data.count, line.data.checked, line.data.costUsd], [1, true, 0.02]);

        assert.deepStrictEqual(await f.agent.act({ type: "publish", runId: item.runId }), { ok: true });
        assert.deepStrictEqual(state.posted.map((p) => p.endpoint), ["repos/a/b/pulls/7/reviews", "repos/a/b/issues/7/comments"], "the review first, its diagrams last");
        const note = state.posted[1].body.body;
        assert.ok(note.startsWith(dg.DIAGRAM_HEADER) && note.includes(DRAWN_FLOW), note);
        assert.ok(note.endsWith(ad.DEFAULT_AGENT_SIGNATURE), "signed like everything the agent posts");
        assert.strictEqual(only(f)[0].headline, "Published: request changes, 1 inline comment, 1 diagram");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent diagrams: none for a small PR or one that has a Mermaid diagram already — and none goes out unchecked", async () => {
      // Under the threshold: no drawing run at all.
      const small = agentFixture({ agent: DIAGRAMS_ON, script: reviewOrDrawing, captureScript: captureJs, gh: diagramGh({ existing: null, posted: [] }) });
      try {
        small.agent.onSnapshot(small.snapshot);
        await until(() => only(small).some((i) => i.state === "needsYou"));
        assert.deepStrictEqual([small.children.length, only(small)[0].diagrams], [1, undefined]);
      } finally {
        small.agent.stop();
      }

      // The PR carries one already — whoever drew it: its link instead of a second.
      const existing = "https://github.com/a/b/pull/7#issuecomment-1";
      const has = agentFixture({ pr: reviewPr({ additions: 300 }), agent: DIAGRAMS_ON, script: reviewOrDrawing, captureScript: captureJs, gh: diagramGh({ existing, posted: [] }) });
      try {
        has.agent.onSnapshot(has.snapshot);
        await until(() => only(has).some((i) => i.state === "needsYou"));
        assert.strictEqual(has.children.length, 1, "no drawing run");
        assert.deepStrictEqual(only(has)[0].diagrams, { list: [], checked: false, existingUrl: existing, note: "The PR has a Mermaid diagram already" });
        assert.strictEqual(only(has)[0].headline, "Would post: request changes, 1 inline comment");
      } finally {
        has.agent.stop();
      }

      // Drawn with no window to parse them: shown, but held back from the post.
      const state = { existing: null, posted: [] };
      const blind = agentFixture({
        pr: reviewPr({ additions: 300 }),
        agent: DIAGRAMS_ON,
        script: reviewOrDrawing,
        captureScript: captureJs,
        fetchPr: async () => ({ pr: reviewPr({ additions: 300 }), state: "OPEN", viewer: "me" }),
        gh: diagramGh(state),
      });
      try {
        blind.agent.onSnapshot(blind.snapshot);
        await until(() => only(blind).some((i) => i.state === "needsYou"));
        const item = only(blind)[0];
        assert.deepStrictEqual([item.diagrams.list.length, item.diagrams.checked], [1, false]);
        assert.deepStrictEqual(await blind.agent.act({ type: "publish", runId: item.runId }), { ok: true });
        assert.deepStrictEqual(state.posted.map((p) => p.endpoint), ["repos/a/b/pulls/7/reviews"], "the review alone");
        assert.strictEqual(only(blind)[0].headline, "Published: request changes, 1 inline comment");
        await until(() => readLog(blind).some((l) => l.event === "diagrams-held"));
        assert.match(readLog(blind).find((l) => l.event === "diagrams-held").detail, /not checked/);
      } finally {
        blind.agent.stop();
      }
    });

    // GitHub as the re-approve check and its writes see it.
    const reapproveGh = (st) => async (args, opts) => {
      if (args[1] === "graphql") {
        return {
          code: 0,
          stdout: JSON.stringify({ data: { viewer: { login: "me" }, node: { state: "OPEN", headRefOid: "aaa111", baseRefName: "master", author: { login: st.author ?? "author1" }, timelineItems: { nodes: st.timeline } } } }),
          stderr: "",
        };
      }
      st.posted.push({ endpoint: args[1], body: JSON.parse(opts.input) });
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const myDismissal = [review("me", "DISMISSED", "2026-11-01T10:00:00Z", "old111"), dismissal("me", "APPROVED", "2026-11-01T10:00:00Z", "old111")];

    await atest("agent re-approve: a base-only push that dismissed your approval is offered back, and given on your click — signed, on the new head", async () => {
      const st = { timeline: myDismissal, posted: [] };
      const notices = [];
      const f = agentFixture({
        pr: reviewPr({ role: "reviewed" }),
        agent: { scenarios: { reapprove: { mode: "shadow", askReviewers: true } } },
        script: keepWorking,
        gh: reapproveGh(st), git: cleanMergeGit(st.git),
        fetchPr: async () => ({ pr: reviewPr({ role: "reviewed" }), state: "OPEN", viewer: "me" }),
        notify: (n) => notices.push([n.kind, n.item.scenario]),
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.scenario === "reapprove"));
        const item = only(f).find((i) => i.scenario === "reapprove");
        assert.deepStrictEqual([item.state, item.headline, item.reapproval], ["needsYou", "Only the base changed — approve again", { logins: ["me"], oldHead: "old111" }]);
        assert.strictEqual(actionLabel(item), "Re-approve");
        assert.strictEqual(f.children.length, 0, "no session: a review of this head would only repeat the approval");
        assert.deepStrictEqual(st.posted, [], "Shadow gives nothing by itself");
        assert.deepStrictEqual(notices, [["needsYou", "reapprove"]]);
        await until(() => readLog(f).some((l) => l.event === "reapprove-check"));
        assert.strictEqual(readLog(f).find((l) => l.event === "reapprove-check").data.verdict, "same");

        assert.deepStrictEqual(await f.agent.act({ type: "reapprove", runId: item.runId }), { ok: true });
        assert.deepStrictEqual(st.posted.map((p) => [p.endpoint, p.body.event, p.body.commit_id]), [["repos/a/b/pulls/7/reviews", "APPROVE", "aaa111"]]);
        assert.ok(st.posted[0].body.body.startsWith(ra.reapprovalBody("old111")) && st.posted[0].body.body.endsWith(ad.DEFAULT_AGENT_SIGNATURE));
        assert.deepStrictEqual([only(f)[0].state, only(f)[0].published], ["done", true]);
        assert.strictEqual((await f.agent.act({ type: "reapprove", runId: item.runId })).ok, false, "never twice");
        await until(() => readLog(f).some((l) => l.event === "reapproved"));
        // The head is read once: planning again starts no second check.
        f.agent.onSnapshot(f.snapshot);
        await tickOnce();
        assert.strictEqual(readLog(f).filter((l) => l.event === "reapprove-check").length, 1);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent re-approve: On gives it at once; changed lines leave the head to the other rules; on your PR the reviewers are asked again", async () => {
      // On: no click.
      const on = { timeline: myDismissal, posted: [] };
      const f = agentFixture({
        pr: reviewPr({ role: "reviewed" }),
        agent: { scenarios: { reapprove: { mode: "on", askReviewers: true } } },
        script: keepWorking,
        gh: reapproveGh(on), git: cleanMergeGit(on.git),
        fetchPr: async () => ({ pr: reviewPr({ role: "reviewed" }), state: "OPEN", viewer: "me" }),
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => on.posted.length === 1 && only(f)[0]?.state === "done");
        assert.strictEqual(on.posted[0].body.event, "APPROVE");
        assert.match(only(f)[0].headline, /^Approved again — only the base changed since old111/);
        assert.strictEqual(view.agentNoticeTitle("finished", only(f)[0]), "Approved again: #7", "not «Review sent»");
        assert.strictEqual(view.agentNoticeTitle("needsYou", { ...only(f)[0], state: "needsYou", published: undefined }), "Only the base changed — approve again: #7");
      } finally {
        f.agent.stop();
      }

      // The author pushed a commit of their own: nothing is offered.
      const changed = { timeline: myDismissal, posted: [], git: { own: "c1 old111\n", chain: "c1\n" } };
      const g = agentFixture({ pr: reviewPr({ role: "reviewed" }), agent: { scenarios: { reapprove: { mode: "on", askReviewers: true } } }, script: keepWorking, gh: reapproveGh(changed), git: cleanMergeGit(changed.git) });
      try {
        g.agent.onSnapshot(g.snapshot);
        await until(() => readLog(g).some((l) => l.event === "reapprove-check"));
        await tickOnce();
        assert.deepStrictEqual([only(g).length, changed.posted.length], [0, 0]);
        assert.notStrictEqual(g.agent.getState().idle.PR_R, "Checking whether only the base changed since your approval", "the other rules decide again");
      } finally {
        g.agent.stop();
      }

      // Your PR: the reviewer whose approval went is asked again.
      const mine = { author: "me", timeline: [review("anna", "DISMISSED", "2026-11-01T10:00:00Z", "old111"), dismissal("anna", "APPROVED", "2026-11-01T10:00:00Z", "old111")], posted: [] };
      const off = { mode: "off" };
      const unapproved = () => ({ ...reviewPr({ role: "author" }), hasHumanApproval: false, reviewers: [] });
      const h = agentFixture({
        pr: unapproved(),
        agent: { scenarios: { reapprove: { mode: "shadow", askReviewers: true }, selfReview: off, driveCi: { mode: "off", maxAttempts: 2 }, driveComments: off, merge: { mode: "off" } } },
        script: keepWorking,
        gh: reapproveGh(mine), git: cleanMergeGit(mine.git),
        fetchPr: async () => ({ pr: unapproved(), state: "OPEN", viewer: "me" }),
      });
      try {
        h.agent.onSnapshot(h.snapshot);
        await until(() => only(h).some((i) => i.scenario === "reask"));
        const item = only(h).find((i) => i.scenario === "reask");
        assert.deepStrictEqual([item.headline, actionLabel(item), view.laneOfScenario(item.scenario)], ["Only the base changed — ask anna again", "Ask again", "mine"]);
        assert.deepStrictEqual(await h.agent.act({ type: "reapprove", runId: item.runId }), { ok: true });
        assert.deepStrictEqual(mine.posted, [{ endpoint: "repos/a/b/pulls/7/requested_reviewers", body: { reviewers: ["anna"] } }]);
        assert.strictEqual(only(h).find((i) => i.scenario === "reask").headline, "Asked anna again — only the base changed");
      } finally {
        h.agent.stop();
      }
    });

    await atest("agent re-approve: a failed read is tried again ten minutes later, not by the very plan it ends in", async () => {
      let reads = 0;
      const f = agentFixture({
        pr: reviewPr({ role: "reviewed" }),
        agent: { scenarios: { reapprove: { mode: "shadow", askReviewers: true } } },
        script: keepWorking,
        gh: async (args) => {
          if (args[1] === "graphql") reads++;
          return { code: 1, stdout: "", stderr: "HTTP 502" };
        },
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => readLog(f).some((l) => l.event === "reapprove-check"));
        await tickOnce();
        f.agent.onSnapshot(f.snapshot);
        await tickOnce();
        assert.strictEqual(reads, 1, "one read until the ten minutes are up");
        assert.strictEqual(f.agent.getState().idle.PR_R, "Checking whether only the base changed since your approval");
      } finally {
        f.agent.stop();
      }
    });

    // --- GitHub's native stacks ---
    const stk = require(path.join(__dirname, "../dist/main/shared/agent-stack.js"));
    // Stack #9 of a/b: layer n is PR #(10 + n), all open unless `states` says otherwise.
    const inStack = (position, size = 3, states = []) => ({
      number: 9,
      position,
      size,
      baseRefName: "master",
      entries: Array.from({ length: size }, (_, i) => ({ position: i + 1, number: 11 + i, title: `layer ${i + 1}`, url: `https://github.com/a/b/pull/${11 + i}`, state: states[i] ?? "OPEN" })),
      bottom: position > 1 ? { number: 11, url: "https://github.com/a/b/pull/11" } : null,
    });
    const layerPr = (position, o = {}) => ({
      ...reviewPr({ id: `PR_L${position}`, number: 10 + position, role: o.role ?? "author" }),
      stack: inStack(position, o.size, o.states),
      baseRefName: position === 1 ? "master" : `layer-${position - 1}`,
      blockedByStack: position > 1,
      ...o.pr,
    });

    test("agent stack: a layer knows the PR below it and the open ones above; the lowest broken layer comes first", () => {
      assert.strictEqual(stk.stackLayer({ stack: null }), null);
      assert.deepStrictEqual(stk.stackLayer(layerPr(2, { size: 4, states: ["OPEN", "OPEN", "MERGED", "OPEN"] })), { number: 9, position: 2, size: 4, trunk: "master", below: 11, above: [14] }, "a merged layer above has nothing to rebase");
      assert.strictEqual(stk.stackLayer(layerPr(1)).below, null);
      const prs = [layerPr(1), layerPr(2), layerPr(3), { ...layerPr(1), id: "PR_X", repo: "x/y" }];
      const red = new Set(["PR_L1", "PR_L2", "PR_X"]);
      assert.strictEqual(stk.brokenLayerBelow(prs[2], prs, (p) => red.has(p.id)).id, "PR_L1", "the lowest of them");
      assert.strictEqual(stk.brokenLayerBelow(prs[0], prs, (p) => red.has(p.id)), null, "nothing below the bottom — stack #9 of another repository is another stack");
      assert.strictEqual(stk.brokenLayerBelow(prs[2], prs, () => false), null);
      assert.strictEqual(stk.brokenLayerBelow(reviewPr(), prs, () => true), null, "outside a stack");
    });

    test("agent stack: a session on a layer keeps to it — a review to its own diff, a drive away from merging the base in", () => {
      const review = stk.stackRules(layerPr(2), "review");
      assert.match(review, /layer 2 of 3 in GitHub stack #9 \(bottom first, onto master\)/);
      assert.match(review, /targets layer-1, the branch of #11 below it/);
      assert.match(review, /a problem in code a lower layer added belongs to that PR/);
      assert.match(stk.stackRules(layerPr(1), "rereview"), /it is the bottom layer, onto master/);
      assert.match(stk.stackRules(layerPr(2), "drive"), /never merge the base branch into this one, and never rebase it/);
      assert.strictEqual(stk.stackRules(layerPr(2), "afterMerge"), null);
      assert.strictEqual(stk.stackRules(reviewPr(), "review"), null, "outside a stack");
      const drive = agentCore.agentRules("drive", "shadow", null, { repo: "a/b", number: 12, baseRef: "origin/layer-1", reasons: ["ci"], stack: stk.stackRules(layerPr(2), "drive") });
      assert.match(drive, /linear history/);
      assert.doesNotMatch(drive, /Resolve a conflict by merging the base branch in/, "a layer is never told to merge its base");
      assert.match(agentCore.agentRules("drive", "shadow", null, { repo: "a/b", number: 7, baseRef: "origin/master", reasons: ["ci"] }), /Resolve a conflict by merging the base branch in/, "outside a stack it still is");
      assert.match(agentCore.agentRules("review", "shadow", null, { repo: "a/b", number: 12, stack: review }), /Review this layer only/);
    });

    test("agent stack: a conflicting layer is yours to rebase, and a broken layer waits for a broken one below it", () => {
      const s = agentOn();
      const conflicted = policy.planJobs([layerPr(2, { pr: { hasConflicts: true, ciState: "failure" } })], s, noSessions);
      assert.deepStrictEqual([conflicted.jobs, conflicted.merges], [[], []], "no drive merging the base in, no self-review, no merge offer");
      assert.match(conflicted.idle.get("PR_L2"), /^Yours — in a stack with conflicts; rebase the stack: Rebase stack on GitHub, or gh stack rebase and gh stack push$/);
      assert.deepStrictEqual(policy.planJobs([{ ...reviewPr({ role: "author" }), hasConflicts: true }], s, noSessions).jobs[0].reasons, ["conflicts"], "outside a stack a conflict is still a drive");

      const red = { ciState: "failure" };
      const drives = (prs) => policy.planJobs(prs, s, noSessions).jobs.filter((j) => j.scenario === "drive").map((j) => j.prNumber);
      const r = policy.planJobs([layerPr(3, { pr: red }), layerPr(2, { pr: red }), layerPr(1, { pr: red })], s, noSessions);
      assert.deepStrictEqual(r.jobs.map((j) => j.prNumber), [11], "only the lowest broken layer is driven");
      assert.strictEqual(r.idle.get("PR_L2"), "Yours — #11 below it in the stack comes first");
      assert.strictEqual(r.idle.get("PR_L3"), "Yours — #11 below it in the stack comes first");
      assert.deepStrictEqual(drives([layerPr(2, { pr: red }), layerPr(1)]), [12], "a green layer below holds nothing");
      assert.deepStrictEqual(drives([layerPr(2, { pr: red }), layerPr(1, { role: "reviewer", pr: red })]), [12], "nor someone else's");
      assert.deepStrictEqual(drives([layerPr(2, { pr: red }), layerPr(1, { pr: { ...red, isDraft: true } })]), [12], "nor a draft");
      assert.strictEqual(policy.planJobs([layerPr(2, { pr: red }), layerPr(1, { pr: { hasConflicts: true } })], s, noSessions).idle.get("PR_L2"), "Yours — #11 below it in the stack comes first", "a layer below that needs its rebase holds the ones above");
      // The Board's card says what mends it.
      const conflictPr = layerPr(2, { pr: { hasConflicts: true } });
      assert.strictEqual(view.stageLine(stage(conflictPr), conflictPr), "Conflicts in the stack — it needs Rebase stack");
      const plainPr = { ...reviewPr({ role: "author" }), hasConflicts: true };
      assert.strictEqual(view.stageLine(stage(plainPr), plainPr), "Conflicts with the base branch");
    });

    test("agent stack: a push alone after your review is checked for the same change on a new base before any re-review", () => {
      const at = (h) => `2026-07-0${h}T00:00:00Z`;
      const rv = (o = {}) => ({ ...reviewPr({ viewerHasReviewed: true, role: "reviewed", requestedOfMe: false }), viewerReviewedAt: at(5), viewerReviewedHead: false, viewerReviewedOid: "old111", lastCommitPushedAt: at(6), authorRepliedAt: null, ...o });
      const plan = (state, o) => policy.planJobs([rv(o)], agentOn(), { ...noSessions, baseOnlyState: () => state });
      let r = plan("unchecked");
      assert.deepStrictEqual([r.jobs, r.baseChecks.map((j) => j.key)], [[], ["PR_R|rereview|aaa111|base"]]);
      assert.strictEqual(r.idle.get("PR_R"), "Reviewed — checking whether only the base changed under your review");
      r = plan("checking");
      assert.deepStrictEqual([r.jobs.length, r.baseChecks.length], [0, 1]);
      r = plan("same");
      assert.deepStrictEqual([r.jobs, r.baseChecks, r.idle.get("PR_R")], [[], [], "Reviewed — only the base changed under your review since"]);
      assert.deepStrictEqual(plan("changed").jobs.map((j) => j.key), [`PR_R|rereview|aaa111|reply@${at(6)}`], "the re-review runs as it always did");
      assert.strictEqual(plan("same", { authorRepliedAt: at(7) }).jobs.length, 1, "the author answered too: no check");
      assert.strictEqual(plan("same", { roles: ["reviewer"], requestedOfMe: true }).jobs.length, 1, "asked again: no check");
      assert.strictEqual(plan("same", { viewerReviewedOid: null }).jobs.length, 1, "no review commit to compare with");
      assert.strictEqual(policy.planJobs([rv()], agentOn(), noSessions).jobs.length, 1, "no hook: changed");
    });

    await atest("agent stack: in a real clone a layer rebased after the one below merged is the same change; an own commit, a change folded in or a conflict resolved by hand isn't", async () => {
      const md = require(path.join(__dirname, "../dist/main/main/agent/reapprove.js"));
      const wtM = require(path.join(__dirname, "../dist/main/main/agent/worktrees.js"));
      const { execFileSync } = require("node:child_process");
      const root = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-stack-"));
      const remote = path.join(root, "remote.git");
      const co = path.join(root, "co");
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
      const g = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.editor=true", ...args], { cwd: co, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      const write = (file, text) => nfsA.writeFileSync(path.join(co, file), text);
      const lines = (over = {}) => Array.from({ length: 12 }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
      execFileSync("git", ["init", "--bare", "-b", "master", remote], { env, stdio: "ignore" });
      // As GitHub does: a commit is fetched by its id, whichever ref holds it.
      execFileSync("git", ["-C", remote, "config", "uploadpack.allowAnySHA1InWant", "true"], { env, stdio: "ignore" });
      execFileSync("git", ["clone", remote, co], { env, stdio: "ignore" });
      g("checkout", "-b", "master");
      write("a.txt", lines());
      write("b.txt", lines());
      g("add", ".");
      g("commit", "-m", "base");
      g("push", "origin", "master");
      // Layer 1 changes a.txt; layer 2 — the PR you reviewed — changes b.txt on top of it.
      g("checkout", "-b", "layer-1");
      write("a.txt", lines({ 2: "layer 1" }));
      g("commit", "-am", "layer 1");
      g("push", "origin", "layer-1");
      const layer1 = g("rev-parse", "HEAD");
      g("checkout", "-b", "layer-2");
      write("b.txt", lines({ 5: "layer 2" }));
      g("commit", "-am", "layer 2");
      const reviewed = g("rev-parse", "HEAD");
      const pushPr = () => {
        g("push", "-f", "origin", "HEAD:refs/pull/2/head");
        return g("rev-parse", "HEAD");
      };
      pushPr();
      const local = { git: wtM.runGit, checkout: co, remote: "origin" };
      const check = (head, reviewedOn = null) => md.sameChangeOnNewBase(local, { number: 2, baseRefName: "master" }, reviewed, head, reviewedOn);
      g("checkout", "master");
      write("c.txt", "elsewhere\n");
      g("add", ".");
      g("commit", "-m", "master moves");
      g("push", "origin", "master");
      // Layer 2 moved onto master with layer 1 NOT merged: layer 1's code is in its diff now.
      g("checkout", "-B", "leak", reviewed);
      g("rebase", "master");
      const leaked = pushPr();
      assert.strictEqual(await check(leaked), null, "against master alone it reads the same — the reviewed head holds layer 1 too");
      assert.strictEqual(await check(leaked, layer1), "the PR's own change differs from the one you reviewed", "against the base you reviewed it on, it doesn't");
      // Layer 1 lands squashed, and GitHub rebases layer 2 onto master.
      g("checkout", "master");
      g("merge", "--squash", "layer-1");
      g("commit", "-m", "layer 1 (#1)");
      g("push", "origin", "master");
      g("checkout", "-B", "rebased", reviewed);
      g("rebase", "--onto", "master", "layer-1");
      const rebased = pushPr();
      assert.strictEqual(await check(rebased), null, "the same layer on the new base");
      assert.strictEqual(await check(rebased, layer1), null, "taken against the base you reviewed it on, too");

      // The check as main runs it: what GitHub records about the base since your review decides what it is taken against.
      const reviewedAt = "2026-11-01T00:00:00Z";
      const retarget = { __typename: "BaseRefChangedEvent", createdAt: "2026-11-02T00:00:00Z", previousRefName: "layer-1" };
      const lowerMerged = { headRefOid: layer1, mergedAt: "2026-11-02T00:00:00Z", isCrossRepository: false, headRepository: { nameWithOwner: "a/b" } };
      const ghWith = ({ events = [], hasNextPage = false, merged = [lowerMerged] } = {}) => async (args, opts) => {
        const { query, variables } = JSON.parse(opts.input);
        if (query.includes("BaseRefChangedEvent")) {
          assert.deepStrictEqual(variables, { id: "PR_2", since: reviewedAt }, "only what happened since your review");
          return { code: 0, stderr: "", stdout: JSON.stringify({ data: { node: { state: "OPEN", headRefOid: g("rev-parse", "HEAD"), baseRefName: "master", timelineItems: { pageInfo: { hasNextPage }, nodes: events } } } }) };
        }
        assert.deepStrictEqual(variables, { owner: "a", name: "b", ref: "layer-1", base: "master" }, "PRs merged from the branch it had into the one it has");
        return { code: 0, stderr: "", stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: merged } } } }) };
      };
      const target = (head) => ({ id: "PR_2", url: "https://github.com/a/b/pull/2", repo: "a/b", number: 2, headOid: head, baseRefName: "master", viewerReviewedAt: reviewedAt, viewerReviewedOid: reviewed });
      const verdict = async (gh, head = rebased) => (await md.checkBaseOnly(gh, target(head), local)).verdict;
      assert.deepStrictEqual(await md.checkBaseOnly(ghWith({ events: [retarget] }), target(rebased), local), { verdict: "same", note: `only the base changed since ${reviewed.slice(0, 7)}`, baseRefName: "master" });
      // A force-push of the base: taken against the tip GitHub records from before it.
      assert.strictEqual(await verdict(ghWith({ events: [{ __typename: "BaseRefForcePushedEvent", createdAt: "2026-11-02T00:00:00Z", beforeCommit: { oid: layer1 } }] })), "same");
      // Whatever can't be told for sure is "changed".
      for (const [why, gh] of [
        ["a force-push GitHub names no commit for", ghWith({ events: [{ __typename: "BaseRefForcePushedEvent", createdAt: "2026-11-02T00:00:00Z", beforeCommit: null }] })],
        ["two changes of the base", ghWith({ events: [retarget, { ...retarget, createdAt: "2026-11-03T00:00:00Z" }] })],
        ["more than one page of them", ghWith({ events: [retarget], hasNextPage: true })],
        ["a fork's PR from a branch of that name", ghWith({ events: [retarget], merged: [{ ...lowerMerged, isCrossRepository: true, headRepository: { nameWithOwner: "evil/b" } }] })],
        ["two PRs it could be", ghWith({ events: [retarget], merged: [lowerMerged, { ...lowerMerged, headRefOid: reviewed }] })],
        ["one merged before your review", ghWith({ events: [retarget], merged: [{ ...lowerMerged, mergedAt: "2026-10-01T00:00:00Z" }] })],
        ["none merged", ghWith({ events: [retarget], merged: [] })],
      ]) {
        assert.strictEqual(await verdict(gh), "changed", why);
      }
      g("checkout", "-B", "leak", leaked);
      pushPr();
      assert.strictEqual(await verdict(ghWith({ events: [retarget] }), leaked), "changed", "retargeted onto master without layer 1: a re-review");
      g("checkout", "-B", "rebased", rebased);
      pushPr();
      await assert.rejects(md.checkBaseOnly(ghWith(), { ...target(rebased), baseRefName: "layer-1" }, local), /moved on/, "the dashboard is behind GitHub");
      assert.deepStrictEqual(await md.checkBaseOnly(ghWith(), { ...target(rebased), viewerReviewedOid: null }, local), { verdict: "changed", note: "no review commit to compare with", baseRefName: "master" });
      assert.strictEqual((await md.checkBaseOnly(ghWith(), target(rebased), null)).note, "no clone of the repository to check the push in");

      write("d.txt", "more\n");
      g("add", ".");
      g("commit", "-m", "more");
      assert.strictEqual(await check(pushPr()), "the PR's own change differs from the one you reviewed", "a commit of the author's on top");

      g("reset", "--hard", rebased);
      write("b.txt", lines({ 5: "layer 2", 9: "slipped in" }));
      g("commit", "--amend", "-a", "--no-edit");
      assert.strictEqual(await check(pushPr()), "the PR's own change differs from the one you reviewed", "a change folded into the rebase");

      // Outside a stack: the base merged in is the same change too.
      g("checkout", "-B", "merged", reviewed);
      g("merge", "--no-edit", "master");
      assert.strictEqual(await check(pushPr()), null, "the base merged in, cleanly");

      // The base changes the reviewed line; the rebase's conflict is resolved by hand.
      g("checkout", "master");
      write("b.txt", lines({ 5: "master's own line 5" }));
      g("commit", "-am", "master touches line 5");
      g("push", "origin", "master");
      g("checkout", "-B", "conflict", rebased);
      try {
        g("rebase", "master");
      } catch {
        // The conflict, as expected.
      }
      write("b.txt", lines({ 5: "layer 2" }));
      g("add", ".");
      g("rebase", "--continue");
      const conflicted = pushPr();
      assert.strictEqual(await check(conflicted), "the reviewed change doesn't go onto the new base cleanly");

      await assert.rejects(check(rebased), /newer head/, "the PR moved on since the dashboard saw it");
      assert.strictEqual(await md.sameChangeOnNewBase(local, { number: 2, baseRefName: "master" }, "nope", conflicted), "no commit id to compare");
      assert.ok(!nfsA.existsSync(path.join(co, ".git", "FETCH_HEAD")), "no FETCH_HEAD is written");

      // A clone that never saw the reviewed head: it is fetched by its id from the remote, where no ref holds it now.
      const co2 = path.join(root, "co2");
      // --no-local: a plain local clone copies every object, unreachable ones too.
      execFileSync("git", ["clone", "--no-local", remote, co2], { env, stdio: "ignore" });
      g("push", "-f", "origin", `${rebased}:refs/pull/2/head`);
      assert.throws(() => execFileSync("git", ["cat-file", "-e", `${reviewed}^{commit}`], { cwd: co2, stdio: "ignore" }), "not in the new clone yet");
      assert.strictEqual(await md.sameChangeOnNewBase({ git: wtM.runGit, checkout: co2, remote: "origin" }, { number: 2, baseRefName: "master" }, reviewed, rebased), null);
    });

    await atest("agent stack: a reviewed PR whose new head is the same change on a new base gets no re-review — checked once per head", async () => {
      const oldHead = "1".repeat(40);
      const head = "2".repeat(40);
      const reviewed = (base = "layer-1") => ({
        ...reviewPr({ viewerHasReviewed: true, role: "reviewed", requestedOfMe: false, headOid: head }),
        ...{ viewerReviewedAt: "2026-07-05T00:00:00Z", viewerReviewedHead: false, viewerReviewedOid: oldHead, lastCommitPushedAt: "2026-07-06T00:00:00Z", authorRepliedAt: null },
        baseRefName: base,
        stack: inStack(2),
      });
      // GitHub as the check reads it: the PR at the dashboard's head and base, not retargeted since your review.
      let ghBase = "layer-1";
      let baseReads = 0;
      const baseGh = async (args, opts) => {
        baseReads++;
        assert.match(JSON.parse(opts.input).query, /BaseRefChangedEvent/);
        return { code: 0, stderr: "", stdout: JSON.stringify({ data: { node: { state: "OPEN", headRefOid: head, baseRefName: ghBase, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] } } } }) };
      };
      const fakeGit = (tree) => async (args) => {
        const a = gitCmd(args);
        // ls-remote <remote> <base ref> <pull ref>: both there, the PR at the dashboard's head.
        if (a[0] === "ls-remote") return `${"b".repeat(40)}\t${a[2]}\n${head}\t${a[3]}\n`;
        if (a[0] === "merge-base") return `${"c".repeat(40)}\n`;
        if (a[0] === "merge-tree") return "tree1\n";
        if (a[0] === "rev-parse") return `${tree}\n`;
        return "";
      };
      const f = agentFixture({ pr: reviewed(), script: keepWorking, git: fakeGit("tree1"), gh: baseGh });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => readLog(f).some((l) => l.event === "base-check"));
        await tickOnce();
        const line = readLog(f).find((l) => l.event === "base-check");
        assert.deepStrictEqual([line.data.verdict, line.data.oldHead, line.data.stack, line.data.layer, line.detail], ["same", oldHead, 9, 2, "only the base changed since 1111111"]);
        assert.deepStrictEqual([only(f).length, f.children.length], [0, 0], "no re-review");
        assert.strictEqual(f.agent.getState().idle.PR_R, "Reviewed — only the base changed under your review since");
        f.agent.onSnapshot(f.snapshot);
        await tickOnce();
        assert.deepStrictEqual([readLog(f).filter((l) => l.event === "base-check").length, baseReads], [1, 1], "once per head");
        // Retargeted since, on the same head: the verdict was for the other base — looked at again.
        ghBase = "master";
        f.snapshot.pullRequests[0] = reviewed("master");
        f.agent.onSnapshot(f.snapshot);
        await until(() => readLog(f).filter((l) => l.event === "base-check").length === 2);
        assert.strictEqual(baseReads, 2);
      } finally {
        f.agent.stop();
        ghBase = "layer-1";
      }

      // The layer's own change differs: the re-review runs — told it is a layer.
      const g = agentFixture({ pr: reviewed(), script: keepWorking, git: fakeGit("tree2"), gh: baseGh });
      try {
        g.agent.onSnapshot(g.snapshot);
        await until(() => g.children.length === 1);
        assert.strictEqual(readLog(g).find((l) => l.event === "base-check").data.verdict, "changed");
        const c = g.children[0];
        assert.match(c.args[c.args.indexOf("--append-system-prompt") + 1], /layer 2 of 3 in GitHub stack #9/);
      } finally {
        g.agent.stop();
      }

      // A failed check waits its ten minutes; meanwhile no re-review starts.
      let lsRemotes = 0;
      const k = agentFixture({
        pr: reviewed(),
        script: keepWorking,
        gh: baseGh,
        git: async (args) => {
          if (gitCmd(args)[0] === "ls-remote") {
            lsRemotes++;
            throw new Error("network down");
          }
          return "";
        },
      });
      try {
        k.agent.onSnapshot(k.snapshot);
        await until(() => readLog(k).some((l) => l.event === "base-check"));
        await tickOnce();
        k.agent.onSnapshot(k.snapshot);
        await tickOnce();
        assert.deepStrictEqual([lsRemotes, readLog(k).find((l) => l.event === "base-check").data.verdict, only(k).length], [1, "error", 0]);
        assert.strictEqual(k.agent.getState().idle.PR_R, "Reviewed — checking whether only the base changed under your review");
      } finally {
        k.agent.stop();
      }
    });

    await atest("agent stack: a drive on a layer never pushes a merge commit, and says which layers above need Rebase stack", async () => {
      const mine = { ...layerPr(2), ciState: "failure", headRefName: "layer-2", headOid: "a".repeat(40) };
      let merges = "0";
      const commonDir = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-common-"));
      nfsA.writeFileSync(path.join(commonDir, "config"), "[core]\n");
      const pushes = [];
      const f = agentFixture({
        pr: mine,
        script: succeed("Fixed the failing test."),
        fetchPr: async () => ({ pr: mine, state: "OPEN", viewer: "me" }),
        git: async (all) => {
          let i = 0;
          for (;;) {
            if (all[i] === "-c") i += 2;
            else if (/^--(git-dir|work-tree)=/.test(all[i] ?? "")) i += 1;
            else break;
          }
          const args = all.slice(i);
          if (args[0] === "config") return `file:${commonDir}/config\0core.bare\0`;
          if (args[0] === "log") return "2222222222222222222222222222222222222222\tfix: the failing test\n";
          if (args[0] === "rev-list") return `${merges}\n`;
          if (args[0] === "diff") return args.includes("--stat") ? " a.ts | 2 +-" : "+fixed";
          if (args[0] === "rev-parse") return args.includes("HEAD") ? "2222222222222222222222222222222222222222\n" : `${commonDir}\n`;
          if (args[0] === "remote") return "https://github.com/a/b.git\n";
          if (args[0] === "push") pushes.push(all);
          return "";
        },
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const item = only(f)[0];
        const rules = f.children[0].args[f.children[0].args.indexOf("--append-system-prompt") + 1];
        assert.match(rules, /layer 2 of 3 in GitHub stack #9/);
        assert.doesNotMatch(rules, /Resolve a conflict by merging the base branch in/);
        nfsA.mkdirSync(item.worktree, { recursive: true });
        // A merge commit turned up in the worktree since (the session went on): nothing pushed.
        merges = "1";
        assert.match((await f.agent.act({ type: "push", runId: item.runId })).error, /merge commit in a stacked PR/);
        assert.strictEqual(pushes.length, 0);
        merges = "0";
        only(f)[0].state = "needsYou";
        assert.deepStrictEqual(await f.agent.act({ type: "push", runId: item.runId }), { ok: true });
        assert.strictEqual(pushes.length, 1);
        assert.strictEqual(only(f)[0].headline, "Pushed 1 commit — the layer above (#13) needs Rebase stack");
      } finally {
        f.agent.stop();
      }

      // A run that made a merge commit itself: failed, nothing to push.
      merges = "1";
      const g = agentFixture({
        pr: mine,
        script: succeed("Merged the base in."),
        git: async (all) => {
          let i = 0;
          for (;;) {
            if (all[i] === "-c") i += 2;
            else if (/^--(git-dir|work-tree)=/.test(all[i] ?? "")) i += 1;
            else break;
          }
          const args = all.slice(i);
          if (args[0] === "config") return `file:${commonDir}/config\0core.bare\0`;
          if (args[0] === "log") return "2222222222222222222222222222222222222222\tMerge branch 'layer-1'\n";
          if (args[0] === "rev-list") return "1\n";
          if (args[0] === "rev-parse") return args.includes("HEAD") ? "2222222222222222222222222222222222222222\n" : `${commonDir}\n`;
          if (args[0] === "remote") return "https://github.com/a/b.git\n";
          return "";
        },
      });
      try {
        g.agent.onSnapshot(g.snapshot);
        await until(() => only(g).some((i) => i.state === "error"));
        assert.strictEqual(only(g)[0].headline, "The run made a merge commit in a stacked PR — nothing to push");
      } finally {
        g.agent.stop();
      }
    });

    // --- asked again with your approval standing on the head (#4079) ---
    const approvedHere = (o = {}) => ({
      ...reviewPr({ viewerHasReviewed: true, role: "reviewer", requestedOfMe: true, headOid: "e".repeat(40) }),
      roles: ["reviewer", "reviewed"],
      viewerApproved: true,
      viewerReviewedHead: true,
      viewerReviewedOid: "e".repeat(40),
      viewerReviewedAt: new Date(Date.now() - 3 * 3600e3).toISOString(),
      authorRepliedAt: null,
      ...o,
    });

    test("agent board: asked again with your approval standing on this head is Done, not Your move — a reply or a new head is yours again", () => {
      const s = stage(approvedHere());
      assert.deepStrictEqual([s.lane, s.column, s.action, s.askedAgain, s.earlier], ["review", "done", null, true, false]);
      assert.strictEqual(view.stageLine(s, approvedHere()), "Asked again — your approval stands on this head");
      assert.strictEqual(view.approvalStands(approvedHere()), true);
      // The author answered in a thread after your approval: a look is due.
      const replied = approvedHere({ authorRepliedAt: new Date().toISOString() });
      assert.strictEqual(view.approvalStands(replied), false);
      assert.deepStrictEqual(where(stage(replied)), ["review", "you", "rereview", "Open on GitHub", false]);
      // Your approval is on an older head: the new head is unreviewed.
      assert.deepStrictEqual(where(stage(approvedHere({ viewerReviewedHead: false }))), ["review", "you", "rereview", "Open on GitHub", false]);
      // Not asked: the plain approval, as before.
      const quiet = stage(approvedHere({ requestedOfMe: false, roles: ["reviewed"] }));
      assert.deepStrictEqual([quiet.column, quiet.askedAgain], ["done", false]);
      assert.strictEqual(view.stageLine(quiet, approvedHere({ requestedOfMe: false, roles: ["reviewed"] })), "You approved");
    });

    await atest("agent: Approve again answers the request on your click — read again first, signed, on the same head; nothing else", async () => {
      const head = "e".repeat(40);
      let freshPr = approvedHere();
      const posted = [];
      const f = agentFixture({
        pr: approvedHere(),
        script: keepWorking,
        fetchPr: async () => ({ pr: freshPr, state: "OPEN", viewer: "me" }),
        gh: async (args, opts) => {
          posted.push({ endpoint: args[1], body: JSON.parse(opts.input) });
          return { code: 0, stdout: "{}", stderr: "" };
        },
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await tickOnce();
        assert.deepStrictEqual([only(f).length, f.children.length], [0, 0], "asked again with nothing new: no re-review");
        // GitHub says otherwise by now: nothing goes out.
        freshPr = approvedHere({ headOid: "f".repeat(40) });
        assert.match((await f.agent.act({ type: "approveAgain", prId: "PR_R" })).error, /new commits since/);
        freshPr = approvedHere({ authorRepliedAt: new Date().toISOString() });
        assert.match((await f.agent.act({ type: "approveAgain", prId: "PR_R" })).error, /no longer stands|answered since/);
        assert.deepStrictEqual(posted, []);
        freshPr = approvedHere();
        assert.deepStrictEqual(await f.agent.act({ type: "approveAgain", prId: "PR_R" }), { ok: true });
        assert.deepStrictEqual(posted.map((p) => [p.endpoint, p.body.event, p.body.commit_id]), [["repos/a/b/pulls/7/reviews", "APPROVE", head]]);
        assert.ok(posted[0].body.body.startsWith("Approved again: nothing changed since my approval of `eeeeeee`.") && posted[0].body.body.endsWith(ad.DEFAULT_AGENT_SIGNATURE), "one line and the signature");
        assert.deepStrictEqual(only(f), [], "no item, no session");
        const logged = readLog(f).find((l) => l.event === "approved-again");
        assert.deepStrictEqual([logged.kind, logged.prNumber, logged.headOid], ["run", 7, head]);
        assert.ok(readLog(f).some((l) => l.kind === "action" && l.event === "approveAgain" && l.data.ok === true), "the click is in the log");
        assert.strictEqual((await f.agent.act({ type: "approveAgain", prId: "PR_GONE" })).ok, false);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent: a review you asked for that finds your approval already on the head says so", async () => {
      const f = agentFixture({ pr: approvedHere({ requestedOfMe: false, roles: ["reviewed"] }), script: succeed("Already approved this head; nothing new."), captureScript: captureJs });
      try {
        f.agent.onSnapshot(f.snapshot);
        assert.deepStrictEqual(await f.agent.act({ type: "enqueue", prId: "PR_R" }), { ok: true });
        await until(() => only(f).length === 1 && only(f)[0].state === "done");
        assert.strictEqual(only(f)[0].headline, "Already approved on this head — nothing to post");
      } finally {
        f.agent.stop();
      }
      // Elsewhere it stays as it was.
      const g = agentFixture({ pr: { ...approvedHere({ requestedOfMe: false, roles: ["reviewed"] }), viewerApproved: false }, script: succeed("Nothing to add."), captureScript: captureJs });
      try {
        g.agent.onSnapshot(g.snapshot);
        assert.deepStrictEqual(await g.agent.act({ type: "enqueue", prId: "PR_R" }), { ok: true });
        await until(() => only(g).length === 1 && only(g)[0].state === "done");
        assert.strictEqual(only(g)[0].headline, "Reviewed — nothing to post");
      } finally {
        g.agent.stop();
      }
    });

    await atest("agent: a run whose process is ended mid-workflow is interrupted, not a clean review — it goes on in the same session", async () => {
      const notes = [];
      let spawned = 0;
      const cutMidWorkflow = (c) => {
        emit(c, { type: "system", subtype: "init", session_id: "s" });
        emit(c, { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w" }] });
        emit(c, { type: "result", subtype: "success", is_error: false, result: "The review workflow is running in the background. I'll report once it completes." });
        setImmediate(() => c.emit("exit", runner.STATUS_CONTROL_C_EXIT, null));
      };
      const f = agentFixture({ script: (c) => (++spawned === 1 ? cutMidWorkflow(c) : keepWorking(c)), notify: (n) => notes.push(n.kind) });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f)[0]?.interrupted === true);
        const item = only(f)[0];
        assert.deepStrictEqual(
          [item.state, item.headline],
          ["needsYou", "Interrupted — its process was ended (Ctrl+C, or Windows shutting down or signing out)"],
          "not «Reviewed — nothing to post»",
        );
        assert.ok(!f.gitCalls.some((a) => a[0] === "worktree" && a[1] === "remove"), "its folder stays for the session to go on in");
        await until(() => readLog(f).some((l) => l.event === "interrupted"));
        const line = readLog(f).find((l) => l.event === "interrupted");
        assert.deepStrictEqual([line.kind, line.data.exitCode, line.data.backgroundTasks], ["run", 3221225786, 1]);
        assert.ok(!readLog(f).some((l) => l.kind === "run" && ["done", "needsYou", "failed"].includes(l.event)), "no false end");
        assert.deepStrictEqual(notes, [], "nothing to tell you: it goes on by itself");

        // The next snapshot takes it up again, in the session it ran.
        nfsA.mkdirSync(item.worktree, { recursive: true });
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.children.length === 2);
        const c = f.children[1];
        assert.strictEqual(c.args[c.args.indexOf("--resume") + 1], item.sessionId, "the very session it ran");
        assert.strictEqual(c.cwd, item.worktree);
        assert.strictEqual(only(f)[0].state, "working");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent: a run cut short three times in a row stops going on by itself", async () => {
      const cut = (c) => {
        emit(c, { type: "system", subtype: "init", session_id: "s" });
        setImmediate(() => c.emit("exit", runner.STATUS_CONTROL_C_EXIT, null));
      };
      const f = agentFixture({ script: cut });
      try {
        f.agent.onSnapshot(f.snapshot);
        for (let k = 1; k <= 2; k++) {
          await until(() => f.children.length === k && only(f)[0].interrupted === true);
          nfsA.mkdirSync(only(f)[0].worktree, { recursive: true });
          f.agent.onSnapshot(f.snapshot);
        }
        await until(() => only(f)[0].state === "error");
        assert.strictEqual(f.children.length, 3);
        assert.strictEqual(only(f)[0].headline, "Cut short 3 times in a row");
        assert.match(only(f)[0].error, /process was ended/);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent: an interrupted drive, or a run whose folder is gone, starts over as a new run", async () => {
      const base = { prId: "PR_R", prNumber: 7, repo: "a/b", url: "https://github.com/a/b/pull/7", title: "t", hostLabel: "GH", mode: "shadow", state: "working", headline: "h", queuedAt: "2026-11-05T00:00:00Z" };
      for (const [scenario, folder] of [["drive", "here"], ["review", "gone"]]) {
        const home = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-agent-"));
        const runId = "00000000-0000-4000-8000-0000000000d1";
        const st = agentStore.emptyStore("2026-11-05");
        st.items = [{ ...base, runId, key: `PR_R|${scenario}|aaa111`, scenario, sessionId: "11111111-1111-4111-8111-111111111111", worktree: folder === "here" ? home : path.join(home, "gone") }];
        agentStore.writeFileAtomic(path.join(home, "agent", "state.json"), JSON.stringify(st));
        const g = agentFixture({ home, script: keepWorking });
        try {
          assert.ok(only(g).every((i) => i.state === "needsYou" && i.interrupted), scenario);
          g.agent.onSnapshot(g.snapshot);
          await until(() => only(g).some((i) => i.key === `PR_R|${scenario}|aaa111|asked`));
          assert.strictEqual(only(g).find((i) => i.runId === runId).headline, view.AGENT_CLOSED.rerun, scenario);
          await until(() => g.children.length > 0);
          assert.ok(g.children.every((c) => c.args.includes("--session-id") && !c.args.includes("--resume")), `${scenario}: a new session`);
        } finally {
          g.agent.stop();
        }
      }
    });

    await atest("agent: a run cut short on a head that has moved isn't resumed — what you asked for starts over on the new head, with no automatic one beside it", async () => {
      const base = { prId: "PR_R", prNumber: 7, repo: "a/b", url: "https://github.com/a/b/pull/7", title: "t", hostLabel: "GH", mode: "shadow", state: "working", headline: "h", queuedAt: "2026-11-05T00:00:00Z", scenario: "review" };
      for (const asked of [false, true]) {
        const home = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-agent-"));
        const runId = "00000000-0000-4000-8000-0000000000e1";
        const st = agentStore.emptyStore("2026-11-05");
        // Its session and folder are still there: before, it would have resumed on the old head.
        // Beside it, what the agent queued on its own for the new head before the app closed.
        const auto = "00000000-0000-4000-8000-0000000000e2";
        st.items = [
          { ...base, runId, key: `PR_R|review|old000${asked ? "|asked" : ""}`, sessionId: "11111111-1111-4111-8111-111111111111", worktree: home },
          { ...base, runId: auto, key: "PR_R|review|aaa111", state: "queued", queuedAt: "2026-11-05T00:01:00Z" },
        ];
        agentStore.writeFileAtomic(path.join(home, "agent", "state.json"), JSON.stringify(st));
        const g = agentFixture({ home, script: keepWorking });
        try {
          g.agent.onSnapshot(g.snapshot);
          const want = `PR_R|review|aaa111${asked ? "|asked" : ""}`;
          await until(() => g.children.length === 1);
          const old = only(g).find((i) => i.runId === runId);
          assert.strictEqual(old.headline, asked ? view.AGENT_CLOSED.rerun : view.AGENT_CLOSED.superseded, `asked=${asked}`);
          // Asked: yours goes first, the automatic one leaves. Found by the agent: the queued one simply runs.
          assert.strictEqual(only(g).find((i) => i.runId === auto).state, asked ? "done" : "working", `asked=${asked}`);
          assert.ok(g.children[0].args.includes("--session-id") && !g.children[0].args.includes("--resume"), "a new session on the new head");
          assert.deepStrictEqual(only(g).filter((i) => i.state === "queued" || i.state === "working").map((i) => i.key), [want], `asked=${asked}: one run, on the new head`);
          g.agent.onSnapshot(g.snapshot);
          assert.strictEqual(only(g).filter((i) => i.state === "queued" || i.state === "working").length, 1, "the next plan adds no automatic review of the head you asked about");
          const line = readLog(g).find((l) => l.event === "not-resumed");
          assert.deepStrictEqual([line.runId, line.headOid, line.data.was], [runId, "aaa111", "old000"]);
        } finally {
          g.agent.stop();
        }
      }
    });

    await atest("agent: switched on in Settings, it plans at once — the poller reports a snapshot only when PRs change", async () => {
      let pushes = 0;
      const f = agentFixture({ enabled: false, script: keepWorking, onChange: () => pushes++ });
      try {
        f.agent.onSnapshot(f.snapshot);
        assert.strictEqual(f.agent.getState().idle.PR_R, "The agent is off");
        f.setAgent({ enabled: true });
        f.agent.refresh();
        assert.ok(pushes > 0, "the new state is pushed");
        assert.strictEqual(f.agent.getState().enabled, true);
        assert.notStrictEqual(f.agent.getState().idle.PR_R, "The agent is off");
        await until(() => f.children.length === 1);
        const before = pushes;
        f.agent.refresh();
        assert.strictEqual(f.children.length, 1, "unchanged settings plan nothing new");
        assert.ok(pushes > before, "a refresh still pushes: the chip and tray line are settings too");
        f.setAgent({ enabled: false });
        f.agent.refresh();
        assert.deepStrictEqual([f.agent.getState().enabled, f.agent.getState().idle.PR_R], [false, "The agent is off"], "switched off: it says so at once");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent: a settings change is noticed on the agent's own tick too", async () => {
      const f = agentFixture({ enabled: false, script: keepWorking, tickMs: 20 });
      try {
        f.agent.onSnapshot(f.snapshot);
        await new Promise((r) => setTimeout(r, 60));
        assert.strictEqual(f.children.length, 0);
        f.setAgent({ enabled: true });
        await until(() => f.children.length === 1);
      } finally {
        f.agent.stop();
      }
    });

    test("agent queue: your order first, then the oldest; a place in front of any run, or the end", () => {
      const q = (id, at, rank) => vItem({ prId: id, runId: `00000000-0000-4000-8000-00000000000${id}`, state: "queued", queuedAt: at, ...(rank !== undefined ? { rank } : {}) });
      const a = q("1", "2026-11-05T09:00:00.000Z");
      const b = q("2", "2026-11-05T10:00:00.000Z");
      const c = q("3", "2026-11-05T11:00:00.000Z");
      assert.deepStrictEqual(view.queueOrder([c, a, b]).map((i) => i.prId), ["1", "2", "3"]);
      const front = view.rankBefore([a, b], a.runId);
      assert.deepStrictEqual(view.queueOrder([a, b, { ...c, rank: front }]).map((i) => i.prId), ["3", "1", "2"], "Run next");
      const middle = view.rankBefore([a, b], b.runId);
      assert.deepStrictEqual(view.queueOrder([a, b, { ...c, rank: middle }]).map((i) => i.prId), ["1", "3", "2"]);
      const end = view.rankBefore([b, c], null);
      assert.deepStrictEqual(view.queueOrder([b, c, { ...a, rank: end }]).map((i) => i.prId), ["2", "3", "1"]);
      assert.strictEqual(view.rankBefore([b, c], "00000000-0000-4000-8000-000000000999"), end, "a run no longer queued means the end");
      assert.strictEqual(view.rankBefore([], null), undefined, "an empty queue: its own time will do");
    });

    await atest("agent worktrees: Run again gets a folder of its own, and the old one stays while your session works in it", async () => {
      const sessions = [];
      const f = agentFixture({ script: reviewWithPlan(), captureScript: captureJs, sessions });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const first = only(f)[0];
        // You continue its session in your terminal.
        sessions.push({ id: first.sessionId, name: "x", status: "idle", where: "terminal", prKeys: [], repoKeys: [], branch: null });
        assert.deepStrictEqual(await f.agent.act({ type: "retry", runId: first.runId }), { ok: true });
        await until(() => only(f).some((i) => i.runId !== first.runId && i.worktree));
        const second = only(f).find((i) => i.runId !== first.runId);
        assert.notStrictEqual(second.worktree, first.worktree, "a folder of its own");
        const removed = () => f.gitCalls.filter((a) => a[0] === "worktree" && a[1] === "remove").map((a) => a[3]);
        assert.ok(!removed().includes(first.worktree), "your session's folder is left alone");
        assert.strictEqual(only(f).find((i) => i.runId === first.runId).worktree, first.worktree, "and remembered, to go later");
        // You closed the session: the next sweep takes the folder.
        sessions.length = 0;
        f.agent.onSnapshot(f.snapshot);
        await until(() => removed().includes(first.worktree));
        await until(() => only(f).find((i) => i.runId === first.runId).worktree === undefined);
      } finally {
        f.agent.stop();
      }
    });

    const agentResult = require(path.join(__dirname, "../dist/main/shared/agent-result.js"));
    test("agent result: the card reads the session's prd-result block, held to its shapes; the rest is the report", () => {
      const block = (o) => "## Summary\n\nLong prose.\n\n```prd-result\n" + JSON.stringify(o) + "\n```\n";
      const r = agentResult.parseRunResult(
        block({
          summary: "Nothing to post: your approve stands.",
          asks: [{ question: "Keep the finding?", options: ["Keep", "Drop", "", 3, "a", "b", "c"] }, { question: "" }, "junk"],
          findings: [
            { severity: "minor", text: "small", where: "a.ts:1" },
            { severity: "BLOCKER", text: "big", where: "b.ts:2" },
            { severity: "weird", text: "odd" },
            { severity: "major", text: "" },
          ],
        }),
      );
      assert.strictEqual(r.card.structured, true);
      assert.strictEqual(r.card.summary, "Nothing to post: your approve stands.");
      assert.deepStrictEqual(r.card.asks, [{ question: "Keep the finding?", options: ["Keep", "Drop", "a", "b"] }], "only real questions, at most 4 string options");
      assert.deepStrictEqual(r.card.findings.map((x) => [x.severity, x.text]), [["blocker", "big"], ["minor", "small"], ["note", "odd"]], "most severe first; unknown severity is a note; empty text dropped");
      assert.strictEqual(r.body, "## Summary\n\nLong prose.", "the block is not part of the report");
      // No block, or a broken one: the first real paragraph, without markdown.
      const fallback = agentResult.parseRunResult("## Summary\n\n**Nothing was prepared** — see `x` and [the PR](https://x).\n\nMore.");
      assert.deepStrictEqual([fallback.card.structured, fallback.card.summary, fallback.card.asks], [false, "Nothing was prepared — see x and the PR.", []]);
      assert.strictEqual(agentResult.parseRunResult("```prd-result\n{not json\n```\nText after.").card.summary, "Text after.");
      assert.strictEqual(agentResult.summarizeOutput("```\ncode\n```\n# H\n\n- first point\n- second"), "first point second");
      assert.strictEqual(agentResult.summarizeOutput("x".repeat(400)).length, 240);
      // The last block wins (a skill's own example earlier in the message doesn't).
      const two = agentResult.parseRunResult(block({ summary: "first" }) + "\n" + block({ summary: "last" }));
      assert.strictEqual(two.card.summary, "last");
      assert.strictEqual(agentResult.resultCard({ output: "Plain words." }).summary, "Plain words.", "a result from before the block still has a summary");
      assert.strictEqual(agentResult.resultCard({}), null);
      for (const [scenario, mode] of [["review", "shadow"], ["brief", "on"], ["drive", "shadow"], ["afterMerge", "on"], ["rereview", "on"]]) {
        assert.ok(agentCore.agentRules(scenario, mode).endsWith(agentResult.resultRuleFor(scenario)), `${scenario} sessions are told how to end`);
      }
    });

    await atest("agent answer: a run on your PR that asks you waits with its question; your answer goes on in the same session; Discard closes it", async () => {
      const text = "Prose.\n\n```prd-result\n" + JSON.stringify({ summary: "One finding is a product decision.", asks: [{ question: "Make the threshold configurable?", options: ["Yes", "No"] }], findings: [] }) + "\n```";
      const mine = { ...reviewPr({ role: "author", headOid: "abcdef1234567" }), awaitingReview: true };
      const common = nfsA.mkdtempSync(path.join(os.tmpdir(), "prd-common-"));
      nfsA.writeFileSync(path.join(common, "config"), "[core]\n");
      const gitImpl = async (all) => {
        let i = 0;
        for (;;) {
          if (all[i] === "-c") i += 2;
          else if (/^--(git-dir|work-tree)=/.test(all[i] ?? "")) i += 1;
          else break;
        }
        const args = all.slice(i);
        if (args[0] === "config") return `file:${common}/config\0core.bare\0`;
        if (args[0] === "rev-parse") return `${common}\n`;
        if (args[0] === "remote") return "https://github.com/a/b.git\n";
        return "";
      };
      const f = agentFixture({ pr: mine, script: succeed(text), git: gitImpl });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const item = only(f)[0];
        assert.deepStrictEqual([item.result.summary, item.result.asks[0].question, item.output], ["One finding is a product decision.", "Make the threshold configurable?", "Prose."]);
        assert.strictEqual(actionLabel(item), "Your call");
        nfsA.mkdirSync(item.worktree, { recursive: true });
        assert.deepStrictEqual(await f.agent.act({ type: "answer", runId: item.runId, text: "Q: Make the threshold configurable?\nA: No" }), { ok: true });
        await until(() => f.children.length === 2);
        const c = f.children[1];
        assert.strictEqual(c.args[c.args.indexOf("--resume") + 1], item.sessionId, "the same session");
        assert.strictEqual(c.cwd, item.worktree);
        await until(() => only(f)[0].state === "needsYou");
        assert.match(c.written, /The user answered from the app: Q: Make the threshold configurable\?\\nA: No/);
        assert.match(nfsA.readFileSync(path.join(f.dir, "agent", "log.jsonl"), "utf8"), /"event":"answered"/);
        assert.strictEqual(only(f)[0].answer, undefined, "the answer is used once");
        // Discard: it closes.
        assert.deepStrictEqual(await f.agent.act({ type: "skip", runId: item.runId }), { ok: true });
        assert.strictEqual(only(f)[0].state, "done");
        assert.strictEqual((await f.agent.act({ type: "answer", runId: item.runId, text: "late" })).ok, false, "a closed result can't be answered");
      } finally {
        f.agent.stop();
      }
    });

    test("agent result: on a PR you review nothing is asked of you — questions are the author's; a brief's go into the review it drafts", () => {
      const block = (o) => "Text.\n\n```prd-result\n" + JSON.stringify(o) + "\n```";
      const r = agentResult.parseRunResult(block({ summary: "s", asks: [{ question: "Is the retry unbounded on purpose?", options: ["Yes"] }], findings: [], authorQuestions: ["Why a new endpoint?"] }), "review");
      assert.deepStrictEqual([r.card.asks, r.card.authorQuestions], [[], ["Why a new endpoint?", "Is the retry unbounded on purpose?"]]);
      const own = agentResult.parseRunResult(block({ summary: "s", asks: [{ question: "Configurable?", options: [] }], findings: [] }), "drive");
      assert.strictEqual(own.card.asks.length, 1, "your own PR may ask you");
      assert.match(agentResult.resultRuleFor("review"), /never ask them anything/);
      assert.match(agentResult.resultRuleFor("brief"), /authorQuestions/);
      assert.strictEqual(agentResult.resultRuleFor("drive"), agentResult.RESULT_RULE);
      // A result stored before the rule reads the same way.
      const old = agentResult.resultCard({ scenario: "rereview", result: { summary: "s", asks: [{ question: "Keep it?", options: [] }], findings: [], structured: true } });
      assert.deepStrictEqual([old.asks, old.authorQuestions], [[], ["Keep it?"]]);
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "needsYou", scenario: "brief", output: "b", result: { summary: "s", asks: [], findings: [], authorQuestions: ["q"], structured: true } })), "Draft a review");
    });

    await atest("agent brief: Review anyway carries the brief's questions for the author into the review it drafts", async () => {
      const big = reviewPr({ additions: 5000 });
      const text = "Brief.\n\n```prd-result\n" + JSON.stringify({ summary: "Big change.", findings: [], authorQuestions: ["Why drop the cache?"], asks: [] }) + "\n```";
      const f = agentFixture({ pr: big, script: succeed(text), agent: { scenarios: { review: { mode: "off" } } } });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.scenario === "brief" && i.state === "needsYou"));
        const brief = only(f).find((i) => i.scenario === "brief");
        assert.deepStrictEqual(brief.result.authorQuestions, ["Why drop the cache?"]);
        assert.deepStrictEqual(await f.agent.act({ type: "reviewAnyway", runId: brief.runId }), { ok: true });
        await until(() => f.children.length === 2);
        assert.match(f.children[1].written, /questions for its author[\s\S]*Why drop the cache\?/);
        assert.match(only(f)[1].brief, /^Brief\./, "the brief's text stays on the review's card");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent brief: a big PR's review follows its brief on its own — the brief's questions in its prompt, its text on its card, no toast for the brief", async () => {
      const big = reviewPr({ additions: 5000 });
      const text = "Brief.\n\n```prd-result\n" + JSON.stringify({ summary: "Big change.", findings: [], authorQuestions: ["Why drop the cache?"], asks: [] }) + "\n```";
      const notices = [];
      const f = agentFixture({ pr: big, script: succeed(text), notify: (n) => notices.push([n.kind, n.item.scenario]) });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.children.length === 2);
        const [brief, review] = only(f);
        assert.deepStrictEqual([brief.scenario, brief.state, brief.headline], ["brief", "done", view.AGENT_CLOSED.reviewed], "the brief leaves Your move for the review");
        assert.deepStrictEqual([review.scenario, review.key], ["review", `${big.id}|review|aaa111`], "planned by the agent, not asked by you");
        assert.deepStrictEqual(review.carry, ["Why drop the cache?"]);
        assert.match(review.brief, /^Brief\./);
        assert.match(f.children[1].written, /questions for its author[\s\S]*Why drop the cache\?/);
        await until(() => only(f)[1].state !== "queued" && only(f)[1].state !== "working");
        assert.ok(!notices.some(([kind, scenario]) => kind === "needsYou" && scenario === "brief"), "the brief alone asks nothing of you: no toast for it");
        // The head's brief and review are both in the ledger: another plan of the same head runs neither again.
        f.agent.onSnapshot(f.snapshot);
        assert.strictEqual(f.children.length, 2);
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent brief: a brief you asked for on a big PR is followed by the review too", async () => {
      const big = reviewPr({ additions: 5000 });
      const f = agentFixture({ pr: big, script: succeed("Brief.") });
      try {
        assert.deepStrictEqual(await f.agent.act({ type: "enqueue", prId: big.id }), { ok: true });
        await until(() => f.children.length === 2);
        const [brief, review] = only(f);
        assert.match(brief.key, /\|brief\|aaa111\|asked$/);
        assert.deepStrictEqual([brief.headline, review.scenario], [view.AGENT_CLOSED.reviewed, "review"]);
      } finally {
        f.agent.stop();
      }
    });

    test("ipc: an answer is text held to a bound", () => {
      const RID = "00000000-0000-4000-8000-000000000001";
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "answer", runId: RID, text: "  Keep  " }), { type: "answer", runId: RID, text: "Keep" });
      assert.throws(() => ipcAgent.validateAgentAction({ type: "answer", runId: RID, text: "" }));
      assert.throws(() => ipcAgent.validateAgentAction({ type: "answer", runId: RID, text: "x".repeat(ipcAgent.AGENT_HINT_MAX + 1) }));
    });

    // --- blockers from the deep test: what you saw is what goes out; off is off; drive can do its job ---
    test("agent publish: a plan recorded again counts once — one review, the last; a step written twice, once", () => {
      const review = (body) => JSON.stringify({ kind: "review", event: "COMMENT", body, comments: [] });
      const reply = JSON.stringify({ kind: "reply", replyTo: 5, body: "Fixed in the last commit." });
      const steps = pub.readPlanLines([review("first"), reply, reply, review("second")].join("\n"));
      assert.deepStrictEqual(steps.map((x) => x.kind), ["reply", "review"]);
      assert.strictEqual(steps[1].body, "second", "the summary you see and what is posted are the same review");
    });

    test("agent publish: a dispute you drop is a reply and a resolve; one you keep, or didn't choose, changes nothing", () => {
      const esc = [{ replyTo: 501, body: "caller checks" }, { replyTo: 502, body: "naming" }, { replyTo: 503, body: "scope" }];
      const steps = pub.disputeSteps(esc, { 501: "drop", 502: "keep" }, new Map([[501, "PRRT_a"], [502, "PRRT_b"]]));
      assert.deepStrictEqual(steps, [
        { kind: "reply", replyTo: 501, body: pub.DROP_REPLY },
        { kind: "resolve", threadId: "PRRT_a" },
      ]);
    });

    await atest("agent re-review: Keep or Drop the author's pushback — a dropped thread is answered and resolved when the review is sent", async () => {
      const writes = [];
      const reviewWithDispute = (c) => {
        const outDir = c.args[c.args.indexOf("--add-dir") + 1];
        const runDir = path.dirname(outDir);
        const run = JSON.parse(nfsA.readFileSync(path.join(runDir, "run.json"), "utf8"));
        const rf = path.join(outDir, "review.json");
        nfsA.writeFileSync(rf, JSON.stringify({ event: "COMMENT", body: "Re-review: 2 of 3 fixed.", comments: [] }));
        const ef = path.join(outDir, "dispute.txt");
        nfsA.writeFileSync(ef, "The author says the caller checks for null.");
        for (const a of [["review", run.repo, String(run.number), rf], ["escalate", run.repo, String(run.number), "501", ef]]) {
          const r = spawnSync(process.execPath, [captureJs, runDir, ...a], { encoding: "utf8" });
          if (r.status !== 0) throw new Error(r.stderr);
        }
        emit(c, { type: "system", subtype: "init", session_id: "s" });
        emit(c, { type: "result", subtype: "success", is_error: false, result: "Prepared the re-review." });
        setImmediate(() => c.emit("exit", 0));
      };
      const gh = async (args, opts) => {
        const body = opts?.input ? JSON.parse(opts.input) : null;
        if (args[1] === "graphql") {
          if (/mutation/.test(body.query)) return writes.push(["resolve", body.variables.id]), { code: 0, stdout: "{}", stderr: "" };
          if (/reviewThreads/.test(body.query)) {
            return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "PRRT_x1", comments: { nodes: [{ databaseId: 501 }] } }] } } } } }), stderr: "" };
          }
          return { code: 0, stdout: JSON.stringify({ data: { node: { isResolved: false, pullRequest: { number: 7, repository: { nameWithOwner: "a/b" } }, comments: { nodes: [{ author: { login: "me" } }] } } } }), stderr: "" };
        }
        if (!body && /pulls\/comments\/\d+$/.test(args[1])) {
          return { code: 0, stdout: JSON.stringify({ pull_request_url: "https://api.github.com/repos/a/b/pulls/7", user: { login: "me" }, in_reply_to_id: null }), stderr: "" };
        }
        writes.push([args[1], body?.body ?? body?.event]);
        return { code: 0, stdout: "{}", stderr: "" };
      };
      const f = agentFixture({ script: reviewWithDispute, captureScript: captureJs, gh, fetchPr: async () => ({ pr: reviewPr(), state: "OPEN", viewer: "me" }) });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const item = only(f)[0];
        assert.deepStrictEqual(item.plan.escalations.map((e) => e.replyTo), [501]);
        assert.match((await f.agent.act({ type: "dispute", runId: item.runId, replyTo: 999, choice: "drop" })).error, /didn't push back/);
        assert.deepStrictEqual(await f.agent.act({ type: "dispute", runId: item.runId, replyTo: 501, choice: "drop" }), { ok: true });
        assert.deepStrictEqual(await f.agent.act({ type: "publish", runId: item.runId }), { ok: true });
        assert.deepStrictEqual(
          writes.map((w) => w[0]),
          ["repos/a/b/pulls/7/reviews", "repos/a/b/pulls/7/comments/501/replies", "resolve"],
          "the review, then your drop: a reply in the thread and its resolve",
        );
        assert.ok(writes[1][1].startsWith(pub.DROP_REPLY) && writes[1][1].endsWith(ad.DEFAULT_AGENT_SIGNATURE), "signed like every write");
        assert.strictEqual(writes[2][1], "PRRT_x1");
      } finally {
        f.agent.stop();
      }
    });

    test("ipc: a dispute choice names a comment and keep or drop, nothing else", () => {
      const RID = "00000000-0000-4000-8000-000000000001";
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "dispute", runId: RID, replyTo: 501, choice: "drop", body: "x" }), { type: "dispute", runId: RID, replyTo: 501, choice: "drop" });
      assert.throws(() => ipcAgent.validateAgentAction({ type: "dispute", runId: RID, replyTo: "501", choice: "drop" }));
      assert.throws(() => ipcAgent.validateAgentAction({ type: "dispute", runId: RID, replyTo: 501, choice: "argue" }));
    });

    await atest("agent publish: a plan changed in the session since you saw it posts nothing; the card shows the new one and Publish then posts it", async () => {
      const posted = [];
      const f = agentFixture({
        script: reviewWithPlan("REQUEST_CHANGES"),
        captureScript: captureJs,
        fetchPr: async () => ({ pr: reviewPr(), state: "OPEN", viewer: "me" }),
        gh: async (args, opts) => (posted.push({ args, body: JSON.parse(opts.input) }), { code: 0, stdout: "{}", stderr: "" }),
      });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const item = only(f)[0];
        assert.strictEqual(item.plan.event, "REQUEST_CHANGES");
        // "Edit first": in the session you turn it into an approve, and it records the review again.
        nfsA.appendFileSync(path.join(item.runFolder, "plan.jsonl"), JSON.stringify({ kind: "review", event: "APPROVE", body: "Edited: looks good", comments: [] }) + "\n");
        const first = await f.agent.act({ type: "publish", runId: item.runId });
        assert.strictEqual(first.ok, false);
        assert.match(first.error, /changed in the session/);
        assert.strictEqual(posted.length, 0, "nothing you hadn't seen went out");
        assert.strictEqual(only(f)[0].plan.event, "APPROVE", "the card now shows what would go out");
        assert.match(only(f)[0].headline, /changed in the session/);
        assert.deepStrictEqual(await f.agent.act({ type: "publish", runId: item.runId }), { ok: true });
        const reviews = posted.filter((p) => /\/reviews$/.test(p.args[1]));
        assert.strictEqual(reviews.length, 1, "one review, never two");
        assert.strictEqual(reviews[0].body.event, "APPROVE");
        assert.strictEqual(f.agent.getState().acceptedUnchanged, 0, "an edited plan isn't 'published exactly as prepared'");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent off: switching it off stops the runs in flight and says why; your clicks still work, nothing new starts", async () => {
      const f = agentFixture({ script: keepWorking, agent: { scenarios: { review: { mode: "on" } } } });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.agent.getState().running.length === 1);
        const runId = only(f)[0].runId;
        f.setAgent({ enabled: false, scenarios: { review: { mode: "on" } } });
        f.agent.refresh();
        await until(() => only(f)[0].state === "done");
        assert.strictEqual(only(f)[0].headline, "Stopped — the agent was switched off");
        assert.strictEqual(f.agent.getState().running.length, 0);
        // Your own clicks, with the agent off.
        assert.match((await f.agent.act({ type: "retry", runId })).error, /The agent is off/, "a new run waits until it is on");
        assert.match((await f.agent.act({ type: "enqueue", prId: "PR_R" })).error, /The agent is off/);
        assert.deepStrictEqual(await f.agent.act({ type: "skip", runId }), { ok: true });
        assert.strictEqual(f.children.length, 1);
      } finally {
        f.agent.stop();
      }
    });

    test("agent tools: drive can merge the base in and read its threads; a list saved before that gets the new rules once", () => {
      for (const rule of ["Bash(git merge *)", "Bash(gh api *)", "Bash(gh pr diff *)"]) assert.ok(ad.DEFAULT_AGENT_TOOLS.drive.includes(rule), rule);
      assert.ok(!ad.DEFAULT_AGENT_TOOLS.drive.some((r) => /npm|test/.test(r)), "still no test commands by default");
      // A list saved before versions: it gets the rules added since.
      const old = ["Read", "Edit", "Bash(git commit *)"];
      const migrated = cfg.validateAgent({ permissions: { tools: { drive: old } } });
      assert.deepStrictEqual(migrated.permissions.tools.drive.slice(0, 3), old, "your own rules stay as they were");
      assert.ok(migrated.permissions.tools.drive.includes("Bash(git merge *)"));
      assert.strictEqual(migrated.permissions.toolsVersion, ad.AGENT_TOOLS_VERSION);
      // Saved at this version, a rule you removed stays removed.
      const mine = cfg.validateAgent({ permissions: { tools: { drive: old }, toolsVersion: ad.AGENT_TOOLS_VERSION } });
      assert.deepStrictEqual(mine.permissions.tools.drive, old);
      // The guard lets drive do exactly that.
      const pr = guard.guardPrFromUrl("https://creatio.ghe.com/eng/core/pull/7");
      assert.strictEqual(guard.checkToolUse("drive", "Bash", { command: "git merge origin/main" }, pr).allow, true);
      assert.strictEqual(guard.checkToolUse("drive", "Bash", { command: "gh api repos/eng/core/pulls/7/comments --hostname creatio.ghe.com" }, pr).allow, true);
      assert.strictEqual(guard.checkToolUse("drive", "Bash", { command: "gh api repos/eng/core/pulls/7/comments --hostname github.com" }, pr).allow, false);
    });

    await atest("agent gh: every session's gh points at its PR's own host and repository", async () => {
      const f = agentFixture({ script: succeed("ok") });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.children.length === 1);
        assert.strictEqual(f.children[0].env.GH_HOST, "github.com");
        assert.strictEqual(f.children[0].env.GH_REPO, "github.com/a/b");
      } finally {
        f.agent.stop();
      }
      assert.deepStrictEqual(agentCore.ghTarget("https://creatio.ghe.com/eng/core/pull/7", "eng/core"), { GH_HOST: "creatio.ghe.com", GH_REPO: "creatio.ghe.com/eng/core" });
      assert.deepStrictEqual(agentCore.ghTarget("not a url", "eng/core"), {});
      assert.deepStrictEqual(agentCore.ghTarget("https://h/x/y/pull/1", "x/y; rm -rf"), {}, "only a plain owner/name");
    });

    // --- steps 4–6 of the test plan: an item's life, one summary, one way to a card ---
    const reconcile = require(path.join(__dirname, "../dist/main/shared/agent-reconcile.js"));
    test("agent reconcile: a PR missing from two snapshots in a row (its host answering) closes its items; a fetch error isn't a merge", () => {
      const items = [
        vItem({ prId: "GONE", state: "needsYou" }),
        vItem({ prId: "GONE", state: "queued" }),
        vItem({ prId: "GONE", state: "working" }),
        vItem({ prId: "GONE", state: "needsYou", scenario: "afterMerge" }),
        vItem({ prId: "GONE", state: "needsYou", scenario: "merge" }),
        vItem({ prId: "HERE", state: "needsYou" }),
        vItem({ prId: "DOWN", state: "error", hostLabel: "GHE" }),
      ];
      const misses = new Map();
      const present = new Set(["HERE"]);
      assert.deepStrictEqual(reconcile.goneItems(items, present, new Set(["GHE"]), misses), [], "one snapshot is not enough");
      const gone = reconcile.goneItems(items, present, new Set(["GHE"]), misses);
      assert.deepStrictEqual(gone.map((i) => [i.prId, i.state, i.scenario]), [["GONE", "needsYou", "review"], ["GONE", "queued", "review"]], "not a running one, not the merge offer, not the Jira run after a merge");
      assert.strictEqual(misses.has("DOWN"), false, "its host failed: not counted");
      assert.deepStrictEqual(reconcile.goneItems(items, new Set(["HERE", "GONE"]), new Set(), misses), [], "back on the dashboard: the count starts over");
      assert.strictEqual(misses.has("GONE"), false);
    });

    test("agent reconcile: a newer run replaces what waits on the same PR in its lane; nothing for you goes to Done", () => {
      const fresh = vItem({ prId: "P", state: "queued", scenario: "review" });
      const items = [
        fresh,
        vItem({ prId: "P", state: "needsYou", scenario: "review" }),
        vItem({ prId: "P", state: "error", scenario: "brief" }),
        vItem({ prId: "P", state: "needsYou", scenario: "drive" }),
        vItem({ prId: "P", state: "done", scenario: "review" }),
        vItem({ prId: "Q", state: "needsYou", scenario: "review" }),
      ];
      assert.deepStrictEqual(reconcile.supersededBy(items, fresh).map((i) => [i.prId, i.scenario]), [["P", "review"], ["P", "brief"]], "your PR's drive is another lane");
      const card = (o) => ({ summary: "s", asks: [], findings: [], structured: true, ...o });
      const r = (o) => vItem({ prId: "P", state: "needsYou", runFolder: "/x", result: card({}), ...o });
      assert.strictEqual(reconcile.nothingForYou(r({})), true);
      assert.strictEqual(reconcile.nothingForYou(r({ scenario: "rereview" })), true);
      assert.strictEqual(reconcile.nothingForYou(r({ plan: { event: "COMMENT" } })), false, "something to publish");
      assert.strictEqual(reconcile.nothingForYou(r({ result: card({ asks: [{ question: "q", options: [] }] }) })), false, "it asks you");
      assert.strictEqual(reconcile.nothingForYou(r({ result: card({ findings: [{ severity: "major", text: "t", where: "" }] }) })), false, "a major finding");
      assert.strictEqual(reconcile.nothingForYou(r({ result: card({ findings: [{ severity: "minor", text: "t", where: "" }] }) })), true);
      assert.strictEqual(reconcile.nothingForYou(r({ scenario: "drive" })), false, "a drive with no commits: CI is still red");
      assert.strictEqual(reconcile.nothingForYou(r({ runFolder: undefined })), false, "a plain dry run's text is yours to post");
      assert.strictEqual(reconcile.nothingForYou(r({ result: undefined })), false);
    });

    await atest("agent reconcile: a new head supersedes the waiting result; a PR that left the dashboard closes its items", async () => {
      const f = agentFixture({ script: reviewWithPlan(), captureScript: captureJs });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "needsYou"));
        const old = only(f)[0];
        // The author pushes: a new head, a new review — the old result goes quietly.
        f.snapshot.pullRequests = [reviewPr({ headOid: "bbb222" })];
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).find((i) => i.runId === old.runId).state === "done");
        assert.strictEqual(only(f).find((i) => i.runId === old.runId).headline, view.AGENT_CLOSED.superseded);
        await until(() => only(f).some((i) => i.runId !== old.runId && i.state === "needsYou"));
        // The PR is merged elsewhere: two snapshots without it, and its result closes.
        f.snapshot.pullRequests = [];
        f.agent.onSnapshot(f.snapshot);
        assert.ok(only(f).some((i) => i.state === "needsYou"), "one snapshot without it is not enough");
        f.agent.onSnapshot(f.snapshot);
        await until(() => !only(f).some((i) => i.state === "needsYou"));
        assert.ok(only(f).some((i) => i.headline === view.AGENT_CLOSED.offDashboard));
        const board = view.stageColumns([], [], f.agent.getState(), { today: view.todayKey(new Date()) });
        assert.deepStrictEqual([board.review.you.length, board.review.done.length], [0, 0], "both close quietly: no decision, no Done today card");
      } finally {
        f.agent.stop();
      }
    });

    await atest("agent reconcile: a review with nothing to post is a note, not a decision", async () => {
      const text = "Checked.\n\n```prd-result\n" + JSON.stringify({ summary: "Nothing to post: your approve stands.", asks: [], findings: [{ severity: "note", text: "fine", where: "" }] }) + "\n```";
      const notices = [];
      const f = agentFixture({ script: succeed(text), captureScript: captureJs, notify: (n) => notices.push(n.kind) });
      try {
        f.agent.onSnapshot(f.snapshot);
        await until(() => only(f).some((i) => i.state === "done"));
        const item = only(f)[0];
        assert.strictEqual(item.headline, "Reviewed — nothing to post");
        assert.deepStrictEqual(notices, ["finished"], "not a decision for you");
        const board = view.stageColumns([], [], f.agent.getState(), { today: view.todayKey(new Date()) });
        assert.ok(board.review.done.some((c) => c.stage.item?.runId === item.runId), "its PR gone, the note is today's");
      } finally {
        f.agent.stop();
      }
    });

    test("agent summary: one set of numbers and words for the chip, the tray, the Board and the cards", () => {
      const base = { enabled: true, items: [], running: [], idle: {}, runsToday: 3, perDay: 30, parallel: 2, heldUntil: null, headerChip: true, trayState: true, paused: false, quietUntil: null, acceptedUnchanged: 0, suggestOn: false };
      const items = [vItem({ prId: "A", state: "queued" }), vItem({ prId: "B", state: "needsYou" }), vItem({ prId: "C", state: "error" }), vItem({ prId: "D", state: "working" })];
      const running = [{ runId: items[3].runId, progress: { steps: [] }, recent: [], paused: true }];
      const sum = view.agentSummary({ ...base, items, running });
      assert.deepStrictEqual(
        { running: sum.running, pausedRuns: sum.pausedRuns, queued: sum.queued, readyForYou: sum.readyForYou, block: sum.block },
        { running: 1, pausedRuns: 1, queued: 1, readyForYou: 1, block: null },
        "B asks nothing (no plan); C failed: that is ready for you",
      );
      assert.strictEqual(view.readyItems([...items, vItem({ prId: "C", state: "queued" })]).length, 0, "not while the agent is on the PR again");
      assert.deepStrictEqual([view.agentSummary({ ...base, paused: true }).block, view.agentSummary({ ...base, quietUntil: "08:00" }).blockText], ["paused", "Quiet hours until 08:00"]);
      assert.strictEqual(view.agentSummary({ ...base, runsToday: 30 }).blockText, "Daily limit reached (30)");
      assert.deepStrictEqual([view.stepLabel([]), view.stepLabel([{ status: "completed" }, { status: "pending" }]), view.stepLabel([{ status: "completed" }])], ["", "2/2", "1/1"]);
      assert.strictEqual(actionLabel(vItem({ prId: "P", state: "error", scenario: "afterMerge" })), null, "the Jira run after a merge can't run again: a note");
    });

    test("main.js wiring: a clicked agent notification names its item; the focus flash is a finite animation", () => {
      const src = nfsA.readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
      assert.match(src, /sendToRenderer\("agent-show-board", item\.runId\)/);
      const preload = nfsA.readFileSync(path.join(__dirname, "../dist/main/main/preload.js"), "utf8");
      assert.match(preload, /"agent-show-board", handler/);
      assert.match(preload, /listener\(typeof runId === "string" \? runId : undefined\)/);
      const css = nfsA.readFileSync(path.join(__dirname, "../src/renderer/src/styles.css"), "utf8");
      assert.match(css, /\.focus-flash \{\s*animation: focus-flash 0\.9s ease-out 3;/);
    });

    test("ipc: an idle PR can be queued in front of a run, and a queued run moved; nothing else rides along", () => {
      const RID = "00000000-0000-4000-8000-000000000001";
      const RID2 = "00000000-0000-4000-8000-000000000002";
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "enqueue", prId: "PR_kw1", before: RID }), { type: "enqueue", prId: "PR_kw1", before: RID });
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "enqueue", prId: "PR_kw1", before: null }), { type: "enqueue", prId: "PR_kw1" });
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "moveQueued", runId: RID, before: RID2, rank: -1 }), { type: "moveQueued", runId: RID, before: RID2 });
      assert.deepStrictEqual(ipcAgent.validateAgentAction({ type: "moveQueued", runId: RID }), { type: "moveQueued", runId: RID, before: null });
      assert.throws(() => ipcAgent.validateAgentAction({ type: "moveQueued", runId: RID, before: "../x" }));
      assert.throws(() => ipcAgent.validateAgentAction({ type: "enqueue", prId: "PR_kw1", before: 5 }));
    });

    await atest("agent queue: Run next and a drop in front of a run decide what starts next; Skip keeps a queued PR out", async () => {
      const f = agentFixture({ script: keepWorking, agent: { limits: { parallel: 1 } } });
      try {
        f.snapshot.pullRequests.push(reviewPr({ id: "PR_B", number: 8 }), reviewPr({ id: "PR_C", number: 9 }));
        f.agent.onSnapshot(f.snapshot);
        await until(() => f.agent.getState().running.length === 1);
        const byPr = (id) => only(f).find((i) => i.prId === id && (i.state === "queued" || i.state === "working"));
        assert.strictEqual(byPr("PR_R").state, "working");
        assert.deepStrictEqual(view.queueOrder(only(f).filter((i) => i.state === "queued")).map((i) => i.prId), ["PR_B", "PR_C"]);
        // Run next: C goes in front of B.
        assert.deepStrictEqual(await f.agent.act({ type: "moveQueued", runId: byPr("PR_C").runId, before: byPr("PR_B").runId }), { ok: true });
        assert.deepStrictEqual(view.queueOrder(only(f).filter((i) => i.state === "queued")).map((i) => i.prId), ["PR_C", "PR_B"]);
        assert.strictEqual(JSON.parse(nfsA.readFileSync(path.join(f.dir, "agent", "state.json"), "utf8")).items.find((i) => i.prId === "PR_C").rank !== undefined, true, "your order survives a restart");
        // Skip B: it stays out, and Idle says why.
        assert.deepStrictEqual(await f.agent.act({ type: "skip", runId: byPr("PR_B").runId }), { ok: true });
        f.agent.onSnapshot(f.snapshot);
        assert.strictEqual(byPr("PR_B"), undefined, "a PR you took out of the queue isn't queued again for this head");
        assert.match(f.agent.getState().idle.PR_B, /took it out of the queue/);
        // An idle PR dropped in front of C runs before it.
        f.snapshot.pullRequests.push(reviewPr({ id: "PR_D", number: 10, requestedOfMe: false }));
        assert.deepStrictEqual(await f.agent.act({ type: "enqueue", prId: "PR_D", before: byPr("PR_C").runId }), { ok: true });
        assert.deepStrictEqual(view.queueOrder(only(f).filter((i) => i.state === "queued")).map((i) => i.prId), ["PR_D", "PR_C"]);
        // The run ends: the first in your order starts.
        await f.agent.act({ type: "stop", runId: byPr("PR_R").runId });
        await until(() => byPr("PR_D")?.state === "working");
        assert.strictEqual(byPr("PR_C").state, "queued");
        assert.strictEqual((await f.agent.act({ type: "moveQueued", runId: byPr("PR_D").runId, before: null })).ok, false, "a started run has left the queue");
      } finally {
        f.agent.stop();
      }
    });

    test("main.js wiring: the tray shows the agent hidden or not; Show agent opens its popover; toasts the agent took are left out", () => {
      const src = nfsA.readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
      assert.match(src, /showAgent: \(\) => showAgent\(\)/);
      assert.match(src, /toggleAgentPause: \(\) =>[\s\S]{0,200}"resumeAgent" : "pauseAgent"/);
      assert.match(src, /agentPushTimer = null;\s*(?:\/\/[^\n]*\n\s*)?updateTrayAgent\(\);\s*if \(agent && mainWindow/, "before the visibility gate");
      assert.match(src, /trayController\.setAgent\(s && s\.enabled && s\.trayState \? \{ line: \(0, agent_view_1\.agentTrayLine\)\(s\), paused: s\.paused \} : null\)/);
      assert.match(src, /sendToRenderer\("agent-open-companion", null\)/);
      assert.match(src, /void poller\?\.refresh\(\);\s*(?:\/\/[^\n]*\n\s*)*agent\?\.refresh\(\);/, "saving settings wakes the agent, without waiting for the poll");
      assert.match(src, /all\.filter\(\(e\) => !\(0, agent_view_1\.agentTakesToast\)\(agentItems, e\)\)/);
      const preload = nfsA.readFileSync(path.join(__dirname, "../dist/main/main/preload.js"), "utf8");
      assert.match(preload, /"agent-open-companion"/);
    });
  }

  // --- Stale PRs: closing one with its Jira task -------------------------------
  {
    const sfs = require("node:fs");
    const stale = require(path.join(__dirname, "../dist/main/shared/stale.js"));
    const staleClose = require(path.join(__dirname, "../dist/main/main/stale-close.js"));
    const ipcv = require(path.join(__dirname, "../dist/main/main/ipc-validation.js"));
    const DAY = 864e5;
    const NOW = Date.parse("2026-11-05T12:00:00Z");
    const ago = (d) => new Date(NOW - d * DAY).toISOString();

    test("stale: validateStaleAfterDays defaults, clamps and allows 0 (off)", () => {
      assert.strictEqual(stale.validateStaleAfterDays(undefined), 30);
      assert.strictEqual(stale.validateStaleAfterDays("garbage"), 30);
      assert.strictEqual(stale.validateStaleAfterDays(0), 0);
      assert.strictEqual(stale.validateStaleAfterDays(-5), 0);
      assert.strictEqual(stale.validateStaleAfterDays(9999), 365);
      assert.strictEqual(stale.validateStaleAfterDays("45"), 45);
      assert.strictEqual(stale.validateStaleAfterDays(14.6), 15);
    });

    test("stale: settings keep staleAfterDays, and an old file without it gets the default", () => {
      assert.strictEqual(cfg.validateSettings({}).staleAfterDays, 30);
      assert.strictEqual(cfg.validateSettings({ staleAfterDays: 60 }).staleAfterDays, 60);
      assert.strictEqual(cfg.defaultSettings().staleAfterDays, 30);
    });

    test("stale: isStalePr counts whole days from createdAt; 0 is off", () => {
      assert.strictEqual(stale.isStalePr({ createdAt: ago(30) }, 30, NOW), true);
      assert.strictEqual(stale.isStalePr({ createdAt: ago(29.9) }, 30, NOW), false);
      assert.strictEqual(stale.isStalePr({ createdAt: ago(400) }, 0, NOW), false);
      assert.strictEqual(stale.isStalePr({ createdAt: "nonsense" }, 30, NOW), false);
    });

    test("stale: the close action is offered on your own stale PRs only", () => {
      assert.strictEqual(stale.canCloseStale({ isStale: true, roles: ["author"] }), true);
      assert.strictEqual(stale.canCloseStale({ isStale: true, roles: ["reviewer"] }), false);
      assert.strictEqual(stale.canCloseStale({ isStale: false, roles: ["author"] }), false);
    });

    const tr = (id, name, toStatus, toCategory, resolutions = [], resolutionRequired = false) => ({
      id, name, toStatus, toCategory, resolutions, resolutionRequired,
    });

    test("stale: suggestTransition picks To Do by category, preferring a To Do name", () => {
      const list = [
        tr("1", "Backlog it", "Backlog", "new"),
        tr("2", "Start", "In Progress", "indeterminate"),
        tr("3", "Reset", "To Do", "new"),
      ];
      assert.strictEqual(stale.suggestTransition(list, "todo").id, "3");
      assert.strictEqual(stale.suggestTransition([tr("9", "Reset", "Selected", "new")], "todo").id, "9");
      assert.strictEqual(stale.suggestTransition([tr("2", "Start", "In Progress", "indeterminate")], "todo"), null);
    });

    test("stale: suggestTransition finds Won't Do by name, status, then a Done with that resolution", () => {
      assert.strictEqual(
        stale.suggestTransition([tr("1", "Done", "Done", "done"), tr("2", "Won't Do", "Won't Do", "done")], "wontDo").id,
        "2",
      );
      assert.strictEqual(stale.suggestTransition([tr("4", "Finish", "Declined", "done")], "wontDo").id, "4");
      assert.strictEqual(stale.suggestTransition([tr("5", "Abort", "Cancelled", "done")], "wontDo").id, "5");
      const viaResolution = tr("6", "Close", "Closed", "done", [{ id: "10", name: "Done" }, { id: "11", name: "Won't Do" }], true);
      assert.strictEqual(stale.suggestTransition([tr("1", "Done", "Done", "done"), viaResolution], "wontDo").id, "6");
      assert.strictEqual(stale.suggestResolution(viaResolution.resolutions).id, "11");
      assert.strictEqual(stale.suggestTransition([tr("1", "Done", "Done", "done")], "wontDo"), null);
      assert.strictEqual(stale.suggestTransition([tr("1", "Done", "Done", "done")], "keep"), null);
    });

    test("stale: validateCloseStaleOptions accepts the four actions and rejects bad ids", () => {
      assert.deepStrictEqual(ipcv.validateCloseStaleOptions({ comment: "bye" }), { comment: "bye", jira: { action: "keep" } });
      assert.deepStrictEqual(
        ipcv.validateCloseStaleOptions({ comment: "", jira: { action: "wontDo", transitionId: "41", resolutionId: "10001" } }),
        { comment: "", jira: { action: "wontDo", transitionId: "41", resolutionId: "10001" } },
      );
      assert.deepStrictEqual(
        ipcv.validateCloseStaleOptions({ jira: { action: "todo", transitionId: "11" } }).jira,
        { action: "todo", transitionId: "11", resolutionId: null },
      );
      assert.deepStrictEqual(
        ipcv.validateCloseStaleOptions({ jira: { action: "delete", deleteSubtasks: "yes" } }).jira,
        { action: "delete", deleteSubtasks: false },
      );
      assert.throws(() => ipcv.validateCloseStaleOptions({ jira: { action: "todo", transitionId: "../x" } }), /invalid transition/);
      assert.throws(() => ipcv.validateCloseStaleOptions({ jira: { action: "nuke" } }), /unknown Jira action/);
      assert.throws(() => ipcv.validateCloseStaleOptions(null), /expected options/);
    });

    const HOST = { label: "GitHub", graphqlUrl: "https://api.github.com/graphql", repos: [] };
    const stalePr = (o = {}) => ({ id: "PR_1", hostLabel: "GitHub", issueKey: "ENG-1", isStale: true, roles: ["author"], ...o });
    function deps(o = {}) {
      const calls = [];
      return {
        calls,
        d: {
          loadSettings: () => ({ hosts: [HOST], jira: { baseUrl: "https://x.atlassian.net", email: "me@x" } }),
          resolveGhToken: () => "ghtok",
          getJiraToken: () => "jtok",
          closePullRequest: async (host, id, comment) => calls.push(["close", host.token, id, comment]),
          fetchTaskInfo: async () => ({ key: "ENG-1" }),
          transitionTask: async (_c, _t, key, tid, rid) => calls.push(["transition", key, tid, rid]),
          deleteTask: async (_c, _t, key, sub) => calls.push(["delete", key, sub]),
          ...o,
        },
      };
    }

    await atest("staleClose: closes the PR, then transitions the task", async () => {
      const { calls, d } = deps();
      const r = await staleClose.closeStale(
        stalePr(),
        { comment: "bye", jira: { action: "wontDo", transitionId: "41", resolutionId: "10001" } },
        d,
      );
      assert.deepStrictEqual(calls, [["close", "ghtok", "PR_1", "bye"], ["transition", "ENG-1", "41", "10001"]]);
      assert.strictEqual(r.ok, true);
      assert.match(r.jira.message, /Won't Do/);
    });

    await atest("staleClose: delete passes deleteSubtasks; keep touches no task", async () => {
      let { calls, d } = deps();
      await staleClose.closeStale(stalePr(), { comment: "", jira: { action: "delete", deleteSubtasks: true } }, d);
      assert.deepStrictEqual(calls[1], ["delete", "ENG-1", true]);
      ({ calls, d } = deps({ getJiraToken: () => null }));
      const r = await staleClose.closeStale(stalePr({ issueKey: null }), { comment: "", jira: { action: "keep" } }, d);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.jira, null);
      assert.strictEqual(calls.length, 1);
    });

    await atest("staleClose: refuses someone else's or a fresh PR, before any call", async () => {
      for (const pr of [stalePr({ roles: ["reviewer"] }), stalePr({ isStale: false }), undefined]) {
        const { calls, d } = deps();
        const r = await staleClose.closeStale(pr, { comment: "", jira: { action: "keep" } }, d);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.prClosed, false);
        assert.strictEqual(calls.length, 0);
      }
    });

    await atest("staleClose: a missing Jira token stops before the PR is closed", async () => {
      const { calls, d } = deps({ getJiraToken: () => null });
      const r = await staleClose.closeStale(stalePr(), { comment: "", jira: { action: "todo", transitionId: "11", resolutionId: null } }, d);
      assert.strictEqual(r.prClosed, false);
      assert.match(r.error, /Jira API token/);
      assert.strictEqual(calls.length, 0);
    });

    await atest("staleClose: a failed close leaves the task alone; a failed task reports the closed PR", async () => {
      let { calls, d } = deps({ closePullRequest: async () => { throw new Error("Resource not accessible"); } });
      let r = await staleClose.closeStale(stalePr(), { comment: "", jira: { action: "delete", deleteSubtasks: false } }, d);
      assert.strictEqual(r.prClosed, false);
      assert.match(r.error, /Couldn't close the PR: Resource not accessible/);
      assert.strictEqual(calls.length, 0);
      ({ calls, d } = deps({ deleteTask: async () => { throw new Error("HTTP 403"); } }));
      r = await staleClose.closeStale(stalePr(), { comment: "", jira: { action: "delete", deleteSubtasks: false } }, d);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.prClosed, true);
      assert.match(r.error, /PR was closed, but ENG-1 was not changed: HTTP 403/);
    });

    await atest("closePullRequest: posts the comment first, then closes; no comment, no addComment", async () => {
      const real = global.fetch;
      const bodies = [];
      global.fetch = async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ data: {} }), text: async () => "" };
      };
      try {
        await github.closePullRequest({ label: "GH", graphqlUrl: "https://api.github.com/graphql", token: "t" }, "PR_1", " bye ");
        assert.match(bodies[0].query, /addComment/);
        assert.strictEqual(bodies[0].variables.body, "bye");
        assert.match(bodies[1].query, /closePullRequest/);
        bodies.length = 0;
        await github.closePullRequest({ label: "GH", graphqlUrl: "https://api.github.com/graphql", token: "t" }, "PR_1", "  ");
        assert.strictEqual(bodies.length, 1);
        assert.match(bodies[0].query, /closePullRequest/);
      } finally {
        global.fetch = real;
      }
    });

    await atest("jira task actions: transitions read with fields, writes fall back past a 401, refusals name the scope", async () => {
      const real = global.fetch;
      const CFG = { baseUrl: "https://acme.atlassian.net", email: "me@acme" };
      const CID = "158d8f10-2fb5-4b9b-9d0f-6a1c3f4b5e6d";
      const GW = `https://api.atlassian.com/ex/jira/${CID}/rest/api/3`;
      const SITE = `${CFG.baseUrl}/rest/api/3`;
      const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
      const err = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "nope" });
      const seen = [];
      try {
        jira.clearJiraCaches();
        global.fetch = async (url, init) => {
          seen.push(`${init.method ?? "GET"} ${url}`);
          if (url.endsWith("/_edge/tenant_info")) return ok({ cloudId: CID });
          if (url.startsWith(GW)) return err(401); // a classic token
          if (url === `${SITE}/issue/ENG-1?fields=summary,status,subtasks`)
            return ok({ fields: { summary: "S", status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, subtasks: [{}, {}] } });
          if (url === `${SITE}/issue/ENG-1/transitions?expand=transitions.fields`)
            return ok({ transitions: [{ id: "41", name: "Close", to: { name: "Closed", statusCategory: { key: "done" } },
              fields: { resolution: { required: true, allowedValues: [{ id: "10001", name: "Won't Do" }] } } }] });
          if (url === `${SITE}/issue/ENG-1/transitions` && init.method === "POST") return { ok: true, status: 204, text: async () => "" };
          if (url.startsWith(`${SITE}/issue/ENG-1?deleteSubtasks=`)) return err(403);
          throw new Error("unexpected " + url);
        };
        const info = await jira.fetchTaskInfo(CFG, "t", "ENG-1");
        assert.strictEqual(info.subtaskCount, 2);
        assert.deepStrictEqual(info.transitions[0], {
          id: "41", name: "Close", toStatus: "Closed", toCategory: "done",
          resolutions: [{ id: "10001", name: "Won't Do" }], resolutionRequired: true,
        });
        await jira.transitionTask(CFG, "t", "ENG-1", "41", "10001");
        assert.ok(seen.includes(`POST ${GW}/issue/ENG-1/transitions`), "gateway tried first");
        assert.ok(seen.includes(`POST ${SITE}/issue/ENG-1/transitions`), "then the site");
        await assert.rejects(jira.deleteTask(CFG, "t", "ENG-1", true), /read-only[\s\S]*write:jira-work/);
        assert.ok(seen.some((u) => u.includes("deleteSubtasks=true")));
        await assert.rejects(jira.transitionTask(CFG, "t", "ENG-1/../x", "1", null), /not an issue key/);
      } finally {
        global.fetch = real;
        jira.clearJiraCaches();
      }
    });

    test("stale: the poller hashes isStale, so crossing the threshold re-emits", () => {
      const base = { pullRequests: [], errors: [], rateLimits: [], fetchedAt: "", version: "x" };
      const p = { id: "a", updatedAt: "", roles: [], failingChecks: [], pendingChecks: [], checks: [], reviewers: [] };
      const h1 = poller.hashSnapshot({ ...base, pullRequests: [{ ...p, isStale: false }] });
      const h2 = poller.hashSnapshot({ ...base, pullRequests: [{ ...p, isStale: true }] });
      assert.notStrictEqual(h1, h2);
    });

    test("stale: the Stale chip is a source chip over isStale", () => {
      const chip = prFilter.SOURCE_CHIPS.find((c) => c.key === "stale");
      assert.strictEqual(chip.flag, "staleOnly");
      assert.strictEqual(chip.matches({ isStale: true }), true);
      assert.strictEqual(chip.matches({ isStale: false }), false);
    });

    test("main.js wiring: stale close takes only the PR id and validated options", () => {
      const src = sfs.readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
      assert.match(src, /"stale:close"[\s\S]{0,200}validatePrId\)\(raw\)[\s\S]{0,120}validateCloseStaleOptions\)\(rawOptions\)/);
      assert.match(src, /"stale:jiraTask"[\s\S]{0,300}validatePrId\)\(raw\)/);
      assert.match(src, /closeStale\)\(snapshotPr\(id\)/);
    });
  }

  {
    const w = require(path.join(__dirname, "../dist/main/shared/weather.js"));
    const svc = require(path.join(__dirname, "../dist/main/main/weather.js"));

    test("weather: WMO codes map to the header's skies", () => {
      assert.strictEqual(w.weatherKind(0, true), "clear-day");
      assert.strictEqual(w.weatherKind(1, false), "clear-night");
      assert.strictEqual(w.weatherKind(3, true), "clouds");
      assert.strictEqual(w.weatherKind(45, true), "fog");
      assert.strictEqual(w.weatherKind(61, true), "rain");
      assert.strictEqual(w.weatherKind(81, true), "rain");
      assert.strictEqual(w.weatherKind(73, true), "snow");
      assert.strictEqual(w.weatherKind(86, false), "snow");
      assert.strictEqual(w.weatherKind(95, true), "thunder");
      assert.strictEqual(w.weatherKind(42, true), "clouds", "an unknown code is cloudy, not clear");
    });

    test("weather: the country after a comma picks among same-named places", () => {
      const json = {
        results: [
          { name: "Paris", country: "United States", admin1: "Texas", latitude: 33.6, longitude: -95.5 },
          { name: "Paris", country: "France", admin1: "Ile-de-France", latitude: 48.85, longitude: 2.35 },
        ],
      };
      const { name, hint } = w.splitCity(" Paris , France ");
      assert.strictEqual(name, "Paris");
      assert.deepStrictEqual(w.parseGeocode(json, hint), { place: "Paris, France", latitude: 48.85, longitude: 2.35 });
      assert.strictEqual(w.parseGeocode(json, "").place, "Paris, United States", "no hint → the first result");
      assert.strictEqual(w.parseGeocode(json, "japan"), null);
      assert.strictEqual(w.parseGeocode({}, ""), null, "no results");
      assert.match(w.geocodeUrl("Paris"), /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?name=Paris&/);
    });

    test("weather: the current block of a forecast", () => {
      assert.deepStrictEqual(
        w.parseCurrent({ current: { temperature_2m: 3.6, weather_code: 61, is_day: 1 } }),
        { kind: "rain", temperatureC: 3.6 },
      );
      assert.strictEqual(w.parseCurrent({ current: { weather_code: 0, is_day: 0, temperature_2m: -2 } }).kind, "clear-night");
      assert.strictEqual(w.parseCurrent({ current: { weather_code: 0 } }), null, "a missing temperature");
      assert.strictEqual(w.describeWeather("Kyiv, Ukraine", "rain", 3.6), "Kyiv, Ukraine · 4°C, Rain");
    });

    const geo = { results: [{ name: "Kyiv", country: "Ukraine", latitude: 50.45, longitude: 30.52 }] };
    const forecast = (code) => ({ current: { temperature_2m: 4, weather_code: code, is_day: 1 } });

    await atest("weather service: no city sends nothing", async () => {
      const calls = [];
      const s = svc.createWeatherService({ fetchJson: async (u) => (calls.push(u), geo) });
      assert.deepStrictEqual(await s.get("  "), { state: "off" });
      assert.deepStrictEqual(calls, []);
    });

    await atest("weather service: caches the answer and the coordinates", async () => {
      let t = 1000;
      const calls = [];
      let code = 61;
      const s = svc.createWeatherService({
        now: () => t,
        fetchJson: async (u) => (calls.push(u), u.includes("geocoding") ? geo : forecast(code)),
      });
      const first = await s.get("Kyiv");
      assert.strictEqual(first.state, "ok");
      assert.strictEqual(first.kind, "rain");
      assert.strictEqual(first.place, "Kyiv, Ukraine");
      assert.strictEqual(calls.length, 2, "geocode + forecast");
      t += svc.WEATHER_TTL_MS - 1;
      await s.get("Kyiv");
      assert.strictEqual(calls.length, 2, "inside the TTL: no request");
      t += 2;
      code = 0;
      assert.strictEqual((await s.get("Kyiv")).kind, "clear-day");
      assert.strictEqual(calls.length, 3, "after the TTL: the forecast only, the coordinates are kept");
    });

    await atest("weather service: a failure keeps the last good sky and retries sooner", async () => {
      let t = 0;
      let fail = false;
      let calls = 0;
      const s = svc.createWeatherService({
        now: () => t,
        fetchJson: async (u) => {
          calls++;
          if (fail) throw new Error("offline");
          return u.includes("geocoding") ? geo : forecast(71);
        },
      });
      assert.strictEqual((await s.get("Kyiv")).kind, "snow");
      fail = true;
      t += svc.WEATHER_TTL_MS;
      assert.strictEqual((await s.get("Kyiv")).kind, "snow", "the header does not drop back on a failed refresh");
      const before = calls;
      t += svc.WEATHER_ERROR_TTL_MS;
      fail = false;
      await s.get("Kyiv");
      assert.ok(calls > before, "retried after the short TTL");
    });

    await atest("weather service: an unknown city is an error, not a sky", async () => {
      const s = svc.createWeatherService({ fetchJson: async () => ({ results: [] }) });
      const r = await s.get("Atlantis");
      assert.strictEqual(r.state, "error");
      assert.match(r.message, /Atlantis/);
    });

    await atest("weather service: callers asking together share one request", async () => {
      let calls = 0;
      const s = svc.createWeatherService({
        fetchJson: async (u) => (calls++, u.includes("geocoding") ? geo : forecast(3)),
      });
      await Promise.all([s.get("Kyiv"), s.get("Kyiv"), s.get("Kyiv")]);
      assert.strictEqual(calls, 2);
    });

    test("settings: the weather city is trimmed, bounded and defaults to empty", () => {
      const cfg = require(path.join(__dirname, "../dist/main/shared/config.js"));
      assert.strictEqual(cfg.validateSettings({}).weatherCity, "");
      assert.strictEqual(cfg.validateSettings({ weatherCity: "  Kyiv " }).weatherCity, "Kyiv");
      assert.strictEqual(cfg.validateSettings({ weatherCity: "x".repeat(300) }).weatherCity.length, 100);
      assert.strictEqual(cfg.validateSettings({ weatherCity: 5 }).weatherCity, "");
    });

    test("main.js wiring: the weather city comes from saved settings, not the renderer", () => {
      const src = require("node:fs").readFileSync(path.join(__dirname, "../dist/main/main/main.js"), "utf8");
      assert.match(src, /"weather:get", async \(\) =>[\s\S]{0,200}loadSettings\)?\(\)\.weatherCity/);
    });
  }

  {
    const wn = require(path.join(__dirname, "../dist/main/shared/whats-new.js"));
    const MIN = 60_000;

    test("what's new: a fresh install shows no news and records the version", () => {
      const r = wn.whatsNewFor(null, "2.11.0", 1000);
      assert.strictEqual(r.highlightUntil, null);
      assert.deepStrictEqual(r.record, { acknowledgedVersion: "2.11.0" });
    });

    test("what's new: after an update it is lit for 30 min from the first look", () => {
      const first = wn.whatsNewFor({ acknowledgedVersion: "2.10.0" }, "2.11.0", 1000);
      assert.strictEqual(first.highlightUntil, 1000 + 30 * MIN);
      assert.deepStrictEqual(first.record, { acknowledgedVersion: "2.10.0", seenVersion: "2.11.0", seenAt: 1000 });
      // A later look (a restart) keeps the first look's clock.
      const later = wn.whatsNewFor(first.record, "2.11.0", 1000 + 29 * MIN);
      assert.strictEqual(later.highlightUntil, 1000 + 30 * MIN);
    });

    test("what's new: past 30 min it gives way to the plain version and is acknowledged", () => {
      const rec = { acknowledgedVersion: "2.10.0", seenVersion: "2.11.0", seenAt: 1000 };
      const r = wn.whatsNewFor(rec, "2.11.0", 1000 + 30 * MIN);
      assert.strictEqual(r.highlightUntil, null);
      assert.deepStrictEqual(r.record, { acknowledgedVersion: "2.11.0" });
    });

    test("what's new: a clock left from an older update starts over for the new one", () => {
      const rec = { acknowledgedVersion: "2.9.0", seenVersion: "2.10.0", seenAt: 1000 };
      const r = wn.whatsNewFor(rec, "2.11.0", 1000 + 90 * MIN);
      assert.strictEqual(r.highlightUntil, 1000 + 120 * MIN);
    });

    test("what's new: a malformed record counts as none; the old one-field file still reads", () => {
      assert.strictEqual(wn.parseWhatsNewRecord(null), null);
      assert.strictEqual(wn.parseWhatsNewRecord({ acknowledgedVersion: 5 }), null);
      assert.deepStrictEqual(wn.parseWhatsNewRecord({ acknowledgedVersion: "2.10.0" }), { acknowledgedVersion: "2.10.0" });
      assert.deepStrictEqual(
        wn.parseWhatsNewRecord({ acknowledgedVersion: "2.10.0", seenVersion: "2.11.0", seenAt: "x" }),
        { acknowledgedVersion: "2.10.0" },
      );
    });
  }

  {
    const cg = require(path.join(__dirname, "../dist/main/shared/check-groups.js"));
    const chk = (name, state) => ({ name, kind: "check", state, url: null });

    test("check badges: several checks in one state collapse into one badge", () => {
      const out = cg.collapseChecks([chk("a", "pending"), chk("b", "pending"), chk("c", "pending")]);
      assert.deepStrictEqual(out, [{ kind: "group", state: "pending", label: "3 checks running", names: ["a", "b", "c"] }]);
    });

    test("check badges: a lone check keeps its own badge, beside another state's group", () => {
      const lone = chk("lint", "failure");
      const out = cg.collapseChecks([lone, chk("u1", "pending"), chk("u2", "pending")]);
      assert.deepStrictEqual(out[0], { kind: "one", check: lone });
      assert.strictEqual(out[1].label, "2 checks running");
      assert.strictEqual(cg.collapseChecks([chk("x", "failure"), chk("y", "failure")])[0].label, "2 checks failing");
      assert.deepStrictEqual(cg.collapseChecks([]), []);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
