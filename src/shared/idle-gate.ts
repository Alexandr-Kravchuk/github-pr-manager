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
 * The fix: when a notification could actually fire, a hidden window alone no
 * longer pauses polling. Budget is still bounded by the poller's per-host
 * spacing, the cold-host floor, the no-change backoff and the cheap REST
 * `/notifications` detector that gates the expensive GraphQL hydrate. A truly
 * asleep machine (`systemSuspended`) and a genuinely-away user
 * (`systemIdleSeconds` past the threshold) still pause regardless — those aren't
 * "the user is relying on notifications", they're "there is no user".
 *
 * "Could actually fire" is deliberately stricter than the master
 * `notifications.enabled` toggle — see `notificationsActionable` below.
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
   * Reads seconds since the last user input (`powerMonitor.getSystemIdleTime`),
   * or `null` when the platform can't report it — treated as "active".
   *
   * A thunk, not a value: it is the only costly input here (a native query), and
   * the cheap suspend / no-window / hidden branches must be able to decide
   * without paying for it. Called at most once, and only when those branches
   * haven't already answered.
   */
  systemIdleSeconds: () => number | null;
  /**
   * A notification could actually reach this user — from
   * `hasDeliverableNotifications` in `notify.ts`, not the raw
   * `notifications.enabled` toggle. When true, a hidden window does not pause
   * polling, because otherwise the notifier can never see a transition.
   *
   * The distinction matters: `enabled` can be on with every event type or both
   * delivery channels off, in which case no toast can ever fire and keeping the
   * poll loop alive would spend the shared GraphQL budget for nothing.
   */
  notificationsActionable: boolean;
}

/**
 * Whether a poll tick should skip the network. See the module doc for the
 * budget-vs-notifications tradeoff this encodes.
 *
 * Branch order is load-bearing, not cosmetic: every cheap check runs before
 * `systemIdleSeconds()` is invoked, so a suspended machine or a
 * hidden-window-with-nothing-to-notify tick costs nothing to decide.
 */
export function isPollingPaused(inputs: IdleGateInputs): boolean {
  // Asleep: nothing to poll for, and the resume `wake()` will force a fetch.
  if (inputs.systemSuspended) return true;
  // No window: startup / activate — let the first fetch run.
  if (!inputs.hasWindow) return false;
  // Hidden window pauses ONLY when no notification could reach the user anyway;
  // when one could, we keep polling so the transition surfaces.
  if (inputs.windowHidden && !inputs.notificationsActionable) return true;
  // Genuinely-away user pauses either way — "there is no user", not "the user
  // is relying on notifications". Only here is the native query worth paying for.
  const idleSeconds = inputs.systemIdleSeconds();
  if (idleSeconds !== null && idleSeconds > IDLE_PAUSE_SECONDS) return true;
  return false;
}
