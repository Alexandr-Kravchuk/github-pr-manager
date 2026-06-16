// Dev launcher: starts the Vite dev server (renderer with HMR), waits for it to
// come up, compiles the main process once, then launches Electron pointed at the
// dev-server URL via ELECTRON_RENDERER_URL (main.ts loads that when set).
//
// Kept dependency-free on purpose — a tiny custom launcher beats pulling in
// concurrently + wait-on + cross-env just for `npm run dev`.
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";

const DEV_PORT = 5173;
const DEV_URL = `http://localhost:${DEV_PORT}`;
const children = [];

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
      const socket = net.connect(port, "127.0.0.1");
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

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const vite = run("npx", ["vite", "--config", "vite.renderer.config.ts", "--port", String(DEV_PORT), "--strictPort"]);
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
  const electron = run("npx", ["electron", "."], { ELECTRON_RENDERER_URL: DEV_URL });
  electron.on("exit", (electronCode) => shutdown(electronCode ?? 0));
});
