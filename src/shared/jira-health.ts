/**
 * Pure classification of a Jira parent-enrichment pass into a `JiraHealth`
 * signal, split out of the Electron-bound `main/jira-store.ts` so the decision
 * logic — the PR's "no more silent empty groups" behaviour — is unit-testable in
 * the plain-Node test runner (which can't `require` anything importing electron).
 */
import type { JiraHealth, JiraSettings } from "./types";

/** Why a parent-enrichment pass has nothing to do; null when it should run. */
export type EnrichmentSkipReason = "no-config" | "no-token" | "no-keys";

/**
 * Decides whether enrichment is applicable, returning the skip reason if not.
 * Checked in order: connection config, then a stored token, then any issue keys.
 */
export function enrichmentSkipReason(
  jira: JiraSettings | undefined,
  hasToken: boolean,
  keyCount: number,
): EnrichmentSkipReason | null {
  if (!jira?.baseUrl || !jira.email) return "no-config";
  if (!hasToken) return "no-token";
  if (keyCount === 0) return "no-keys";
  return null;
}

/**
 * Health for a completed pass: `ok` when at least one parent resolved, else
 * `empty` (the call succeeded but nothing resolved — token can't see the issues,
 * or none are subtasks).
 */
export function healthFromResolution(queried: number, resolved: number): JiraHealth {
  return { state: resolved > 0 ? "ok" : "empty", queried, resolved };
}

/** Health for a failed pass — `error` carrying the failure detail. */
export function healthFromError(queried: number, error: unknown): JiraHealth {
  const message = error instanceof Error ? error.message : String(error);
  return { state: "error", message, queried, resolved: 0 };
}
