/**
 * In-memory pub/sub for SSE broadcasts, partitioned per user session (`sid`).
 *
 * Under Tier B each logged-in session polls GitHub with its own identity and
 * therefore sees its own pull requests — so broadcasts must not leak across
 * sessions. Each `sid` owns an independent channel (a Set of listeners); a tab
 * only ever receives events for its own session.
 *
 * Still single-process (one `next start` behind IIS/ARR) — no Redis needed.
 */

export interface BroadcastEvent {
  /** SSE event name, e.g. "snapshot" or "config-error". */
  type: string;
  /** Already-encoded payload string (typically JSON). */
  data: string;
}

type Listener = (event: BroadcastEvent) => void;

/** sid -> set of listeners (open tabs) for that session. */
const channels = new Map<string, Set<Listener>>();

/** Subscribe a session's tab to its channel; returns an unsubscribe function. */
export function subscribe(sid: string, listener: Listener): () => void {
  let set = channels.get(sid);
  if (!set) {
    set = new Set();
    channels.set(sid, set);
  }
  set.add(listener);
  return () => {
    const s = channels.get(sid);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) channels.delete(sid);
  };
}

/** Publish an event to every current subscriber of a session. Listener errors are swallowed. */
export function publish(sid: string, type: string, data: string): void {
  const set = channels.get(sid);
  if (!set) return;
  for (const listener of set) {
    try {
      listener({ type, data });
    } catch {
      // A dead controller (client disconnected mid-publish) — its cleanup
      // hook will remove it shortly; don't let one bad listener break others.
    }
  }
}

/** Diagnostic: how many SSE clients are connected for a session. */
export function subscriberCount(sid: string): number {
  return channels.get(sid)?.size ?? 0;
}
