import type { HostError, RateLimitInfo } from "./types";

/**
 * The colour of a host pill's dot in the header. One word per host instead of
 * the raw GraphQL budget number, which said nothing without a hover:
 *
 *  - `error`   — the last fetch failed outright (red);
 *  - `limited` — the host refused for a spent budget, or the budget is running
 *                low (amber: a wait, not a failure, matching the banner below);
 *  - `ok`      — fetched and plenty left (green);
 *  - `unknown` — no reading yet (grey), e.g. the frame before the first poll.
 *
 * Node-free on purpose: the renderer value-imports it (see AGENTS.md).
 */
export type HostHealth = "ok" | "limited" | "error" | "unknown";

/**
 * Below this share of the hourly budget the dot turns amber. A refresh spends a
 * few points of 5000, so 10% is still hundreds of refreshes — early enough to
 * notice before the host starts refusing.
 */
export const LOW_BUDGET_SHARE = 0.1;
/** The same threshold for a reading that did not report its hourly limit. */
export const LOW_BUDGET_POINTS = 500;

/**
 * Whether a reading carries budget numbers at all. A host whose responses had no
 * `rateLimit` (GHES with rate limiting off) still yields a reading — `remaining`
 * 0, no `limit`, empty `resetAt` — and read as numbers it is "0 points left".
 * The poller treats the same shape as "no budget reported" (`hostIntervalMs`).
 * A spent-budget reading the poller synthesises always carries `resetAt`.
 */
export function hasBudgetReading(rateLimit: Pick<RateLimitInfo, "resetAt">): boolean {
  return rateLimit.resetAt !== "";
}

export function hostHealth(
  rateLimit: Pick<RateLimitInfo, "remaining" | "limit" | "resetAt"> | undefined,
  error: Pick<HostError, "rateLimitedUntil"> | undefined,
): HostHealth {
  if (error) return error.rateLimitedUntil !== undefined ? "limited" : "error";
  if (!rateLimit) return "unknown";
  if (!hasBudgetReading(rateLimit)) return "ok";
  const floor = rateLimit.limit ? rateLimit.limit * LOW_BUDGET_SHARE : LOW_BUDGET_POINTS;
  return rateLimit.remaining < floor ? "limited" : "ok";
}
