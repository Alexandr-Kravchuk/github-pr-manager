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
      className={cn("rounded-full hover:text-sky-600 dark:hover:text-sky-300", className)}
    >
      {children}
    </button>
  );
}
