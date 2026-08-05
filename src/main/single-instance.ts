import type { BrowserWindow } from "electron";

/**
 * The wiring the single-instance lock needs from Electron's `app`, expressed as
 * plain callbacks so the branch logic can be unit-tested without booting
 * Electron. `main.ts` runs the real lock request at import time, so it can't be
 * `require`d from a test — this module carries the decisions instead.
 */
export interface SingleInstanceDeps {
  /** `app.requestSingleInstanceLock()` — false when another instance holds it. */
  requestSingleInstanceLock: () => boolean;
  /** `app.quit()` — tear down this (non-primary) instance. */
  quit: () => void;
  /** `app.on("second-instance", handler)` registration. */
  onSecondInstance: (handler: () => void) => void;
  /** The current main window, or null before it exists / after it closes. */
  getMainWindow: () => BrowserWindow | null;
  /** Raise the existing window to the foreground (already null-safe). */
  focusMainWindow: () => void;
  /** `app.whenReady()` — resolves once the app is ready. */
  whenReady: () => Promise<unknown>;
}

/**
 * Surface the already-running instance's window when a second launch arrives.
 *
 * `second-instance` normally fires after the app is ready and `createWindow()`
 * has run, so `win` is set and we focus synchronously. When `win` is null — the
 * brief startup gap, or after the window closed during teardown — defer the
 * focus to `whenReady` so the raise-to-front intent isn't silently dropped.
 */
export function handleSecondInstance(
  win: BrowserWindow | null,
  focusMainWindow: () => void,
  whenReady: () => Promise<unknown>,
): void {
  if (win) {
    focusMainWindow();
  } else {
    void whenReady().then(() => focusMainWindow());
  }
}

/**
 * Acquire the OS single-instance lock. Returns true when this is the primary
 * instance and startup should proceed; false when another instance already
 * holds the lock — in which case this instance has been told to quit and the
 * caller must NOT register any startup or window-lifecycle handlers.
 */
export function acquireSingleInstanceLock(deps: SingleInstanceDeps): boolean {
  if (!deps.requestSingleInstanceLock()) {
    deps.quit();
    return false;
  }
  deps.onSecondInstance(() =>
    handleSecondInstance(deps.getMainWindow(), deps.focusMainWindow, deps.whenReady),
  );
  return true;
}
