/**
 * Minimal Jira Cloud client for parent-task grouping. Given a set of issue keys
 * parsed from PR titles (e.g. "ENG-93374"), it resolves each key's parent issue
 * (e.g. the task "ENG-93367" it is a subtask of) via one batched JQL search.
 *
 * Deliberately Electron-free (Node `fetch` + `Buffer`) so it stays testable and
 * runs in the poller. Auth is HTTP Basic with the user's Atlassian email + API
 * token — the token is supplied by the caller (stored encrypted, never here).
 *
 * Supports both Atlassian API-token types transparently, because the token is
 * opaque and the two types need *different* URLs (see `apiBasesFor`):
 *   - a **scoped** (least-privilege, read-only) token only works through the API
 *     gateway `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3`;
 *   - a **classic** (unscoped) token only works against the site URL
 *     `<baseUrl>/rest/api/3`.
 * We try the gateway first and fall back to the site on a 401/403, then cache the
 * winner. A scoped token's recommended scope is just `read:jira-work`.
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

/**
 * Resolved Atlassian cloudId per site base URL — needed to build the API-gateway
 * URL scoped tokens require. The `_edge/tenant_info` endpoint is public. A
 * *resolved* id is cached for the process lifetime; a *failed* lookup (null) is
 * cached only briefly, so a transient network blip on `_edge/tenant_info` can't
 * disable the gateway path until the app restarts.
 */
interface CloudIdEntry {
  id: string | null;
  /** Epoch ms after which a null (failed) result is re-probed; Infinity for a resolved id. */
  expiresAt: number;
}
const cloudIdCache = new Map<string, CloudIdEntry>();
/** A failed cloudId lookup is re-probed after this long; a resolved id never expires. */
const NEGATIVE_CLOUDID_TTL_MS = 60_000;
/**
 * The REST base that actually worked for a site, remembered after the first
 * success so later ticks don't re-probe the gateway (and pay its fallback cost).
 * Only a base whose token type is *settled* is cached (see `fetchChunk`) — a
 * site-only base chosen because the cloudId couldn't be resolved is left
 * uncached so a later tick can still discover the gateway.
 */
const apiBaseCache = new Map<string, string>();

/** Clears all caches (tests / a config change). */
export function clearParentCache(): void {
  parentCache.clear();
  cloudIdCache.clear();
  apiBaseCache.clear();
}

function authHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

function debug(msg: string): void {
  if (process.env.PRD_DEBUG) console.log("[jira]", msg);
}

/** `fetch` with the shared per-request timeout applied via an AbortController. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves the site's Atlassian cloudId from the public `_edge/tenant_info`
 * endpoint (no auth). Cached per base URL; null if it can't be determined, in
 * which case we simply skip the gateway and try the site URL only.
 */
async function resolveCloudId(baseUrl: string): Promise<string | null> {
  const cached = cloudIdCache.get(baseUrl);
  // A resolved id is good for the process lifetime; a null result only until its
  // short TTL lapses, so a transient tenant_info failure self-heals on a later tick.
  if (cached && (cached.id !== null || Date.now() < cached.expiresAt)) return cached.id;
  let id: string | null = null;
  try {
    const res = await fetchWithTimeout(`${baseUrl}/_edge/tenant_info`, {
      headers: { Accept: "application/json", "User-Agent": "github-pr-manager" },
      cache: "no-store",
    });
    if (res.ok) {
      const json = (await res.json()) as { cloudId?: string };
      id = json.cloudId ?? null;
    } else {
      debug(`tenant_info ${res.status} for ${baseUrl}`);
    }
  } catch (e) {
    debug(`tenant_info failed for ${baseUrl}: ${(e as Error).message}`);
    id = null;
  }
  debug(`cloudId for ${baseUrl}: ${id ?? "(none)"}`);
  cloudIdCache.set(baseUrl, {
    id,
    expiresAt: id === null ? Date.now() + NEGATIVE_CLOUDID_TTL_MS : Infinity,
  });
  return id;
}

/**
 * Ordered REST bases to try for this site. Gateway first (scoped tokens), site
 * second (classic tokens); once one succeeds it is cached and returned alone.
 * The order matters: a scoped token on the site URL answers 200-but-empty, which
 * is indistinguishable from a genuine "no matches", so a scoped token must never
 * reach the site URL — whereas a classic token on the gateway answers a clean
 * 401, which `fetchChunk` uses as its fallback trigger.
 */
async function apiBasesFor(config: JiraSettings): Promise<string[]> {
  const cached = apiBaseCache.get(config.baseUrl);
  if (cached) return [cached];
  const bases: string[] = [];
  const cloudId = await resolveCloudId(config.baseUrl);
  if (cloudId) bases.push(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`);
  bases.push(`${config.baseUrl}/rest/api/3`);
  return bases;
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
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: authHeader(config.email, token),
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "github-pr-manager",
    },
    body: JSON.stringify({ jql, fields: ["parent"], maxResults: 100 }),
    cache: "no-store",
  };

  // Try each candidate base. Only 401/403 triggers a fallback: those mean "wrong
  // token type for this base" (e.g. a classic token on the gateway), so the next
  // base is worth trying. Any other status (429/500/…) means the base is right
  // but the call genuinely failed — deliberately surfaced rather than retried on
  // the site URL, where a scoped token would answer 200-but-empty and mask the
  // real error as "no parents found".
  const bases = await apiBasesFor(config);
  debug(`bases to try: ${bases.join(" , ")}`);
  let res: Response | null = null;
  for (let i = 0; i < bases.length; i++) {
    const candidate = await fetchWithTimeout(`${bases[i]}/search/jql`, init);
    debug(`${bases[i]} -> HTTP ${candidate.status}`);
    if ((candidate.status === 401 || candidate.status === 403) && i < bases.length - 1) {
      continue;
    }
    res = candidate;
    // Cache the winner only once the token type is settled — the gateway was a
    // candidate (`bases.length > 1`), so either it won or it was tried and
    // rejected. A lone site base (cloudId unresolved) is NOT cached: a scoped
    // token's 200-but-empty there is indistinguishable from success, and pinning
    // it would permanently hide the gateway. Leaving it uncached lets a later
    // tick re-probe the cloudId and recover.
    if (candidate.ok && bases.length > 1) apiBaseCache.set(config.baseUrl, bases[i]);
    break;
  }
  if (!res) throw new Error("Jira: no reachable API base");
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
