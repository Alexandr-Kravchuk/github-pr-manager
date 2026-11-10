/**
 * Lights up the card or tile of another PR while the pointer is on a marker
 * that names it — the "on #N" umbrella of a hand-made stacked PR. A class
 * toggled on the element itself rather than React state: a hover must not
 * re-render every card of the list, and the PR it names may sit in another
 * group. Each card and tile root carries `data-pr-id` for this.
 */
const LINKED_CLASS = "pr-linked";

function elementsOf(prId: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>(`[data-pr-id="${CSS.escape(prId)}"]`);
}

/** Handlers for the marker: highlight on pointer or focus, clear on leave or blur. */
export function linkedPrHandlers(prId: string) {
  const on = () => elementsOf(prId).forEach((el) => el.classList.add(LINKED_CLASS));
  const off = () => elementsOf(prId).forEach((el) => el.classList.remove(LINKED_CLASS));
  return { onMouseEnter: on, onMouseLeave: off, onFocus: on, onBlur: off };
}
