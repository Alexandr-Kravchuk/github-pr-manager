// A build that isn't the installed app — run from source (`npm run dev`,
// `npm start`) or from a packaging folder (`dist/win-unpacked`) — keeps its data
// in a folder of its own, `<userData> (dev)`, never in the installed app's. All
// builds are named "PR Dashboard", so without this every worktree's build read
// and wrote the release's `settings.json` and agent state: a branch whose
// settings had a different shape saved it in its own, and the release that the
// next auto-update restarted read the fields it did not know as their defaults.
//
// The first such launch starts from a copy of the installed app's files so it
// opens configured — with the agent switched off, since it no longer shares
// the release's single-instance lock and two agents would act on the same PRs.
// Electron-free on purpose (main.ts passes the paths in), so the rules are
// unit-tested on real folders.
import fs from "node:fs";
import path from "node:path";

export interface BuildIdentity {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** `process.execPath`. */
  execPath: string;
  /** `app.getName()` — the uninstaller is named after it. */
  productName: string;
  exists?: (file: string) => boolean;
}

/**
 * Whether this process is the installed app. A packaged build counts unless it
 * runs on Windows without the uninstaller the NSIS install puts next to the
 * exe: that is a `win-unpacked` folder, which must not take the installed app's
 * data, its launch-at-login entry (written with this exe's path) or its
 * updates (an update would run the real installer).
 */
export function isInstalledBuild(build: BuildIdentity): boolean {
  if (!build.isPackaged) return false;
  if (build.platform !== "win32") return true;
  const exists = build.exists ?? fs.existsSync;
  return exists(path.win32.join(path.win32.dirname(build.execPath), `Uninstall ${build.productName}.exe`));
}

/** What a build that isn't the installed app copies from its folder, besides `settings.json`. */
export const DEV_SEED_FILES = [
  "seen-state.json",
  "ignored-state.json",
  "window-state.json",
  "weather-location.json",
] as const;

/** The dev build's data folder next to the installed app's one. */
export function devUserDataDir(userData: string): string {
  return `${userData} (dev)`;
}

/**
 * Seeds `devDir` from `releaseDir` unless it has a `settings.json` already, and
 * returns the files it wrote. A file the dev folder has is never overwritten.
 * `settings.json` goes last: it marks the folder seeded, so a seed cut short is
 * finished on the next launch. The Jira token is not copied — it is encrypted
 * with a key that, on Windows, lives in the folder's own Chromium state.
 */
export function seedDevUserData(releaseDir: string, devDir: string): string[] {
  const devSettings = path.join(devDir, "settings.json");
  if (fs.existsSync(devSettings)) return [];
  fs.mkdirSync(devDir, { recursive: true });
  const written: string[] = [];
  for (const name of DEV_SEED_FILES) {
    const from = path.join(releaseDir, name);
    const to = path.join(devDir, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.copyFileSync(from, to);
    written.push(name);
  }
  const settings = devSettingsFrom(path.join(releaseDir, "settings.json"));
  if (settings) {
    fs.writeFileSync(devSettings, JSON.stringify(settings, null, 2), "utf8");
    written.push("settings.json");
  }
  return written;
}

/** The installed app's settings with the agent off, or null when there are none to read. */
function devSettingsFrom(file: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const settings = parsed as Record<string, unknown>;
  const agent = settings.agent;
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) return settings;
  return { ...settings, agent: { ...(agent as Record<string, unknown>), enabled: false } };
}
