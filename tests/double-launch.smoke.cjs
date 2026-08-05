// Real-process double-launch smoke test for the single-instance lock.
//
// WHY THIS IS SEPARATE FROM `npm test`: it spawns the actual Electron runtime
// twice, which needs a display (the primary instance creates a real window) and
// the built app in `dist/`. That can't run in a headless CI box or a plain-Node
// unit runner, so it lives on its own and is invoked explicitly:
//
//     npm run build            # produce dist/main/main/main.js
//     npm run test:double-launch
//
// WHAT IT ASSERTS: launch A (the primary) and let it hold the lock; a moment
// later launch B. If the single-instance guard works, B fails to acquire the
// lock and quits almost immediately. If it were broken, B would boot its own
// window and live out its full smoke lifetime. We give both instances the same
// PRD_SMOKE_EXIT_MS budget, so "B exited far sooner than its budget" is the
// signal that the lock — not the smoke timer — shut it down.
//
// STATUS: executed on a Windows 11 workstation — the primary held the lock and
// the second instance was rejected in ~300ms (well inside its 15s budget). Kept
// out of `npm test` because it needs a display + a built dist/, so CI won't run
// it; re-run manually on a real machine as closing evidence for a release.

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
// Derive the entry from package.json `main` rather than hardcoding the compiled
// path, so a change to the tsc/electron-builder output layout can't silently
// desync this guard from what `electron .` actually loads.
const MAIN_ENTRY = path.join(REPO_ROOT, require(path.join(REPO_ROOT, "package.json")).main);

// `require("electron")` resolves to the path of the Electron executable.
const electronPath = require("electron");

// Timing budgets. These were calibrated on a Windows workstation (B is rejected
// in ~300ms); they are deliberately generous. Override via env vars if a slower
// or loaded machine shows flakiness — e.g. PRD_SMOKE_A_HEADSTART_MS=5000.
//
// A holds the lock this long; B is given the same budget so a fast B exit can
// only mean the lock rejected it, not that its own timer fired.
const SMOKE_MS = Number(process.env.PRD_SMOKE_MS) || 15000;
// B must quit within this window to count as "rejected by the lock".
const B_MUST_EXIT_WITHIN_MS = Number(process.env.PRD_SMOKE_B_EXIT_MS) || 4000;
// Let A fully boot and acquire the lock before B races it.
const A_HEADSTART_MS = Number(process.env.PRD_SMOKE_A_HEADSTART_MS) || 2500;

function fail(msg) {
  console.error(`FAIL - ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(MAIN_ENTRY)) {
  fail(`built app not found at ${MAIN_ENTRY} — run \`npm run build\` first`);
}

function launch(label, extraEnv) {
  const child = spawn(electronPath, ["."], {
    cwd: REPO_ROOT,
    env: { ...process.env, PRD_SMOKE_EXIT_MS: String(SMOKE_MS), ...extraEnv },
    stdio: "inherit",
  });
  const startedAt = Date.now();
  const exited = new Promise((resolve) => {
    child.once("exit", (code) => resolve({ code, ms: Date.now() - startedAt }));
  });
  console.log(`  launched ${label} (pid ${child.pid})`);
  return { child, exited };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  console.log("double-launch smoke: starting primary instance A…");
  const a = launch("A", {});

  await delay(A_HEADSTART_MS);
  // If A already died during its head-start, the test can't be trusted.
  const aDiedEarly = await Promise.race([a.exited, delay(0).then(() => null)]);
  if (aDiedEarly) fail(`primary A exited during head-start (code ${aDiedEarly.code}) — cannot test the lock`);

  console.log("double-launch smoke: launching second instance B…");
  const b = launch("B", {});

  const bResult = await Promise.race([
    b.exited,
    delay(B_MUST_EXIT_WITHIN_MS).then(() => null),
  ]);

  // Clean up A regardless of outcome.
  const killA = () => {
    if (a.child.exitCode === null) a.child.kill();
  };

  if (!bResult) {
    killA();
    if (b.child.exitCode === null) b.child.kill();
    fail(
      `second instance B was still running after ${B_MUST_EXIT_WITHIN_MS}ms — ` +
        `the single-instance lock did NOT reject it (double-launch regression)`,
    );
  }

  killA();
  await a.exited.catch(() => {});

  if (bResult.ms >= SMOKE_MS - 1000) {
    fail(`B exited at ${bResult.ms}ms — too close to its own smoke budget to attribute to the lock`);
  }

  console.log(
    `ok - single-instance lock rejected the second launch (B exited in ${bResult.ms}ms, code ${bResult.code})`,
  );
  console.log("1 passed, 0 failed");
  process.exit(0);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
