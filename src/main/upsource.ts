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

/** One call's deadline, the body included: a stalled body must not hold a read. */
const REQUEST_TIMEOUT_MS = 15_000;
/** One whole read's deadline, every call of it together. */
const READ_DEADLINE_MS = 45_000;
/** `getReviews` page size, and how many pages one read takes at most. */
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

/**
 * Why a call never got an answer, in words that carry no request data: a
 * fetch error's own message can quote a header value, the token included.
 */
function failureReason(e: unknown, aborted: boolean): string {
  if (aborted) return "timed out";
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : "network error";
}

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
      throw new Error(
        `Upsource is unreachable (${failureReason(e, ctrl.signal.aborted)}). It is an internal server: check the VPN.`,
      );
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

/**
 * Reads your open reviews and maps them into dashboard items. Each call has
 * its own deadline, and all of them together share `deadlineMs`, so a server
 * that answers slowly cannot stretch one read over every page.
 */
export async function fetchUpsourceReviews(
  fetchFn: FetchFn,
  baseUrl: string,
  token: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  deadlineMs = READ_DEADLINE_MS,
): Promise<PullRequest[]> {
  const end = Date.now() + deadlineMs;
  const call = <T>(method: string, body: unknown): Promise<T> => {
    const left = end - Date.now();
    if (left <= 0) throw new Error("Upsource is unreachable (timed out). It is an internal server: check the VPN.");
    return rpc<T>(fetchFn, baseUrl, token, method, body, Math.min(timeoutMs, left));
  };
  const me = await call<{ userId: string; isGuestUser?: boolean }>("getCurrentUser", {});
  // An unauthenticated call is answered as the guest, not refused: a guest
  // has no reviews of its own, so the list would silently come back empty.
  if (!me.userId || me.isGuestUser) {
    throw new UpsourceAuthError("Upsource answered as a guest: the token was not accepted.");
  }
  // Paged, so a long list is read whole — up to MAX_PAGES pages, which is far
  // more open reviews than one person has.
  const reviews: RawUpsourceReview[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const got = await call<{ reviews?: RawUpsourceReview[]; hasMore?: boolean }>("getReviews", {
      limit: PAGE_SIZE,
      skip: page * PAGE_SIZE,
      query: UPSOURCE_REVIEWS_QUERY,
    });
    reviews.push(...(got.reviews ?? []));
    if (!got.hasMore || (got.reviews ?? []).length === 0) break;
  }
  const ids = upsourceUserIds(reviews);
  const users = new Map<string, RawUpsourceUser>();
  if (ids.length > 0) {
    const info = await call<{ infos?: RawUpsourceUser[] }>("getUserInfo", { ids });
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

/** What the poller sees of Upsource: never a promise it would have to wait for. */
export interface UpsourceSource {
  /** The reviews as last read — or what the settings say right now when Upsource is off or has no token. */
  current(): UpsourceResult;
  /**
   * Starts a read in the background when one is due, or at once with
   * `force`. One read at a time: a forced kick during a read runs one more
   * right after it, so a token saved mid-read is read with.
   */
  kick(force: boolean): void;
  /** When the next read is due (epoch ms), or null while Upsource is off. */
  nextDueAt(): number | null;
  /** Resolves once no read is running — for tests. */
  idle(): Promise<void>;
}

export interface UpsourceSourceDeps {
  loadSettings: () => Settings;
  getToken: () => string | null;
  /** Called after every read that finished: the poller builds its snapshot again. */
  onUpdate?: () => void;
  fetchFn?: FetchFn;
  now?: () => number;
  /** One call's deadline and one read's; tests shorten them. */
  timeoutMs?: number;
  deadlineMs?: number;
}

const EMPTY: UpsourceResult = { prs: [], error: null, fetchedAt: null };
const NO_TOKEN: UpsourceResult = {
  prs: [],
  error: { hostLabel: UPSOURCE_HOST_LABEL, message: "No Upsource token: paste one in Settings › Integrations." },
  fetchedAt: null,
};

/**
 * The poller's Upsource source. It reads in the background, at most once per
 * poll interval (a forced kick reads at once), keeps the last good list
 * through a failed read, and reports nothing while Upsource is not set up.
 * The poller takes `current()` as it is and is told by `onUpdate` when a read
 * finished, so a slow or hanging Upsource never holds a GitHub snapshot back.
 */
export function createUpsourceSource(deps: UpsourceSourceDeps): UpsourceSource {
  const now = deps.now ?? Date.now;
  const fetchFn: FetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
  let last: UpsourceResult = EMPTY;
  /** The server and token `last` was read with. */
  let lastKey = "";
  let nextAt = 0;
  let running: Promise<void> | null = null;
  let again = false;

  /** The settings' view right now: off, no token, or the server and token to read with. */
  const config = (): { state: "off" } | { state: "no-token" } | { state: "on"; baseUrl: string; token: string; intervalMs: number } => {
    let settings: Settings;
    try {
      settings = deps.loadSettings();
    } catch {
      return { state: "off" };
    }
    const baseUrl = settings.upsource?.baseUrl;
    if (!baseUrl) return { state: "off" };
    const token = deps.getToken();
    if (!token) return { state: "no-token" };
    return { state: "on", baseUrl, token, intervalMs: Math.max(10, settings.pollIntervalSeconds) * 1000 };
  };

  const readOnce = async (baseUrl: string, token: string, intervalMs: number): Promise<void> => {
    const key = `${baseUrl}\n${token}`;
    const t = now();
    nextAt = t + intervalMs;
    let result: UpsourceResult;
    try {
      const prs = await fetchUpsourceReviews(fetchFn, baseUrl, token, deps.timeoutMs, deps.deadlineMs);
      result = { prs, error: null, fetchedAt: new Date(t).toISOString() };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A refused token leaves nothing worth showing; a network failure keeps
      // the last list of the same server and token, which is better than a
      // blank one off the VPN.
      const kept = key === lastKey ? last : EMPTY;
      result = {
        prs: e instanceof UpsourceAuthError ? [] : kept.prs,
        error: { hostLabel: UPSOURCE_HOST_LABEL, message },
        fetchedAt: kept.fetchedAt,
      };
    }
    // A read of a server or token the settings no longer name is dropped:
    // the next one, with what they name now, is already queued.
    const c = config();
    if (c.state === "on" && `${c.baseUrl}\n${c.token}` === key) {
      last = result;
      lastKey = key;
    } else {
      again = true;
    }
  };

  const start = (): void => {
    const c = config();
    if (c.state !== "on") return;
    running = readOnce(c.baseUrl, c.token, c.intervalMs)
      .catch((e) => console.error("[upsource] read failed:", e))
      .finally(() => {
        running = null;
        deps.onUpdate?.();
        if (again) {
          again = false;
          start();
        }
      });
  };

  return {
    current() {
      const c = config();
      if (c.state === "off") return EMPTY;
      if (c.state === "no-token") return NO_TOKEN;
      // A new server or token shows nothing of the old one while it is read.
      return `${c.baseUrl}\n${c.token}` === lastKey ? last : EMPTY;
    },
    kick(force) {
      const c = config();
      if (c.state !== "on") return;
      const stale = `${c.baseUrl}\n${c.token}` !== lastKey;
      if (running) {
        if (force || stale) again = true;
        return;
      }
      if (force || stale || now() >= nextAt) start();
    },
    nextDueAt() {
      return config().state === "on" ? nextAt : null;
    },
    async idle() {
      while (running) await running;
    },
  };
}
