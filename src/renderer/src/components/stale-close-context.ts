import { createContext } from "react";

import type { PullRequest } from "../../../shared/types";

/**
 * Opens the stale-PR close dialog for a PR. Provided once in App.tsx (which
 * renders the one dialog), so the card, the tile and the table row don't each
 * thread another prop down. Null outside the provider: the close action is
 * then not offered. Its own file for the same Fast Refresh reason as
 * `claude-context.ts`.
 */
export const StaleCloseContext = createContext<((pr: PullRequest) => void) | null>(null);
