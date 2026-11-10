import { Menu, Tray } from "electron";

import { loadAppIcon } from "./app-icon";

/**
 * The app icon scaled for the tray. Windows/Linux want 16pt, the macOS menu bar
 * 18pt; passing the full 512px source makes some platforms render it clipped.
 * Not a template image on macOS on purpose — the icon is a colored logo, and a
 * template would flatten it to a black silhouette.
 */
function trayIcon(): Electron.NativeImage | null {
  const image = loadAppIcon();
  if (!image) return null;
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
  /** Bring the window back with the PR agent in view ("Show agent"). */
  showAgent?(): void;
  /** Pause the whole agent, or resume it ("Pause agent" / "Resume agent"). */
  toggleAgentPause?(): void;
}

/** The PR agent as the tray shows it: its one line (`agentTrayLine`) and whether it is paused. */
export interface TrayAgentStatus {
  line: string;
  paused: boolean;
}

/** Windows cuts a tray tooltip at 127 characters. */
const TOOLTIP_MAX = 127;

/** The tooltip: the app's name, and the agent's line under it while there is one. */
export function trayTooltip(agent: TrayAgentStatus | null): string {
  const text = agent ? `PR Dashboard\nAgent: ${agent.line}` : "PR Dashboard";
  return text.length > TOOLTIP_MAX ? `${text.slice(0, TOOLTIP_MAX - 1)}…` : text;
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
  /**
   * The app is on its way out: stop intercepting close. Latched from every
   * exit signal the platform gives us — `before-quit`, the updater's
   * `before-quit-for-update`, and the window's `session-end` (Windows
   * shutdown/logout, where Electron never emits `before-quit`).
   */
  markQuitting(): void;
  /**
   * Re-arm the latch. Called from the window's `show`/`focus`: a window the
   * user can see means whatever exit was in flight did not happen, whichever
   * stage cancelled it (`before-quit`, `will-quit`, a `beforeunload` veto) —
   * a state-based reset instead of guessing at the quit pipeline's timing.
   */
  cancelQuitting(): void;
  /** The window's `close` handler: hides to the tray, or lets the close through. */
  handleClose(event: CloseEvent): void;
  /**
   * The PR agent's state for the tooltip and the menu (its line, Show agent,
   * Pause/Resume agent); null while the agent is off or Settings › Agent says
   * not to show it in the tray. Kept while there is no icon, for the next one.
   */
  setAgent(status: TrayAgentStatus | null): void;
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
  let agent: TrayAgentStatus | null = null;

  /** The tooltip and the menu, for the agent's current state. */
  const render = (): void => {
    if (!tray || tray.isDestroyed()) return;
    tray.setToolTip(trayTooltip(agent));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open PR Dashboard", click: () => deps.open() },
        ...(agent
          ? ([
              { type: "separator" },
              // A label, not an action: what the agent is doing right now.
              { label: `Agent: ${agent.line}`, enabled: false },
              { label: "Show agent", click: () => deps.showAgent?.() },
              { label: agent.paused ? "Resume agent" : "Pause agent", click: () => deps.toggleAgentPause?.() },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
        { type: "separator" },
        { label: "Quit PR Dashboard", click: () => deps.quit() },
      ]),
    );
  };

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

    render();
    // Windows/Linux only: a plain click should restore the window (the context
    // menu is the right-click gesture there). On macOS a left click opens the
    // context menu *and* still emits `click`, so registering these would reopen
    // the dashboard on any click on the menu bar icon — without the user ever
    // choosing "Open PR Dashboard". There the menu is the only way in.
    if (process.platform !== "darwin") {
      tray.on("click", () => deps.open());
      tray.on("double-click", () => deps.open());
    }
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

    setAgent(status: TrayAgentStatus | null): void {
      // A run reports a step per tool call; the menu is rebuilt only when what it shows changed.
      if (status?.line === agent?.line && status?.paused === agent?.paused) return;
      agent = status ? { ...status } : null;
      render();
    },
  };
}
