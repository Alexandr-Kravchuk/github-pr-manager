/**
 * One Jira enrichment pass and how it picks a source: the `twg` CLI first, the
 * stored API token as the fallback. Electron-free, with the twg runner and the
 * token reader injected, so the whole decision is unit-tested in plain Node;
 * `main/jira-store.ts` only wires it to the keychain and the poller.
 *
 * The order:
 *  1. twg. Not installed → silently on to the token. Signed out or failing →
 *     remembered, then on to the token; reported only if the token can't run.
 *     A twg that hung or failed for another reason is skipped for
 *     `TWG_BACKOFF_MS`, so it can't cost every tick its timeout; a signed-out
 *     one is not — it fails in under a second, and retrying is how a
 *     `twg login` done in a terminal gets picked up.
 *  2. The API token, when there is one and the account email is set. A token
 *     Jira rejected is not sent again until it changes: retrying cannot fix it,
 *     only adds failed sign-ins on the account, and the `auth` health from the
 *     rejection stays up meanwhile.
 * When both are rejected, twg's sign-in is what the health reports: it is the
 * primary source, and signing in there fixes it for good.
 */
import { createHash } from "node:crypto";

import { fetchSubtaskParents, resolveIssues, TwgNotInstalledError, type JiraIssue, type JiraLookup } from "./jira";
import { canUseToken, healthFromError, healthFromIssues } from "./jira-health";
import type { TwgRunner } from "./jira-twg";
import type { JiraHealth, JiraSettings, JiraSource } from "./types";

export interface JiraPassResult {
  health: JiraHealth;
  /** Issue key → what it resolved to (absent when the key resolved nothing). */
  issues: Map<string, JiraIssue>;
  /** Subtask parent (a task) key → that task, so the caller can read the epic above it. */
  tasks: Map<string, JiraIssue>;
}

export interface JiraPassDeps {
  /** Runs `twg`; see `main/twg.ts`. */
  runTwg: TwgRunner;
  /** Whether an API token is stored — checked before `readToken`, to skip a needless keychain decrypt. */
  hasToken: () => boolean;
  /** Decrypts the stored API token; null when it can't. */
  readToken: () => string | null;
  /** Debug sink. */
  debug?: (line: string) => void;
  /** Clock, for the twg backoff; defaults to `Date.now`. */
  now?: () => number;
}

/** How long a twg that hung or failed (not signed out) is skipped. */
export const TWG_BACKOFF_MS = 60_000;

/** Fingerprint of a token, so a rejected one is recognised without being kept in memory. */
function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Builds the pass. Stateful only in remembering the last rejected token, which
 * is why it is a factory: one instance lives as long as the poller.
 */
export function createJiraPass(
  deps: JiraPassDeps,
): (jira: JiraSettings, keys: string[]) => Promise<JiraPassResult | undefined> {
  let rejected: { fingerprint: string; health: JiraHealth } | null = null;
  let twgBackoff: { until: number; health: JiraHealth } | null = null;
  const debug = deps.debug ?? (() => {});
  const now = deps.now ?? Date.now;

  async function run(lookup: JiraLookup, source: JiraSource, keys: string[]): Promise<JiraPassResult> {
    const issues = await resolveIssues(lookup, keys);
    const tasks = await fetchSubtaskParents(lookup, issues.values());
    return { health: healthFromIssues(keys.length, issues.values(), source), issues, tasks };
  }

  return async (jira, keys) => {
    const empty = (health: JiraHealth): JiraPassResult => ({ health, issues: new Map(), tasks: new Map() });

    let twgProblem: JiraHealth | null = null;
    if (twgBackoff && now() < twgBackoff.until) {
      twgProblem = twgBackoff.health;
      debug("twg in backoff after a failure — API token fallback");
    } else {
      twgBackoff = null;
      try {
        const result = await run({ kind: "twg", baseUrl: jira.baseUrl, run: deps.runTwg }, "twg", keys);
        debug(`twg resolved ${result.issues.size} of ${keys.length} keys`);
        return result;
      } catch (e) {
        if (e instanceof TwgNotInstalledError) debug("twg not installed — API token fallback");
        else {
          twgProblem = healthFromError(keys.length, e, "twg");
          if (twgProblem.state !== "auth") twgBackoff = { until: now() + TWG_BACKOFF_MS, health: twgProblem };
          debug(`twg failed (${twgProblem.state}): ${twgProblem.message} — API token fallback`);
        }
      }
    }

    // Both sources rejected: report twg's sign-in, the primary fix.
    const reportTokenFailure = (health: JiraHealth): JiraPassResult =>
      empty(health.state === "auth" && twgProblem?.state === "auth" ? twgProblem : health);

    const token = canUseToken(jira, deps.hasToken()) ? deps.readToken() : null;
    if (!token || !canUseToken(jira, true)) return twgProblem ? empty(twgProblem) : undefined;

    const print = fingerprint(token);
    if (rejected?.fingerprint === print) {
      debug("API token was rejected and has not changed — not sending it again");
      return reportTokenFailure(rejected.health);
    }
    try {
      const result = await run({ kind: "token", config: jira, token }, "token", keys);
      rejected = null;
      return result;
    } catch (e) {
      const health = healthFromError(keys.length, e, "token");
      if (health.state === "auth") rejected = { fingerprint: print, health };
      return reportTokenFailure(health);
    }
  };
}
