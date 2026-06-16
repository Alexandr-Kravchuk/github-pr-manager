import { NextResponse } from "next/server";

import { awaitFirstTick, getConfigError, getSnapshot, seedPoller } from "@/lib/poller";
import { getSession, sessionTokens, sessionUserKey } from "@/lib/session";

// Always fresh data — and we drive that freshness via the per-user poller
// rather than refetching from GitHub on each browser request.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Initial-load endpoint for the dashboard. Seeds the caller's session tokens
 * into their poller (the timer-driven tick can't read the cookie itself), waits
 * for the first tick, then returns that session's cached snapshot.
 *
 * Live updates after the initial load come through `/api/stream` (SSE).
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated.", kind: "auth" }, { status: 401 });
  }

  seedPoller({
    sid: session.sid,
    userKey: sessionUserKey(session),
    tokens: sessionTokens(session),
  });
  await awaitFirstTick(session.sid);

  const configError = getConfigError(session.sid);
  if (configError) {
    return NextResponse.json({ error: configError, kind: "config" }, { status: 400 });
  }

  const snapshot = getSnapshot(session.sid);
  if (!snapshot) {
    // First tick resolved without a snapshot AND without a config error — only
    // on truly exceptional failures. Surface as 503 so the client can retry.
    return NextResponse.json({ error: "No data available yet.", kind: "transient" }, { status: 503 });
  }

  return NextResponse.json(snapshot);
}
