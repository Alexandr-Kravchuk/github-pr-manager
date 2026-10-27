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
  // A "parent" cluster can hold PRs whose own issue IS the key (a task next to
  // its subtasks' PRs, or a task with no parent), or whose epic is the key two
  // levels up (a subtask), so the key's summary may come from any of the three.
  const summary =
    mode === "parent"
      ? prs
          .map((pr) =>
            pr.parentKey === key
              ? pr.parentSummary
              : pr.issueKey === key
                ? pr.issueSummary
                : pr.grandparentKey === key
                  ? pr.grandparentSummary
                  : null,
          )
          .find((s): s is string => Boolean(s))
      : prs.map((pr) => groupSummaryOf(pr, mode)).find((s): s is string => Boolean(s));
  return summary ? `${key} · ${summary}` : key;
}

/**
 * The "group by parent task" key of every PR, keyed by PR id — the top of the
 * Jira hierarchy its issue shares with the other PRs on the board.
 *
 * Grouping by `parentKey` alone missed three cases, all seen on the board:
 *  - a PR on a task with no parent (ENG-83724 "Code designer": five PRs, one
 *    key) had no parent key at all and fell into "Other";
 *  - a PR on a task sat apart from the PRs on that task's subtasks — the
 *    subtasks' parent is the task, while the task's parent is its epic;
 *  - a subtask whose task has no PR of its own (ENG-104627 under ENG-103702)
 *    never reached the epic its sibling tasks' PRs cluster under — nothing on
 *    the board linked the task to the epic, so the enricher now resolves that
 *    link as `grandparentKey`.
 * So each PR links its issue to its parent and, for a subtask, that parent to
 * the epic; PRs that share any key end up in one cluster, and the cluster is named after its top key: the one with no
 * parent inside the cluster. Jira gives each issue one parent, so a cluster has
 * exactly one such key. A PR with no issue key has no group (null).
 */
export function parentGroupKeys(prs: PullRequest[]): Map<string, string | null> {
  const up = new Map<string, string>(); // union-find over issue keys
  const find = (k: string): string => {
    let root = k;
    while (up.get(root) !== root) root = up.get(root) as string;
    up.set(k, root);
    return root;
  };
  const add = (k: string) => {
    if (!up.has(k)) up.set(k, k);
  };
  const parentOf = new Map<string, string>();
  const link = (child: string, parent: string) => {
    add(parent);
    parentOf.set(child, parent);
    const a = find(child);
    const b = find(parent);
    if (a !== b) up.set(a, b);
  };
  for (const pr of prs) {
    if (!pr.issueKey) continue;
    add(pr.issueKey);
    if (pr.parentKey) {
      link(pr.issueKey, pr.parentKey);
      if (pr.grandparentKey) link(pr.parentKey, pr.grandparentKey);
    }
  }
  // The top key of each cluster: the one whose parent is not in it.
  const top = new Map<string, string>();
  for (const k of up.keys()) {
    const p = parentOf.get(k);
    if (!p || find(p) !== find(k)) top.set(find(k), k);
  }
  const out = new Map<string, string | null>();
  for (const pr of prs) out.set(pr.id, pr.issueKey ? (top.get(find(pr.issueKey)) ?? null) : null);
  return out;
}

/**
 * The task between a PR and the cluster it sits in, for the card to name —
 * the heading says the epic, the badge says the subtask, and without this the
 * task they belong to (ENG-103702, "footer…") is said nowhere. Null when the
 * heading already is that task, the PR is on the task itself, or the PR is not
 * in a "parent" cluster (`groupKey` null).
 */
export function hiddenParentOf(
  pr: PullRequest,
  groupKey: string | null,
): { key: string; summary: string | null } | null {
  if (!groupKey || !pr.parentKey) return null;
  if (groupKey === pr.parentKey || groupKey === pr.issueKey) return null;
  return { key: pr.parentKey, summary: pr.parentSummary };
}

/** Which stack a PR is in — stack numbers are per repository. Null outside one. */
function stackKeyOf(pr: PullRequest): string | null {
  return pr.stack ? `${pr.hostLabel}/${pr.repo}#${pr.stack.number}` : null;
}

/**
 * Puts the PRs of one native GitHub stack next to each other, bottom first, at
 * the place where the list's ordering put the first of them. Every other PR
 * keeps its position. Applied before grouping, so it holds within each group
 * too: a group only filters this order, it never reorders it.
 */
export function orderStacks(prs: PullRequest[]): PullRequest[] {
  const byStack = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const key = stackKeyOf(pr);
    if (!key) continue;
    const list = byStack.get(key);
    if (list) list.push(pr);
    else byStack.set(key, [pr]);
  }
  if (byStack.size === 0) return prs;
  const out: PullRequest[] = [];
  const placed = new Set<string>();
  for (const pr of prs) {
    const key = stackKeyOf(pr);
    if (!key) {
      out.push(pr);
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    const members = byStack.get(key) ?? [];
    out.push(...[...members].sort((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0)));
  }
  return out;
}

/** The tooltip on a PR's stack badge. */
export function stackTitle(pr: PullRequest): string {
  if (!pr.stack) return "";
  const { number, position, size, bottom } = pr.stack;
  const where = `Stack #${number}: ${position} of ${size}, counted from the base branch`;
  return bottom
    ? `${where}. GitHub merges only the bottom PR — this one waits for #${bottom.number}`
    : `${where}. This is the bottom PR — GitHub merges it first`;
}
