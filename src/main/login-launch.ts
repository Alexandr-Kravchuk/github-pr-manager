/**
 * Launch-at-login, and recognizing that the current process IS that launch so
 * it can start in the tray instead of opening a window on every sign-in.
 *
 * Kept free of `electron` imports so both decisions are unit-testable; main.ts
 * passes in the platform, argv and the login-item state it reads from `app`.
 */

/** Passed by the Windows login item so the launched process knows it was not
 *  opened by the user. */
export const HIDDEN_LAUNCH_ARG = "--hidden";

export interface LoginItemOptions {
  openAtLogin: boolean;
  openAsHidden?: boolean;
  args?: string[];
}

/**
 * The options for `app.setLoginItemSettings`. On Windows the login item is a
 * Run-key command line, so the marker travels as an argument; the value is
 * keyed by the AppUserModelID, so re-applying this on every start also upgrades
 * an entry registered by an older build without the argument. macOS login items
 * carry no arguments — `openAsHidden` is the legacy (pre-13) equivalent and is
 * ignored by newer releases, which is why the macOS side is best-effort.
 */
export function loginItemSettingsFor(enabled: boolean, platform: NodeJS.Platform): LoginItemOptions {
  if (platform === "win32") return { openAtLogin: enabled, args: [HIDDEN_LAUNCH_ARG] };
  if (platform === "darwin") return { openAtLogin: enabled, openAsHidden: true };
  return { openAtLogin: enabled };
}

/** Whether this process was started by the OS login item rather than the user. */
export function wasLaunchedAtLogin(argv: readonly string[], wasOpenedAtLogin: boolean | undefined): boolean {
  return argv.includes(HIDDEN_LAUNCH_ARG) || wasOpenedAtLogin === true;
}
