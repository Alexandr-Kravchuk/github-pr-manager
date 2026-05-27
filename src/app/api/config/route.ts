import { NextResponse } from "next/server";

import { ConfigError, loadPublicConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Returns the sanitized config (poll interval, hosts/repos) — without tokens. */
export async function GET() {
  try {
    return NextResponse.json(loadPublicConfig());
  } catch (e) {
    if (e instanceof ConfigError) {
      return NextResponse.json({ error: e.message, kind: "config" }, { status: 400 });
    }
    throw e;
  }
}
