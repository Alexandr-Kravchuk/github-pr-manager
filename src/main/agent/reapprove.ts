// Re-approve / re-ask: the reads and writes behind `shared/agent-reapprove.ts`.
// Once per head of a PR the policy points at, one GraphQL read of the PR's
// timeline tells a dismissed approval from a plain comment; then the commits
// pushed since are checked in your clone — merges of the base only, each one
// exactly what merging its two parents gives. Only then is anything offered,
// and what goes out is the app's own: an approval with one line and the
// signature, or a review request.

import { signedBody, type PublishRequest } from "../../shared/agent-publish";
import { baseMerges, dismissedApprovals, reapprovalBody, type ReviewTimelineNode } from "../../shared/agent-reapprove";
import { safeGit, withNoHooks } from "./drive";
import { ghError, hostFlag, type GhRunner } from "./publish";
import type { GitRunner } from "./worktrees";

const TIMELINE_QUERY = `query($id: ID!) {
  viewer { login }
  node(id: $id) {
    ... on PullRequest {
      state headRefOid baseRefName author { login }
      timelineItems(last: 100, itemTypes: [PULL_REQUEST_REVIEW, REVIEW_DISMISSED_EVENT]) {
        nodes {
          __typename
          ... on PullRequestReview { id author { login } state submittedAt commit { oid } }
          ... on ReviewDismissedEvent { previousReviewState review { id author { login } commit { oid } } }
        }
      }
    }
  }
}`;

export interface ReapprovalCheck {
  verdict: "same" | "pass";
  /** Whose dismissed approvals the push since left standing — nothing but the base came in. */
  logins: string[];
  /** The head they were given on. */
  oldHead?: string;
  /** What was found, in a line. */
  note: string;
}

export interface ReapprovalTarget {
  id: string;
  url: string;
  repo: string;
  number: number;
  headOid: string | null;
}

/** Your clone of the PR's repository, and its remote for that repository. */
export interface LocalRepo {
  git: GitRunner;
  checkout: string;
  remote: string;
}

const pass = (note: string): ReapprovalCheck => ({ verdict: "pass", logins: [], note });

const lines = (out: string): string[] =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Null when everything pushed between the approved head and the new one is
 * merges of the base, each exactly the tree `git merge-tree` makes of its two
 * parents — else why not. Read in your clone with nothing of its config able
 * to start a program (no hooks, fsmonitor or gpg), and without touching it: the
 * fetch writes no ref and no FETCH_HEAD, the merge only objects. Throws when
 * the PR has moved on since the dashboard saw it — the next head is checked.
 */
export async function baseOnlyPush(local: LocalRepo, pr: { number: number; baseRefName: string }, oldHead: string, newHead: string): Promise<string | null> {
  return withNoHooks(async (hooks) => {
    const git = (args: string[]) => local.git([...safeGit(hooks), ...args], local.checkout);
    const succeeds = async (args: string[]) => {
      try {
        await git(args);
        return true;
      } catch {
        return false;
      }
    };
    const baseRef = `refs/heads/${pr.baseRefName}`;
    const pullRef = `refs/pull/${pr.number}/head`;
    const tips = new Map(lines(await git(["ls-remote", local.remote, baseRef, pullRef])).map((l) => [l.split(/\s+/)[1], l.split(/\s+/)[0]]));
    const baseTip = tips.get(baseRef);
    if (!baseTip) return `no base branch ${pr.baseRefName} on the remote`;
    if (tips.get(pullRef) !== newHead) throw new Error("the PR has a newer head than the dashboard shows");
    // An empty refmap: not even the remote-tracking branch moves.
    await git(["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", local.remote, baseRef, pullRef]);
    if (!(await succeeds(["cat-file", "-e", `${oldHead}^{commit}`]))) return "the approved head is gone — the branch was rewritten since";
    if (!(await succeeds(["merge-base", "--is-ancestor", oldHead, newHead]))) return "the branch was rewritten since the approval";
    const own = lines(await git(["rev-list", "--parents", `${oldHead}..${newHead}`, "--not", baseTip])).map((l) => l.split(" "));
    const chain = new Set(lines(await git(["rev-list", "--first-parent", `${oldHead}..${newHead}`])));
    const found = baseMerges(own, chain);
    if ("why" in found) return found.why;
    for (const m of found.merges) {
      const tree = lines(await git(["rev-parse", `${m.sha}^{tree}`]))[0];
      let clean: string | undefined;
      try {
        clean = lines(await git(["merge-tree", "--write-tree", m.parents[0], m.parents[1]]))[0];
      } catch (e) {
        // Exit 1 is a conflict; an older git doesn't know the option at all. (The
        // message repeats the command line, so "write-tree" alone tells nothing.)
        return /unknown option/i.test((e as Error).message) ? "checking a merge needs git 2.38 or newer" : "a merge had conflicts resolved by hand";
      }
      if (!clean || clean !== tree) return "a merge carries changes of its own";
    }
    return null;
  });
}

/**
 * Whether a base-only push dismissed approvals on this head: yours on someone's
 * PR (`reapprove`), or your reviewers' on your PR (`reask`). Throws on a read
 * that failed — the caller tries again later — and answers "pass" for every
 * case where nothing should be given again, a missing clone included.
 */
export async function checkReapproval(gh: GhRunner, pr: ReapprovalTarget, scenario: "reapprove" | "reask", local: LocalRepo | null): Promise<ReapprovalCheck> {
  const r = await gh(["api", "graphql", "--input", "-", ...hostFlag(pr.url)], { input: JSON.stringify({ query: TIMELINE_QUERY, variables: { id: pr.id } }) });
  if (r.code !== 0) throw new Error(`couldn't read the PR's reviews: ${ghError(r)}`);
  type Node = {
    state?: string;
    headRefOid?: string;
    baseRefName?: string;
    author?: { login?: string } | null;
    timelineItems?: { nodes?: ReviewTimelineNode[] };
  };
  const data = (JSON.parse(r.stdout) as { data?: { viewer?: { login?: string }; node?: Node | null } }).data;
  const node = data?.node;
  const viewer = data?.viewer?.login;
  if (!node || !viewer) throw new Error("couldn't read the PR's reviews");
  if (node.state !== "OPEN") return pass("the PR is not open");
  const head = node.headRefOid ?? "";
  // The dashboard is behind: check again once it sees this head.
  if (!head || head !== pr.headOid) throw new Error("the PR has a newer head than the dashboard shows");
  const me = viewer.toLowerCase();
  const found = dismissedApprovals(node.timelineItems?.nodes ?? [], head, scenario === "reask" ? [node.author?.login ?? viewer] : []).filter((d) =>
    scenario === "reapprove" ? d.login.toLowerCase() === me : d.login.toLowerCase() !== me,
  );
  if (found.length === 0) return pass(scenario === "reapprove" ? "no dismissed approval of yours" : "no dismissed approvals");
  if (!local) return pass("no clone of the repository to check the push in");
  const why = new Map<string, string | null>();
  for (const oldHead of new Set(found.map((d) => d.head))) {
    why.set(oldHead, await baseOnlyPush(local, { number: pr.number, baseRefName: node.baseRefName ?? "" }, oldHead, head));
  }
  const ok = found.filter((d) => why.get(d.head) === null);
  if (ok.length === 0) return pass([...why.values()].find((w) => w) ?? "more than the base came in since the approval");
  return {
    verdict: "same",
    logins: ok.map((d) => d.login),
    oldHead: ok[0].head,
    note: `only merges of the base since ${ok[0].head.slice(0, 7)}`,
  };
}

/** Your approval again, on the head it now has: one line and the signature. */
export function reapproveRequest(repo: string, number: number, head: string, oldHead: string, signature: string): PublishRequest {
  return {
    label: "approval",
    endpoint: `repos/${repo}/pulls/${number}/reviews`,
    body: { event: "APPROVE", commit_id: head, body: signedBody(reapprovalBody(oldHead), signature) },
  };
}

/** Your reviewers asked again — GitHub tells them; nothing is written in the PR. */
export function reaskRequest(repo: string, number: number, logins: readonly string[]): PublishRequest {
  return { label: "review request", endpoint: `repos/${repo}/pulls/${number}/requested_reviewers`, body: { reviewers: [...logins] } };
}
