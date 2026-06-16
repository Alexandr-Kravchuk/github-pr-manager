import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";

// electron-updater reads the GitHub feed from app-update.yml (emitted by
// electron-builder from the `publish` config). That file only exists in a
// packaged build, so updates are a no-op in dev. macOS additionally requires a
// signed app for quitAndInstall to apply — unsigned local builds will log an
// error and carry on, which is fine.

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const INITIAL_DELAY_MS = 10_000;

let started = false;

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (started) return;
  // No update feed in dev, and an explicit escape hatch for internal builds.
  if (!app.isPackaged || process.env.PRD_DISABLE_UPDATER) return;
  started = true;

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
    const window = getWindow();
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (response === 0) {
      // Defer so the dialog fully closes before the app tears down.
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  });

  const check = () => {
    autoUpdater
      .checkForUpdates()
      .catch((e) => console.error("[updater] check failed:", e?.message ?? e));
  };

  setTimeout(check, INITIAL_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
}
