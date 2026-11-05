/**
 * Minimal Jira Cloud client for the grouped views. Given a set of issue keys
 * parsed from PR titles (e.g. "ENG-93374"), one batched JQL search resolves each
 * key's own summary (the "group by issue" heading) and its parent issue (e.g. the
 * task "ENG-93367" it is a subtask of, for "group by parent task").
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
import type { JiraTaskInfo } from "./stale";
import type { JiraSettings } from "./types";

/** What one issue key resolved to. */
export interface JiraIssue {
  /** The issue's own summary — null when Jira returned the issue without one. */
  summary: string | null;
  /** The task this issue is a subtask of, or null when it has no parent. */
  parentKey: string | null;
  /** Summary of {@link parentKey}; null when there is no parent, or it has none. */
  parentSummary: string | null;
  /**
   * Whether the issue is a subtask — its parent is then a task, not the epic,
   * so the enricher looks one level higher to reach the epic.
   */
  isSubtask: boolean;
}

interface CacheEntry {
  /**
   * null = Jira didn't return this key at all (a negative cache, so we don't
   * re-query it). An issue that simply has no parent is a *positive* entry with
   * `parentKey: null` — it still carries its own summary.
   */
  issue: JiraIssue | null;
  fetchedAt: number;
}

/** Issue lookups cached per key — summaries and parentage change rarely. */
const issueCache = new Map<string, CacheEntry>();
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
 * A shorter cap for the lightweight, unauthenticated `_edge/tenant_info` probe.
 * On a cold cache during a full Jira outage the enricher pays two *sequential*
 * timeouts in one tick — the cloudId probe, then the site search — so giving the
 * probe the full 10 s doubled the worst-case stall to ~20 s. A tenant_info that
 * hasn't answered in a few seconds is down; capping the probe keeps the cold
 * outage close to the single-request budget the poll expects.
 */
const TENANT_INFO_TIMEOUT_MS = 4_000;

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
 * Separator between a Jira HTTP error's stable prefix ("Jira HTTP 429 …") and the
 * variable response body appended after it. The poller's change-detection
 * (`stableJiraMessage`) splits on this to keep a per-response-varying body from
 * re-emitting a snapshot every tick — so both sides must use the same token.
 */
export const JIRA_ERROR_DETAIL_SEP = " — ";

/**
 * Bumped by `clearJiraCaches()` so an enrichment pass that was already in
 * flight when the caches were cleared (e.g. the user saved a new token mid-tick)
 * can tell that its data belongs to the pre-clear world and must not be written
 * back — otherwise the resolving pass would silently re-pin the stale base and
 * repopulate the just-cleared caches with old-token results.
 */
let cacheEpoch = 0;

/** Clears all caches (tests / a config change) and invalidates in-flight passes. */
export function clearJiraCaches(): void {
  cacheEpoch++;
  issueCache.clear();
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

/** `fetch` with a per-request timeout applied via an AbortController. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    const res = await fetchWithTimeout(
      `${baseUrl}/_edge/tenant_info`,
      {
        headers: { Accept: "application/json", "User-Agent": "github-pr-manager" },
        cache: "no-store",
      },
      TENANT_INFO_TIMEOUT_MS,
    );
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
 * Whether a result is trustworthy enough to *cache* — governs both pinning the
 * winning base (`apiBaseCache`) and writing negative per-key entries.
 *
 * Two ways to be trustworthy:
 *  - `pinned`: the base was already vetted when it was first pinned, so it stays
 *    trusted even though `apiBasesFor` now returns it as a single-element array.
 *    This term must live inside the predicate: a bare `bases.length > 1` check
 *    once treated every steady-state (pinned) call as untrusted and silently
 *    stopped negative caching after the first resolution (a round-3 regression);
 *    folding `pinned` in here keeps that impossible to reintroduce at the (sole)
 *    call site.
 *  - a fresh candidate set that settled the token type cleanly: the gateway was
 *    a candidate (`bases.length > 1`), so a win means scoped and a 401/403 means
 *    classic — and no candidate was skipped via a *thrown* network error
 *    (`cleanFallback`), which tells us nothing about that base's verdict. A lone
 *    site base (cloudId unresolved) can't tell a scoped token's masked
 *    200-but-empty from a genuine no-match, so it is never trusted on its own.
 *
 * Caching an untrusted 200-but-empty would strand the dashboard on the wrong
 * base and keep false negatives alive for `CACHE_TTL_MS` after the gateway
 * recovers — the exact "silent empty" this module exists to prevent.
 */
function resultIsTrustworthy(bases: string[], cleanFallback: boolean, pinned: boolean): boolean {
  return pinned || (cleanFallback && bases.length > 1);
}

interface RawSearchResponse {
  issues?: Array<{
    key: string;
    fields?: {
      summary?: string;
      parent?: { key: string; fields?: { summary?: string } };
      issuetype?: { subtask?: boolean; hierarchyLevel?: number };
    };
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
    // `summary` is the issue's own title (the "group by issue" heading); `parent`
    // brings the parent's key *and* its summary in the same round trip;
    // `issuetype` says whether that parent is a task (a subtask's) or the epic.
    body: JSON.stringify({ jql, fields: ["summary", "parent", "issuetype"], maxResults: 100 }),
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
  // Snapshot the epoch first: if clearJiraCaches() runs while a fetch below is
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
      `Jira HTTP ${res.status} ${res.statusText}${text ? `${JIRA_ERROR_DETAIL_SEP}${text.slice(0, 200)}` : ""}`,
    );
  }
  // Trust a result enough to cache (pin the base + write negatives) when the base
  // was already vetted and pinned on an earlier call, OR the fresh candidate set
  // settled the token type cleanly. Both cases live inside resultIsTrustworthy so
  // the pinned steady-state can't silently fall through to "untrusted".
  const trusted = resultIsTrustworthy(bases, cleanFallback, pinned);
  // A pass that raced a clearJiraCaches() (epoch moved while a fetch was
  // awaited) fetched with the old token: writing it back would re-pin the stale
  // base and repopulate the just-cleared caches, so it must not touch them.
  // fetchIssues then reports this pass as empty — a one-tick blip; the refresh
  // the token/settings change triggers re-resolves immediately with fresh state.
  const writable = epoch === cacheEpoch;
  if (winner && trusted && writable) apiBaseCache.set(config.baseUrl, winner);
  const json = (await res.json()) as RawSearchResponse;
  const returned = new Set<string>();
  for (const issue of json.issues ?? []) {
    returned.add(issue.key);
    const p = issue.fields?.parent;
    const type = issue.fields?.issuetype;
    if (!writable) continue;
    issueCache.set(issue.key, {
      issue: {
        summary: issue.fields?.summary ?? null,
        parentKey: p?.key ?? null,
        parentSummary: p?.fields?.summary ?? null,
        // `subtask` is the long-standing flag; team-managed projects' custom
        // subtask types are recognised by their hierarchy level (-1) instead.
        isSubtask: type?.subtask === true || (type?.hierarchyLevel ?? 0) < 0,
      },
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
      if (!returned.has(key)) issueCache.set(key, { issue: null, fetchedAt: now });
    }
  }
}

/**
 * Resolves the given issue keys. Only keys not already fresh in the cache hit the
 * network. Returns a map of key → issue for every key Jira actually returned;
 * a key it didn't return (unknown, or invisible to this token) is simply absent,
 * while a key that exists but has no parent IS present, with `parentKey: null` —
 * its summary is still worth having for the by-issue heading. Throws on a
 * network / auth error — the caller treats it as best-effort.
 */
export async function fetchIssues(
  config: JiraSettings,
  token: string,
  keys: string[],
): Promise<Map<string, JiraIssue>> {
  const now = Date.now();
  const unique = [...new Set(keys)];
  const stale = unique.filter((k) => {
    const c = issueCache.get(k);
    return !c || now - c.fetchedAt >= CACHE_TTL_MS;
  });
  for (let i = 0; i < stale.length; i += CHUNK_SIZE) {
    await fetchChunk(config, token, stale.slice(i, i + CHUNK_SIZE), now);
  }
  const result = new Map<string, JiraIssue>();
  for (const key of unique) {
    const issue = issueCache.get(key)?.issue;
    if (issue) result.set(key, issue);
  }
  return result;
}

/**
 * Resolves the tasks that the given subtasks belong to, so the caller can read
 * each task's own parent — the epic. One level only: a task's parent is
 * already the epic, and climbing past it would merge unrelated epics under a
 * shared initiative. The tasks go through `fetchIssues` and its cache, so a
 * task that also has a PR of its own costs nothing extra.
 *
 * Best-effort on top of a pass that already succeeded: a failure here returns
 * an empty map instead of throwing, so it costs the epic link, not the issue
 * summaries and parents already resolved.
 */
export async function fetchSubtaskParents(
  config: JiraSettings,
  token: string,
  issues: Iterable<JiraIssue>,
): Promise<Map<string, JiraIssue>> {
  const keys = new Set<string>();
  for (const issue of issues) if (issue.isSubtask && issue.parentKey) keys.add(issue.parentKey);
  if (keys.size === 0) return new Map();
  try {
    return await fetchIssues(config, token, [...keys]);
  } catch (e) {
    debug(`subtask parents failed: ${(e as Error).message}`);
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Task actions for the stale-PR close dialog: read a task's transitions, move
// it through one, or delete it. Unlike the enricher these run once, on a click,
// so a failure is surfaced to the user instead of being swallowed.
// ---------------------------------------------------------------------------

/** Issue keys only — the key is interpolated into the REST path. */
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

function assertIssueKey(key: string): void {
  if (!ISSUE_KEY_RE.test(key)) throw new Error(`Jira: not an issue key: ${key}`);
}

/**
 * Words a refused write in terms of what to fix. The read path works with a
 * read-only token — the one the settings recommend — so a 401/403 here is far
 * more often a missing scope than a wrong token.
 */
function writeRefusal(status: number, body: string): string {
  const detail = body ? `${JIRA_ERROR_DETAIL_SEP}${body.slice(0, 200)}` : "";
  if (status === 401 || status === 403) {
    return `Jira refused the change (HTTP ${status}). The API token may be read-only: a scoped token needs write:jira-work (and delete:issue:jira to delete a task), and your account needs the permission in that project${detail}`;
  }
  return `Jira HTTP ${status}${detail}`;
}

/**
 * One request against whichever REST base answers for this token: the pinned
 * one when the enricher already settled it, else the gateway and then the
 * site, moving on after a 401/403/404 — a classic token answers 401 on the
 * gateway, and a scoped token an anonymous 404 on the site. Every candidate
 * that refused did nothing, so trying the next one cannot apply a change twice.
 * Never pins a base: that stays the enricher's call, made from a trusted read.
 */
async function jiraRequest(
  config: JiraSettings,
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  const { bases } = await apiBasesFor(config);
  const init: RequestInit = {
    method,
    headers: {
      Authorization: authHeader(config.email, token),
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "User-Agent": "github-pr-manager",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  };
  let lastError: unknown = null;
  let last: Response | null = null;
  for (let i = 0; i < bases.length; i++) {
    const isLast = i === bases.length - 1;
    try {
      const res = await fetchWithTimeout(`${bases[i]}${path}`, init);
      debug(`${method} ${bases[i]}${path} -> HTTP ${res.status}`);
      if (!isLast && (res.status === 401 || res.status === 403 || res.status === 404)) {
        last = res;
        continue;
      }
      return res;
    } catch (e) {
      debug(`${method} ${bases[i]}${path} -> threw ${(e as Error).message}`);
      // The timeout surfaces as a bare "This operation was aborted".
      lastError =
        (e as Error).name === "AbortError"
          ? new Error(`Jira didn't answer within ${REQUEST_TIMEOUT_MS / 1000} seconds — try again.`)
          : e;
    }
  }
  if (last) return last;
  throw lastError instanceof Error ? lastError : new Error("Jira: no reachable API base");
}

async function expectOk(res: Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  throw new Error(writeRefusal(res.status, text));
}

interface RawTransitions {
  transitions?: Array<{
    id: string;
    name: string;
    to?: { name?: string; statusCategory?: { key?: string } };
    fields?: Record<
      string,
      { required?: boolean; allowedValues?: Array<{ id?: string; name?: string }> }
    >;
  }>;
}

interface RawIssue {
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    subtasks?: unknown[];
  };
}

/** The task's status, subtasks and the transitions Jira offers on it now. */
export async function fetchTaskInfo(
  config: JiraSettings,
  token: string,
  key: string,
): Promise<JiraTaskInfo> {
  assertIssueKey(key);
  const issueRes = await jiraRequest(config, token, "GET", `/issue/${key}?fields=summary,status,subtasks`);
  if (issueRes.status === 404) throw new Error(`Jira: ${key} was not found, or this token cannot see it.`);
  await expectOk(issueRes);
  const issue = (await issueRes.json()) as RawIssue;
  const trRes = await jiraRequest(config, token, "GET", `/issue/${key}/transitions?expand=transitions.fields`);
  await expectOk(trRes);
  const raw = (await trRes.json()) as RawTransitions;
  return {
    key,
    summary: issue.fields?.summary ?? null,
    status: issue.fields?.status?.name ?? "",
    statusCategory: issue.fields?.status?.statusCategory?.key ?? "",
    subtaskCount: Array.isArray(issue.fields?.subtasks) ? issue.fields.subtasks.length : 0,
    transitions: (raw.transitions ?? []).map((t) => {
      const resolution = t.fields?.resolution;
      return {
        id: String(t.id),
        name: t.name,
        toStatus: t.to?.name ?? t.name,
        toCategory: t.to?.statusCategory?.key ?? "",
        resolutions: (resolution?.allowedValues ?? [])
          .filter((v): v is { id: string; name: string } => typeof v.id === "string" && typeof v.name === "string")
          .map((v) => ({ id: v.id, name: v.name })),
        resolutionRequired: resolution?.required === true,
      };
    }),
  };
}

/** Moves the task through one transition, setting a resolution when given. */
export async function transitionTask(
  config: JiraSettings,
  token: string,
  key: string,
  transitionId: string,
  resolutionId: string | null,
): Promise<void> {
  assertIssueKey(key);
  const body: Record<string, unknown> = { transition: { id: transitionId } };
  if (resolutionId) body.fields = { resolution: { id: resolutionId } };
  await expectOk(await jiraRequest(config, token, "POST", `/issue/${key}/transitions`, body));
  issueCache.delete(key);
}

/**
 * Deletes the task for good. Jira refuses to delete a task that has subtasks
 * unless they go with it, so the caller states that explicitly.
 */
export async function deleteTask(
  config: JiraSettings,
  token: string,
  key: string,
  deleteSubtasks: boolean,
): Promise<void> {
  assertIssueKey(key);
  await expectOk(await jiraRequest(config, token, "DELETE", `/issue/${key}?deleteSubtasks=${deleteSubtasks}`));
  issueCache.delete(key);
}
