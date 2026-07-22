/**
 * Jira API-token storage + the poller's parent enricher.
 *
 * The token is the one credential this app persists, so it is encrypted with the
 * OS keychain via Electron `safeStorage` and written to a separate file — never
 * to `settings.json` (which the project keeps credential-free). The base URL and
 * email live in settings; only the secret is here.
 */
import fs from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";

import {
  enrichmentSkipReason,
  healthFromError,
  healthFromResolution,
} from "../shared/jira-health";
import { clearParentCache, fetchParents } from "../shared/jira";
import type { JiraHealth, JiraStatus, PullRequest, Settings } from "../shared/types";

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
  // (a scoped vs classic token needs a different URL) and the resolved parents.
  // Without this, switching token types in a running app keeps a stale/poisoned
  // base cached and the next lookup silently returns nothing.
  if (!token) {
    try {
      fs.rmSync(file, { force: true });
      clearParentCache();
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
    clearParentCache();
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

/** Setup state for the settings UI and the grouping gate. */
export function getJiraStatus(loadSettings: () => Settings): JiraStatus {
  let hasConfig = false;
  try {
    const jira = loadSettings().jira;
    hasConfig = Boolean(jira?.baseUrl && jira?.email);
  } catch {
    hasConfig = false;
  }
  const hasToken = hasJiraToken();
  return {
    configured: hasConfig && hasToken,
    hasConfig,
    hasToken,
    encryptionAvailable: encryptionAvailable(),
  };
}

/**
 * Builds the poller's parent enricher: resolves Jira parents for the PRs' issue
 * keys and sets `parentKey` / `parentSummary` on each. Returns a `JiraHealth`
 * describing the pass so the UI can explain an empty/failed result instead of
 * showing silent empty groups; returns `undefined` when there was nothing to do
 * (Jira off, no token, or no issue keys). Best-effort — never throws.
 */
export function buildParentEnricher(
  loadSettings: () => Settings,
): (prs: PullRequest[]) => Promise<JiraHealth | undefined> {
  const debug = (msg: string) => {
    if (process.env.PRD_DEBUG) console.log("[jira]", msg);
  };
  return async (prs: PullRequest[]) => {
    let jira: Settings["jira"];
    try {
      jira = loadSettings().jira;
    } catch (e) {
      debug(`skip: loadSettings threw - ${(e as Error).message}`);
      return undefined;
    }

    // Resolve the token only when the connection is configured (avoid a needless
    // keychain decrypt). The skip decision itself lives in the pure, tested
    // `enrichmentSkipReason` so its ordering can't drift untested.
    const hasConfig = Boolean(jira?.baseUrl && jira?.email);
    const token = hasConfig ? getJiraToken() : null;
    const keys = [...new Set(prs.map((p) => p.issueKey).filter((k): k is string => Boolean(k)))];
    const skip = enrichmentSkipReason(jira, Boolean(token), keys.length);
    if (skip) {
      debug(`skip: ${skip} (hasFile=${hasJiraToken()} encryptionAvailable=${encryptionAvailable()} prs=${prs.length})`);
      return undefined;
    }

    debug(`resolving parents for ${keys.length} keys: ${keys.join(", ")}`);
    try {
      const parents = await fetchParents(jira!, token!, keys);
      debug(`resolved ${parents.size} parents: ${[...parents.entries()].map(([k, p]) => `${k}->${p.parentKey}`).join(", ") || "(none)"}`);
      for (const pr of prs) {
        const parent = pr.issueKey ? parents.get(pr.issueKey) : undefined;
        pr.parentKey = parent?.parentKey ?? null;
        pr.parentSummary = parent?.parentSummary ?? null;
      }
      return healthFromResolution(keys.length, parents.size);
    } catch (e) {
      if (process.env.PRD_DEBUG) console.warn("[jira] parent resolution failed:", (e as Error).message);
      return healthFromError(keys.length, e);
    }
  };
}
