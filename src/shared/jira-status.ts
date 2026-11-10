/**
 * How the renderer loads the Jira status: the `cached` answer first, so the
 * site link and the grouping options appear at once, then the `fresh` one when
 * twg is still being checked or the caller asked to check it again. Node-free —
 * the renderer value-imports it.
 */
import type { JiraStatus, JiraStatusMode } from "./types";

/**
 * Returns a `load(fresh?)` that feeds `set` and drops every answer to a call
 * that a later `load` has replaced, so a slow `twg whoami` can never overwrite
 * a newer status.
 */
export function createJiraStatusLoader(
  get: (mode: JiraStatusMode) => Promise<JiraStatus>,
  set: (status: JiraStatus) => void,
): (fresh?: boolean) => Promise<void> {
  let latest = 0;
  return async (fresh = false) => {
    const id = ++latest;
    const apply = (status: JiraStatus): void => {
      if (id === latest) set(status);
    };
    try {
      if (!fresh) {
        const status = await get("cached");
        apply(status);
        if (status.twg.state !== "checking" || id !== latest) return;
      }
      apply(await get("fresh"));
    } catch {
      // Best-effort: the previous status stays on screen.
    }
  };
}
