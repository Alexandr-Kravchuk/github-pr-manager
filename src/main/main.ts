import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, ipcMain, nativeImage, nativeTheme, Notification, powerMonitor, session, shell } from "electron";

import { ConfigError, defaultSettings, getGhStatus, pickAppId, toHostConfigs, toPublicConfig } from "../shared/config";
import { isPollingPaused } from "../shared/idle-gate";
import { setIgnored } from "../shared/ignored";
import {
  createReleaseGuard,
  hasDeliverableNotifications,
  planDelivery,
  runNotifyCycle,
} from "../shared/notify";
import { markSeen } from "../shared/state";
import type {
  ConfigResult,
  DashboardResult,
  GhStatus,
  JiraStatus,
  PullRequest,
  SaveSettingsResult,
  Settings,
} from "../shared/types";
import { ensureCliPath } from "./cli-path";
import { clearParentCache } from "../shared/jira";
import { buildParentEnricher, getJiraStatus, setJiraToken } from "./jira-store";
import {
  validateClipboardText,
  validateExternalUrl,
  validateIgnoredArgs,
  validateJiraToken,
  validateSeenItems,
  validateThemePreference,
} from "./ipc-validation";
import { isMockMode, mockPollerOverrides } from "./mock";
import { Poller } from "./poller";
import { acquireSingleInstanceLock } from "./single-instance";
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

/**
 * Previous PR set seen by the notifier — for transition diffing. Null until the
 * first snapshot, which only establishes the baseline (fires nothing).
 */
let prevNotifyPrs: PullRequest[] | null = null;

/**
 * The idle gate handed to the poller: true when a fetch would just waste the
 * rate-limit budget. The suspend / genuinely-away / no-window branches and the
 * notifications-aware "hidden window" carve-out all live in the pure
 * `isPollingPaused` (unit-tested); this only samples the live Electron state and
 * feeds it in. `wake()` (focus/resume) forces a fetch back regardless.
 *
 * A hidden/minimized window no longer pauses polling when a notification could
 * actually reach the user — otherwise the notifier can never observe a
 * transition while the window is out of sight, which is exactly when the user
 * relies on it. "Could actually reach" comes from `hasDeliverableNotifications`,
 * not the bare `notifications.enabled` toggle: `enabled` with every event type
 * or both delivery channels off can never fire a toast, and keeping the poll
 * loop alive for that state would spend budget for nothing. Budget is otherwise
 * bounded by per-host spacing, the cold-host floor, the no-change backoff and
 * the cheap REST detector.
 *
 * Takes the `settings` the poller already loaded this tick instead of reading
 * `settings.json` again: `Poller.tick()` loads and validates it at the top of
 * every tick and returns early via `emitConfigError` if that throws, so a second
 * read here would be duplicate synchronous I/O on the main thread and its error
 * branch would be unreachable. Both native-touching inputs
 * (`getSystemIdleTime`, `Notification.isSupported`) are passed as thunks for the
 * same reason — the free branches inside `isPollingPaused` decide without paying
 * for either.
 */
function isDashboardPaused(settings: Settings): boolean {
  const win = mainWindow;
  const hasWindow = Boolean(win && !win.isDestroyed());

  return isPollingPaused({
    systemSuspended,
    hasWindow,
    // Verified against Electron's win32 semantics (minimize + hide-to-taskbar).
    // The macOS equivalents — Cmd+H, moving the window to another Space, and
    // native full-screen — are not yet manually confirmed to resolve
    // `isMinimized()`/`isVisible()` the same way; the failure direction is safe
    // (we'd keep polling, never miss a toast), but a macOS pass is still owed.
    windowHidden: hasWindow && (win!.isMinimized() || !win!.isVisible()),
    systemIdleSeconds: () => {
      try {
        return powerMonitor.getSystemIdleTime();
      } catch {
        /* getSystemIdleTime can be unavailable on some platforms — treat as active */
        return null;
      }
    },
    notificationsActionable: () =>
      hasDeliverableNotifications(settings.notifications, Notification.isSupported()),
  });
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** Brings the window back to the foreground (from minimized / hidden / behind). */
function focusMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Shown notifications, retained until the OS is done with them. Electron can
 * garbage-collect a `Notification` while its toast is still on screen, which
 * drops the pending `click` event — so we hold a reference until it closes.
 */
const liveNotifications = new Set<Notification>();

/** How long to retain a Notification with no click/close/failed before force-releasing it. */
const NOTIFICATION_RELEASE_MS = 60_000;

/** Shows one native OS notification; `onClick` runs when the user clicks it. */
function showOsNotification(title: string, body: string, silent: boolean, onClick: () => void): void {
  const n = new Notification({ title, body, silent });
  // One-shot release shared across click/close/failed plus a safety-net timer
  // (some OS/Electron combos expire a toast without emitting any event, which
  // would otherwise retain the reference for the process lifetime). The dedup +
  // safety-net logic is extracted to `createReleaseGuard` so it unit-tests.
  const release = createReleaseGuard(
    {
      onRelease: () => liveNotifications.delete(n),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return { clear: () => clearTimeout(t) };
      },
    },
    NOTIFICATION_RELEASE_MS,
  );
  // Release on click too: some OS/versions fire `click` without a later `close`,
  // which would otherwise retain every clicked toast for the process lifetime.
  n.on("click", () => {
    try {
      onClick();
    } finally {
      release();
    }
  });
  n.on("close", release);
  n.on("failed", release);
  liveNotifications.add(n);
  n.show();
}

/**
 * Diffs the new snapshot against the last, then delivers desktop notifications
 * per the user's settings: a native OS notification (click opens the PR) and/or
 * a sound. Best-effort — a failure here must never break the poll loop, and the
 * baseline is kept current even when settings can't be read, so re-enabling
 * notifications later doesn't replay a backlog.
 */
function handleNotifications(prs: PullRequest[]): void {
  const dbg = (msg: string): void => {
    if (process.env.PRD_DEBUG) console.log(`[notify] ${msg}`);
  };

  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (e) {
    // Advance the baseline (avoids a replay storm once settings recover), but
    // surface this always-on, not only under PRD_DEBUG: a persistent settings
    // problem silently drops real transitions otherwise. The poller surfaces the
    // same failure to the UI as a config error; this keeps a diagnosable trace.
    prevNotifyPrs = prs;
    console.warn(`[notify] settings unreadable — notifications skipped this tick: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const wasBaseline = prevNotifyPrs === null;

  // Advance the baseline and deliver via `runNotifyCycle`: it diffs, returns the
  // new baseline (always `prs`) BEFORE the injected delivery runs, and swallows
  // any delivery failure — so a throwing deliverer degrades to a skipped tick
  // and never replays a backlog. That ordering guarantee is unit-tested on the
  // pure helper; this callback holds only the Electron delivery.
  prevNotifyPrs = runNotifyCycle(prevNotifyPrs, prs, settings.notifications, (events) => {
    if (!settings.notifications.enabled) {
      dbg("disabled in Settings — nothing fires (enable it under Notifications)");
      return;
    }
    if (events.length === 0) {
      dbg(wasBaseline ? "baseline snapshot — no toasts on first tick" : "no notifiable transitions this tick");
      return;
    }

    // Decide delivery with the pure planner (focus suppression, summary-vs-
    // individual split, chime-once, native-off sound fallback all live there and
    // are unit-tested); this process only executes the descriptor.
    const win = mainWindow;
    const focused = Boolean(win && !win.isDestroyed() && win.isFocused());
    const kinds = events.map((e) => e.kind).join(", ");
    const plan = planDelivery(events, settings.notifications, {
      focused,
      nativeSupported: Notification.isSupported(),
    });

    if (plan.mode === "none") {
      dbg(focused ? `suppressed ${events.length} event(s) — window focused: ${kinds}` : `no delivery channel: ${kinds}`);
      return;
    }

    const { native, sound } = settings.notifications;
    dbg(`delivering ${events.length} event(s) [native=${native} sound=${sound} mode=${plan.mode}]: ${kinds}`);

    if (plan.mode === "summary") {
      // Guarded like the individual branch: on the busiest path a throwing
      // Notification must leave a trace, not vanish into runNotifyCycle's catch.
      try {
        showOsNotification(
          "PR Dashboard",
          `${events.length} pull requests need your attention`,
          plan.summarySilent,
          focusMainWindow,
        );
      } catch (e) {
        console.warn(`[notify] summary toast failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (plan.mode === "individual") {
      events.forEach((ev, i) => {
        // Guard each toast independently so one failing construction/show can't
        // drop the remaining ones in the batch. Always-on (not PRD_DEBUG-gated)
        // so a delivery failure is diagnosable in production.
        try {
          showOsNotification(ev.title, ev.body, plan.silent[i], () => {
            // Validate before opening: the URL comes from a user-configured
            // GraphQL host, so guard the scheme like every other openExternal
            // call here. On a bad URL, fall back to surfacing the app.
            try {
              void shell.openExternal(validateExternalUrl(ev.url));
            } catch {
              focusMainWindow();
            }
          });
        } catch (e) {
          console.warn(`[notify] toast failed for ${ev.kind}: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    } else {
      // sound-only: no native window, but the user still wants an audible ping.
      sendToRenderer("notify-sound", undefined);
    }
  });
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

/**
 * Windows AppUserModelID used for native toast attribution. Read from
 * `package.json`'s `build.appId` — the *same* key electron-builder reads to
 * stamp the installed app's shortcut — so the runtime value and the packaged
 * installer share one source and can't silently drift. `package.json` is bundled
 * into the app (see `build.files`), so this resolves in dev and packaged alike;
 * falls back to the known literal if it can't be read.
 */
function resolveWindowsAppId(): string {
  const fallback = "com.creatio.prdashboard"; // keep in sync with package.json build.appId
  try {
    const raw = fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8");
    // Branch selection (present / malformed / missing / non-string) lives in the
    // pure `pickAppId`, which is unit-tested; this only does the file read.
    return pickAppId(raw, fallback);
  } catch {
    return fallback;
  }
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
      // Let the renderer play the notification sound without a prior click —
      // pings fire on their own, never off a user gesture.
      autoplayPolicy: "no-user-gesture-required",
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
      let previousJira: Settings["jira"];
      try {
        previousJira = loadSettings().jira;
      } catch {
        previousJira = undefined;
      }
      const saved = persistSettings(raw);
      // The site URL / account identify what the Jira caches describe: the
      // parent cache is keyed by issue key alone, so entries resolved against
      // the old site would otherwise be served for the new one for up to its
      // TTL. A connection change invalidates them exactly like a token change.
      if (
        saved.jira?.baseUrl !== previousJira?.baseUrl ||
        saved.jira?.email !== previousJira?.email
      ) {
        clearParentCache();
      }
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

  ipcMain.handle("jira:status", async (): Promise<JiraStatus> => getJiraStatus(loadSettings));

  ipcMain.handle("jira:setToken", async (_event, raw: unknown) => {
    const result = setJiraToken(validateJiraToken(raw));
    // A token change can flip grouping availability — re-poll so parents resolve
    // (or clear) without waiting for the next natural tick.
    if (result.ok) await poller?.refresh();
    return result;
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

// The primary instance's startup, run once the app is ready. Extracted from the
// whenReady callback (a) to keep the lock-acquisition branch below shallow and
// readable, and (b) so the single-instance decision logic lives in the
// unit-tested single-instance.ts rather than an inline closure.
function startApp(): void {
  // Must run before any `gh` invocation: a Finder/.app launch inherits a minimal
  // PATH without Homebrew, so without this `gh` is not found and token
  // resolution fails with a misleading "not signed in".
  ensureCliPath();

  // Windows attributes toast notifications to an AppUserModelID; without this
  // they can show under a generic name (or not at all). Must match the
  // electron-builder `appId` so the packaged install's shortcut lines up.
  if (process.platform === "win32") app.setAppUserModelId(resolveWindowsAppId());

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
    // No real Jira calls in fixture mode; the mock overrides below win anyway.
    enrichParents: isMockMode() ? undefined : buildParentEnricher(loadSettings),
    onSnapshot: (snapshot) => {
      if (process.env.PRD_DEBUG) {
        console.log(
          `[snapshot] prs=${snapshot.pullRequests.length} errors=${snapshot.errors.length} rate=${JSON.stringify(snapshot.rateLimits)}`,
        );
      }
      sendToRenderer("snapshot", snapshot);
      handleNotifications(snapshot.pullRequests);
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
  initAutoUpdater((status) => sendToRenderer("update-status", status));

  // Apply the remaining prefs (launch-at-login + auto-update; theme re-applied
  // harmlessly). Runs after the updater is initialized.
  applyPreferences(prefs);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

// Enforce single instance: if another copy already holds the OS lock, quit this
// one; otherwise register the second-instance refocus and proceed with startup.
// Without this guard the OS login-item and any accidental double-launch each
// spin up their own window. The decision logic is unit-tested in
// single-instance.ts (main.ts can't be required from a test — this call runs the
// real lock request at import time).
const isPrimaryInstance = acquireSingleInstanceLock({
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  onSecondInstance: (handler) => {
    app.on("second-instance", handler);
  },
  getMainWindow: () => mainWindow,
  focusMainWindow,
  whenReady: () => app.whenReady(),
});

// All startup and window lifecycle stays inside the primary-instance branch: a
// non-primary instance has already been told to quit and must never register
// `ready` or `window-all-closed` handlers. Gating on the boolean makes that
// exclusion structural, independent of Electron's internal ready/quit timing.
if (isPrimaryInstance) {
  void app.whenReady().then(startApp);

  // Plain window app (per product decision): closing the last window quits.
  app.on("window-all-closed", () => {
    poller?.stop();
    app.quit();
  });
}
