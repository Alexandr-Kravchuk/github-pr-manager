/**
 * The renderer's side of the keyboard shortcuts.
 *
 * Only F5 lives here: the other accelerators belong to the application menu
 * (`main/menu.ts`), which fires them whatever has focus. A menu item carries
 * exactly one accelerator, so F5 — the second Refresh key — has to be a
 * renderer `keydown` handler, and this module holds the decision it makes so
 * the decision is unit-testable without a DOM.
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
