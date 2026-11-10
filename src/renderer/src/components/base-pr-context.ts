import { createContext } from "react";
import type { PullRequest } from "../../../shared/types";

/**
 * The PR each hand-made stacked PR is based on (`basePrIndex`), keyed by PR id.
 * Built once in App.tsx from the whole snapshot — not the filtered list — so a
 * card still names the PR under it when a filter hides that one. Its own file
 * for the same Fast Refresh reason as `claude-context.ts`.
 */
export const BasePrContext = createContext<ReadonlyMap<string, PullRequest>>(new Map());
