/**
 * Single in-process poller for the desktop app.
 *
 * Replaces the Next server's singleton poller + SSE broadcast: one timer in the
 * main process queries every configured host, then hands the result to the host
 * (main.ts) via callbacks, which `webContents.send`s it to the renderer.
 *
 * Deliberately free of Electron imports so it stays unit-testable; settings
 * loading, token resolution, the state-file path and the app version are all
 * injected.
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
}

const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 3_600_000;

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
 * Computes how long to wait before the next tick based on rate-limit state, so
 * we never exhaust a host's GraphQL budget. Capped at 1 h; never below the base.
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
  return Math.min(nextMs, MAX_INTERVAL_MS);
}

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private intervalMs = 60_000;
  private currentSnapshot: DashboardResponse | null = null;
  private currentConfigError: string | null = null;
  private lastHash = "";
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

  /** Forces an immediate poll (coalesced with any in-flight tick) and reschedules. */
  async refresh(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.runTickThenSchedule();
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

  private runTickThenSchedule(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.tick()
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

  private async tick(): Promise<number> {
    let hosts: HostConfig[];
    try {
      const settings = this.options.loadSettings();
      this.intervalMs = Math.min(
        MAX_INTERVAL_MS,
        Math.max(MIN_INTERVAL_MS, settings.pollIntervalSeconds * 1000),
      );
      hosts = this.options.toHostConfigs(settings);
      // Recovering from a previous config error — clear it.
      this.currentConfigError = null;
    } catch (e) {
      if (e instanceof ConfigError) {
        if (this.currentConfigError !== e.message) {
          this.currentConfigError = e.message;
          this.options.onConfigError(e.message);
        }
        this.resolveFirst();
        return this.intervalMs;
      }
      console.error("[poller] loadSettings failed:", e);
      this.resolveFirst();
      return this.intervalMs;
    }

    const allPrs: PullRequest[] = [];
    const errors: HostError[] = [];
    const rateLimits: RateLimitInfo[] = [];

    // Hosts are queried in parallel; one failing doesn't break the rest.
    const results = await Promise.allSettled(hosts.map((h) => fetchHost(h)));
    results.forEach((result, i) => {
      const host = hosts[i];
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
      this.options.onSnapshot(snapshot);
    }
    this.resolveFirst();

    return computeNextIntervalMs(rateLimits, this.intervalMs);
  }
}
