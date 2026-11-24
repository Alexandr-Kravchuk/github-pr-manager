// Which PRs ask for you right now: a Claude session on the PR waits for your
// answer, and you haven't clicked its tile since it started waiting. The
// tile pulses for them (ClaudeGlow), and the "need you" pill and a collapsed
// group's badge (App.tsx) count them, so one rule decides all three.
//
// "Answered" is per session and module-level, so a re-rendered or remounted
// tile stays still; an entry goes once the session stops waiting, and its
// next wait asks again.

import { sessionGlow, sessionsForPr, shownSession } from "../../shared/claude-sessions";
import type { ClaudeSessionInfo, PullRequest } from "../../shared/types";

const answered = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

export function subscribeNeedsYou(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const needsYouVersion = (): number => version;

export function isAnswered(sessionId: string): boolean {
  return answered.has(sessionId);
}

export function markAnswered(sessionId: string): void {
  if (answered.has(sessionId)) return;
  answered.add(sessionId);
  changed();
}

/** Forget an answer once its session no longer waits. Silent: it only matters for the next wait. */
export function forgetAnswer(sessionId: string): void {
  answered.delete(sessionId);
}

/** The waiting session that asks for you on this PR, or null. */
export function needsYouSession(pr: PullRequest, sessions: readonly ClaudeSessionInfo[]): ClaudeSessionInfo | null {
  const session = shownSession(sessionsForPr(pr, sessions));
  if (!session || sessionGlow(session) !== "waiting" || answered.has(session.id)) return null;
  return session;
}

/**
 * Whether the window is on screen: not hidden to the tray and not minimized —
 * both make the page `document.hidden`. Focus doesn't matter: the pulses are
 * for a window you can see beside the app you work in. (Electron runs with
 * MacWebContentsOcclusion off, so a window fully covered by others still
 * counts as shown.) The tile's and the pill's pulses run only while it holds.
 */
const shownListeners = new Set<() => void>();
let shownListening = false;
export function windowShown(): boolean {
  return !document.hidden;
}
function notifyShown(): void {
  for (const l of shownListeners) l();
}
export function subscribeShown(listener: () => void): () => void {
  if (!shownListening) {
    shownListening = true;
    document.addEventListener("visibilitychange", notifyShown);
  }
  shownListeners.add(listener);
  return () => shownListeners.delete(listener);
}
