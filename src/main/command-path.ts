import { execFileSync } from "node:child_process";
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

let loginShellHit: Record<string, true> = {};

/**
 * Whether the terminal the dashboard opens would find `name`. A macOS app
 * started from the Dock gets a minimal PATH (no Homebrew, no npm global bin),
 * so a miss there asks the user's login shell — the one the terminal window
 * will run — before giving up. Only a hit is remembered: a CLI installed later
 * must show up without restarting the app.
 */
export function hasCommand(name: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  const windows = process.platform === "win32";
  if (findOnPath(name, { pathVar: process.env.PATH ?? "", windows, pathExt: process.env.PATHEXT })) return true;
  if (process.platform !== "darwin") return false;
  if (loginShellHit[name]) return true;
  try {
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", `command -v ${name}`], {
      timeout: 4_000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    if (out.trim()) {
      loginShellHit = { ...loginShellHit, [name]: true };
      return true;
    }
  } catch {
    // no such command, or the shell's profile failed: treat as missing
  }
  return false;
}
