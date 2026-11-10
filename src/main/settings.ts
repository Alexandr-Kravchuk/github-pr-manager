import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

import { ConfigError, defaultSettings, toStoredSettings, validateSettings } from "../shared/config";
import type { Settings } from "../shared/types";
import { parseWhatsNewRecord, type WhatsNewRecord } from "../shared/whats-new";

/** Path of the persisted settings file under the OS userData directory. */
function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/** Path of the "seen" state store (new-comment baseline) under userData. */
export function seenStatePath(): string {
  return path.join(app.getPath("userData"), "seen-state.json");
}

/** Path of the "ignored" state store (hidden PRs) under userData. */
export function ignoredStatePath(): string {
  return path.join(app.getPath("userData"), "ignored-state.json");
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

/** Path of the "whats-new" state (last acknowledged version) under userData. */
export function whatsNewPath(): string {
  return path.join(app.getPath("userData"), "whats-new.json");
}

/** The stored "What's new" record (see shared/whats-new.ts), or null. */
export function loadWhatsNewRecord(): WhatsNewRecord | null {
  try {
    return parseWhatsNewRecord(JSON.parse(fs.readFileSync(whatsNewPath(), "utf8")));
  } catch {
    return null;
  }
}

export function saveWhatsNewRecord(record: WhatsNewRecord): void {
  const file = whatsNewPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record), "utf8");
}

/** Persists the current version as acknowledged (hides "What's new"). */
export function acknowledgeVersion(version: string): void {
  saveWhatsNewRecord({ acknowledgedVersion: version });
}

/** Validates and writes settings. Throws ConfigError on an invalid shape. */
export function persistSettings(raw: unknown): Settings {
  const settings = validateSettings(raw);
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(toStoredSettings(settings), null, 2), "utf8");
  return settings;
}
