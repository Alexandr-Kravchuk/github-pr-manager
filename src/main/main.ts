import path from "node:path";
import { app, BrowserWindow, clipboard, ipcMain, nativeImage, nativeTheme, powerMonitor, session, shell } from "electron";

import { ConfigError, defaultSettings, getGhStatus, toHostConfigs, toPublicConfig } from "../shared/config";
import { setIgnored } from "../shared/ignored";
import { markSeen } from "../shared/state";
import type {
  ConfigResult,
  DashboardResult,
  GhStatus,
  SaveSettingsResult,
  Settings,
} from "../shared/types";
import { ensureCliPath } from "./cli-path";
import {
  validateClipboardText,
  validateExternalUrl,
  validateIgnoredArgs,
  validateSeenItems,
  validateThemePreference,
} from "./ipc-validation";
import { isMockMode, mockPollerOverrides } from "./mock";
import { Poller } from "./poller";
import {
  acknowledgeVersion,
  ignoredStatePath,
  loadAcknowledgedVersion,
  loadSettings,
  persistSettings,
  seenStatePath,
} from "./settings";
import { checkForUpdatesNow, initAutoUpdater, setAutoUpdateEnabled } from "./updater";

let mainWindow: BrowserWindow | null = null;
let poller: Poller | null = null;
let systemSuspended = false;

/** Pause polling after this many seconds of user inactivity. */
const IDLE_PAUSE_SECONDS = 300;

/**
 * The idle gate handed to the poller: true when a fetch would just waste the
 * rate-limit budget — the machine is asleep, the window is minimized/hidden, or
 * the user has been idle a while. No window yet (startup / dock activate) counts
 * as active so the first fetch runs. `wake()` (focus/resume) forces a fetch back.
 */
function isDashboardPaused(): boolean {
  if (systemSuspended) return true;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized() || !win.isVisible()) return true;
  try {
    if (powerMonitor.getSystemIdleTime() > IDLE_PAUSE_SECONDS) return true;
  } catch {
    /* getSystemIdleTime can be unavailable on some platforms — treat as active */
  }
  return false;
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** Registers/unregisters the OS "open at login" item. Packaged app only — in dev
 *  the item would point at the dev Electron binary. Not supported on Linux. */
function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged || process.platform === "linux") return;
  app.setLoginItemSettings({ openAtLogin: enabled });
  if (process.env.PRD_DEBUG) {
    console.log("[main] launchAtLogin", enabled, "-> openAtLogin", app.getLoginItemSettings().openAtLogin);
  }
}

/** Window chrome background for the current effective theme — matches the
 *  renderer's `--canvas` so there's no flash before paint nor a mismatched
 *  edge on resize. */
function themeBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#09090b" : "#f7f7f8";
}

/** Drives the renderer's `prefers-color-scheme` (and native chrome) from the
 *  user's appearance preference. "system" hands control back to the OS. */
function applyThemeSource(theme: Settings["theme"]): void {
  nativeTheme.themeSource = theme;
}

/** Applies user preferences (launch-at-login + auto-update + theme) to the OS/updater. */
function applyPreferences(settings: Settings): void {
  applyLaunchAtLogin(settings.launchAtLogin);
  setAutoUpdateEnabled(settings.autoUpdate);
  applyThemeSource(settings.theme);
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
    backgroundColor: themeBackground(),
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

  // Returning to the dashboard (focus / un-minimize / re-show) should refresh
  // immediately rather than wait out the parked idle cadence.
  const wakePoller = (): void => void poller?.wake();
  mainWindow.on("focus", wakePoller);
  mainWindow.on("show", wakePoller);
  mainWindow.on("restore", wakePoller);

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
    // Piggy-back an update check on the manual Refresh so the user isn't stuck
    // waiting for the periodic timer. Fire-and-forget; no-op in dev / when off.
    checkForUpdatesNow();
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

  ipcMain.handle("ignored:set", async (_event, id: unknown, ignored: unknown) => {
    const args = validateIgnoredArgs(id, ignored);
    await setIgnored(args.id, args.ignored, ignoredStatePath());
    // No forced poll: the renderer updates its own copy optimistically, and the
    // next natural tick re-applies the persisted set — so this doesn't spend the
    // rate-limit budget on every ignore click.
  });

  ipcMain.handle("app:openExternal", async (_event, url: unknown) => {
    await shell.openExternal(validateExternalUrl(url));
  });

  ipcMain.handle("settings:get", async (): Promise<Settings> => loadSettings());

  ipcMain.handle("settings:save", async (_event, raw: unknown): Promise<SaveSettingsResult> => {
    try {
      const saved = persistSettings(raw);
      applyPreferences(saved);
      // Apply immediately: a fresh poll re-resolves tokens and re-fetches, and
      // its snapshot/config-error is pushed to the renderer.
      await poller?.refresh();
      return { ok: true };
    } catch (e) {
      if (e instanceof ConfigError) return { ok: false, error: e.message };
      return { ok: false, error: (e as Error).message };
    }
  });

  // Appearance toggle: apply instantly (so the click is reflected without a
  // Save), then persist into settings. A broken settings file shouldn't block
  // the live toggle, so persistence is best-effort.
  ipcMain.handle("theme:set", async (_event, raw: unknown): Promise<void> => {
    const theme = validateThemePreference(raw);
    applyThemeSource(theme);
    try {
      persistSettings({ ...loadSettings(), theme });
    } catch {
      /* keep the in-session theme even if the file can't be written */
    }
  });

  ipcMain.handle("gh:status", async (): Promise<GhStatus> => {
    try {
      return getGhStatus(loadSettings());
    } catch {
      // An invalid settings file shouldn't break the gh probe.
      return { installed: getGhStatus(defaultSettings()).installed, hosts: [] };
    }
  });

  ipcMain.handle("app:getVersion", async (): Promise<string> => app.getVersion());

  ipcMain.handle("app:getWhatsNew", async () => {
    const acked = loadAcknowledgedVersion();
    const current = app.getVersion();
    if (!acked || acked === current) return null;
    return {
      version: current,
      url: `https://github.com/Alexandr-Kravchuk/github-pr-manager/releases/tag/v${current}`,
    };
  });

  ipcMain.handle("app:dismissWhatsNew", async () => {
    acknowledgeVersion(app.getVersion());
  });

  ipcMain.handle("app:copyText", async (_event, text: unknown): Promise<void> => {
    clipboard.writeText(validateClipboardText(text));
  });
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

  // Seed the acknowledged version on first run so "What's new" doesn't flash
  // on a fresh install.
  if (loadAcknowledgedVersion() === null) {
    acknowledgeVersion(app.getVersion());
  }

  poller = new Poller({
    loadSettings,
    toHostConfigs,
    statePath: seenStatePath(),
    ignoredStatePath: ignoredStatePath(),
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
    isPaused: isDashboardPaused,
    // PRD_MOCK: canned PRs instead of gh/network — see mock.ts.
    ...(isMockMode() ? mockPollerOverrides(app.getPath("userData")) : {}),
  });
  poller.start();

  // Pause polling across sleep; refresh on resume / unlock so the first thing
  // the user sees on return is current rather than stale.
  powerMonitor.on("suspend", () => {
    systemSuspended = true;
  });
  powerMonitor.on("resume", () => {
    systemSuspended = false;
    void poller?.wake();
  });
  powerMonitor.on("unlock-screen", () => void poller?.wake());

  // Resolve the saved appearance before the first window so the initial paint
  // and the native window background already match (no dark flash in light mode).
  // Fall back to defaults if the settings file is invalid.
  let prefs: Settings;
  try {
    prefs = loadSettings();
  } catch {
    prefs = defaultSettings();
  }
  applyThemeSource(prefs.theme);

  // Keep the window's native background in sync when the effective theme flips —
  // an OS change under "system", or a Light/Dark toggle.
  nativeTheme.on("updated", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(themeBackground());
    }
  });

  createWindow();
  initAutoUpdater();

  // Apply the remaining prefs (launch-at-login + auto-update; theme re-applied
  // harmlessly). Runs after the updater is initialized.
  applyPreferences(prefs);

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
