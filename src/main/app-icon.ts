import path from "node:path";
import { app, nativeImage } from "electron";

/**
 * Loads the app icon (`build/icon.png`, bundled via electron-builder's
 * `build.files`). The single source for every surface that needs it — the
 * window icon and the tray — so the path can never drift between them.
 * Returns null when the file is missing or unreadable.
 */
export function loadAppIcon(): Electron.NativeImage | null {
  const image = nativeImage.createFromPath(path.join(app.getAppPath(), "build", "icon.png"));
  return image.isEmpty() ? null : image;
}
