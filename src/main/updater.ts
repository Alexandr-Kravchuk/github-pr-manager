import { app } from "electron";
import { autoUpdater } from "electron-updater";

import type { UpdateStatus } from "../shared/types";
import { diag } from "./diag-log";

// electron-updater reads the GitHub feed from app-update.yml (emitted by
// electron-builder from the `publish` config). That file only exists in a
// packaged build, so updates are a no-op in dev. macOS additionally requires a
// signed app for quitAndInstall to apply.

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const INITIAL_DELAY_MS = 10_000;

let initialized = false; // handlers wired (packaged builds only)
let initialTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let autoUpdateEnabled = false; // mirrors the user's auto-update setting
let downloadingVersion = ""; // set on update-available, read by download-progress

function check(): void {
  autoUpdater
    .checkForUpdates()
    .catch((e) => console.error("[updater] check failed:", e?.message ?? e));
}

/**
 * Triggers an immediate update check on demand (e.g. from a manual Refresh) so
 * the user needn't wait for the periodic timer. No-op in dev, when the updater
 * isn't initialized, or when the user turned auto-update off.
 */
export function checkForUpdatesNow(): void {
  if (!initialized || !autoUpdateEnabled) return;
  check();
}

/**
 * Wires electron-updater once. No checks run until setAutoUpdateEnabled(true).
 * A no-op in dev / when PRD_DISABLE_UPDATER is set (so toggling later also no-ops).
 * `onStatus` is pushed to the renderer so it can show download progress.
 */
export function initAutoUpdater(onStatus: (status: UpdateStatus) => void): void {
  if (initialized) return;
  if (!app.isPackaged || process.env.PRD_DISABLE_UPDATER) return;
  initialized = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err?.message ?? err);
    diag(`updater: error ${err?.message ?? String(err)}`);
  });
  autoUpdater.on("update-available", (info) => {
    console.log("[updater] update available:", info.version);
    downloadingVersion = info.version;
    onStatus({ state: "downloading", version: info.version, percent: 0 });
  });
  autoUpdater.on("download-progress", (progress) => {
    onStatus({ state: "downloading", version: downloadingVersion, percent: Math.round(progress.percent) });
  });
  autoUpdater.on("update-not-available", () => {
    console.log("[updater] up to date");
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] v%s downloaded — restarting to apply", info.version);
    diag(`updater: v${info.version} downloaded — installing silently, the installer starts the app again`);
    onStatus({ state: "downloaded", version: info.version });
    // Silent, and the app started again afterwards. The Windows installer is
    // the assisted (wizard) one, and its templates start the app after an
    // update only when silent: a plain quitAndInstall() quit the app and left
    // the wizard waiting for clicks — at 01:19 for an update that landed in
    // the night — with the app closed until someone clicked through it.
    // macOS ignores both flags: Squirrel always restarts the app.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 3_000);
  });
}

/**
 * Turns periodic update checks on or off, reflecting the user's setting. Safe to
 * call repeatedly. No effect in dev / when the updater wasn't initialized.
 */
export function setAutoUpdateEnabled(enabled: boolean): void {
  autoUpdateEnabled = enabled;
  if (!initialized) return;
  if (enabled) {
    if (intervalTimer) return; // already running
    initialTimer = setTimeout(check, INITIAL_DELAY_MS);
    intervalTimer = setInterval(check, CHECK_INTERVAL_MS);
  } else {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }
}
