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
}

export const AgentContext = createContext<AgentContextValue>({
  state: null,
  act: async () => ({ ok: false, error: "The agent is not available." }),
  openCompanion: () => {},
  showBoard: () => {},
});
