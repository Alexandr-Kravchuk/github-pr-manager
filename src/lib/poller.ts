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

async function tick(): Promise<void> {
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
      return;
    }
    console.error("[poller] loadConfig failed:", e);
    state.resolveFirst();
    return;
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
}

function scheduleNext(): void {
  const state = getState();
  state.timer = setTimeout(async () => {
    try {
      await tick();
    } catch (e) {
      console.error("[poller] tick failed:", e);
    } finally {
      scheduleNext();
    }
  }, state.intervalMs);
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
    .catch((e) => console.error("[poller] initial tick failed:", e))
    .finally(scheduleNext);
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
