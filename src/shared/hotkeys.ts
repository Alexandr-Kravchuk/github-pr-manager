/**
 * The renderer's side of the keyboard shortcuts.
 *
 * F5 lives here because it is not a menu accelerator: the other shortcuts
 * belong to the application menu (`main/menu.ts`), which fires them whatever
 * has focus. A menu item carries exactly one accelerator, so F5 — the second
 * Refresh key — has to be a renderer `keydown` handler, and this module holds
 * the decision it makes so the decision is unit-testable without a DOM.
 *
 * `shouldAllowForcedRefresh` also lives here, even though the menu's
 * CmdOrCtrl+R and the header button reach it too: it is the one guard shared
 * by all three triggers, so it belongs next to F5's decision rather than
 * duplicated per trigger.
 *
 * Value-imported by the renderer: keep this module free of `node:` builtins
 * (a guard test asserts the compiled output stays clean).
 */

/** The parts of a `KeyboardEvent` the refresh decision reads. */
export interface RefreshKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** True for the OS-generated repeats while the key is held down. */
  repeat: boolean;
}

/**
 * Whether this keypress should force a refresh.
 *
 * Bare F5 only. Modifiers are excluded so the combinations stay free for
 * anything else, and **repeats are excluded** because holding the key down
 * otherwise chains forced polls: the renderer's in-flight guard drops only the
 * calls that arrive *during* a poll, not the ones that arrive right after each
 * one finishes, and every forced poll spends from an hourly GraphQL budget
 * shared with every other client on the same token.
 */
export function shouldRefreshOnKey(event: RefreshKeyEvent): boolean {
  if (event.key !== "F5") return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  return !event.repeat;
}

/**
 * Whether a forced refresh (the header button, CmdOrCtrl+R, or F5) should
 * actually run one, given how recently the last one did.
 *
 * `shouldRefreshOnKey` only screens out an auto-repeated F5; it says nothing
 * about a burst of distinct presses — a fast double-tap of the header button,
 * or CmdOrCtrl+R held down (the menu has no `repeat` flag to filter on the way
 * F5 does). Without this, each press reaches `poller.refresh()`, which by
 * contract bypasses per-host spacing and resets backoff, and also triggers an
 * update check — every one of them spends from an hourly GraphQL budget shared
 * with every other client on the same token. The cooldown is intentionally
 * short: it collapses a burst into one round trip without making a deliberate
 * second press feel unresponsive.
 */
export function shouldAllowForcedRefresh(now: number, lastForcedAt: number, cooldownMs: number): boolean {
  return now - lastForcedAt >= cooldownMs;
}
