/**
 * Step 2 of the Authorization Code flow.
 *
 * Verifies the CSRF `state`, exchanges the `code` for an access token (the
 * confidential exchange that needs `client_secret` — which is why this can't
 * run on a static host), fetches the viewer login, and merges the result into
 * the encrypted session. A user can connect both providers; each callback adds
 * or replaces just its own entry, keeping any other provider already linked.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getHostByProvider } from "@/lib/config";
import { publicBaseUrl, resolveProvider, type OAuthProvider } from "@/lib/oauth";
import { getSession, newSessionId, writeSession } from "@/lib/session";

import { STATE_COOKIE_PREFIX } from "../../login/[provider]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Redirect back to /login with a short reason code (no secrets in the URL). */
function fail(req: Request, reason: string): NextResponse {
  const url = new URL("/login", publicBaseUrl(req));
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url.toString());
}

/** Exchanges the authorization code for an access token. Returns null on any failure. */
async function exchangeCode(
  p: OAuthProvider,
  code: string,
  redirectUri: string,
): Promise<string | null> {
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
  return json?.access_token ?? null;
}

/**
 * Fetches the viewer login via GraphQL (works uniformly for github.com, GHE
 * Cloud and Enterprise Server). Best-effort: on a GHE host whose IP allow-list
 * isn't open yet this fails, so we degrade gracefully and keep the token — the
 * label is filled in later — rather than blocking the login.
 */
async function fetchViewerLogin(graphqlUrl: string, accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "github-pr-manager",
      },
      body: JSON.stringify({ query: "{ viewer { login } }" }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { viewer?: { login?: string } } };
    return json.data?.viewer?.login ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;

  const host = getHostByProvider(provider);
  if (!host) return fail(req, "unknown_provider");

  let p: OAuthProvider;
  try {
    p = resolveProvider(host);
  } catch {
    return fail(req, "provider_misconfigured");
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // One-time use: verify and immediately drop the state cookie.
  const store = await cookies();
  const stateCookie = `${STATE_COOKIE_PREFIX}${provider}`;
  const expected = store.get(stateCookie)?.value;
  store.delete(stateCookie);

  if (!code || !state || !expected || state !== expected) {
    return fail(req, "bad_state");
  }

  const accessToken = await exchangeCode(p, code, `${publicBaseUrl(req)}/api/auth/callback/${provider}`);
  if (!accessToken) return fail(req, "exchange_failed");

  const login = await fetchViewerLogin(host.graphqlUrl, accessToken);

  // Merge into the existing session (keep any other provider already linked).
  const existing = await getSession();
  const sid = existing?.sid ?? newSessionId();
  await writeSession({
    sid,
    providers: { ...(existing?.providers ?? {}), [provider]: { accessToken, login } },
  });

  return NextResponse.redirect(new URL("/", publicBaseUrl(req)).toString());
}
