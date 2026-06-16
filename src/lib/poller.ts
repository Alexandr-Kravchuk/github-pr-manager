/**
 * Per-user server-side pollers (Tier B multi-user).
 *
 * Each logged-in session (`sid`) gets its own poller: it queries GitHub with
 * that session's OAuth tokens and therefore sees that user's pull requests.
 * Results are pushed to the session's own SSE channel (see `broadcast.ts`).
 *
 * Request-seeded tokens (the crux of multi-user). A poller's `tick()` runs on a
 * timer with no request context, so it can't read the session cookie itself.
 * Instead the authenticated `/api/pull-requests` route — which *does* have the
 * cookie — calls `seedPoller()` to drop the session's tokens into the registry
 * and start (or refresh) that session's loop. The loop then reuses those tokens
 * until the next authenticated request refreshes them or `dropPollerIdentity()`
 * (logout) removes the session.
 *
 * State lives on `globalThis` so Next.js dev-mode HMR doesn't spin up a second
 * registry.
 */

import { publish } from "./broadcast";
import { ConfigError, readConfig } from "./config";
import { fetchHost } from "./github";
import { applyActivity } from "./state";
import type {
  DashboardResponse,
  HostConfig,
  HostError,
  PullRequest,
  RateLimitInfo,
} from "./types";
import { appVersion } from "./version";

interface UserPoller {
  sid: string;
  /** provider id -> access token; refreshed on every authenticated request. */
  tokens: Record<string, string>;
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
  __ghprPollers?: Map<string, UserPoller>;
};

function registry(): Map<string, UserPoller> {
  return (G.__ghprPollers ??= new Map());
}

function createPoller(sid: string): UserPoller {
  let resolveFirst: () => void = () => {};
  const firstReady = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  return {
    sid,
    tokens: {},
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
  return JSON.stringify({ prs: lite, errors: s.errors, version: s.version });
}

/**
 * Computes how long to wait before the next tick based on rate-limit state.
 * Capped at 1 h; never goes below the base interval.
 */
function computeNextIntervalMs(rateLimits: RateLimitInfo[], baseMs: number): number {
  let nextMs = baseMs;
  for (const rl of rateLimits) {
    if (!rl.resetAt || rl.cost <= 0) continue;
    const secondsUntilReset = Math.max(0, (new Date(rl.resetAt).getTime() - Date.now()) / 1000);
    const safeTicks = Math.floor(rl.remaining / rl.cost);
    if (safeTicks <= 0) {
      const backoff = Math.max(60_000, secondsUntilReset * 1000);
      if (backoff > nextMs) {
        console.warn(
          `[poller] ${rl.hostLabel}: rate limit exhausted, backing off ${Math.round(backoff / 1000)}s`,
        );
        nextMs = backoff;
      }
    } else {
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

async function tick(p: UserPoller): Promise<number> {
  // The session may have been dropped (logout) while a tick was scheduled.
  if (!registry().has(p.sid)) return p.intervalMs;

  let config;
  try {
    config = readConfig();
    p.currentConfigError = null;
  } catch (e) {
    if (e instanceof ConfigError) {
      if (p.currentConfigError !== e.message) {
        p.currentConfigError = e.message;
        publish(p.sid, "config-error", e.message);
      }
      p.resolveFirst();
      return p.intervalMs;
    }
    console.error("[poller] readConfig failed:", e);
    p.resolveFirst();
    return p.intervalMs;
  }

  // Only poll hosts whose provider this session has connected — inject the
  // session token into a per-request host copy. Hosts the user hasn't linked
  // are silently skipped (not an error).
  const authedHosts: HostConfig[] = [];
  for (const host of config.hosts) {
    const token = host.oauthProvider ? p.tokens[host.oauthProvider] : undefined;
    if (token) authedHosts.push({ ...host, token });
  }

  const allPrs: PullRequest[] = [];
  const errors: HostError[] = [];
  const rateLimits: RateLimitInfo[] = [];

  const results = await Promise.allSettled(authedHosts.map((h) => fetchHost(h)));
  results.forEach((result, i) => {
    const host = authedHosts[i];
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
    await applyActivity(p.sid, allPrs);
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
  p.currentSnapshot = snapshot;
  if (hash !== p.lastHash) {
    p.lastHash = hash;
    publish(p.sid, "snapshot", JSON.stringify(snapshot));
  }
  p.resolveFirst();

  return computeNextIntervalMs(rateLimits, p.intervalMs);
}

function scheduleNext(p: UserPoller, nextMs?: number): void {
  // Don't reschedule a poller that's been dropped.
  if (!registry().has(p.sid)) return;
  const delay = nextMs ?? p.intervalMs;
  p.timer = setTimeout(async () => {
    let next: number | undefined;
    try {
      next = await tick(p);
    } catch (e) {
      console.error("[poller] tick failed:", e);
    } finally {
      scheduleNext(p, next);
    }
  }, delay);
  // Don't keep the Node event loop alive just for the poller.
  p.timer.unref?.();
}

/**
 * Seeds (or refreshes) a session's tokens and ensures its poller is running.
 * Called from the authenticated `/api/pull-requests` route, which has the
 * cookie the timer-driven tick can't read. Safe to call on every request.
 */
export function seedPoller(identity: { sid: string; tokens: Record<string, string> }): void {
  const reg = registry();
  let p = reg.get(identity.sid);
  if (!p) {
    p = createPoller(identity.sid);
    reg.set(identity.sid, p);
  }
  p.tokens = identity.tokens;

  if (!p.started) {
    p.started = true;
    try {
      p.intervalMs = Math.max(10, readConfig().pollIntervalSeconds) * 1000;
    } catch {
      // Stick with the default; tick() will publish the config-error.
    }
    tick(p)
      .then((ms) => scheduleNext(p, ms))
      .catch((e) => {
        console.error("[poller] initial tick failed:", e);
        scheduleNext(p);
      });
  }
}

/** Stops and forgets a session's poller (logout, or token revocation). */
export function dropPollerIdentity(sid: string): void {
  const reg = registry();
  const p = reg.get(sid);
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  reg.delete(sid);
}

/** Latest snapshot for a session, or null if no successful tick yet. */
export function getSnapshot(sid: string): DashboardResponse | null {
  return registry().get(sid)?.currentSnapshot ?? null;
}

/** Current config error for a session, or null if config is OK / unknown. */
export function getConfigError(sid: string): string | null {
  return registry().get(sid)?.currentConfigError ?? null;
}

/** Resolves once a session's first tick has completed; resolves immediately if unknown. */
export function awaitFirstTick(sid: string): Promise<void> {
  return registry().get(sid)?.firstReady ?? Promise.resolve();
}
