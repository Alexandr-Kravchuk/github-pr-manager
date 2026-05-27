import { NextResponse } from "next/server";

import { markSeen, type SeenInput } from "@/lib/state";

export const runtime = "nodejs";

/** Marks one or more PRs as seen (clears the NEW badge). */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const rawItems = (body as { items?: unknown })?.items;
  if (!Array.isArray(rawItems)) {
    return NextResponse.json({ error: "Expected an items: [] field." }, { status: 400 });
  }

  const items: SeenInput[] = rawItems
    .filter(
      (it): it is SeenInput =>
        typeof it === "object" &&
        it !== null &&
        typeof (it as SeenInput).id === "string" &&
        typeof (it as SeenInput).comments === "number" &&
        typeof (it as SeenInput).updatedAt === "string",
    )
    .map((it) => ({ id: it.id, comments: it.comments, updatedAt: it.updatedAt }));

  await markSeen(items);
  return NextResponse.json({ ok: true, count: items.length });
}
