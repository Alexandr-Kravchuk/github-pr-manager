/**
 * Launch-at-login, and recognizing that the current process IS that launch so
 * it can start in the tray (macOS) instead of opening a window on every sign-in.
 *
 * Kept free of `electron` imports so both decisions are unit-testable; main.ts
 * passes in the platform, argv and the login-item state it reads from `app`.
 */

/** Passed by the Windows login item of older builds, so the launched process
 *  knew it was not opened by the user. Still recognized; no longer written. */
export const HIDDEN_LAUNCH_ARG = "--hidden";

export interface LoginItemOptions {
  openAtLogin: boolean;
  openAsHidden?: boolean;
  args?: string[];
  /** Windows only: the Run-key value name; defaults to the AppUserModelID. */
  name?: string;
}

/**
 * The options for `app.setLoginItemSettings`. On Windows the login item is a
 * plain Run-key command line with no marker: Windows 11 puts a new tray icon
 * in the overflow behind `^`, so an app that came up in the tray at sign-in
 * looked as if it had not started at all — the window opens instead (see
 * `startsInTray`). The value is keyed by the AppUserModelID, so re-applying
 * this on every start also rewrites an entry an older build registered with
 * `--hidden`. macOS login items carry no arguments — `openAsHidden` is the
 * legacy (pre-13) equivalent and is ignored by newer releases, which is why the
 * macOS side is best-effort.
 */
export function loginItemSettingsFor(enabled: boolean, platform: NodeJS.Platform): LoginItemOptions {
  if (platform === "win32") return { openAtLogin: enabled };
  if (platform === "darwin") return { openAtLogin: enabled, openAsHidden: true };
  return { openAtLogin: enabled };
}

/**
 * Whether a launch comes up in the tray without a window: a login launch with
 * close-to-tray on, and never on Windows — the menu bar icon is always in
 * sight on macOS, while Windows 11 hides a tray icon behind `^`. An old Run
 * entry's `--hidden` is ignored there for the same reason.
 */
export function startsInTray(platform: NodeJS.Platform, launchedAtLogin: boolean, closeToTray: boolean): boolean {
  return platform !== "win32" && launchedAtLogin && closeToTray;
}

/**
 * The Run-key value a build without `setAppUserModelId` registered: Electron
 * falls back to `electron.app.<productName>` as the AppUserModelID and names the
 * value after it. Registering under the real ID leaves that value behind, so the
 * app starts twice at sign-in — once without the hidden-launch marker.
 */
export const LEGACY_WINDOWS_LOGIN_ITEM_NAME = "electron.app.PR Dashboard";

/**
 * Login items left by older builds that must be removed, whatever the current
 * preference is — an orphan keeps launching the app after the user turns the
 * setting off. Windows deletes a Run value by `name` alone.
 */
export function staleLoginItemsFor(platform: NodeJS.Platform): LoginItemOptions[] {
  if (platform !== "win32") return [];
  return [{ openAtLogin: false, name: LEGACY_WINDOWS_LOGIN_ITEM_NAME }];
}

/** Whether this process was started by the OS login item rather than the user. */
export function wasLaunchedAtLogin(argv: readonly string[], wasOpenedAtLogin: boolean | undefined): boolean {
  return argv.includes(HIDDEN_LAUNCH_ARG) || wasOpenedAtLogin === true;
}
