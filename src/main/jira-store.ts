/**
 * Jira API-token storage + the poller's Jira enricher.
 *
 * The token is the one credential this app persists, so it is encrypted with the
 * OS keychain via Electron `safeStorage` and written to a separate file — never
 * to `settings.json` (which the project keeps credential-free). The base URL and
 * email live in settings; only the secret is here.
 */
import fs from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";

import { makeDebug } from "../shared/debug";
import {
  enrichmentSkipReason,
  hasJiraConfig,
  healthFromError,
  jiraConfigured,
  jiraSiteState,
  signInSource,
} from "../shared/jira-health";
import { clearJiraCaches } from "../shared/jira";
import { createJiraPass } from "../shared/jira-pass";
import type { TwgRunner } from "../shared/jira-twg";
import { runTwg } from "./twg";
import type { JiraHealth, JiraStatus, PullRequest, Settings, TwgStatus } from "../shared/types";

function jiraTokenPath(): string {
  return path.join(app.getPath("userData"), "jira-token.enc");
}

/** Whether the OS keychain is available to encrypt/decrypt a token. */
function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Whether an encrypted token file is present. */
export function hasJiraToken(): boolean {
  return fs.existsSync(jiraTokenPath());
}

/**
 * Stores (empty string clears) the Jira API token, encrypted. Returns ok=false
 * with a message if the keychain is unavailable or the write fails.
 */
export function setJiraToken(token: string): { ok: boolean; error?: string } {
  const file = jiraTokenPath();
  // A token change invalidates every token-dependent cache: which API base works
  // (a scoped vs classic token needs a different URL) and the resolved issues.
  // Without this, switching token types in a running app keeps a stale/poisoned
  // base cached and the next lookup silently returns nothing.
  if (!token) {
    try {
      fs.rmSync(file, { force: true });
      clearJiraCaches();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  if (!encryptionAvailable()) {
    return { ok: false, error: "OS keychain is unavailable, so the token can't be stored securely." };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, safeStorage.encryptString(token));
    clearJiraCaches();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Decrypts and returns the stored token, or null if absent/unreadable. */
export function getJiraToken(): string | null {
  if (!encryptionAvailable()) return null;
  try {
    const buf = fs.readFileSync(jiraTokenPath());
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

/**
 * Setup state for the settings UI and the grouping gate. The twg status is
 * passed in — read from the cache in `main.ts` — so this never waits on a
 * `twg whoami`.
 */
export function getJiraStatus(loadSettings: () => Settings, twg: TwgStatus): JiraStatus {
  // Both settings-derived fields come from `jiraSiteState`, which is pure and
  // therefore unit-tested — including its fail-closed branch, which is what
  // makes a broken settings file degrade to "no Jira" instead of a broken badge.
  const { hasConfig, baseUrl } = jiraSiteState(loadSettings);
  let jira: Settings["jira"];
  try {
    jira = loadSettings().jira;
  } catch {
    jira = undefined;
  }
  const hasToken = hasJiraToken();
  return {
    configured: jiraConfigured(jira, twg, hasToken),
    twg,
    signInSource: signInSource(jira, twg, hasToken),
    hasConfig,
    hasEmail: Boolean(hasConfig && jira?.email),
    hasToken,
    baseUrl,
    encryptionAvailable: encryptionAvailable(),
  };
}

/**
 * Builds the poller's Jira enricher: resolves the PRs' issue keys and sets
 * `issueSummary` (the by-issue heading) plus `parentKey` / `parentSummary` (the
 * by-parent heading) on each. Returns a `JiraHealth` describing the pass so the
 * UI can explain an empty/failed/rejected result instead of showing silent empty
 * groups; returns `undefined` when there was nothing to do (Jira off, no source
 * that can sign in, or no issue keys). Which source runs — twg, else the API
 * token — is decided by `createJiraPass` (pure, unit-tested). Best-effort —
 * never throws.
 */
export function buildJiraEnricher(
  loadSettings: () => Settings,
  opts: { runTwg?: TwgRunner } = {},
): (prs: PullRequest[]) => Promise<JiraHealth | undefined> {
  const debug = makeDebug("[jira]");
  const pass = createJiraPass({
    runTwg: opts.runTwg ?? runTwg,
    hasToken: hasJiraToken,
    readToken: getJiraToken,
    debug: (line) => debug(line),
  });
  return async (prs: PullRequest[]) => {
    let jira: Settings["jira"];
    try {
      jira = loadSettings().jira;
    } catch (e) {
      debug(`skip: loadSettings threw - ${(e as Error).message}`);
      return undefined;
    }

    // The skip decision lives in the pure, tested `enrichmentSkipReason` so its
    // ordering can't drift untested; the re-check in the `if` is redundant at
    // runtime but lets the compiler narrow `jira` instead of trusting `!`.
    const keys = [...new Set(prs.map((p) => p.issueKey).filter((k): k is string => Boolean(k)))];
    const skip = enrichmentSkipReason(jira, keys.length);
    if (skip || !hasJiraConfig(jira)) {
      debug(() => `skip: ${skip} (prs=${prs.length})`);
      return undefined;
    }

    debug(() => `resolving ${keys.length} keys: ${keys.join(", ")}`);
    try {
      const result = await pass(jira, keys);
      if (!result) {
        debug(() => `skip: no source — twg not installed and no usable API token (hasFile=${hasJiraToken()} encryptionAvailable=${encryptionAvailable()})`);
        return undefined;
      }
      const { issues, tasks } = result;
      debug(() => `${result.health.source ?? "?"} ${result.health.state}: ${[...issues.entries()].map(([k, i]) => `${k}->${i.parentKey ?? "(no parent)"}`).join(", ") || "(none)"}`);
      for (const pr of prs) {
        const issue = pr.issueKey ? issues.get(pr.issueKey) : undefined;
        const task = issue?.isSubtask && issue.parentKey ? tasks.get(issue.parentKey) : undefined;
        pr.issueSummary = issue?.summary ?? null;
        pr.parentKey = issue?.parentKey ?? null;
        pr.parentSummary = issue?.parentSummary ?? null;
        pr.grandparentKey = task?.parentKey ?? null;
        pr.grandparentSummary = task?.parentSummary ?? null;
      }
      // Counted in `healthFromIssues` (pure, and unit-tested for it): `resolved`
      // means parents, not issues — see the rule there for why the distinction
      // is load-bearing for the banner.
      return result.health;
    } catch (e) {
      if (process.env.PRD_DEBUG) console.warn("[jira] issue resolution failed:", (e as Error).message);
      return healthFromError(keys.length, e);
    }
  };
}
