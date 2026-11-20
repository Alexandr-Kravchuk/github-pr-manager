// The main process's own short log, `userData/main.log`: how it started
// (version, arguments, data folder) and what went wrong reading settings or
// installing an update. A packaged app has no console, and the app that an
// installer started after an update came up with empty settings while every
// later start read them — with nothing written anywhere to say why. Capped at
// MAX_BYTES (the previous half kept as `main.log.old`); a failure to write is
// swallowed, since the log must never be what breaks the app.
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 256 * 1024;

let logFile: string | null = null;

/** Where the log goes; nothing is written before this is called. */
export function initDiagLog(dir: string): void {
  logFile = path.join(dir, "main.log");
}

export function diag(message: string): void {
  if (!logFile) return;
  try {
    try {
      if (fs.statSync(logFile).size > MAX_BYTES) fs.renameSync(logFile, `${logFile}.old`);
    } catch {
      /* no log yet */
    }
    // No mkdir: the data folder exists once Chromium has started, and a log
    // pointed at a folder that is gone (a test's) should write nowhere.
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    /* never let the log break the app */
  }
}
