// Dev launcher: starts the Vite dev server (renderer with HMR), waits for it to
// come up, compiles the main process once, then launches Electron pointed at the
// dev-server URL via ELECTRON_RENDERER_URL (main.ts loads that when set).
//
// Kept dependency-free on purpose — a tiny custom launcher beats pulling in
// concurrently + wait-on + cross-env just for `npm run dev`.
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import process from "node:process";

// Overridable via PRD_DEV_PORT so `npm run dev` can dodge a port already in use.
const DEV_PORT = Number(process.env.PRD_DEV_PORT) || 5173;
// Pin to IPv4 so the readiness probe and Electron hit the same address Vite
// binds — Vite defaults to "localhost" which can resolve to IPv6 ::1, while a
// 127.0.0.1 probe would then never connect.
const DEV_HOST = "127.0.0.1";
const DEV_URL = `http://${DEV_HOST}:${DEV_PORT}`;
const children = [];

// `--mock` (optionally `--mock=<case>`) enables PRD_MOCK fixture mode from here
// rather than an inline `VAR=value` npm-script prefix, which cmd.exe (Windows)
// can't parse. Set before spawning so the value flows to the Electron child via
// its inherited env. Default case "empty" — switch live by editing `.prd-mock`.
const mockArg = process.argv.find((a) => a === "--mock" || a.startsWith("--mock="));
if (mockArg) {
  const eq = mockArg.indexOf("=");
  process.env.PRD_MOCK = eq >= 0 ? mockArg.slice(eq + 1) : "empty";
}

function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  return child;
}

function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect(port, DEV_HOST);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Vite dev server did not start on port ${port} in time.`));
        } else {
          setTimeout(tryConnect, 250);
        }
      });
    };
    tryConnect();
  });
}

function killChild(child) {
  if (child.killed || child.pid == null) return;
  // On Windows the children are spawned via a shell (npx), so `child.kill()`
  // reaps only the shell wrapper and orphans the real node grandchild (Vite),
  // which keeps holding the dev port and breaks the next launch. Kill the whole
  // tree with taskkill instead; fall back to kill() if that isn't available.
  if (process.platform === "win32") {
    // spawnSync only throws when the process can't be spawned at all; a taskkill
    // that runs but exits non-zero (e.g. the tree is already gone, or access is
    // denied) reports via .error/.status, not an exception — so fall back to
    // child.kill() on any of those, not only a thrown error.
    let killed = false;
    try {
      const res = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killed = !res.error && res.status === 0;
    } catch {
      killed = false;
    }
    if (!killed) child.kill();
  } else {
    child.kill();
  }
}

function shutdown(code = 0) {
  for (const child of children) killChild(child);
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const vite = run("npx", [
  "vite",
  "--config",
  "vite.renderer.config.ts",
  "--host",
  DEV_HOST,
  "--port",
  String(DEV_PORT),
  "--strictPort",
]);
vite.on("exit", (code) => shutdown(code ?? 0));

try {
  await waitForPort(DEV_PORT);
} catch (error) {
  console.error(error.message);
  shutdown(1);
}

// Compile the main process before launching Electron (it runs the compiled
// dist/main output, not the .ts source).
const tscMain = run("npx", ["tsc", "-p", "tsconfig.main.json"]);
tscMain.on("exit", (code) => {
  if (code !== 0) {
    shutdown(code ?? 1);
    return;
  }
  console.log(`[dev] Vite ready at ${DEV_URL}, launching Electron…`);
  const electron = run("npx", ["electron", "."], { ELECTRON_RENDERER_URL: DEV_URL });
  electron.on("exit", (electronCode) => shutdown(electronCode ?? 0));
});
