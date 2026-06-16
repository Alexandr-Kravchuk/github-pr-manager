import path from "node:path";
import { app, BrowserWindow, ipcMain, nativeImage, session, shell } from "electron";

import { ConfigError, getGhStatus, toHostConfigs, toPublicConfig } from "../shared/config";
import { markSeen } from "../shared/state";
import type {
  ConfigResult,
  DashboardResult,
  GhStatus,
  SaveSettingsResult,
  Settings,
} from "../shared/types";
import { ensureCliPath } from "./cli-path";
import { validateExternalUrl, validateSeenItems } from "./ipc-validation";
import { Poller } from "./poller";
import { loadSettings, persistSettings, seenStatePath } from "./settings";
import { initAutoUpdater } from "./updater";

let mainWindow: BrowserWindow | null = null;
let poller: Poller | null = null;

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/**
 * Content-Security-Policy as a response header (not a <meta> tag, which would
 * forbid Vite's dev-mode inline preamble). Strict for the packaged file:// load;
 * relaxed for the Vite dev server (inline/eval + HMR websocket). Avatars come
 * from GitHub over https, so img-src allows https.
 */
function applyCsp(): void {
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
  const policy = isDev
    ? "default-src 'self' 'unsafe-inline' data: https: ws: http://localhost:*; script-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' https: data:"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] },
    });
  });
}

function resolveAppIcon(): Electron.NativeImage | undefined {
  // Window icon (Windows/Linux taskbar + title bar). macOS uses the bundle icon.
  // Falls back to the default Electron icon if the file is missing.
  const image = nativeImage.createFromPath(path.join(app.getAppPath(), "build", "icon.png"));
  return image.isEmpty() ? undefined : image;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "PR Dashboard",
    backgroundColor: "#09090b",
    autoHideMenuBar: true,
    icon: resolveAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[main] render process gone:", details.reason);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, desc) => {
    console.error(`[main] renderer failed to load: ${code} ${desc}`);
  });

  // External links (PR titles, check badges) must open in the system browser,
  // never as an in-app Electron window. A target=_blank / window.open is routed
  // here; navigations away from the app shell are likewise sent to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  // Optional non-interactive boot gate: when PRD_SMOKE_EXIT_MS is set, quit a
  // moment after the renderer finishes loading. Lets `electron .` double as a
  // "does it boot?" check in CI/dev without a human watching the window.
  const smokeExitMs = Number(process.env.PRD_SMOKE_EXIT_MS);
  if (Number.isFinite(smokeExitMs) && smokeExitMs > 0) {
    mainWindow.webContents.once("did-finish-load", () => {
      if (process.env.PRD_DEBUG) console.log("[smoke] renderer finished loading");
      setTimeout(() => app.quit(), smokeExitMs);
    });
    // Backstop so a hung load can never wedge a non-interactive run.
    setTimeout(() => app.quit(), smokeExitMs + 10_000);
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}

/** Current cached dashboard state as an IPC result. */
function dashboardResult(): DashboardResult {
  const configError = poller?.getConfigError() ?? null;
  if (configError) {
    return { ok: false, kind: "config", error: configError };
  }
  const snapshot = poller?.getSnapshot() ?? null;
  if (!snapshot) {
    return { ok: false, kind: "transient", error: "No data available yet." };
  }
  return { ok: true, snapshot };
}

function registerIpc(): void {
  // Initial paint: cached snapshot (waits for the first tick so it isn't empty).
  ipcMain.handle("dashboard:get", async (): Promise<DashboardResult> => {
    await poller?.awaitFirstTick();
    return dashboardResult();
  });

  // Manual "Refresh": force an immediate poll, then return the fresh state.
  ipcMain.handle("dashboard:refresh", async (): Promise<DashboardResult> => {
    await poller?.refresh();
    return dashboardResult();
  });

  ipcMain.handle("config:get", async (): Promise<ConfigResult> => {
    try {
      return { ok: true, config: toPublicConfig(loadSettings()) };
    } catch (e) {
      if (e instanceof ConfigError) return { ok: false, error: e.message };
      throw e;
    }
  });

  ipcMain.handle("seen:mark", async (_event, items: unknown) => {
    await markSeen(validateSeenItems(items), seenStatePath());
  });

  ipcMain.handle("app:openExternal", async (_event, url: unknown) => {
    await shell.openExternal(validateExternalUrl(url));
  });

  ipcMain.handle("settings:get", async (): Promise<Settings> => loadSettings());

  ipcMain.handle("settings:save", async (_event, raw: unknown): Promise<SaveSettingsResult> => {
    try {
      persistSettings(raw);
      // Apply immediately: a fresh poll re-resolves tokens and re-fetches, and
      // its snapshot/config-error is pushed to the renderer.
      await poller?.refresh();
      return { ok: true };
    } catch (e) {
      if (e instanceof ConfigError) return { ok: false, error: e.message };
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle("gh:status", async (): Promise<GhStatus> => {
    try {
      return getGhStatus(loadSettings());
    } catch {
      // An invalid settings file shouldn't break the gh probe.
      return { installed: getGhStatus({ pollIntervalSeconds: 60, hosts: [] }).installed, hosts: [] };
    }
  });

  ipcMain.handle("app:getVersion", async (): Promise<string> => app.getVersion());
}

void app.whenReady().then(() => {
  // Must run before any `gh` invocation: a Finder/.app launch inherits a minimal
  // PATH without Homebrew, so without this `gh` is not found and token
  // resolution fails with a misleading "not signed in".
  ensureCliPath();

  if (process.env.PRD_DEBUG) {
    console.log("[main] userData:", app.getPath("userData"));
    console.log("[main] PATH:", process.env.PATH);
  }

  applyCsp();
  registerIpc();

  poller = new Poller({
    loadSettings,
    toHostConfigs,
    statePath: seenStatePath(),
    appVersion: app.getVersion(),
    onSnapshot: (snapshot) => {
      if (process.env.PRD_DEBUG) {
        console.log(
          `[snapshot] prs=${snapshot.pullRequests.length} errors=${snapshot.errors.length} rate=${JSON.stringify(snapshot.rateLimits)}`,
        );
      }
      sendToRenderer("snapshot", snapshot);
    },
    onConfigError: (message) => {
      if (process.env.PRD_DEBUG) console.error("[config-error]", message);
      sendToRenderer("config-error", message);
    },
  });
  poller.start();

  createWindow();
  initAutoUpdater(() => mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Plain window app (per product decision): closing the last window quits.
app.on("window-all-closed", () => {
  poller?.stop();
  app.quit();
});
