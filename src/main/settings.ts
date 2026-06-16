import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

import { ConfigError, defaultSettings, validateSettings } from "../shared/config";
import type { Settings } from "../shared/types";

/** Path of the persisted settings file under the OS userData directory. */
function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/** Path of the "seen" state store (new-comment baseline) under userData. */
export function seenStatePath(): string {
  return path.join(app.getPath("userData"), "seen-state.json");
}

/**
 * Reads and validates settings. A missing file is the first-run state and
 * yields empty (unconfigured) settings — not an error. A present-but-invalid
 * file throws ConfigError so the poller/UI can surface the problem.
 */
export function loadSettings(): Settings {
  let text: string;
  try {
    text = fs.readFileSync(settingsPath(), "utf8");
  } catch {
    return defaultSettings();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`settings.json: JSON parse error — ${(e as Error).message}`);
  }
  return validateSettings(parsed);
}

/** Validates and writes settings. Throws ConfigError on an invalid shape. */
export function persistSettings(raw: unknown): Settings {
  const settings = validateSettings(raw);
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), "utf8");
  return settings;
}
