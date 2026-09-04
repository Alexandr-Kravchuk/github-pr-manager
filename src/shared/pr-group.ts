/**
 * How a Jira-keyed group heading is built: which key a PR clusters under, and
 * what the heading above that cluster says.
 *
 * Its own module, and deliberately free of `node:` builtins, because the
 * renderer value-imports it (see the carve-out rule in AGENTS.md and the guard
 * test in `tests/run-tests.cjs`). Living here rather than as closures inside
 * `App.tsx`'s grouping memo is what makes the rendered heading — the thing the
 * by-issue feature actually ships — testable without a DOM: the mode branching
 * and the fallback to a bare key are decisions, not markup.
 */
import type { PullRequest } from "./types";

/**
 * The two grouping modes that cluster by a Jira key (as opposed to by repo, or
 * not at all): the PR's own issue, or the parent task Jira resolved for it.
 */
export type IssueGroupMode = "issue" | "parent";

/**
 * The key a PR clusters under in this mode — its own issue key, or the parent
 * task's. Null when the PR has none, which is what puts it in the "Other"
 * bucket rather than in a group of its own.
 */
export function groupKeyOf(pr: PullRequest, mode: IssueGroupMode): string | null {
  return mode === "parent" ? pr.parentKey : pr.issueKey;
}

/**
 * The Jira summary that titles this mode's heading, as carried by one PR. Null
 * whenever Jira didn't resolve one — not configured, key unknown to it, or the
 * pass failed — which is the ordinary case the heading has to survive.
 */
export function groupSummaryOf(pr: PullRequest, mode: IssueGroupMode): string | null {
  return mode === "parent" ? pr.parentSummary : pr.issueSummary;
}

/**
 * The heading for one cluster: `"ENG-93374 · Retry transient network errors"`,
 * or the bare key when Jira resolved no summary for it. The key always leads —
 * it is what the user searched for and what the cards' badges show — and a
 * summary only ever appends to it.
 *
 * Reads the whole cluster and takes the first non-empty summary rather than
 * `prs[0]`'s. Today the two agree: every PR under one key is written from one
 * Jira lookup in one pass. Scanning costs nothing at cluster sizes and keeps the
 * heading right without depending on that.
 */
export function groupLabel(key: string, prs: PullRequest[], mode: IssueGroupMode): string {
  const summary = prs.map((pr) => groupSummaryOf(pr, mode)).find((s): s is string => Boolean(s));
  return summary ? `${key} · ${summary}` : key;
}
