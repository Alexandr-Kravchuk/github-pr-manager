/**
 * Singleton server-side poller.
 *
 * Replaces per-tab browser polling: one process polls GitHub, all open tabs
 * receive updates via SSE (see `broadcast.ts` and the `/api/stream` route).
 *
 * Lifecycle:
 *  - `ensurePollerStarted()` is called from the first request that needs data
 *    (either `/api/pull-requests` or `/api/stream`). It's a no-op on subsequent
 *    calls.
 *  - The poller never stops on its own — it lives for the whole process. On
 *    SIGTERM the OS will reclaim the timer.
 *  - State (started flag, timer, latest snapshot) lives on `globalThis` so
 *    that Next.js dev-mode HMR doesn't accidentally start a second poller.
 */

import { publish } from "./broadcast";
import { ConfigError, loadConfig } from "./config";
import { fetchHost } from "./github";
import { applyActivity } from "./state";
import type { DashboardResponse, HostError, PullRequest, RateLimitInfo } from "./types";
import { appVersion } from "./version";

interface PollerState {
  started: boolean;
  timer: NodeJS.Timeout | null;
  intervalMs: number;
  /** Most recent successful poll result; what new SSE clients see first. */
  currentSnapshot: DashboardResponse | null;
  /** Most recent config error, or null if config is healthy. */
  currentConfigError: string | null;
  /** Hash of the last snapshot — skip broadcast if nothing changed. */
  lastHash: string;
  /** Resolves once the very first tick completes (success or config-error). */
  firstReady: Promise<void>;
  resolveFirst: () => void;
}

const G = globalThis as typeof globalThis & {
  __ghprPoller?: PollerState;
};

function getState(): PollerState {
  if (!G.__ghprPoller) {
    let resolveFirst: () => void = () => {};
    const firstReady = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    G.__ghprPoller = {
      started: false,
      timer: null,
      intervalMs: 60_000,
      currentSnapshot: null,
      currentConfigError: null,
      lastHash: "",
      firstReady,
      resolveFirst,
    };
  }
  return G.__ghprPoller;
}

/**
 * Stable hash over the fields that drive the UI. We deliberately exclude
 * `fetchedAt` so that "nothing actually changed" ticks don't trigger a
 * client-side re-render (and don't shove a fresh JSON down every SSE pipe).
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
  return JSON.stringify({
    prs: lite,
    errors: s.errors,
    version: s.version,
  });
}

/**
 * Computes how long to wait before the next tick based on rate-limit state.
 *
 * For each host we have `remaining` points and a `resetAt` timestamp. The
 * safe number of ticks until reset is `floor(remaining / cost)`. If we have
 * fewer safe ticks than natural ticks at the base interval we back off so we
 * don't exceed the budget. Capped at 1 h; never goes below the base interval.
 */
function computeNextIntervalMs(rateLimits: RateLimitInfo[], baseMs: number): number {
  let nextMs = baseMs;
  for (const rl of rateLimits) {
    if (!rl.resetAt || rl.cost <= 0) continue;
    const secondsUntilReset = Math.max(0, (new Date(rl.resetAt).getTime() - Date.now()) / 1000);
    const safeTicks = Math.floor(rl.remaining / rl.cost);
    if (safeTicks <= 0) {
      // Exhausted — sleep until the reset window, minimum 60 s.
      const backoff = Math.max(60_000, secondsUntilReset * 1000);
      if (backoff > nextMs) {
        console.warn(
          `[poller] ${rl.hostLabel}: rate limit exhausted, backing off ${Math.round(backoff / 1000)}s`,
        );
        nextMs = backoff;
      }
    } else {
      // Spread remaining ticks evenly across the reset window.
      const safeMs = (secondsUntilReset / safeTicks) * 1000;
      if (safeMs > nextMs) {
        console.warn(
          `[poller] ${rl.hostLabel}: ${rl.remaining} points left (cost ${rl.cost}), slowing to ${Math.round(safeMs / 1000)}s`,
        );
        nextMs = safeMs;
      }
    }
  }
  return Math.min(nextMs, 3_600_000);
}

async function tick(): Promise<number> {
  const state = getState();

  let config;
  try {
    config = loadConfig();
    // Recovering from a previous config error — clear it for new clients
    // and broadcast a snapshot once we have one.
    state.currentConfigError = null;
  } catch (e) {
    if (e instanceof ConfigError) {
      if (state.currentConfigError !== e.message) {
        state.currentConfigError = e.message;
        publish("config-error", e.message);
      }
      state.resolveFirst();
      return state.intervalMs;
    }
    console.error("[poller] loadConfig failed:", e);
    state.resolveFirst();
    return state.intervalMs;
  }

  const allPrs: PullRequest[] = [];
  const errors: HostError[] = [];
  const rateLimits: RateLimitInfo[] = [];

  // Hosts are queried in parallel; one failing doesn't break the rest.
  const results = await Promise.allSettled(config.hosts.map((h) => fetchHost(h)));
  results.forEach((result, i) => {
    const host = config.hosts[i];
    if (result.status === "fulfilled") {
      allPrs.push(...result.value.pullRequests);
      if (host.repos.length > 0) rateLimits.push(result.value.rateLimit);
    } else {
      errors.push({
        hostLabel: host.label,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  try {
    await applyActivity(allPrs);
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
    version: appVersion(),
  };

  const hash = hashSnapshot(snapshot);
  state.currentSnapshot = snapshot;
  if (hash !== state.lastHash) {
    state.lastHash = hash;
    publish("snapshot", JSON.stringify(snapshot));
  }
  state.resolveFirst();

  return computeNextIntervalMs(rateLimits, state.intervalMs);
}

function scheduleNext(nextMs?: number): void {
  const state = getState();
  const delay = nextMs ?? state.intervalMs;
  state.timer = setTimeout(async () => {
    let next: number | undefined;
    try {
      next = await tick();
    } catch (e) {
      console.error("[poller] tick failed:", e);
    } finally {
      scheduleNext(next);
    }
  }, delay);
  // Don't keep the Node event loop alive just for the poller — if everything
  // else has exited (tests, SIGTERM handlers), let the process die.
  state.timer.unref?.();
}

/**
 * Starts the singleton poller. Safe to call repeatedly — the second and
 * subsequent calls are no-ops.
 */
export function ensurePollerStarted(): void {
  const state = getState();
  if (state.started) return;
  state.started = true;

  // Read the desired interval from config; tolerate missing config (the
  // first tick will surface the same error to clients).
  try {
    const cfg = loadConfig();
    state.intervalMs = Math.max(10, cfg.pollIntervalSeconds) * 1000;
  } catch {
    // Stick with the default; tick() will publish the config-error.
  }

  // First tick is fire-and-forget; promise hooks (awaitFirstTick) handle
  // any caller that needs to wait for it.
  tick()
    .then((ms) => scheduleNext(ms))
    .catch((e) => {
      console.error("[poller] initial tick failed:", e);
      scheduleNext();
    });
}

/** Latest snapshot, or null if no successful tick has happened yet. */
export function getSnapshot(): DashboardResponse | null {
  return getState().currentSnapshot;
}

/** Current config error, or null if config is OK. */
export function getConfigError(): string | null {
  return getState().currentConfigError;
}

/** Resolves once the first tick has completed (snapshot OR config error). */
export function awaitFirstTick(): Promise<void> {
  return getState().firstReady;
}
