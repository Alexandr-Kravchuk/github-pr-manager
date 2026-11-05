/**
 * PROTOTYPE — throwaway, see AgentPrototype.tsx. Which `?variant=` is on, in
 * one place both the header (App.tsx: the Board segment of the view switch) and
 * the prototype read, so switching variants needs no reload.
 */
import { useSyncExternalStore } from "react";

export const VARIANT_KEYS = ["A", "B", "C", "D", "E"] as const;

function fromUrl(): string | null {
  const v = new URLSearchParams(window.location.search).get("variant")?.toUpperCase() ?? null;
  return v && (VARIANT_KEYS as readonly string[]).includes(v) ? v : null;
}

let current: string | null = fromUrl();
const listeners = new Set<() => void>();

export function setAgentVariant(key: string): void {
  current = key;
  const url = new URL(window.location.href);
  url.searchParams.set("variant", key);
  window.history.replaceState(null, "", url);
  for (const l of listeners) l();
}

/** The variant on screen, or null when the page was opened without `?variant=`. */
export function useAgentVariant(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
