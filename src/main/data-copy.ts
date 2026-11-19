// A packaged (MSIX) app's private copy of this app's data folder, on Windows.
//
// A process started from an MSIX app — Claude Desktop's terminal or sessions,
// for one — has its writes under %APPDATA% redirected into that package's
// `LocalCache\Roaming`, and its reads show that copy over the real folder.
// GetCurrentPackageFullName says "not packaged" in such a process, so nothing
// in it tells it apart. PR Dashboard started from there once kept every
// setting in Claude's copy (`…\Packages\Claude_<id>\LocalCache\Roaming\PR
// Dashboard`), while the app started from the Start menu, the desktop, the
// login entry and the updater's relaunch read the real, nearly empty folder:
// "the settings reset after every update". Kept free of `electron` imports so
// it is unit-tested against a folder tree.
import fs from "node:fs";
import path from "node:path";

import type { DataCopy } from "../shared/types";

export interface DataCopyInput {
  platform: NodeJS.Platform;
  /** `app.getPath("appData")`: %APPDATA% (Roaming). */
  appData: string;
  /** `app.getPath("userData")`. */
  userData: string;
  /** %LOCALAPPDATA%, which holds `Packages`. */
  localAppData: string | undefined;
}

/** Whether two paths open the same file: one read through a package's view of the other does. */
function sameFile(a: string, b: string): boolean {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    if (x.ino !== 0 && y.ino !== 0) return x.ino === y.ino && x.dev === y.dev;
    return x.size === y.size && x.mtimeMs === y.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Every package that holds a copy of this app's data folder with a
 * `settings.json` in it — a copy without one keeps no settings, only caches.
 * `inside` when this process reads its own data folder through that copy (it
 * was started from that package's app), else `outside`. Inside first. None off
 * Windows, or when the data folder is not under %APPDATA%.
 */
export function findDataCopies({ platform, appData, userData, localAppData }: DataCopyInput): DataCopy[] {
  if (platform !== "win32" || !localAppData) return [];
  const rel = path.relative(appData, userData);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return [];
  const packages = path.join(localAppData, "Packages");
  let names: string[];
  try {
    names = fs.readdirSync(packages);
  } catch {
    return [];
  }
  const ownSettings = path.join(userData, "settings.json");
  const copies: DataCopy[] = [];
  for (const name of names) {
    const dir = path.join(packages, name, "LocalCache", "Roaming", rel);
    const settings = path.join(dir, "settings.json");
    let changedAt: number;
    try {
      changedAt = fs.statSync(settings).mtimeMs;
    } catch {
      continue;
    }
    copies.push({
      // A package folder is `<Name>_<publisher hash>`.
      appName: name.split("_")[0] || name,
      dir,
      where: sameFile(ownSettings, settings) ? "inside" : "outside",
      changedAt,
    });
  }
  return copies.sort((a, b) => (a.where === b.where ? b.changedAt - a.changedAt : a.where === "inside" ? -1 : 1));
}
