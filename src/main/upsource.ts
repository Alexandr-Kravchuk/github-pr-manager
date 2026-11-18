/**
 * Upsource: the Hub token's storage and the poller's review source.
 *
 * The token is a Hub permanent token (Hub › Profile › Authentication), sent as
 * `Authorization: Bearer`. Like the Jira API token it is encrypted with the OS
 * keychain through Electron `safeStorage` and kept out of `settings.json`. The
 * server address lives in settings.
 *
 * Upsource is an internal server: off the VPN every request fails, and the
 * source then keeps the last reviews it read and reports the error on the
 * host pill rather than emptying the list.
 */
import fs from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";

import {
  UPSOURCE_HOST_LABEL,
  UPSOURCE_REVIEWS_QUERY,
  toUpsourcePrs,
  upsourceUserIds,
  type RawUpsourceReview,
  type RawUpsourceUser,
} from "../shared/upsource";
import type { HostError, PullRequest, Settings, UpsourceStatus } from "../shared/types";

function tokenPath(): string {
  return path.join(app.getPath("userData"), "upsource-token.enc");
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function hasUpsourceToken(): boolean {
  return fs.existsSync(tokenPath());
}

/** Stores (empty string clears) the Upsource token, encrypted. */
export function setUpsourceToken(token: string): { ok: boolean; error?: string } {
  const file = tokenPath();
  if (!token) {
    try {
      fs.rmSync(file, { force: true });
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
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function getUpsourceToken(): string | null {
  if (!encryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(fs.readFileSync(tokenPath()));
  } catch {
    return null;
  }
}

export function getUpsourceStatus(loadSettings: () => Settings): UpsourceStatus {
  let baseUrl: string | null = null;
  try {
    baseUrl = loadSettings().upsource?.baseUrl ?? null;
  } catch {
    baseUrl = null;
  }
  return {
    hasConfig: Boolean(baseUrl),
    baseUrl,
    hasToken: hasUpsourceToken(),
    encryptionAvailable: encryptionAvailable(),
  };
}

/** A refused credential, as opposed to a server that could not be reached. */
export class UpsourceAuthError extends Error {}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** One call's deadline, the body included: a stalled body must not hold a poll. */
const REQUEST_TIMEOUT_MS = 15_000;
/** `getReviews` page size, and how many pages one read takes at most. */
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

/** One Upsource RPC call: `POST <base>/~rpc/<method>` with a JSON body. */
async function rpc<T>(
  fetchFn: FetchFn,
  baseUrl: string,
  token: string,
  method: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  // The token is a Bearer credential: never over plain http. Settings refuse
  // such an address too; this guards a hand-edited settings file.
  if (!baseUrl.startsWith("https://")) {
    throw new Error("Upsource address must use https: the token is not sent over plain http.");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    try {
      res = await fetchFn(`${baseUrl}/~rpc/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new UpsourceAuthError(
          "Upsource rejected the token. Create a new one in Hub and paste it in Settings › Integrations.",
        );
      }
      text = await res.text();
    } catch (e) {
      if (e instanceof UpsourceAuthError) throw e;
      const reason = ctrl.signal.aborted ? "timed out" : (e as Error).message;
      throw new Error(`Upsource is unreachable (${reason}). It is an internal server: check the VPN.`);
    }
  } finally {
    clearTimeout(timer);
  }
  let json: { result?: T; error?: { message?: string } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Upsource ${method}: HTTP ${res.status}, not a JSON answer.`);
  }
  if (json.error) throw new Error(`Upsource ${method}: ${json.error.message ?? "error"}`);
  if (!res.ok || json.result === undefined) throw new Error(`Upsource ${method}: HTTP ${res.status}.`);
  return json.result;
}

/** Reads your open reviews and maps them into dashboard items. */
export async function fetchUpsourceReviews(
  fetchFn: FetchFn,
  baseUrl: string,
  token: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<PullRequest[]> {
  const me = await rpc<{ userId: string; isGuestUser?: boolean }>(fetchFn, baseUrl, token, "getCurrentUser", {}, timeoutMs);
  // An unauthenticated call is answered as the guest, not refused: a guest
  // has no reviews of its own, so the list would silently come back empty.
  if (!me.userId || me.isGuestUser) {
    throw new UpsourceAuthError("Upsource answered as a guest: the token was not accepted.");
  }
  // Paged, so a long list is read whole — up to MAX_PAGES pages, which is far
  // more open reviews than one person has.
  const reviews: RawUpsourceReview[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const got = await rpc<{ reviews?: RawUpsourceReview[]; hasMore?: boolean }>(fetchFn, baseUrl, token, "getReviews", {
      limit: PAGE_SIZE,
      skip: page * PAGE_SIZE,
      query: UPSOURCE_REVIEWS_QUERY,
    }, timeoutMs);
    reviews.push(...(got.reviews ?? []));
    if (!got.hasMore || (got.reviews ?? []).length === 0) break;
  }
  const ids = upsourceUserIds(reviews);
  const users = new Map<string, RawUpsourceUser>();
  if (ids.length > 0) {
    const info = await rpc<{ infos?: RawUpsourceUser[] }>(fetchFn, baseUrl, token, "getUserInfo", { ids }, timeoutMs);
    for (const u of info.infos ?? []) users.set(u.userId, u);
  }
  return toUpsourcePrs(reviews, users, me.userId, baseUrl);
}

export interface UpsourceResult {
  prs: PullRequest[];
  error: HostError | null;
  /** When the reviews were last read (ISO), or null before the first good read. */
  fetchedAt: string | null;
}

export interface UpsourceSourceDeps {
  loadSettings: () => Settings;
  getToken: () => string | null;
  fetchFn?: FetchFn;
  now?: () => number;
  /** One call's deadline; tests shorten it. */
  timeoutMs?: number;
}

/**
 * The poller's Upsource source. It reads at most once per poll interval
 * (a forced refresh reads at once), keeps the last good list through a failed
 * read, and reports nothing at all while Upsource is not set up.
 */
export function createUpsourceSource(deps: UpsourceSourceDeps) {
  const now = deps.now ?? Date.now;
  const fetchFn: FetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
  let last: UpsourceResult = { prs: [], error: null, fetchedAt: null };
  let lastKey = "";
  let nextAt = 0;

  return async function read(force: boolean): Promise<UpsourceResult> {
    let settings: Settings;
    try {
      settings = deps.loadSettings();
    } catch {
      return last;
    }
    const baseUrl = settings.upsource?.baseUrl;
    if (!baseUrl) {
      last = { prs: [], error: null, fetchedAt: null };
      lastKey = "";
      return last;
    }
    const token = deps.getToken();
    if (!token) {
      last = {
        prs: [],
        error: { hostLabel: UPSOURCE_HOST_LABEL, message: "No Upsource token: paste one in Settings › Integrations." },
        fetchedAt: null,
      };
      lastKey = "";
      return last;
    }
    // A new server or token reads at once and drops the old list.
    const key = `${baseUrl}\n${token}`;
    if (key !== lastKey) {
      lastKey = key;
      last = { prs: [], error: null, fetchedAt: null };
      nextAt = 0;
    }
    const t = now();
    if (!force && t < nextAt) return last;
    nextAt = t + Math.max(10, settings.pollIntervalSeconds) * 1000;
    try {
      const prs = await fetchUpsourceReviews(fetchFn, baseUrl, token, deps.timeoutMs);
      last = { prs, error: null, fetchedAt: new Date(t).toISOString() };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A refused token leaves nothing worth showing; a network failure keeps
      // the last list, which is better than a blank one off the VPN.
      last = {
        prs: e instanceof UpsourceAuthError ? [] : last.prs,
        error: { hostLabel: UPSOURCE_HOST_LABEL, message },
        fetchedAt: last.fetchedAt,
      };
    }
    return last;
  };
}
