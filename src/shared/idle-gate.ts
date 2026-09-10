/**
 * Pure decision for the poller's idle gate — "should this tick hit the network,
 * and how hard?"
 *
 * The gate exists to spare the shared `gh` rate-limit budget while nobody is
 * looking at the dashboard. It answers with a *plan*, not a boolean, because
 * "nobody is looking" has two very different causes that deserve different
 * treatment:
 *
 *  - **`park`** — there is nothing a fetch could surface at all: the machine is
 *    asleep, or the window is hidden with no notification able to reach the
 *    user. Skip the network entirely; `wake()` (focus / show / resume / unlock)
 *    forces a catch-up fetch on return.
 *  - **`run` with a `presenceFactor`** — a fetch is still worth making, but how
 *    fresh it needs to be depends on how long the machine has gone without
 *    keyboard/mouse input. The factor multiplies the poller's per-host floors,
 *    so freshness degrades gradually instead of stopping dead.
 *
 * ## Why a ramp instead of an away-user cutoff
 *
 * This used to pause polling outright once `systemIdleSeconds` passed a
 * 5-minute threshold. That read *input* idle time, so simply reading the
 * dashboard without touching the machine looked identical to having left the
 * building: after five minutes the tick stopped fetching, and the window sat on
 * data that got arbitrarily old (38 minutes, in the report that prompted this)
 * while showing a live-looking "online" dot. Worse, the cheap REST
 * `/notifications` detector runs *inside* the tick, so the same early return
 * also silenced the one signal that could have cheaply noticed the staleness.
 *
 * There is no signal that separates "staring at the screen" from "walked away
 * with the app in the foreground" — input idle time is the only proxy available,
 * and a camera is not on the table. So the ramp treats the distinction as a
 * matter of degree: input-idle time buys progressively less freshness rather
 * than flipping a switch. `park` is reserved for the cases where the answer is
 * unambiguous (asleep; hidden with nothing to deliver).
 *
 * The practical effect: reading the dashboard hands-free stays fully fresh for
 * `PRESENCE_FULL_SECONDS`, then stretches, and a machine left open overnight
 * settles at one GraphQL hydrate per hour (the factor cap meets
 * `MAX_INTERVAL_MS` in `poller.ts`) while still rechecking every minute —
 * rather than polling all night at full cadence.
 *
 * ## What the factor does and does not reach
 *
 * It stretches only the *unforced* GraphQL hydrate floors in `poller.ts`. It
 * does not stretch the cheap REST `/notifications` probe: while any stretch is
 * in effect the poller caps its own sleep at a one-minute recheck
 * (`PRESENCE_RECHECK_MS`), so the probe keeps its ~60s server-advised cadence
 * however deep the ramp has gone. That is affordable because an unchanged inbox
 * answers `304`, which does not count against the rate limit.
 *
 * The recheck exists for a second reason, and it is the one that is easy to get
 * wrong: coming back to a window that is *already focused* — moving the mouse
 * over the dashboard you were reading — fires no `focus` event and therefore no
 * `wake()`. The tick timer is the only thing that can notice, so it must not be
 * asleep for the whole stretched interval.
 *
 * Two things consequently stay prompt no matter how large the factor grows: a
 * probe that sees movement on a tracked PR forces an immediate hydrate of that
 * host on the same tick, and the stretch is re-evaluated from scratch every
 * recheck, so it collapses to nothing on the first tick after the user touches
 * the machine. What the ramp actually governs is CI transitions — which produce
 * no notification at all — on a machine nobody has touched.
 *
 * ## Multiple copies on the same identity
 *
 * Several machines running this app on one `gh` identity do not coordinate —
 * there is no shared server to coordinate through. They do not need to: probes
 * are free while nothing changes, hydrates fire only on real movement or on the
 * (factor-stretched) floor, and each copy's seen-state stays local. The ramp is
 * what keeps the total bounded — N copies left open overnight settle at N
 * hydrates per hour, not N full-cadence pollers. A copy being driven over
 * remote desktop is not special-cased: it rides whatever its own OS reports as
 * input-idle time, and if that reports "no input" (a disconnected session, say)
 * it simply ramps down like any untouched machine and recovers on the first
 * recheck after real input arrives.
 *
 * Electron-free so it unit-tests in plain Node, exactly like `notify.ts` — the
 * host (`main.ts`) reads the live window / powerMonitor / settings state and
 * feeds it in.
 */

/**
 * Input-idle time that still buys full polling cadence. Chosen so that a long
 * hands-free reading session — watching a batch of CI runs finish, say — never
 * degrades, while a machine genuinely left behind starts backing off within the
 * hour.
 */
export const PRESENCE_FULL_SECONDS = 7200; // 2 h

/** Past the grace window, the factor doubles once per this much extra idle time. */
export const PRESENCE_STEP_SECONDS = 1800; // 30 min

/**
 * Cap on the presence factor. With `poller.ts`'s 5-minute expensive floor this
 * reaches 80 minutes, which `MAX_INTERVAL_MS` clamps to one hour — the intended
 * resting cadence for an unattended machine.
 */
export const PRESENCE_MAX_FACTOR = 16;

/** How a tick should treat the network this time round. */
export type PollPlan =
  /** Skip the network entirely — nothing a fetch could surface reaches anyone. */
  | { mode: "park" }
  /** Fetch, with every unforced per-host floor multiplied by `presenceFactor`. */
  | { mode: "run"; presenceFactor: number };

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
   * or `null` when the platform can't report it — treated as fully present.
   *
   * A thunk, not a value: it is the only costly input here (a native query), and
   * the cheap suspend / no-window / hidden branches must be able to decide
   * without paying for it. Called at most once, and only when those branches
   * haven't already answered.
   */
  systemIdleSeconds: () => number | null;
  /**
   * Reads whether a notification could actually reach this user — from
   * `hasDeliverableNotifications` in `notify.ts`, not the raw
   * `notifications.enabled` toggle. When false, a hidden window parks, because
   * nothing a fetch found could be shown to anybody.
   *
   * The distinction matters: `enabled` can be on with every event type or both
   * delivery channels off, in which case no toast can ever fire and keeping the
   * poll loop alive would spend the shared GraphQL budget for nothing.
   *
   * A thunk for the same reason as `systemIdleSeconds` — it ends in a native
   * `Notification.isSupported()` call, so the suspend / no-window branches must
   * be able to decide without it. Read at most once, only in the hidden branch.
   */
  notificationsActionable: () => boolean;
}

/**
 * How much to stretch the unforced polling floors for a given input-idle time.
 * 1 (no stretch) through the grace window, then doubling per
 * `PRESENCE_STEP_SECONDS`, capped at `PRESENCE_MAX_FACTOR`.
 *
 * `null` (platform can't report idle time) means "assume present": the failure
 * direction has to be freshness, not a silently stale dashboard.
 */
export function computePresenceFactor(idleSeconds: number | null): number {
  if (idleSeconds === null || idleSeconds <= PRESENCE_FULL_SECONDS) return 1;
  const steps = Math.floor((idleSeconds - PRESENCE_FULL_SECONDS) / PRESENCE_STEP_SECONDS) + 1;
  return Math.min(PRESENCE_MAX_FACTOR, 2 ** steps);
}

/**
 * Decides how a poll tick should treat the network. See the module doc for the
 * budget-vs-freshness tradeoff this encodes.
 *
 * Branch order is load-bearing, not cosmetic: both `park` answers are reached
 * without reading `systemIdleSeconds`, so an asleep machine or one with no
 * window yet costs nothing to decide.
 */
export function planPolling(inputs: IdleGateInputs): PollPlan {
  // Asleep: nothing to poll for, and the resume `wake()` will force a fetch.
  if (inputs.systemSuspended) return { mode: "park" };
  // No window: startup / activate — let the first fetch run at full cadence.
  if (!inputs.hasWindow) return { mode: "run", presenceFactor: 1 };
  // Hidden window parks ONLY when no notification could reach the user anyway;
  // when one could, keep polling so the transition surfaces.
  if (inputs.windowHidden && !inputs.notificationsActionable()) return { mode: "park" };
  // Present-ness is a matter of degree from here on — the only place the native
  // idle query is worth paying for.
  return { mode: "run", presenceFactor: computePresenceFactor(inputs.systemIdleSeconds()) };
}
