import { createContext } from "react";

import type { ClaudeSessionInfo } from "../../../shared/types";

/**
 * Whether the Claude integration is on (Settings → Claude). Provided once in
 * App.tsx so the three views don't each thread another prop down to the row.
 * Its own file because React Fast Refresh only hot-swaps a module that exports
 * components alone — next to `ClaudeButton` it forced a full reload on every edit.
 */
export const ClaudeEnabledContext = createContext(false);

/**
 * Whether Settings open Claude sessions in Claude Desktop — the button's menu
 * then also offers "Review in terminal".
 */
export const ClaudeDesktopContext = createContext(false);

/** The running Claude Code sessions main pushes; each button picks its PR's out of them. */
export const ClaudeSessionsContext = createContext<readonly ClaudeSessionInfo[]>([]);
