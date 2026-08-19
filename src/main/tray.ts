import path from "node:path";
import { app, Menu, nativeImage, Tray } from "electron";

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

/** What the controller drives in the app around it, injected by `main.ts`. */
export interface TrayControllerDeps {
  /** Bring the dashboard window back to the foreground. */
  open(): void;
  /** Tear the app down for real (the only exit once close hides to tray). */
  quit(): void;
  /** Hide the dashboard window — the close-to-tray action itself. */
  hide(): void;
}

/** The part of a window `close` event this module touches. */
export interface CloseEvent {
  preventDefault(): void;
}

/**
 * Owns the tray icon *and* the close/quit state that depends on it, so the two
 * cannot drift apart: whether close hides is exactly "the preference is on AND
 * an icon really exists", which is only knowable here.
 */
export interface TrayController {
  /**
   * Applies the `closeToTray` preference: creates the icon, or removes it.
   * Returns whether close now hides — false when no icon could be created, in
   * which case close keeps quitting rather than hiding the window with nothing
   * left to restore it.
   */
  setEnabled(enabled: boolean): boolean;
  /** Whether a `close` currently hides the window instead of destroying it. */
  hidesToTray(): boolean;
  /** The app is on its way out (`before-quit`): stop intercepting close. */
  markQuitting(): void;
  /** The quit was cancelled after all — resume intercepting close. */
  cancelQuitting(): void;
  /** The window's `close` handler: hides to the tray, or lets the close through. */
  handleClose(event: CloseEvent): void;
}

/**
 * Creates the tray controller. Nothing touches Electron until a method is
 * called, so this is safe at module scope; the state is per-controller, so
 * tests can build as many as they need.
 */
export function createTrayController(deps: TrayControllerDeps): TrayController {
  let tray: Tray | null = null;
  /** Mirrors the preference, but only ever true while an icon really exists. */
  let hidesToTray = false;
  /**
   * True once the app is genuinely on its way out, so the close handler lets the
   * window go instead of hiding it again. Without this a tray-mode app could
   * never be quit: every teardown path closes the window first.
   */
  let quitting = false;

  /** Creates the icon if it isn't there yet. False when none could be made. */
  const ensureTray = (): boolean => {
    if (tray && !tray.isDestroyed()) return true;

    const icon = trayIcon();
    if (!icon) {
      console.error("[tray] no usable icon");
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
        { label: "Open PR Dashboard", click: () => deps.open() },
        { type: "separator" },
        { label: "Quit PR Dashboard", click: () => deps.quit() },
      ]),
    );
    // Windows/Linux: a plain click should restore the window (the context menu is
    // the right-click gesture there). On macOS a click opens the menu instead and
    // this never fires.
    tray.on("click", () => deps.open());
    tray.on("double-click", () => deps.open());
    return true;
  };

  const destroyTray = (): void => {
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  };

  return {
    setEnabled(enabled: boolean): boolean {
      if (enabled) {
        hidesToTray = ensureTray();
        if (!hidesToTray) {
          // Never diverge from the saved preference in silence: the user asked
          // for hide-on-close and is getting quit-on-close instead.
          console.error(
            "[tray] close-to-tray is enabled but no tray icon could be created — the close button will keep quitting",
          );
        }
      } else {
        destroyTray();
        hidesToTray = false;
      }
      if (process.env.PRD_DEBUG) {
        console.log("[tray] closeToTray", enabled, "-> hides to tray", hidesToTray);
      }
      return hidesToTray;
    },

    hidesToTray: () => hidesToTray,

    markQuitting(): void {
      quitting = true;
    },

    cancelQuitting(): void {
      quitting = false;
    },

    handleClose(event: CloseEvent): void {
      if (quitting || !hidesToTray) return; // let the window close for real
      event.preventDefault();
      deps.hide();
    },
  };
}
