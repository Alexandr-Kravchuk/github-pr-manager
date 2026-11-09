/**
 * One Jira enrichment pass and how it picks a source: the `twg` CLI first, the
 * stored API token as the fallback. Electron-free, with the twg runner and the
 * token reader injected, so the whole decision is unit-tested in plain Node;
 * `main/jira-store.ts` only wires it to the keychain and the poller.
 *
 * The order:
 *  1. twg. Not installed → silently on to the token. Signed out or failing →
 *     remembered, then on to the token; reported only if the token can't run.
 *     A twg that hung or failed for another reason is skipped for the next
 *     `TWG_BACKOFF_PASSES` passes, so it can't cost every tick its timeout.
 *     Counted in passes, not time: the next tick starts a full poll interval
 *     after this one ends, so any wall-clock window shorter than the interval
 *     would always have expired by then. A signed-out twg is not skipped — it
 *     fails in under a second, and retrying is how a `twg login` done in a
 *     terminal gets picked up.
 *  2. The API token, when there is one and the account email is set. A
 *     credential Jira rejected is not sent again until it changes — the token,
 *     the account email or the site: retrying cannot fix it, only adds failed
 *     sign-ins on the account, and the `auth` health from the rejection stays
 *     up meanwhile.
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
}

/** How many passes a twg that hung or failed (not signed out) is skipped for. */
export const TWG_BACKOFF_PASSES = 5;

/**
 * Fingerprint of the whole credential — site, email and token — so a rejected
 * one is recognised without being kept in memory, and a corrected email or
 * site counts as a new credential.
 */
function fingerprint(baseUrl: string, email: string, token: string): string {
  return createHash("sha256").update(`${baseUrl}\n${email}\n${token}`).digest("hex");
}

/**
 * Builds the pass. Stateful only in remembering the last rejected token, which
 * is why it is a factory: one instance lives as long as the poller.
 */
export function createJiraPass(
  deps: JiraPassDeps,
): (jira: JiraSettings, keys: string[]) => Promise<JiraPassResult | undefined> {
  let rejected: { fingerprint: string; health: JiraHealth } | null = null;
  let twgBackoff: { passesLeft: number; health: JiraHealth } | null = null;
  const debug = deps.debug ?? (() => {});

  /** Starts the twg backoff unless the failure is a sign-out (retried every pass) or a missing twg. */
  function backOffTwg(health: JiraHealth): void {
    if (health.state !== "auth") twgBackoff = { passesLeft: TWG_BACKOFF_PASSES, health };
  }

  async function run(lookup: JiraLookup, source: JiraSource, keys: string[]): Promise<JiraPassResult> {
    const issues = await resolveIssues(lookup, keys);
    // A twg that hangs only on the subtask parents still costs its timeout every
    // pass while the issues themselves come from the cache, so it backs off too.
    const onTasksError =
      source === "twg"
        ? (e: unknown) => {
            if (!(e instanceof TwgNotInstalledError)) backOffTwg(healthFromError(keys.length, e, "twg"));
          }
        : undefined;
    const tasks = await fetchSubtaskParents(lookup, issues.values(), onTasksError);
    return { health: healthFromIssues(keys.length, issues.values(), source), issues, tasks };
  }

  return async (jira, keys) => {
    const empty = (health: JiraHealth): JiraPassResult => ({ health, issues: new Map(), tasks: new Map() });

    let twgProblem: JiraHealth | null = null;
    if (twgBackoff && twgBackoff.passesLeft > 0) {
      twgBackoff.passesLeft--;
      twgProblem = twgBackoff.health;
      debug(`twg in backoff after a failure (${twgBackoff.passesLeft} more passes) — API token fallback`);
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
          backOffTwg(twgProblem);
          debug(`twg failed (${twgProblem.state}): ${twgProblem.message} — API token fallback`);
        }
      }
    }

    // Both sources rejected: report twg's sign-in, the primary fix.
    const reportTokenFailure = (health: JiraHealth): JiraPassResult =>
      empty(health.state === "auth" && twgProblem?.state === "auth" ? twgProblem : health);

    const token = canUseToken(jira, deps.hasToken()) ? deps.readToken() : null;
    if (!token || !canUseToken(jira, true)) return twgProblem ? empty(twgProblem) : undefined;

    const print = fingerprint(jira.baseUrl, jira.email, token);
    if (rejected?.fingerprint === print) {
      debug("API token was rejected and neither it, the email nor the site has changed — not sending it again");
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
