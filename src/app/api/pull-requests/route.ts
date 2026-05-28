import { NextResponse } from "next/server";

import { awaitFirstTick, ensurePollerStarted, getConfigError, getSnapshot } from "@/lib/poller";

// Always fresh data — and we drive that freshness via the singleton poller
// rather than refetching from GitHub on each browser request.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Initial-load endpoint for the dashboard. Returns whatever the server-side
 * poller has cached; if nothing has been polled yet, waits for the very first
 * tick before responding so the first paint isn't empty.
 *
 * Live updates after the initial load come through `/api/stream` (SSE).
 */
export async function GET() {
  ensurePollerStarted();
  await awaitFirstTick();

  const configError = getConfigError();
  if (configError) {
    return NextResponse.json({ error: configError, kind: "config" }, { status: 400 });
  }

  const snapshot = getSnapshot();
  if (!snapshot) {
    // First tick resolved without producing a snapshot AND without a config
    // error — only happens on truly exceptional failures. Surface as 503 so
    // the client can retry.
    return NextResponse.json({ error: "No data available yet.", kind: "transient" }, { status: 503 });
  }

  return NextResponse.json(snapshot);
}
