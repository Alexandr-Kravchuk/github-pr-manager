import { NextResponse } from "next/server";

import { ConfigError, loadPublicConfig } from "@/lib/config";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Returns the sanitized config (poll interval, hosts/repos) — without tokens. */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated.", kind: "auth" }, { status: 401 });
  }
  try {
    return NextResponse.json(loadPublicConfig());
  } catch (e) {
    if (e instanceof ConfigError) {
      return NextResponse.json({ error: e.message, kind: "config" }, { status: 400 });
    }
    throw e;
  }
}
