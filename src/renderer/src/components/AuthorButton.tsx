import { useContext, type ReactNode } from "react";

import { cn } from "../format";
import { AuthorFilterContext } from "./author-filter-context";

/**
 * A PR's author — avatar, login or both, whatever the view draws — as the
 * author filter's toggle: a click shows only this login's PRs, a second click
 * on the same author shows everyone again. One component for the card, the
 * tile and the table, so the three can't disagree on what the click does.
 */
export function AuthorButton({
  login,
  className,
  children,
}: {
  login: string;
  className?: string;
  children: ReactNode;
}) {
  const filter = useContext(AuthorFilterContext);
  if (!filter) return <span className={className}>{children}</span>;
  const active = filter.author === login;
  const label = active ? "Show PRs by every author" : `Show only PRs by ${login}`;
  return (
    <button
      type="button"
      onClick={() => filter.toggle(login)}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        // The avatar-only views (tile, table) carry no text to take a focus or
        // hover cue, so the ring is the only sign focus landed on the button.
        "rounded-full hover:text-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:text-sky-300",
        className,
        // The filtered author is marked on every PR left in the list, so the
        // click that undoes the filter is visible where the user clicks, not
        // only on the chip that may have scrolled away. A ring, not a text
        // colour: `cn` is a plain join, so a colour would fight the caller's on
        // stylesheet order.
        active && "ring-2 ring-sky-500/70",
      )}
    >
      {children}
    </button>
  );
}
