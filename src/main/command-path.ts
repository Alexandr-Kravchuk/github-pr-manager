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

/**
 * Whether `name` is on the PATH the dashboard runs with. On macOS `startApp`
 * has already merged the login shell's PATH into `process.env.PATH`
 * (`ensureCliPath`, before IPC is registered), so one scan covers a Dock launch
 * too; a CLI whose directory only an interactive shell's rc file adds is not
 * found, and the Codex rows then stay hidden.
 */
export function hasCommand(name: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  return findOnPath(name, {
    pathVar: process.env.PATH ?? "",
    windows: process.platform === "win32",
    pathExt: process.env.PATHEXT,
  });
}
