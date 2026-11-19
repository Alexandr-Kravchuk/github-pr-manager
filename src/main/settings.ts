import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

import { ConfigError, defaultSettings, keepUnknownSettings, toStoredSettings, validateSettings } from "../shared/config";
import type { Settings } from "../shared/types";
import { parseWhatsNewRecord, type WhatsNewRecord } from "../shared/whats-new";
import { diag } from "./diag-log";

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

/** Read errors a virus scan or an installer's file work holds for a moment. */
const TRANSIENT_READ_ERRORS = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);
const READ_RETRIES = 3;
const READ_RETRY_MS = 100;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The settings file's text, or null when there is none (the first run). Any
 * other failure throws ConfigError after a few short retries — it used to read
 * as "no file", so an app that couldn't read its settings came up looking
 * unconfigured, and a Save from there would have written the defaults over
 * them. Exported for tests.
 */
export function readSettingsText(file: string = settingsPath()): string | null {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        // A first run has no other state either; one that has means the file
        // went missing, which is worth knowing when settings "reset".
        if (fs.existsSync(path.join(path.dirname(file), "seen-state.json"))) {
          diag(`settings: ${file} is missing although the folder holds app state — starting unconfigured`);
        }
        return null;
      }
      if (attempt < READ_RETRIES && err.code && TRANSIENT_READ_ERRORS.has(err.code)) {
        pause(READ_RETRY_MS);
        continue;
      }
      diag(`settings: cannot read ${file}: ${err.code ?? ""} ${err.message}`);
      throw new ConfigError(
        `settings.json could not be read (${err.code ?? err.message}). Your settings were not changed — restart PR Dashboard; main.log in its data folder has the details.`,
      );
    }
  }
}

/**
 * Reads and validates settings. A missing file is the first-run state and
 * yields empty (unconfigured) settings — not an error. A present-but-invalid
 * or unreadable file throws ConfigError so the poller/UI can surface the problem.
 */
export function loadSettings(): Settings {
  const text = readSettingsText();
  if (text === null) return defaultSettings();
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

/**
 * Validates and writes settings, keeping the fields of the file on disk that
 * this build does not know (`keepUnknownSettings`). Throws ConfigError on an
 * invalid shape, and when the file on disk can't be read: never write over
 * settings that couldn't be looked at. The write goes to a temporary file
 * renamed over the old one, so a process ended mid-write (an installer's
 * taskkill) leaves the previous settings, not half a file.
 */
export function persistSettings(raw: unknown): Settings {
  const settings = validateSettings(raw);
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stored = keepUnknownSettings(parseOrUndefined(readSettingsText(file)), toStoredSettings(settings));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return settings;
}

/** JSON or nothing: a corrupt file is one a Save may replace. */
function parseOrUndefined(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
