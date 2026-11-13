// A build run from source (`npm run dev`, `npm start`) keeps its data in a
// folder of its own, `<userData> (dev)`, never in the installed app's. Both
// builds are named "PR Dashboard", so without this every worktree's dev build
// read and wrote the release's `settings.json` and agent state: a branch whose
// settings had a different shape saved it in its own, and the release that the
// next auto-update restarted read the fields it did not know as their defaults.
//
// The first dev launch starts from a copy of the installed app's files so it
// opens configured — with the agent switched off, since dev and release no
// longer share the single-instance lock and two agents would act on the same
// PRs. Electron-free on purpose (main.ts passes the paths in), so the seeding is
// unit-tested on real folders.
import fs from "node:fs";
import path from "node:path";

/** What a dev build copies from the installed app's folder, besides `settings.json`. */
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
