import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app } from "electron";
import { autoUpdater } from "electron-updater";

import type { UpdateStatus } from "../shared/types";
import { createPinnedVerifier, type VerifyUpdateCodeSignature } from "./update-signature";

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
// The version being downloaded right now: set on update-available, cleared when
// that download ends either way. Only an error while it is set is shown — a
// failed periodic check (offline) is not news.
let downloadingVersion = "";
let pushStatus: ((status: UpdateStatus) => void) | null = null;
let errorShown = false; // an "Update failed" pill is on screen

const LOG_MAX_BYTES = 1024 * 1024;

function check(): void {
  autoUpdater
    .checkForUpdates()
    .catch((e) => console.error("[updater] check failed:", e?.message ?? e));
}

/** Appends one updater error to userData/updater.log; best-effort. */
function logError(err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    const file = join(app.getPath("userData"), "updater.log");
    // A machine that is offline for weeks fails every check: start over past
    // 1 MB rather than grow without end.
    const tooBig = existsSync(file) && statSync(file).size > LOG_MAX_BYTES;
    (tooBig ? writeFileSync : appendFileSync)(file, `${new Date().toISOString()} ${detail}\n`);
  } catch {
    // the console line above is still there
  }
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
  const push = (status: UpdateStatus): void => {
    errorShown = status.state === "error";
    onStatus(status);
  };
  pushStatus = push;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Windows (NsisUpdater): also accept our pinned self-signed certificate where
  // its root isn't trusted — see update-signature.ts.
  if (process.platform === "win32" && "verifyUpdateCodeSignature" in autoUpdater) {
    const nsis = autoUpdater as unknown as { verifyUpdateCodeSignature: VerifyUpdateCodeSignature };
    nsis.verifyUpdateCodeSignature = createPinnedVerifier(nsis.verifyUpdateCodeSignature);
  }

  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err?.message ?? err);
    logError(err);
    if (!downloadingVersion) return;
    downloadingVersion = "";
    const message = String(err?.message ?? err).split("\n")[0].slice(0, 200);
    push({ state: "error", message });
  });
  autoUpdater.on("update-available", (info) => {
    console.log("[updater] update available:", info.version);
    downloadingVersion = info.version;
    push({ state: "downloading", version: info.version, percent: 0 });
  });
  autoUpdater.on("download-progress", (progress) => {
    push({ state: "downloading", version: downloadingVersion, percent: Math.round(progress.percent) });
  });
  autoUpdater.on("update-not-available", () => {
    console.log("[updater] up to date");
    // Clears an error pill left by an earlier attempt.
    push({ state: "idle" });
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] v%s downloaded — restarting to apply", info.version);
    downloadingVersion = "";
    push({ state: "downloaded", version: info.version });
    setTimeout(() => autoUpdater.quitAndInstall(), 3_000);
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
    // Nothing will check again, so an error pill would never go away. Only
    // then: this runs on every settings save, and an idle mid-download would
    // blink the progress pill until the next progress event.
    if (errorShown) pushStatus?.({ state: "idle" });
  }
}
