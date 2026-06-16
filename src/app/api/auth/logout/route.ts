/**
 * Logs the user out by clearing the encrypted session cookie.
 *
 * POST-only (a logout is a state change; this keeps it off GET so a prefetch
 * or `<img>` can't trigger it). sameSite=lax on the session cookie plus the
 * same-origin in-app fetch covers CSRF for v1.
 */

import { NextResponse } from "next/server";

import { dropPollerIdentity } from "@/lib/poller";
import { clearSession, getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  // Stop polling on this session's behalf before the cookie is gone, so stale
  // tokens don't keep hitting GitHub after logout.
  const session = await getSession();
  if (session) dropPollerIdentity(session.sid);

  await clearSession();
  return NextResponse.json({ ok: true });
}
