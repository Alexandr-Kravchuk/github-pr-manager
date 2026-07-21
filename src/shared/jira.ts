/**
 * Minimal Jira Cloud client for parent-task grouping. Given a set of issue keys
 * parsed from PR titles (e.g. "ENG-93374"), it resolves each key's parent issue
 * (e.g. the task "ENG-93367" it is a subtask of) via one batched JQL search.
 *
 * Deliberately Electron-free (Node `fetch` + `Buffer`) so it stays testable and
 * runs in the poller. Auth is HTTP Basic with the user's Atlassian email + API
 * token — the token is supplied by the caller (stored encrypted, never here).
 */
import type { JiraSettings } from "./types";

/** A resolved parent for one issue key. */
export interface JiraParent {
  parentKey: string;
  parentSummary: string | null;
}

interface CacheEntry {
  /** null = the key has no parent (a negative cache, so we don't re-query it). */
  parent: JiraParent | null;
  fetchedAt: number;
}

/** Parent lookups cached per issue key — membership changes rarely. */
const parentCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;
/** JQL `key in (...)` handles many keys per request; chunk defensively. */
const CHUNK_SIZE = 50;
/**
 * Hard cap per request. The enricher is awaited inside the poll tick, so an
 * unbounded Jira call would stall dashboard refreshes — this optional feature
 * must never hold the poll hostage.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Clears the parent cache (tests / a config change). */
export function clearParentCache(): void {
  parentCache.clear();
}

function authHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

interface RawSearchResponse {
  issues?: Array<{
    key: string;
    fields?: { parent?: { key: string; fields?: { summary?: string } } };
  }>;
}

/** Queries one chunk of keys and populates the cache (including negatives). */
async function fetchChunk(
  config: JiraSettings,
  token: string,
  keys: string[],
  now: number,
): Promise<void> {
  const jql = `key in (${keys.join(",")})`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/rest/api/3/search/jql`, {
      method: "POST",
      headers: {
        Authorization: authHeader(config.email, token),
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "github-pr-manager",
      },
      body: JSON.stringify({ jql, fields: ["parent"], maxResults: 100 }),
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Jira HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
    );
  }
  const json = (await res.json()) as RawSearchResponse;
  const returned = new Set<string>();
  for (const issue of json.issues ?? []) {
    returned.add(issue.key);
    const p = issue.fields?.parent;
    parentCache.set(issue.key, {
      parent: p ? { parentKey: p.key, parentSummary: p.fields?.summary ?? null } : null,
      fetchedAt: now,
    });
  }
  // Keys Jira didn't return (unknown/no access) get a negative entry too.
  for (const key of keys) {
    if (!returned.has(key)) parentCache.set(key, { parent: null, fetchedAt: now });
  }
}

/**
 * Resolves parents for the given issue keys. Only keys not already fresh in the
 * cache hit the network. Returns a map of key → parent for keys that have one
 * (keys without a parent are simply absent). Throws on a network / auth error —
 * the caller treats it as best-effort.
 */
export async function fetchParents(
  config: JiraSettings,
  token: string,
  keys: string[],
): Promise<Map<string, JiraParent>> {
  const now = Date.now();
  const unique = [...new Set(keys)];
  const stale = unique.filter((k) => {
    const c = parentCache.get(k);
    return !c || now - c.fetchedAt >= CACHE_TTL_MS;
  });
  for (let i = 0; i < stale.length; i += CHUNK_SIZE) {
    await fetchChunk(config, token, stale.slice(i, i + CHUNK_SIZE), now);
  }
  const result = new Map<string, JiraParent>();
  for (const key of unique) {
    const parent = parentCache.get(key)?.parent;
    if (parent) result.set(key, parent);
  }
  return result;
}
