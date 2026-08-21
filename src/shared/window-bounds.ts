/**
 * Window geometry rules, kept pure so every case can be unit-tested without an
 * Electron window or a real display: parsing what was written to disk, and
 * deciding whether saved bounds are still usable on the displays present now.
 *
 * The display list is passed in rather than read from `screen` here —
 * `screen.getAllDisplays()` is only valid after `app.whenReady()`, and taking
 * it as an argument is what makes the off-screen cases testable.
 */

/** A rectangle in screen coordinates. */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What is persisted between runs. */
export interface SavedWindowState {
  /** Normal (un-maximized) bounds. Absent when they could not be read. */
  bounds: WindowBounds | null;
  isMaximized: boolean;
  isFullScreen: boolean;
}

/** The part of an Electron `Display` this module needs (its `workArea`). */
export interface DisplayArea {
  workArea: WindowBounds;
}

/** Floor for a restored size — mirrors the window's `minWidth`/`minHeight`. */
export const MIN_WINDOW_WIDTH = 960;
export const MIN_WINDOW_HEIGHT = 640;

/** Size used on first run, and whenever saved bounds are unusable. */
export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 860;

/**
 * How much of the window must land on a display for the position to be kept.
 * Enough that the title bar is grabbable — a window overlapping by a few pixels
 * is as unreachable as one fully off-screen.
 */
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 60;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readBounds(raw: unknown): WindowBounds | null {
  if (!raw || typeof raw !== "object") return null;
  const { x, y, width, height } = raw as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * Parses the persisted file. Anything unrecognized yields null (first run /
 * corrupt store) — window geometry is never worth failing a launch over.
 */
export function parseWindowState(raw: unknown): SavedWindowState | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const bounds = readBounds(record.bounds);
  const isMaximized = record.isMaximized === true;
  const isFullScreen = record.isFullScreen === true;
  if (!bounds && !isMaximized && !isFullScreen) return null;
  return { bounds, isMaximized, isFullScreen };
}

/** Area shared by two rectangles, per axis. */
function overlap(a: WindowBounds, b: WindowBounds): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Returns bounds safe to restore on the displays present now, or null when the
 * saved position cannot be used (the monitor it lived on is gone, the window
 * sits past the edge of every screen, the store held garbage). Size is clamped
 * to the window's minimum and to the display it lands on, and the position is
 * pulled back inside that display's work area when it overflows.
 */
export function sanitizeWindowBounds(
  saved: WindowBounds | null,
  displays: readonly DisplayArea[],
): WindowBounds | null {
  if (!saved || displays.length === 0) return null;

  let best: DisplayArea | null = null;
  let bestArea = 0;
  for (const display of displays) {
    const work = readBounds(display.workArea);
    if (!work) continue;
    const shared = overlap(saved, work);
    if (shared.width < MIN_VISIBLE_WIDTH || shared.height < MIN_VISIBLE_HEIGHT) continue;
    const area = shared.width * shared.height;
    if (area > bestArea) {
      best = { workArea: work };
      bestArea = area;
    }
  }
  if (!best) return null;

  const work = best.workArea;
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(saved.width, Math.max(work.width, MIN_WINDOW_WIDTH)));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(saved.height, Math.max(work.height, MIN_WINDOW_HEIGHT)));
  // Keep the window inside the work area when it now overflows; a display
  // smaller than the minimum window size still gets the top-left corner
  // aligned, which keeps the title bar reachable.
  const x = Math.round(Math.min(Math.max(saved.x, work.x), Math.max(work.x, work.x + work.width - width)));
  const y = Math.round(Math.min(Math.max(saved.y, work.y), Math.max(work.y, work.y + work.height - height)));
  return { x, y, width, height };
}
