/**
 * Tiny `PRD_DEBUG`-gated logger, shared so the Jira subsystem keeps one debug
 * convention instead of reimplementing the gate per module. Electron-free.
 *
 * Accepts a thunk for messages that are expensive to build (fs/keychain probes,
 * joins over result sets): the thunk only runs when `PRD_DEBUG` is set, so the
 * disabled-diagnostics hot path pays nothing.
 */
export function makeDebug(tag: string): (msg: string | (() => string)) => void {
  return (msg) => {
    if (process.env.PRD_DEBUG) console.log(tag, typeof msg === "function" ? msg() : msg);
  };
}
