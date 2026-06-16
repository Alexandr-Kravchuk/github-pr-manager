/**
 * Step 1 of the Authorization Code (web-redirect) flow.
 *
 * Generates a CSRF `state`, stashes it in a short-lived httpOnly cookie, and
 * redirects the browser to the provider's authorize page. The user enters
 * their credentials on github.com / the GHE tenant — never here.
 */

import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getHostByProvider } from "@/lib/config";
import { callbackUrl, isSecureDeployment, resolveProvider } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const STATE_COOKIE_PREFIX = "ghpr_oauth_state_";

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;

  const host = getHostByProvider(provider);
  if (!host) {
    return NextResponse.json({ error: `Unknown OAuth provider "${provider}".` }, { status: 404 });
  }

  let p;
  try {
    p = resolveProvider(host);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const state = randomUUID();
  (await cookies()).set(`${STATE_COOKIE_PREFIX}${provider}`, state, {
    httpOnly: true,
    secure: isSecureDeployment(),
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes to complete the round-trip.
  });

  const authorize = new URL(p.authorizeUrl);
  authorize.searchParams.set("client_id", p.clientId);
  authorize.searchParams.set("redirect_uri", callbackUrl(req, provider));
  authorize.searchParams.set("scope", p.scopes.join(" "));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");

  return NextResponse.redirect(authorize.toString());
}
