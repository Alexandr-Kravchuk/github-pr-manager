import { app, Menu } from "electron";

/** What the menu drives in the app around it, injected by `main.ts`. */
export interface AppMenuDeps {
  /** Show the settings screen (the platform's "Preferences" gesture). */
  openSettings(): void;
  /** Force an immediate poll — the same action as the header's Refresh button. */
  refresh(): void;
}

/** What `createMenuActions` needs from the app to build those two actions. */
export interface MenuActionDeps {
  /** Bring the dashboard window back to the foreground (from hidden/minimized). */
  focusWindow(): void;
  /** Push an event to the renderer over the preload bridge. */
  send(channel: string): void;
}

/**
 * The two menu actions, as one testable unit.
 *
 * Both surface the window first. Close-to-tray makes hidden-but-alive the app's
 * normal idle state, and on macOS the app can be frontmost with no window on
 * screen — so a shortcut that only pushed an event to a hidden renderer would
 * look dead while still spending a GraphQL request. Refresh therefore shows the
 * window exactly like Settings does: the point of pressing it is to see the
 * result.
 */
export function createMenuActions(deps: MenuActionDeps): AppMenuDeps {
  return {
    openSettings: () => {
      deps.focusWindow();
      deps.send("menu:open-settings");
    },
    refresh: () => {
      deps.focusWindow();
      deps.send("menu:refresh");
    },
  };
}

/** Extra knobs the template needs but that are not app actions. */
export interface AppMenuOptions {
  /** darwin / win32 / linux — decides where Settings and Quit live. */
  platform?: NodeJS.Platform;
  /**
   * Adds the reload / DevTools items. Replacing Electron's default menu also
   * removes its developer shortcuts, so they are put back for an unpackaged
   * run instead of being lost.
   */
  devItems?: boolean;
}

/**
 * The application menu template.
 *
 * The menu is where the keyboard shortcuts live: a menu accelerator fires
 * regardless of which element has focus and, unlike a renderer `keydown`
 * handler, it also shows the user what the shortcut is. `CmdOrCtrl` resolves to
 * Command on macOS and Control elsewhere, so one template serves both.
 *
 * Everything beyond our two items is role-based on purpose. `setApplicationMenu`
 * **replaces** Electron's default menu, and on macOS that default is what makes
 * Cmd+C / Cmd+V / Cmd+A work inside text fields (the search box, the Jira token
 * field) as well as Cmd+Q / Cmd+H / Cmd+W — a hand-rolled two-item menu would
 * silently take all of that away.
 *
 * F5 is deliberately **not** here: a menu item carries exactly one accelerator,
 * and a hidden duplicate item's accelerator is not reliable across platforms.
 * The renderer handles F5 in a `keydown` listener instead (see `App.tsx`).
 */
export function buildAppMenuTemplate(
  deps: AppMenuDeps,
  options: AppMenuOptions = {},
): Electron.MenuItemConstructorOptions[] {
  const platform = options.platform ?? process.platform;
  const isMac = platform === "darwin";

  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: isMac ? "Settings…" : "Settings",
    accelerator: "CmdOrCtrl+,",
    click: () => deps.openSettings(),
  };

  const refreshItem: Electron.MenuItemConstructorOptions = {
    label: "Refresh",
    // F5 does the same thing, handled in the renderer.
    accelerator: "CmdOrCtrl+R",
    click: () => deps.refresh(),
  };

  // `reload` would claim CmdOrCtrl+R and shadow Refresh, so only the explicit
  // force-reload is offered next to the DevTools toggle.
  const devItems: Electron.MenuItemConstructorOptions[] = options.devItems
    ? [{ type: "separator" }, { role: "forceReload" }, { role: "toggleDevTools" }]
    : [];

  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      refreshItem,
      ...devItems,
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  if (isMac) {
    return [
      {
        // macOS puts Preferences in the application menu, right under About.
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          settingsItem,
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      viewMenu,
      {
        // Spelled out rather than `role: "windowMenu"`, which on macOS omits
        // Close: Electron's default menu keeps Cmd+W in the File menu, and this
        // app has no File menu on macOS. Without the item Cmd+W would silently
        // stop working — and with close-to-tray on, Cmd+W is how the window is
        // put away.
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { role: "close" },
          { type: "separator" },
          { role: "front" },
        ],
      },
    ];
  }

  return [
    {
      // Windows/Linux keep Settings in File, next to Quit.
      label: "File",
      submenu: [settingsItem, { type: "separator" }, { role: "quit" }],
    },
    { role: "editMenu" },
    viewMenu,
    { role: "windowMenu" },
  ];
}

/** Builds and installs the application menu. */
export function installAppMenu(deps: AppMenuDeps, options: AppMenuOptions = {}): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(deps, options)));
}
