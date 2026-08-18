import path from "node:path";
import { app, Menu, nativeImage, Tray } from "electron";

/**
 * The tray (Windows notification area / macOS menu bar / Linux status area)
 * icon. It exists only while the "close to tray" preference is on: with the
 * preference off the app stays a plain window app and an idle icon in the tray
 * would be dead weight.
 */
let tray: Tray | null = null;

/** Callbacks the tray's menu and clicks drive, injected by `main.ts`. */
export interface TrayHandlers {
  /** Bring the dashboard window back to the foreground. */
  open(): void;
  /** Tear the app down for real (the only exit once close hides to tray). */
  quit(): void;
}

/**
 * The app icon scaled for the tray. Windows/Linux want 16pt, the macOS menu bar
 * 18pt; passing the full 512px source makes some platforms render it clipped.
 * Not a template image on macOS on purpose — the icon is a colored logo, and a
 * template would flatten it to a black silhouette.
 */
function trayIcon(): Electron.NativeImage | null {
  const image = nativeImage.createFromPath(path.join(app.getAppPath(), "build", "icon.png"));
  if (image.isEmpty()) return null;
  const size = process.platform === "darwin" ? 18 : 16;
  return image.resize({ width: size, height: size });
}

/**
 * Creates the tray icon if it isn't there yet (idempotent).
 *
 * Returns **false** when no tray could be created — a missing/unreadable icon
 * file, or a platform that refuses the tray. The caller must then leave the
 * close button quitting the app: hiding the window with no tray icon to restore
 * it would strand the user with a running, invisible process.
 */
export function ensureTray(handlers: TrayHandlers): boolean {
  if (tray && !tray.isDestroyed()) return true;

  const icon = trayIcon();
  if (!icon) {
    console.error("[tray] no usable icon — close-to-tray stays off");
    return false;
  }

  try {
    tray = new Tray(icon);
  } catch (e) {
    console.error("[tray] could not create the tray icon:", (e as Error).message);
    tray = null;
    return false;
  }

  tray.setToolTip("PR Dashboard");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open PR Dashboard", click: () => handlers.open() },
      { type: "separator" },
      { label: "Quit PR Dashboard", click: () => handlers.quit() },
    ]),
  );
  // Windows/Linux: a plain click should restore the window (the context menu is
  // the right-click gesture there). On macOS a click opens the menu instead and
  // this never fires.
  tray.on("click", () => handlers.open());
  tray.on("double-click", () => handlers.open());
  return true;
}

/** Removes the tray icon, if any. Safe to call when there is none. */
export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

/** Whether a tray icon is currently installed (for tests / diagnostics). */
export function hasTray(): boolean {
  return Boolean(tray && !tray.isDestroyed());
}
