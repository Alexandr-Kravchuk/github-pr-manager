/**
 * Encrypted session cookie.
 *
 * The cookie holds the user's per-provider OAuth access tokens, so it must be
 * *encrypted*, not merely signed: a signed (JWS) token is still readable in
 * base64url, which would leak the GitHub tokens to anyone who exfiltrates the
 * cookie. We use JWE direct encryption (`dir` + `A256GCM`) with a key derived
 * from `AUTH_SECRET`, so the payload is opaque at rest.
 *
 * The token never reaches the browser as readable data — the client only ever
 * sees the encrypted blob, and only `httpOnly` reads/writes it server-side.
 */

import { createHash, randomUUID } from "node:crypto";

import { EncryptJWT, jwtDecrypt } from "jose";
import { cookies } from "next/headers";

import type { SessionPayload } from "./types";

export const SESSION_COOKIE = "ghpr_session";

/** 30 days — classic OAuth App tokens don't expire, so the session can be long-lived. */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Derives a 256-bit content-encryption key from `AUTH_SECRET`. SHA-256 lets the
 * operator use any-length secret while A256GCM still gets exactly 32 bytes.
 */
function getKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set — required to encrypt session cookies.");
  }
  return new Uint8Array(createHash("sha256").update(secret).digest());
}

/** Mints a fresh session id for a brand-new login. */
export function newSessionId(): string {
  return randomUUID();
}

/** Encrypts a session payload into a compact JWE string. */
export async function encodeSession(payload: SessionPayload): Promise<string> {
  return new EncryptJWT({ sid: payload.sid, providers: payload.providers })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .encrypt(getKey());
}

/** Decrypts and validates a JWE string. Returns null on any failure (tampered/expired/wrong key). */
export async function decodeSession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtDecrypt(token, getKey());
    const sid = payload.sid;
    const providers = payload.providers;
    if (typeof sid !== "string" || typeof providers !== "object" || providers === null) {
      return null;
    }
    return { sid, providers: providers as SessionPayload["providers"] };
  } catch {
    return null;
  }
}

/**
 * A stable identity key for namespacing seen-state, so the NEW badges survive
 * logout/login and adding a second provider — unlike `sid`, which is fresh per
 * login. Prefers the github.com login, then any provider with a known login;
 * falls back to the ephemeral `sid` only if no viewer login resolved (e.g. a
 * GHE host whose viewer fetch was IP-blocked).
 */
export function sessionUserKey(session: SessionPayload): string {
  const entries = Object.entries(session.providers);
  const preferred =
    entries.find(([id, p]) => id === "github" && p.login) ??
    entries.find(([, p]) => p.login);
  return preferred ? `${preferred[0]}:${preferred[1].login}` : session.sid;
}

/** Flattens a session's providers into a `{ providerId: accessToken }` map for the poller. */
export function sessionTokens(session: SessionPayload): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [id, provider] of Object.entries(session.providers)) {
    tokens[id] = provider.accessToken;
  }
  return tokens;
}

/** Reads the current session from the request cookie, or null if absent/invalid. */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return decodeSession(raw);
}

/** Writes the session cookie (httpOnly, secure, sameSite=lax). Call only in a Route Handler. */
export async function writeSession(payload: SessionPayload): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, await encodeSession(payload), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

/** Clears the session cookie. Call only in a Route Handler. */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
