import fs from "node:fs";
import path from "node:path";
import { app, screen } from "electron";

import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  parseWindowState,
  sanitizeWindowBounds,
  type SavedWindowState,
  type WindowBounds,
} from "../shared/window-bounds";

/**
 * Where the window's size/position lives. Deliberately its own file, not part
 * of `settings.json`: `loadSettings()` throws `ConfigError` on an unexpected
 * shape and the poller surfaces that to the user, so a stray geometry value
 * must not be able to make the app look unconfigured. Same fail-soft contract
 * as seen-state / ignored-state — unreadable means "first run".
 */
function windowStatePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

/** Reads the persisted geometry, or null when there is none / it is unusable. */
export function loadWindowState(): SavedWindowState | null {
  try {
    return parseWindowState(JSON.parse(fs.readFileSync(windowStatePath(), "utf8")));
  } catch {
    return null;
  }
}

/**
 * The `BrowserWindow` constructor options for the saved geometry: restored
 * bounds when they still land on a display present now, otherwise the default
 * size with no position (Electron centers it).
 */
export function windowOptionsFrom(saved: SavedWindowState | null): Partial<WindowBounds> {
  const bounds = sanitizeWindowBounds(saved?.bounds ?? null, screen.getAllDisplays());
  if (!bounds) return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
  return bounds;
}

/** The part of a window this module reads. */
export interface GeometrySource {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  getNormalBounds(): WindowBounds;
}

/**
 * Snapshots the window and writes it. `getNormalBounds()` rather than
 * `getBounds()`, so a maximized or full-screen window still records the size to
 * come back to; a minimized window is skipped because its bounds are not
 * meaningful on every platform.
 */
export function saveWindowState(window: GeometrySource | null): void {
  if (!window || window.isDestroyed() || window.isMinimized()) return;
  const state: SavedWindowState = {
    bounds: window.getNormalBounds(),
    isMaximized: window.isMaximized(),
    isFullScreen: window.isFullScreen(),
  };
  try {
    const file = windowStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Geometry is a convenience; never let a failed write break the app.
  }
}

/**
 * Wraps `saveWindowState` in a short debounce, because `move`/`resize` fire per
 * frame while a window is being dragged.
 */
export function createWindowStateSaver(
  getWindow: () => GeometrySource | null,
  delayMs = 400,
): { schedule(): void; flush(): void } {
  let timer: NodeJS.Timeout | null = null;
  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    schedule(): void {
      clear();
      timer = setTimeout(() => {
        timer = null;
        saveWindowState(getWindow());
      }, delayMs);
      timer.unref?.();
    },
    /** Writes immediately — used on `close`, where the timer would never fire. */
    flush(): void {
      clear();
      saveWindowState(getWindow());
    },
  };
}
