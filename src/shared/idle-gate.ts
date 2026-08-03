/**
 * Pure decision for the poller's idle gate — "should this tick skip the network?"
 *
 * The gate exists to spare the shared `gh` rate-limit budget while nobody is
 * looking at the dashboard. But desktop notifications exist precisely to alert
 * the user *while* the window isn't in front of them — so a hidden/minimized
 * window used to pause polling exactly when the notifier was supposed to be the
 * user's eyes. Net effect: notifications only ever fired on the `wake()` path
 * (system resume/unlock), which bypasses the gate.
 *
 * The fix: when notifications are enabled, a hidden window alone no longer
 * pauses polling. Budget is still bounded by the poller's per-host spacing, the
 * cold-host floor, the no-change backoff and the cheap REST `/notifications`
 * detector that gates the expensive GraphQL hydrate. A truly asleep machine
 * (`systemSuspended`) and a genuinely-away user (`systemIdleSeconds` past the
 * threshold) still pause regardless — those aren't "the user is relying on
 * notifications", they're "there is no user".
 *
 * Electron-free so it unit-tests in plain Node, exactly like `notify.ts` — the
 * host (`main.ts`) reads the live window / powerMonitor / settings state and
 * feeds it in.
 */

/** Pause polling once the user has been inactive at the machine this long. */
export const IDLE_PAUSE_SECONDS = 300;

export interface IdleGateInputs {
  /** `powerMonitor` 'suspend' latched — the machine is asleep. */
  systemSuspended: boolean;
  /**
   * A window exists and is usable. No window yet (startup / dock activate)
   * counts as active so the very first fetch runs.
   */
  hasWindow: boolean;
  /** The window is minimized or otherwise not visible to the user. */
  windowHidden: boolean;
  /**
   * Seconds since the last user input (`powerMonitor.getSystemIdleTime`), or
   * `null` when the platform can't report it — treated as "active".
   */
  systemIdleSeconds: number | null;
  /**
   * The user opted into desktop notifications. When true, a hidden window does
   * not pause polling — otherwise the notifier can never see a transition.
   */
  notificationsEnabled: boolean;
}

/**
 * Whether a poll tick should skip the network. See the module doc for the
 * budget-vs-notifications tradeoff this encodes.
 */
export function isPollingPaused(inputs: IdleGateInputs): boolean {
  // Asleep: nothing to poll for, and the resume `wake()` will force a fetch.
  if (inputs.systemSuspended) return true;
  // No window: startup / activate — let the first fetch run.
  if (!inputs.hasWindow) return false;
  // Hidden window pauses ONLY when the user hasn't asked to be notified in the
  // background; with notifications on we keep polling so transitions surface.
  if (inputs.windowHidden && !inputs.notificationsEnabled) return true;
  // Genuinely-away user pauses either way — "there is no user", not "the user
  // is relying on notifications".
  if (inputs.systemIdleSeconds !== null && inputs.systemIdleSeconds > IDLE_PAUSE_SECONDS) {
    return true;
  }
  return false;
}
