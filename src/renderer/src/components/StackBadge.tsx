import { createPortal } from "react-dom";
import { stackTitle } from "../../../shared/pr-group";
import type { PullRequest } from "../../../shared/types";
import { cn } from "../format";
import { useAnchoredMenu } from "./anchored-menu";

/** GitHub's stack glyph: three layers. */
function StackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 2 9 5-9 5-9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  );
}

const STATE_CLASS: Record<string, string> = {
  OPEN: "text-emerald-600 dark:text-emerald-400",
  MERGED: "text-violet-600 dark:text-violet-300",
  CLOSED: "text-red-600 dark:text-red-300",
};

const MENU_WIDTH_PX = 360;

/**
 * The PR's place in a native GitHub stack, "2/2" as GitHub shows it — amber
 * while a PR below it is still open (GitHub will not merge this one yet), green
 * on the bottom PR. Clicking it opens the stack the way GitHub's own popover
 * does: top PR first, the base branch last, this PR highlighted; picking a row
 * opens that PR. Renders nothing outside a stack.
 */
export function StackBadge({ pr, className }: { pr: PullRequest; className?: string }) {
  const menu = useAnchoredMenu(MENU_WIDTH_PX);

  if (!pr.stack) return null;
  const { stack } = pr;
  const title = stackTitle(pr);
  // The PR GitHub merges next: the lowest one still open.
  const firstOpen = stack.entries.find((e) => e.state === "OPEN")?.number;

  const open = (url: string) => {
    window.api.openExternal(url).catch(() => {});
    menu.close();
  };

  return (
    <>
      <button
        ref={menu.buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          menu.toggle();
        }}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        className={cn(
          "inline-flex shrink-0 items-center gap-0.5 rounded px-0.5 text-xs font-medium tabular-nums hover:bg-elevated",
          pr.blockedByStack ? "text-amber-600 dark:text-amber-300" : "text-emerald-600 dark:text-emerald-400",
          className,
        )}
      >
        <StackIcon />
        {stack.position}/{stack.size}
      </button>
      {menu.open &&
        createPortal(
          <div
            ref={menu.menuRef}
            role="menu"
            aria-label={`Stack #${stack.number}`}
            style={menu.style}
            className="z-50 overflow-hidden rounded-lg border border-line bg-surface text-sm shadow-xl"
          >
            <div className="border-b border-line px-3 py-2 font-semibold text-fg">Stack #{stack.number}</div>
            <ul className="py-1">
              {[...stack.entries].reverse().map((e) => {
                const current = e.number === pr.number;
                return (
                  <li key={e.number}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => open(e.url)}
                      title={`Open #${e.number} on GitHub`}
                      className={cn(
                        "flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-elevated",
                        current && "bg-elevated",
                      )}
                    >
                      <span className={cn("mt-0.5 w-8 shrink-0 text-xs tabular-nums", STATE_CLASS[e.state] ?? "text-fg-muted")}>
                        {e.position}.
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate", current ? "font-semibold text-fg" : "text-fg-secondary")}>
                          {e.title}
                        </span>
                        <span className="block text-xs text-fg-subtle">
                          #{e.number}
                          {e.state !== "OPEN" && ` · ${e.state.toLowerCase()}`}
                          {current && " · this PR"}
                          {e.number === firstOpen && " · merges first"}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-line px-3 py-1.5 text-xs text-fg-subtle">
              base: <span className="font-mono text-fg-muted">{stack.baseRefName}</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
