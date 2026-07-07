/**
 * Cheap REST "did anything move?" detector, gating the expensive GraphQL tick.
 *
 * The dashboard's cost is github.com GraphQL points (a shared per-token budget,
 * ~35–100 per tick). The GitHub Notifications REST API lives in a *separate*
 * rate-limit pool (`core`, 5000/h) and speaks conditional requests: send back
 * the previous `Last-Modified` as `If-Modified-Since` and an unchanged inbox
 * answers `304 Not Modified` — which does **not** count against the limit. So
 * we can ask "did anything happen on this host?" every ~60s for free, and only
 * fire the pricey `fetchHost` GraphQL hydrate when a *tracked* PR actually moved.
 *
 * This covers *human* activity on the tracked PRs (comments, reviews, pushes,
 * review-requests) — the user is a participant in their authored + review-
 * requested PRs, so those events land in this inbox. It deliberately does NOT
 * cover CI status changes: a check-run flipping red→green bumps neither the
 * PR's `updatedAt` nor a notification. CI freshness stays on the poller's
 * GraphQL floor (see the hotness logic in `poller.ts`).
 *
 * "Did a tracked PR move?" is decided by an activity **watermark**, not by the
 * inbox merely changing: we remember the newest notification timestamp seen so
 * far and fire only when a notification on a *tracked* repo is newer than it.
 * That way a persistent unread notification, or churn on untracked repos, never
 * re-triggers a hydrate (which would waste GraphQL budget).
 *
 * Best-effort: any failure (missing scope, GHE quirk, network) disables the
 * detector for that host and the poller falls back to plain floor polling —
 * exactly like team discovery in `github.ts`. It must never take the dashboard
 * down.
 */

import { restBaseUrl } from "./github";
import type { HostConfig } from "./types";

/** Result of one notifications probe against a host. */
export interface NotifProbe {
  /** True when a tracked repo got activity newer than the previous watermark. */
  changed: boolean;
  /** `Last-Modified` to echo as `If-Modified-Since` next time (null if none). */
  lastModified: string | null;
  /** Newest notification timestamp seen so far (ISO) — the activity watermark. */
  watermark: string | null;
  /** Server-advised minimum spacing before the next probe (`X-Poll-Interval`). */
  pollIntervalMs: number;
  /** "ok" or "unavailable" — the latter permanently disables the detector. */
  status: "ok" | "unavailable";
}

/** State carried between probes for a single host. */
export interface NotifState {
  /** `Last-Modified` of the previous response (drives the conditional request). */
  lastModified: string | null;
  /** Newest notification `updated_at` acted on so far, or null before the first probe. */
  watermark: string | null;
}

/** Floor for the probe cadence; also the fallback when the header is absent. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** One notification row, trimmed to the fields we look at. */
interface RawNotification {
  updated_at?: string;
  repository?: { full_name?: string };
}

/**
 * Parses the `X-Poll-Interval` header (seconds) into ms, floored at the
 * default. Missing/garbage → the default. Exported for unit tests.
 */
export function parsePollIntervalMs(header: string | null): number {
  const secs = Number(header);
  if (!Number.isFinite(secs) || secs <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(DEFAULT_POLL_INTERVAL_MS, secs * 1000);
}

/** Newest `updated_at` (ISO, lexicographically comparable) over `items`, or null. */
function newestActivity(items: RawNotification[]): string | null {
  let max: string | null = null;
  for (const n of items) {
    const ts = n.updated_at;
    if (ts && (max === null || ts > max)) max = ts;
  }
  return max;
}

/**
 * Newest `updated_at` among notifications whose repository is one of `repos`,
 * or null when none. The `/notifications` inbox spans every repo the user
 * watches on the host, so this scopes the signal to what the dashboard shows.
 * Case-insensitive (GitHub owner/name are case-insensitive). Exported for tests.
 */
export function newestTrackedActivity(items: RawNotification[], repos: string[]): string | null {
  if (items.length === 0 || repos.length === 0) return null;
  const tracked = new Set(repos.map((r) => r.toLowerCase()));
  let max: string | null = null;
  for (const n of items) {
    const full = n.repository?.full_name?.toLowerCase();
    const ts = n.updated_at;
    if (full !== undefined && ts && tracked.has(full) && (max === null || ts > max)) max = ts;
  }
  return max;
}

/**
 * Probes a host's notification inbox. On the first probe (`prev.watermark`
 * null) it only records a baseline and reports `changed:false` — the poller's
 * regular first tick already hydrates every host, so there is nothing to force.
 */
export async function probeNotifications(
  host: HostConfig,
  prev: NotifState,
): Promise<NotifProbe> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${host.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "github-pr-manager",
  };
  if (prev.lastModified) headers["If-Modified-Since"] = prev.lastModified;

  const url = `${restBaseUrl(host.graphqlUrl)}/notifications?all=false`;
  const res = await fetch(url, { headers, cache: "no-store" });

  const pollIntervalMs = parsePollIntervalMs(res.headers.get("x-poll-interval"));
  const carry = (status: NotifProbe["status"]): NotifProbe => ({
    changed: false,
    lastModified: prev.lastModified,
    watermark: prev.watermark,
    pollIntervalMs,
    status,
  });

  // Not modified — nothing happened. Free against the rate limit.
  if (res.status === 304) return carry("ok");
  // No scope / endpoint absent — disable the detector for this host.
  if (res.status === 403 || res.status === 404) return carry("unavailable");
  // Transient (5xx, etc.): keep the baseline, stay enabled, retry next probe.
  if (!res.ok) return carry("ok");

  const lastModified = res.headers.get("last-modified") ?? prev.lastModified;
  const items = (await res.json().catch(() => [])) as RawNotification[];

  // Advance the watermark to the newest thing in the inbox (tracked or not), so
  // stale/untracked entries never re-trigger. On the first probe, just baseline.
  const newestSeen = newestActivity(items);
  const nextWatermark =
    prev.watermark === null || (newestSeen !== null && newestSeen > prev.watermark)
      ? (newestSeen ?? new Date().toISOString())
      : prev.watermark;

  if (prev.watermark === null) {
    return { changed: false, lastModified, watermark: nextWatermark, pollIntervalMs, status: "ok" };
  }

  const newestTracked = newestTrackedActivity(items, host.repos);
  const changed = newestTracked !== null && newestTracked > prev.watermark;

  return { changed, lastModified, watermark: nextWatermark, pollIntervalMs, status: "ok" };
}
