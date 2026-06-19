/**
 * Single in-process poller for the desktop app.
 *
 * Replaces the Next server's singleton poller + SSE broadcast: one timer in the
 * main process queries the configured hosts, then hands the result to the host
 * (main.ts) via callbacks, which `webContents.send`s it to the renderer.
 *
 * Three budget-saving behaviours keep a shared `gh` token from being exhausted
 * (the per-user GraphQL budget is spent by every client on the token, not just
 * this app — and a github.com tick costs many tens of points, observed ~35–100
 * depending on repo/PR volume, vs only a few on a GHE host):
 *
 *  - **Idle gating** — when the injected `isPaused()` says the window is hidden
 *    / minimized or the machine is asleep / the user is idle, ticks skip the
 *    network entirely. `wake()` (wired to focus/resume) forces an immediate
 *    fetch on return.
 *  - **Per-host spacing** — each host is fetched on its own cadence; expensive
 *    hosts (high GraphQL cost) get a higher minimum interval so the shared
 *    budget survives other clients. A host not due this tick keeps its last
 *    result in the snapshot.
 *  - **No-change backoff** — after several consecutive unchanged ticks the base
 *    interval is stretched (capped), and reset on any change or an explicit
 *    refresh/wake.
 *
 * Deliberately free of Electron imports so it stays unit-testable; settings
 * loading, token resolution, the state-file path, the app version and the
 * idle-gate predicate are all injected.
 */

import { ConfigError } from "../shared/config";
import { fetchHost } from "../shared/github";
import { applyActivity } from "../shared/state";
import type {
  DashboardResponse,
  HostConfig,
  HostError,
  PullRequest,
  RateLimitInfo,
  Settings,
} from "../shared/types";

export interface PollerOptions {
  /** Loads current settings; may throw ConfigError (invalid file). */
  loadSettings: () => Settings;
  /** Resolves settings into fetch-ready hosts; may throw ConfigError (gh auth). */
  toHostConfigs: (settings: Settings) => HostConfig[];
  /** Path of the "seen" state store. */
  statePath: string;
  /** Running app version, stamped into each snapshot. */
  appVersion: string;
  /** Called with each changed snapshot. */
  onSnapshot: (snapshot: DashboardResponse) => void;
  /** Called when configuration is broken (e.g. a host isn't authenticated). */
  onConfigError: (message: string) => void;
  /**
   * Optional idle gate. When it returns true (window hidden/minimized, machine
   * asleep or user idle), a tick skips the network fetch — sparing the rate-limit
   * budget while nobody is looking. `wake()` forces a fetch when the user returns.
   */
  isPaused?: () => boolean;
}

const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 3_600_000;
/** Cheap "are we back yet?" cadence while the idle gate is closed (no network). */
const PARKED_INTERVAL_MS = 20_000;
/**
 * A host whose GraphQL cost per tick is at least this is "expensive" (github.com
 * runs tens of points — observed ~35–100; a GHE host only a few) and gets a
 * higher minimum interval, so a shared per-user token survives other clients
 * spending the same budget.
 */
const EXPENSIVE_COST = 5;
/** Minimum spacing for an expensive host (github.com), regardless of base. */
const EXPENSIVE_FLOOR_MS = 300_000; // 5 min
/** Stretch the base interval only after this many consecutive unchanged ticks. */
const IDLE_BACKOFF_AFTER = 2;
/** Cap on the no-change backoff multiplier. */
const IDLE_BACKOFF_MAX_FACTOR = 16;

/**
 * Stable hash over the fields that drive the UI. Deliberately excludes
 * `fetchedAt` so that "nothing actually changed" ticks don't push a fresh
 * payload to the renderer.
 */
function hashSnapshot(s: DashboardResponse): string {
  const lite = s.pullRequests.map((p) => [
    p.id,
    p.updatedAt,
    p.totalComments,
    p.unresolvedThreads,
    p.ciState,
    p.reviewDecision,
    p.hasHumanApproval,
    p.hasNewActivity,
    p.needsAttention,
    p.failingChecks.length,
    p.pendingChecks.length,
    p.checks.length,
    p.awaitingReview,
    p.hasUnaddressedChangeRequest,
    p.isDraft,
  ]);
  return JSON.stringify({ prs: lite, errors: s.errors, version: s.version });
}

/**
 * Minimum spacing before a host may be fetched again, from its last rate-limit
 * reading. Expensive hosts get a floor so the shared token keeps headroom for
 * other clients; otherwise the remaining safe ticks are spread across the window
 * to the reset. Never below the (possibly backed-off) base; capped at 1 h.
 */
export function hostIntervalMs(rl: RateLimitInfo | null, baseMs: number): number {
  // No reading yet (host not fetched, or no repos so no GraphQL spend): base.
  if (!rl || rl.cost <= 0 || !rl.resetAt) return Math.min(MAX_INTERVAL_MS, baseMs);
  const floor = rl.cost >= EXPENSIVE_COST ? Math.max(baseMs, EXPENSIVE_FLOOR_MS) : baseMs;
  const secondsUntilReset = Math.max(0, (new Date(rl.resetAt).getTime() - Date.now()) / 1000);
  const safeTicks = Math.floor(rl.remaining / rl.cost);
  if (safeTicks <= 0) {
    // Budget spent: wait out the reset (at least a minute), but no less than floor.
    return Math.min(MAX_INTERVAL_MS, Math.max(floor, Math.max(60_000, secondsUntilReset * 1000)));
  }
  const safeMs = (secondsUntilReset / safeTicks) * 1000;
  return Math.min(MAX_INTERVAL_MS, Math.max(floor, safeMs));
}

/**
 * No-change backoff multiplier for the base interval: 1 until the stale streak
 * passes the threshold, then doubling per extra unchanged tick, capped.
 */
export function computeIdleFactor(unchangedStreak: number): number {
  if (unchangedStreak <= IDLE_BACKOFF_AFTER) return 1;
  return Math.min(IDLE_BACKOFF_MAX_FACTOR, 2 ** (unchangedStreak - IDLE_BACKOFF_AFTER));
}

/** Last known result for one host, kept between its (spaced-out) fetches. */
interface HostSlot {
  prs: PullRequest[];
  rateLimit: RateLimitInfo | null;
  error: HostError | null;
  /** Epoch ms before which this host should not be fetched again. */
  nextDueAt: number;
}

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private intervalMs = 60_000;
  private currentSnapshot: DashboardResponse | null = null;
  private currentConfigError: string | null = null;
  private lastHash = "";
  /** Consecutive ticks whose snapshot was unchanged — drives the backoff. */
  private unchangedStreak = 0;
  /** Per-host last result + next-due time, keyed by graphqlUrl. */
  private readonly hostSlots = new Map<string, HostSlot>();
  // Serializes ticks so a manual refresh can't interleave with a timer tick.
  private inFlight: Promise<void> | null = null;
  private readonly firstReady: Promise<void>;
  private resolveFirst: () => void = () => {};

  constructor(private readonly options: PollerOptions) {
    this.firstReady = new Promise<void>((resolve) => {
      this.resolveFirst = resolve;
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runTickThenSchedule();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Forces an immediate poll of every host (coalesced with any in-flight tick),
   * resets the backoff and reschedules. For explicit user intent — manual
   * Refresh and settings save — so it bypasses per-host spacing.
   */
  async refresh(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unchangedStreak = 0;
    await this.runTickThenSchedule(true);
  }

  /**
   * Wakes the poller from idle (window focus / system resume): an immediate
   * tick that still respects per-host spacing, with the backoff reset so the
   * user sees fresh data without dragging an expensive host on every focus.
   */
  async wake(): Promise<void> {
    if (!this.started) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unchangedStreak = 0;
    await this.runTickThenSchedule(false);
  }

  getSnapshot(): DashboardResponse | null {
    return this.currentSnapshot;
  }

  getConfigError(): string | null {
    return this.currentConfigError;
  }

  /** Resolves once the first tick has completed (snapshot OR config error). */
  awaitFirstTick(): Promise<void> {
    return this.firstReady;
  }

  private runTickThenSchedule(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.tick(force)
      .then((nextMs) => {
        this.schedule(nextMs);
      })
      .catch((e) => {
        console.error("[poller] tick failed:", e);
        this.schedule(this.intervalMs);
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  private schedule(nextMs: number): void {
    this.timer = setTimeout(() => {
      void this.runTickThenSchedule();
    }, nextMs);
    // Don't keep the event loop alive solely for the poller.
    this.timer.unref?.();
  }

  /** Records the config error (once) and returns the base interval. */
  private emitConfigError(message: string): number {
    if (this.currentConfigError !== message) {
      this.currentConfigError = message;
      this.options.onConfigError(message);
    }
    this.resolveFirst();
    return this.intervalMs;
  }

  private async tick(force: boolean): Promise<number> {
    let settings: Settings;
    try {
      settings = this.options.loadSettings();
      this.intervalMs = Math.min(
        MAX_INTERVAL_MS,
        Math.max(MIN_INTERVAL_MS, settings.pollIntervalSeconds * 1000),
      );
    } catch (e) {
      if (e instanceof ConfigError) return this.emitConfigError(e.message);
      console.error("[poller] loadSettings failed:", e);
      this.resolveFirst();
      return this.intervalMs;
    }

    // Idle gate: skip all gh/network work while nobody is looking. A forced
    // tick (manual refresh) always runs. Cheap re-check cadence until we wake.
    if (!force && this.options.isPaused?.()) {
      this.resolveFirst();
      return PARKED_INTERVAL_MS;
    }

    let hosts: HostConfig[];
    try {
      hosts = this.options.toHostConfigs(settings);
      // Recovering from a previous config error — clear it.
      this.currentConfigError = null;
    } catch (e) {
      if (e instanceof ConfigError) return this.emitConfigError(e.message);
      console.error("[poller] toHostConfigs failed:", e);
      this.resolveFirst();
      return this.intervalMs;
    }

    const now = Date.now();
    // Forget hosts that are no longer configured.
    const liveKeys = new Set(hosts.map((h) => h.graphqlUrl));
    for (const key of [...this.hostSlots.keys()]) {
      if (!liveKeys.has(key)) this.hostSlots.delete(key);
    }

    const effectiveBase = Math.min(
      MAX_INTERVAL_MS,
      this.intervalMs * computeIdleFactor(this.unchangedStreak),
    );

    // Due = never fetched, overdue, or forced. Others reuse their last result.
    const due = hosts.filter((h) => {
      if (force) return true;
      const slot = this.hostSlots.get(h.graphqlUrl);
      return !slot || now >= slot.nextDueAt;
    });

    const results = await Promise.allSettled(due.map((h) => fetchHost(h)));
    results.forEach((result, i) => {
      const host = due[i];
      const prev = this.hostSlots.get(host.graphqlUrl);
      if (result.status === "fulfilled") {
        const rateLimit = host.repos.length > 0 ? result.value.rateLimit : null;
        this.hostSlots.set(host.graphqlUrl, {
          prs: result.value.pullRequests,
          rateLimit,
          error: null,
          nextDueAt: now + hostIntervalMs(rateLimit, effectiveBase),
        });
      } else {
        // Keep the last good PRs (better than blanking the host) and surface the
        // error. Space the retry by the last reading so an erroring expensive
        // host — e.g. rate-limited — isn't hammered.
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.hostSlots.set(host.graphqlUrl, {
          prs: prev?.prs ?? [],
          rateLimit: prev?.rateLimit ?? null,
          error: { hostLabel: host.label, message },
          nextDueAt: now + hostIntervalMs(prev?.rateLimit ?? null, effectiveBase),
        });
      }
    });

    // Assemble the snapshot from every host's latest slot (fetched + carried).
    const allPrs: PullRequest[] = [];
    const errors: HostError[] = [];
    const rateLimits: RateLimitInfo[] = [];
    for (const slot of this.hostSlots.values()) {
      allPrs.push(...slot.prs);
      if (slot.error) errors.push(slot.error);
      if (slot.rateLimit) rateLimits.push(slot.rateLimit);
    }

    try {
      await applyActivity(allPrs, this.options.statePath);
    } catch (e) {
      console.error("[poller] applyActivity failed:", e);
    }

    // Attention-needing first; then by most recently updated.
    allPrs.sort((a, b) => {
      if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

    const snapshot: DashboardResponse = {
      pullRequests: allPrs,
      errors,
      rateLimits,
      fetchedAt: new Date().toISOString(),
      version: this.options.appVersion,
    };

    const hash = hashSnapshot(snapshot);
    this.currentSnapshot = snapshot;
    if (hash !== this.lastHash) {
      this.lastHash = hash;
      this.unchangedStreak = 0;
      this.options.onSnapshot(snapshot);
    } else {
      this.unchangedStreak++;
    }
    this.resolveFirst();

    return this.nextWakeMs(now);
  }

  /** Soonest per-host due time, clamped to [MIN, MAX]; base if no hosts. */
  private nextWakeMs(now: number): number {
    if (this.hostSlots.size === 0) {
      return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, this.intervalMs));
    }
    let soonest = MAX_INTERVAL_MS;
    for (const slot of this.hostSlots.values()) {
      const wait = Math.max(0, slot.nextDueAt - now);
      if (wait < soonest) soonest = wait;
    }
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, soonest));
  }
}
