import { createContext } from "react";

import type { AgentAction, AgentActionResult, AgentState } from "../../../shared/types";

export interface AgentContextValue {
  /** Null while it loads, and in fixture mode, where there is no agent. */
  state: AgentState | null;
  act: (action: AgentAction) => Promise<AgentActionResult>;
  /** Opens the companion's popover, on a run when given. */
  openCompanion: (runId?: string) => void;
  /** Switches to the Board, where a result that waits for you has its card. */
  showBoard: () => void;
  /**
   * Shows one of the agent's items: the Board, scrolled to its card, which
   * flashes. With Settings open it waits until you close them — a view is
   * never switched out from under an edit.
   */
  focusItem: (runId?: string) => void;
}

export const AgentContext = createContext<AgentContextValue>({
  state: null,
  act: async () => ({ ok: false, error: "The agent is not available." }),
  openCompanion: () => {},
  showBoard: () => {},
  focusItem: () => {},
});
