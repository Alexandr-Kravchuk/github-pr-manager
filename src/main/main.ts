import fs from "node:fs";
import path from "node:path";
import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, clipboard, ipcMain, nativeTheme, Notification, powerMonitor, session, shell } from "electron";

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
import { loadAppIcon } from "./app-icon";
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
import { installAppMenu } from "./menu";
import { isMockMode, mockPollerOverrides } from "./mock";
import { Poller } from "./poller";
import { acquireSingleInstanceLock, createWindowReadyGate } from "./single-instance";
import { createTrayController } from "./tray";
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

// Signals the first time createWindow() assigns mainWindow. The second-instance
// handler's deferred focus waits on THIS — a window actually existing — rather
// than app.whenReady(), because the two are distinct events: whenReady can
// resolve while mainWindow is still null. See single-instance.ts (the gate is
// factored out so the full deferred-focus timeline is unit-testable).
const windowGate = createWindowReadyGate();

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
 * The tray icon plus the close/quit state that hangs off it. Owning both in one
 * place is what keeps "the close button hides" and "a tray icon exists" from
 * drifting apart; `tray.ts` holds the logic so it is unit-testable against a
 * mocked Electron, and this module only supplies the live window/app actions.
 */
const trayController = createTrayController({
  open: () => focusMainWindow(),
  quit: () => app.quit(),
  hide: () => hideMainWindow(),
});

/**
 * Hides the window for close-to-tray. A macOS window in native full-screen
 * must leave full-screen first — hiding it directly is a long-standing
 * Electron/macOS trap that can strand the user on an empty Space.
 */
function hideMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen()) {
    win.once("leave-full-screen", () => {
      if (!win.isDestroyed()) win.hide();
    });
    win.setFullScreen(false);
  } else {
    win.hide();
  }
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

/** Applies user preferences (launch-at-login + auto-update + close-to-tray +
 *  theme) to the OS/updater. */
function applyPreferences(settings: Settings): void {
  applyLaunchAtLogin(settings.launchAtLogin);
  setAutoUpdateEnabled(settings.autoUpdate);
  // Creates or removes the tray icon; a failure to create one leaves close
  // quitting (the controller says so) rather than hiding an unreachable window.
  trayController.setEnabled(settings.closeToTray);
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
  return loadAppIcon() ?? undefined;
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

  // In tray mode the close button hides the window instead of destroying it,
  // and the tray menu (or relaunching the app, which the single-instance
  // handler routes to `focusMainWindow`) brings the dashboard back. Background
  // behavior while hidden is deliberately conditional: the idle gate keeps the
  // poller running only while a notification could actually be delivered
  // (`isPollingPaused`'s hidden-window carve-out) — with notifications off
  // there is nothing a fetch could surface, so polling parks until the window
  // is shown again and the show-wake refresh catches it up. The three-way
  // close decision — hide / let a real quit through / no tray, so close as
  // usual — lives in `trayController.handleClose` and is unit-tested there.
  mainWindow.on("close", (event) => trayController.handleClose(event));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // A window now exists: release any second-instance focus that was deferred
  // because it arrived before the first window. Resolving again is a no-op.
  windowGate.markWindowReady();

  // Windows shutdown/restart/logout never emits `before-quit` (documented
  // Electron behavior), so the quit latch must come from the window's own
  // session-end signal — otherwise close-to-tray would intercept the OS's
  // close and hold up the logout.
  mainWindow.on("session-end", () => trayController.markQuitting());

  // Returning to the dashboard (focus / un-minimize / re-show) should refresh
  // immediately rather than wait out the parked idle cadence. A visible window
  // also re-arms the quit latch: if the user can see the dashboard, whatever
  // exit was in flight was cancelled — at any stage of the quit pipeline.
  const wakePoller = (): void => void poller?.wake();
  const backFromHiding = (): void => {
    trayController.cancelQuitting();
    wakePoller();
  };
  mainWindow.on("focus", backFromHiding);
  mainWindow.on("show", backFromHiding);
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
      // The tray preference is the one preference that can fail to take
      // effect (no usable icon, or the platform refused a tray). Saying
      // "saved" while close actually quits would strand the user believing
      // the app watches in the background — surface it.
      if (saved.closeToTray && !trayController.hidesToTray()) {
        return {
          ok: true,
          warning:
            "Close to tray couldn't be enabled — no tray icon could be created on this system, so the close button will quit the app.",
        };
      }
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
      // A tray-hidden window can stay hidden for days; pushing snapshots at
      // it pays a full-payload IPC clone plus an offscreen re-render for
      // nothing. The renderer reloads on show (its visibilitychange/focus wake
      // calls getDashboard) and the show handler wakes the poller, so a gated
      // push loses nothing.
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        sendToRenderer("snapshot", snapshot);
      }
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

  // The application menu owns the keyboard shortcuts (Settings on CmdOrCtrl+,
  // Refresh on CmdOrCtrl+R). Both actions belong to the renderer — it owns the
  // view and the loading state — so the menu only forwards them over IPC.
  // Installed after the window so the forwarded events have somewhere to land.
  installAppMenu(
    {
      openSettings: () => {
        focusMainWindow();
        sendToRenderer("menu:open-settings", undefined);
      },
      refresh: () => sendToRenderer("menu:refresh", undefined),
    },
    { devItems: !app.isPackaged },
  );

  initAutoUpdater((status) => sendToRenderer("update-status", status));

  // Apply the remaining prefs (launch-at-login + auto-update; theme re-applied
  // harmlessly). Runs after the updater is initialized.
  applyPreferences(prefs);

  app.on("activate", () => {
    // A window may exist but be hidden in the tray — reactivating (dock click,
    // relaunch) has to bring that one back, not leave the user staring at
    // nothing because `getAllWindows()` was non-empty.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      focusMainWindow();
    }
  });
}

// Enforce single instance: if another copy already holds the OS lock, quit this
// one; otherwise register the second-instance refocus and proceed with startup.
// Without this guard the OS login-item and any accidental double-launch each
// spin up their own window. The decision logic is unit-tested in
// single-instance.ts, and this wiring is covered by a fake-electron test that
// requires the COMPILED dist/main/main/main.js (see the "main.js wiring" tests in
// tests/run-tests.cjs). The deps stay injectable callbacks because importing this
// module runs the real lock request at import time — so tests drive the compiled
// output with electron mocked rather than importing the TS source directly.
const isPrimaryInstance = acquireSingleInstanceLock({
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  onSecondInstance: (handler) => {
    app.on("second-instance", handler);
  },
  getMainWindow: () => mainWindow,
  focusMainWindow,
  whenWindowReady: windowGate.whenWindowReady,
});

// All startup and window lifecycle stays inside the primary-instance branch: a
// non-primary instance has already been told to quit and must never register
// `ready` or `window-all-closed` handlers. Gating on the boolean makes that
// exclusion structural, independent of Electron's internal ready/quit timing.
if (isPrimaryInstance) {
  void app.whenReady().then(startApp);

  // Closing the last window quits — unless close-to-tray is on, in which case
  // the window is hidden rather than closed and this never fires (see the
  // `close` handler in createWindow).
  app.on("window-all-closed", () => {
    poller?.stop();
    app.quit();
  });

  // A normal exit (tray menu Quit, Cmd+Q, app.quit()) passes through here,
  // which releases the close handler's hold on the window. Two real exits do
  // NOT: the updater's quitAndInstall on macOS closes windows BEFORE emitting
  // before-quit (latched below via before-quit-for-update), and Windows
  // shutdown/logout never emits before-quit at all (latched via the window's
  // session-end in createWindow). If a quit is cancelled at any stage, the
  // latch is re-armed when the window is next shown — a state-based reset
  // instead of second-guessing the quit pipeline's event timing.
  app.on("before-quit", () => trayController.markQuitting());

  // electron-updater's quitAndInstall: emitted on Electron's native
  // autoUpdater by Squirrel.Mac (which closes all windows first and only
  // emits before-quit after they are gone — the close would be intercepted
  // and the update would never install) and, for symmetry, by
  // electron-updater's Windows path right before its app.quit().
  nativeAutoUpdater.on("before-quit-for-update", () => trayController.markQuitting());
}
