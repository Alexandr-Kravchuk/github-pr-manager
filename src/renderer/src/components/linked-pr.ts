import { linkedPrPlace, type LinkedPrPlace } from "../../../shared/pr-group";

/**
 * Lights up the card or tile of another PR while the pointer is on a marker
 * that names it — the "on #N" umbrella of a hand-made stacked PR. A class
 * toggled on the element itself rather than React state: a hover must not
 * re-render every card of the list, and the PR it names may sit in another
 * group. Each card and tile root carries `data-pr-id` for this.
 */
const LINKED_CLASS = "pr-linked";

function elementsOf(prId: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-pr-id="${CSS.escape(prId)}"]`)];
}

export function setLinkedHighlight(prId: string, on: boolean): void {
  for (const el of elementsOf(prId)) el.classList.toggle(LINKED_CLASS, on);
}

/**
 * Where that PR is right now. The sticky header covers the top of the window,
 * so a card scrolled under it is not "visible" even though it is in the
 * viewport.
 */
export function locateLinkedPr(prId: string): LinkedPrPlace {
  const header = document.querySelector("header");
  const viewTop = header ? header.getBoundingClientRect().bottom : 0;
  return linkedPrPlace(
    elementsOf(prId).map((el) => el.getBoundingClientRect()),
    viewTop,
    window.innerHeight,
  );
}
