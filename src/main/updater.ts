import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";

// electron-updater reads the GitHub feed from app-update.yml (emitted by
// electron-builder from the `publish` config). That file only exists in a
// packaged build, so updates are a no-op in dev. macOS additionally requires a
// signed app for quitAndInstall to apply.

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const INITIAL_DELAY_MS = 10_000;

let initialized = false; // handlers wired (packaged builds only)
let getWindowFn: () => BrowserWindow | null = () => null;
let initialTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let autoUpdateEnabled = false; // mirrors the user's auto-update setting

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
 */
export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  getWindowFn = getWindow;
  if (initialized) return;
  if (!app.isPackaged || process.env.PRD_DISABLE_UPDATER) return;
  initialized = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err?.message ?? err);
  });
  autoUpdater.on("update-available", (info) => {
    console.log("[updater] update available:", info.version);
  });
  autoUpdater.on("update-not-available", () => {
    console.log("[updater] up to date");
  });
  autoUpdater.on("update-downloaded", async (info) => {
    const options = {
      type: "info" as const,
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `PR Dashboard ${info.version} has been downloaded.`,
      detail: "Restart to apply the update. It will also install automatically next time you quit.",
    };
    const window = getWindowFn();
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall());
    }
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
