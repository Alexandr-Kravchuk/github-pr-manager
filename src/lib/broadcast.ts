/**
 * In-memory pub/sub for SSE broadcasts.
 *
 * The dashboard is single-user, single-process (one `next start` /
 * launchd LaunchAgent), so a simple Set-of-listeners is enough — no Redis
 * or external pub/sub needed. Each open browser tab is one subscriber.
 */

export interface BroadcastEvent {
  /** SSE event name, e.g. "snapshot" or "config-error". */
  type: string;
  /** Already-encoded payload string (typically JSON). */
  data: string;
}

type Listener = (event: BroadcastEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to broadcasts; returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publish an event to every current subscriber. Listener errors are swallowed. */
export function publish(type: string, data: string): void {
  for (const listener of listeners) {
    try {
      listener({ type, data });
    } catch {
      // A dead controller (client disconnected mid-publish) — its cleanup
      // hook will remove it shortly; don't let one bad listener break others.
    }
  }
}

/** Diagnostic: how many SSE clients are currently connected. */
export function subscriberCount(): number {
  return listeners.size;
}
