import { createContext } from "react";

/**
 * The author filter as the three views see it: which login is filtered on, and
 * the toggle a click on an author calls. Provided once in App.tsx, like
 * `ClaudeEnabledContext`, so the card, the tile and the table row don't each
 * thread another prop down. Null outside the provider: the author then renders
 * as plain text. Its own file for the same Fast Refresh reason as
 * `claude-context.ts`.
 */
export interface AuthorFilter {
  author: string | null;
  toggle: (login: string) => void;
}

export const AuthorFilterContext = createContext<AuthorFilter | null>(null);
