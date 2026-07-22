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
import { makeDebug } from "./debug";
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
/**
 * Gateway bases that recently *threw* (proxy blocking api.atlassian.com, DNS,
 * timeout), per site base URL: epoch ms until which the gateway candidate is
 * skipped. Without this, an untrusted thrown fallback — which deliberately never
 * pins a base — would re-probe the gateway and re-pay its 10 s timeout on every
 * chunk of every tick, forever. The backoff only skips the *attempt*; it never
 * pins the site base or marks its results trusted, so the poisoning guarantees
 * around 200-but-empty are unchanged.
 */
const gatewayBackoff = new Map<string, number>();
const GATEWAY_BACKOFF_MS = 60_000;
const GATEWAY_ORIGIN = "https://api.atlassian.com/";

/**
 * Bumped by `clearParentCache()` so an enrichment pass that was already in
 * flight when the caches were cleared (e.g. the user saved a new token mid-tick)
 * can tell that its data belongs to the pre-clear world and must not be written
 * back — otherwise the resolving pass would silently re-pin the stale base and
 * repopulate the just-cleared caches with old-token results.
 */
let cacheEpoch = 0;

/** Clears all caches (tests / a config change) and invalidates in-flight passes. */
export function clearParentCache(): void {
  cacheEpoch++;
  parentCache.clear();
  cloudIdCache.clear();
  apiBaseCache.clear();
  gatewayBackoff.clear();
}

function authHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

const debug = makeDebug("[jira]");

/** Atlassian cloudIds are UUIDs; anything else is treated as unresolved. */
const CLOUD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      const json = (await res.json()) as { cloudId?: unknown };
      // Accept only a UUID-shaped id: the value is interpolated into the gateway
      // URL path, and tenant_info lives on a user-configured host — a malformed
      // (or hostile) value must degrade to "unresolved", not rewrite the URL.
      id = typeof json.cloudId === "string" && CLOUD_ID_RE.test(json.cloudId) ? json.cloudId : null;
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
async function apiBasesFor(
  config: JiraSettings,
): Promise<{ bases: string[]; pinned: boolean }> {
  const cached = apiBaseCache.get(config.baseUrl);
  // A pinned base was already vetted when it was cached (only trusted results are
  // pinned), so flag it: the caller must treat it as trustworthy even though the
  // gateway is no longer in the (now single-element) candidate list.
  if (cached) return { bases: [cached], pinned: true };
  const bases: string[] = [];
  const cloudId = await resolveCloudId(config.baseUrl);
  const backedOffUntil = gatewayBackoff.get(config.baseUrl) ?? 0;
  if (cloudId && Date.now() >= backedOffUntil) {
    bases.push(`${GATEWAY_ORIGIN}ex/jira/${cloudId}/rest/api/3`);
  } else if (cloudId) {
    debug(`gateway in backoff for ${config.baseUrl} (threw recently) — site only this pass`);
  }
  bases.push(`${config.baseUrl}/rest/api/3`);
  return { bases, pinned: false };
}

/**
 * Whether a *freshly-resolved* candidate set is trustworthy enough to *cache* —
 * governs both pinning the winning base (`apiBaseCache`) and writing negative
 * per-key entries. Both are only safe once the token type was settled by clean
 * HTTP responses:
 *
 *  - the gateway was a candidate (`bases.length > 1`), so a win means scoped and
 *    a 401/403 means classic; a lone site base (cloudId unresolved) can't tell a
 *    scoped token's masked 200-but-empty from a genuine no-match; and
 *  - no candidate was skipped via a *thrown* network error (`cleanFallback`),
 *    which tells us nothing about that base's verdict.
 *
 * An already-*pinned* base is trusted separately by the caller (it was vetted
 * when first pinned) — this predicate covers only a fresh candidate set, so it
 * must not be used alone once a base is pinned (the array is then single-element
 * and this would wrongly return false for the steady-state case).
 *
 * Caching an untrusted 200-but-empty would strand the dashboard on the wrong
 * base and keep false negatives alive for `CACHE_TTL_MS` after the gateway
 * recovers — the exact "silent empty" this module exists to prevent.
 */
function resultIsTrustworthy(bases: string[], cleanFallback: boolean): boolean {
  return cleanFallback && bases.length > 1;
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

  // Walk the candidate bases. Two things advance to the next base:
  //   - a clean 401/403 response ("wrong token type for this base", e.g. a
  //     classic token on the gateway) — a *trusted* fallback; and
  //   - a thrown network error (timeout/abort, DNS, or a proxy blocking the
  //     gateway host while allowing the site) — we still try the next base so a
  //     classic token behind such a proxy isn't stranded, but the fallback is
  //     *untrusted*: we never learned this base's verdict (see resultIsTrustworthy).
  // Any other status (429/500/…) means the base answered but the call genuinely
  // failed: surfaced as an error, never retried on the site URL where a scoped
  // token would answer 200-but-empty and mask it as "no parents found".
  // Snapshot the epoch first: if clearParentCache() runs while a fetch below is
  // awaited (a token/config change mid-tick), everything this pass learned is
  // about the old token and must not touch the caches.
  const epoch = cacheEpoch;
  const { bases, pinned } = await apiBasesFor(config);
  debug(() => `bases to try: ${bases.join(" , ")}${pinned ? " (pinned)" : ""}`);
  let res: Response | null = null;
  let winner: string | null = null;
  let cleanFallback = true;
  let lastError: unknown = null;
  for (let i = 0; i < bases.length; i++) {
    const isLast = i === bases.length - 1;
    let candidate: Response;
    try {
      candidate = await fetchWithTimeout(`${bases[i]}/search/jql`, init);
    } catch (e) {
      debug(`${bases[i]} -> threw ${(e as Error).message}`);
      lastError = e;
      cleanFallback = false; // reached the next base without learning this one's verdict
      if (bases[i].startsWith(GATEWAY_ORIGIN) && epoch === cacheEpoch) {
        // Skip the gateway candidate for a while: the throw says nothing about
        // the token type, but re-attempting an unreachable host on every chunk
        // of every tick would stall each poll by the 10 s timeout indefinitely.
        gatewayBackoff.set(config.baseUrl, Date.now() + GATEWAY_BACKOFF_MS);
      }
      if (isLast) break;
      continue;
    }
    debug(`${bases[i]} -> HTTP ${candidate.status}`);
    if ((candidate.status === 401 || candidate.status === 403) && !isLast) {
      continue;
    }
    res = candidate;
    winner = bases[i];
    break;
  }
  if (!res) {
    // Every base failed. Surface a thrown network error if we saw one.
    if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    throw new Error("Jira: no reachable API base");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Jira HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
    );
  }
  // Trust a result enough to cache (pin the base + write negatives) when the base
  // was already vetted and pinned on an earlier call, OR the fresh candidate set
  // settled the token type cleanly. Without the `pinned` term the single-element
  // array returned for a pinned base would make every steady-state call look
  // untrusted and silently stop negative caching after the first resolution.
  const trusted = pinned || resultIsTrustworthy(bases, cleanFallback);
  // A pass that raced a clearParentCache() (epoch moved while a fetch was
  // awaited) fetched with the old token: writing it back would re-pin the stale
  // base and repopulate the just-cleared caches, so it must not touch them.
  // fetchParents then reports this pass as empty — a one-tick blip; the refresh
  // the token/settings change triggers re-resolves immediately with fresh state.
  const writable = epoch === cacheEpoch;
  if (winner && trusted && writable) apiBaseCache.set(config.baseUrl, winner);
  const json = (await res.json()) as RawSearchResponse;
  const returned = new Set<string>();
  for (const issue of json.issues ?? []) {
    returned.add(issue.key);
    const p = issue.fields?.parent;
    if (!writable) continue;
    parentCache.set(issue.key, {
      parent: p ? { parentKey: p.key, parentSummary: p.fields?.summary ?? null } : null,
      fetchedAt: now,
    });
  }
  // Keys Jira didn't return get a negative entry — but only from a trusted base.
  // A 200-but-empty reached via an unverified base (cloudId unresolved, or past a
  // thrown error) might be a scoped token that should have used the gateway;
  // caching those negatives for CACHE_TTL_MS would keep the banner "empty" for up
  // to 10 min after the gateway recovers. Skip them so the keys are re-queried on
  // the next tick, once the gateway is reachable again.
  if (trusted && writable) {
    for (const key of keys) {
      if (!returned.has(key)) parentCache.set(key, { parent: null, fetchedAt: now });
    }
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
