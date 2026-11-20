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

/** File errors a virus scan or an installer's file work holds for a moment. */
const TRANSIENT_FILE_ERRORS = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);
const FILE_RETRIES = 3;
const FILE_RETRY_MS = 100;
/**
 * How long a failed read is answered from memory. The retries sleep on the
 * main thread, and `loadSettings` runs on every poll tick and several IPC
 * calls: a file that stays unreadable must not freeze the app on each of them.
 */
const READ_FAILURE_MEMO_MS = 5000;

let lastReadFailure: { file: string; code: string; at: number } | null = null;
// Each failure is logged once until a read succeeds: the poller reads the
// settings every tick, and repeats would rotate the start lines out of main.log.
let missingLogged = false;
let loggedFailure: string | null = null;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `op`, trying again a few times while it fails with a transient file error. */
function withFileRetries<T>(op: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt < FILE_RETRIES && code && TRANSIENT_FILE_ERRORS.has(code)) {
        pause(FILE_RETRY_MS);
        continue;
      }
      throw e;
    }
  }
}

function unreadableError(code: string): ConfigError {
  return new ConfigError(
    `settings.json could not be read (${code}). Your settings were not changed — restart PR Dashboard; main.log in its data folder has the details.`,
  );
}

/**
 * The settings file's text, or null when there is none (the first run). Any
 * other failure throws ConfigError after a few short retries — it used to read
 * as "no file", so an app that couldn't read its settings came up looking
 * unconfigured, and a Save from there would have written the defaults over
 * them. A transient error that outlasted the retries is remembered for a few
 * seconds, and the calls in that time throw at once, without retries; `fresh`
 * (a Save's read-before-write, not a hot path) reads anyway. Exported for tests.
 */
export function readSettingsText(file: string = settingsPath(), opts: { fresh?: boolean } = {}): string | null {
  const recent = lastReadFailure;
  // A clock set back makes the age negative: that is no reason to keep failing.
  const age = recent ? Date.now() - recent.at : -1;
  if (!opts.fresh && recent && recent.file === file && age >= 0 && age < READ_FAILURE_MEMO_MS) {
    throw unreadableError(recent.code);
  }
  try {
    const text = withFileRetries(() => fs.readFileSync(file, "utf8"));
    lastReadFailure = null;
    loggedFailure = null;
    return text;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      lastReadFailure = null;
      loggedFailure = null;
      // A first run has no other state either; one that has means the file
      // went missing, which is worth knowing when settings "reset".
      if (!missingLogged && fs.existsSync(path.join(path.dirname(file), "seen-state.json"))) {
        missingLogged = true;
        diag(`settings: ${file} is missing although the folder holds app state — starting unconfigured`);
      }
      return null;
    }
    const code = err.code ?? err.message;
    // Only a failure the retries slept on is worth answering from memory.
    lastReadFailure = err.code && TRANSIENT_FILE_ERRORS.has(err.code) ? { file, code, at: Date.now() } : null;
    if (loggedFailure !== `${file}|${code}`) {
      loggedFailure = `${file}|${code}`;
      diag(`settings: cannot read ${file}: ${err.code ?? ""} ${err.message}`);
    }
    throw unreadableError(code);
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
  const stored = keepUnknownSettings(
    parseOrUndefined(readSettingsText(file, { fresh: true })),
    toStoredSettings(settings),
  );
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    withFileRetries(() => fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), "utf8"));
    // A scanner that opens the file it just saw written fails the rename on
    // Windows for a moment, like a read.
    withFileRetries(() => fs.renameSync(tmp, file));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Already gone, or held as well: nothing more to do about it here.
    }
    diag(`settings: cannot replace ${file}: ${err.code ?? ""} ${err.message}`);
    throw new ConfigError(
      `settings.json could not be saved (${err.code ?? err.message}). Your previous settings were kept — try again; main.log in its data folder has the details.`,
    );
  }
  missingLogged = false;
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
