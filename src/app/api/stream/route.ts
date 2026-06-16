/**
 * Server-Sent Events stream of dashboard updates.
 *
 * Each connected browser tab opens one EventSource against this route. The
 * route hooks the tab into the in-memory broadcast channel (see
 * `lib/broadcast.ts`), so when the singleton poller (`lib/poller.ts`) sees a
 * change at GitHub, every open tab gets it pushed within milliseconds — no
 * client-side polling needed.
 *
 * Wire protocol (each event is named so the client can `addEventListener`):
 *  - `event: snapshot`     → JSON `DashboardResponse`
 *  - `event: config-error` → plain-text error message
 *  - `: keepalive`         → comment line, every 25s, to keep proxies honest
 *
 * On connect we immediately send the current cached snapshot (if any), so
 * a fresh tab paints instantly without waiting for the next poll tick.
 */

import { subscribe } from "@/lib/broadcast";
import { getConfigError, getSnapshot, seedPoller } from "@/lib/poller";
import { getSession, sessionTokens, sessionUserKey } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

/** Format an SSE event frame: `event: <type>\ndata: <line>\n…\n\n`. */
function frame(type: string, data: string): Uint8Array {
  // Per spec, multi-line payloads need one `data:` line per source line.
  const lines = data.split("\n").map((l) => `data: ${l}`).join("\n");
  return encoder.encode(`event: ${type}\n${lines}\n\n`);
}

const HEARTBEAT_MS = 25_000;

export async function GET(req: Request) {
  // The browser's EventSource can't read a 401 body and would reconnect-loop,
  // so the page drives the auth gate via its regular `fetch` calls. Here we
  // just refuse to open the stream when there's no session — no body to parse,
  // the connection simply doesn't establish.
  const session = await getSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sid = session.sid;

  // Opening a tab is also a valid trigger to (re)start the session's poller.
  seedPoller({ sid, userKey: sessionUserKey(session), tokens: sessionTokens(session) });

  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Client already disconnected before `start` ran (rare but possible:
      // very fast HEAD probes, prefetch abort, etc.). Bail out before
      // subscribing — otherwise the listener stays in the Set forever and
      // every publish will throw on its enqueue.
      if (req.signal.aborted) {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
        return;
      }

      // Replay current state so the tab paints without a server round-trip.
      const snapshot = getSnapshot(sid);
      if (snapshot) {
        controller.enqueue(frame("snapshot", JSON.stringify(snapshot)));
      }
      const configError = getConfigError(sid);
      if (configError) {
        controller.enqueue(frame("config-error", configError));
      }

      unsubscribe = subscribe(sid, ({ type, data }) => {
        try {
          controller.enqueue(frame(type, data));
        } catch {
          // Controller closed under us — the abort/cancel hook will tidy up.
        }
      });

      // Comment-only line keeps the connection warm through idle proxies
      // and surfaces a dead client as an enqueue error.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // Same as above.
        }
      }, HEARTBEAT_MS);

      // When the client navigates away or closes the tab, fetch aborts the
      // request — that's our cue to drop the subscription.
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
    cancel() {
      // Stream consumer went away (e.g. client disconnect, proxy timeout).
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx / similar reverse proxies sometimes buffer this content type;
      // this header asks them not to. Harmless on direct `next start`.
      "X-Accel-Buffering": "no",
    },
  });
}
