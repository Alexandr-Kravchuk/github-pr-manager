/**
 * Tiny `PRD_DEBUG`-gated logger, shared so the Jira subsystem keeps one debug
 * convention instead of reimplementing the gate per module. Electron-free.
 */
export function makeDebug(tag: string): (msg: string) => void {
  return (msg: string) => {
    if (process.env.PRD_DEBUG) console.log(tag, msg);
  };
}
