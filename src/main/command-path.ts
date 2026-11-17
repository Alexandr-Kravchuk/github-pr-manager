import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Whether `name` is an executable on `pathVar` — scanned, never spawned, so a
 * check costs a few `stat`s. On Windows a bare name also matches each
 * `PATHEXT` extension (`codex` → `codex.cmd`, the shim npm installs).
 */
export function findOnPath(
  name: string,
  opts: {
    pathVar: string;
    windows: boolean;
    pathExt?: string;
    exists?: (file: string) => boolean;
  },
): boolean {
  const exists =
    opts.exists ??
    ((file: string) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
  const sep = opts.windows ? ";" : ":";
  const exts = opts.windows
    ? ["", ...(opts.pathExt || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const dir of opts.pathVar.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (exists(path.join(dir.replace(/^"|"$/g, ""), name + ext))) return true;
    }
  }
  return false;
}

/** What the login shell said about a name, and when: a miss is remembered too, for a while. */
const loginShellAnswer = new Map<string, { found: boolean; at: number }>();
const probing = new Set<string>();
const LOGIN_SHELL_TTL_MS = 5 * 60_000;

/** Asks the login shell without blocking the main process; the answer lands in `loginShellAnswer`. */
function probeLoginShell(name: string): void {
  if (probing.has(name)) return;
  probing.add(name);
  execFile(
    process.env.SHELL || "/bin/zsh",
    ["-lc", `command -v ${name}`],
    { timeout: 4_000, encoding: "utf8" },
    (error, stdout) => {
      probing.delete(name);
      // no such command, or the shell's profile failed: treat as missing
      loginShellAnswer.set(name, { found: !error && stdout.trim().length > 0, at: Date.now() });
    },
  );
}

/**
 * Whether the terminal the dashboard opens would find `name`. A macOS app
 * started from the Dock gets a minimal PATH (no Homebrew, no npm global bin),
 * so a miss there asks the user's login shell — the one the terminal window
 * will run — before giving up. That ask is asynchronous: this runs in an IPC
 * handler on the main process, and a login shell can take seconds. It answers
 * from the last result (false before the first one, so call it once at start-up
 * to warm it) and asks again after `LOGIN_SHELL_TTL_MS`, hits and misses alike,
 * so a CLI installed later shows up without restarting the app.
 */
export function hasCommand(name: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  const windows = process.platform === "win32";
  if (findOnPath(name, { pathVar: process.env.PATH ?? "", windows, pathExt: process.env.PATHEXT })) return true;
  if (process.platform !== "darwin") return false;
  const known = loginShellAnswer.get(name);
  if (!known || Date.now() - known.at > LOGIN_SHELL_TTL_MS) probeLoginShell(name);
  return known?.found ?? false;
}
