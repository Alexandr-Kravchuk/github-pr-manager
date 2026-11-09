// Re-approve / re-ask: the reads and writes behind `shared/agent-reapprove.ts`.
// Once per head of a PR the policy points at, one GraphQL read of the PR's
// timeline tells a dismissed approval from a plain comment; then the commits
// pushed since are checked in your clone — merges of the base only, each one
// exactly what merging its two parents gives. Only then is anything offered,
// and what goes out is the app's own: an approval with one line and the
// signature, or a review request.

import { signedBody, type PublishRequest } from "../../shared/agent-publish";
import { baseMerges, dismissedApprovals, reapprovalBody, type ReviewTimelineNode } from "../../shared/agent-reapprove";
import { isPlainBranch, safeGit, withNoHooks } from "./drive";
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

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The checks' common start, inside `withNoHooks`: the PR's head and its base's
 * tip read from the remote — the head must be the one the dashboard shows, or
 * it throws and the next head is checked — and both fetched without touching
 * the clone: an empty refmap moves not even a remote-tracking branch, and no
 * FETCH_HEAD is written. `baseTip` is null when the base branch is gone.
 */
async function fetchPrTips(
  local: LocalRepo,
  hooks: string,
  pr: { number: number; baseRefName: string },
  newHead: string,
): Promise<{ git: (args: string[]) => Promise<string>; succeeds: (args: string[]) => Promise<boolean>; baseTip: string | null }> {
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
  const baseTip = tips.get(baseRef) ?? null;
  if (tips.get(pullRef) !== newHead) throw new Error("the PR has a newer head than the dashboard shows");
  if (baseTip) await git(["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", local.remote, baseRef, pullRef]);
  return { git, succeeds, baseTip };
}

/**
 * Null when the PR's new head is exactly the change you reviewed on a new base
 * — else why not. Covers a stack GitHub rebased after a lower layer merged, a
 * "Rebase stack", and the base merged in.
 *
 * "The change you reviewed" is the reviewed head against the base it had then:
 * from where it forks off that base (`from`) to the reviewed head. The base is
 * the PR's present branch unless it was retargeted since your review — then
 * `reviewedOn` is a commit of the branch it had (a stack's lower layer), so a
 * layer moved onto the trunk without the layer below it merged doesn't pass:
 * the lower layer's code is in its diff now, and you never reviewed it here.
 * The expected tree is that change put onto the base commit the new head sits
 * on (`merge-tree --merge-base=<from> <onto> <reviewed>`); the new head's tree
 * must be that one exactly. Anything of the author's own since — a commit, a
 * conflict resolved by hand — makes it differ. Read in your clone the way
 * `baseOnlyPush` reads it; a commit the clone lacks (the reviewed head, which
 * a rebase leaves on no branch; `reviewedOn`) is fetched by its id.
 */
export async function sameChangeOnNewBase(
  local: LocalRepo,
  pr: { number: number; baseRefName: string },
  oldHead: string,
  newHead: string,
  reviewedOn: string | null = null,
): Promise<string | null> {
  if (!OID.test(oldHead) || !OID.test(newHead) || (reviewedOn !== null && !OID.test(reviewedOn))) return "no commit id to compare";
  if (oldHead === newHead) return "the head is the one you reviewed";
  return withNoHooks(async (hooks) => {
    const { git, succeeds, baseTip } = await fetchPrTips(local, hooks, pr, newHead);
    if (!baseTip) return `no base branch ${pr.baseRefName} on the remote`;
    const have = async (oid: string) => {
      if (await succeeds(["cat-file", "-e", `${oid}^{commit}`])) return true;
      await git(["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", local.remote, oid]).catch(() => "");
      return succeeds(["cat-file", "-e", `${oid}^{commit}`]);
    };
    if (!(await have(oldHead))) return "the reviewed head is in neither your clone nor the remote";
    if (reviewedOn !== null && !(await have(reviewedOn))) return "the base you reviewed against is in neither your clone nor the remote";
    const onto = lines(await git(["merge-base", newHead, baseTip]).catch(() => ""))[0];
    if (!onto) return "the new head shares no history with its base";
    const from = lines(await git(["merge-base", oldHead, reviewedOn ?? onto]).catch(() => ""))[0];
    if (!from) return "the reviewed head shares no history with the base you reviewed it against";
    let expected: string | undefined;
    try {
      expected = lines(await git(["merge-tree", "--write-tree", `--merge-base=${from}`, onto, oldHead]))[0];
    } catch (e) {
      return /unknown option/i.test((e as Error).message) ? "checking it needs git 2.40 or newer" : "the reviewed change doesn't go onto the new base cleanly";
    }
    const tree = lines(await git(["rev-parse", `${newHead}^{tree}`]))[0];
    return expected && expected === tree ? null : "the PR's own change differs from the one you reviewed";
  });
}

const BASE_CHANGES_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      state headRefOid baseRefName
      timelineItems(last: 50, itemTypes: [BASE_REF_CHANGED_EVENT]) {
        nodes { ... on BaseRefChangedEvent { createdAt previousRefName } }
      }
    }
  }
}`;

/** The newest PR from a branch — a stack's lower layer, by its head branch; its head is kept after the branch is deleted. */
const HEAD_BRANCH_QUERY = `query($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $ref, last: 1) { nodes { headRefOid } }
  }
}`;

export interface BaseOnlyTarget {
  id: string;
  url: string;
  repo: string;
  number: number;
  headOid: string | null;
  baseRefName: string;
  /** Your latest opinionated review: when, and on which commit. */
  viewerReviewedAt: string | null;
  viewerReviewedOid: string | null;
}

export interface BaseOnlyCheck {
  verdict: "same" | "changed";
  note: string;
  /** The base the verdict holds for: a retarget since asks again. */
  baseRefName: string;
}

/**
 * Whether a reviewed PR's new head is the change you reviewed on a new base
 * (`sameChangeOnNewBase`). One GraphQL read tells whether the PR was
 * retargeted since your review — a stack's layer moves to the trunk when the
 * one below merges — and then the branch it had is found (the newest PR from
 * that branch, whose head GitHub keeps after the branch is deleted; else the
 * branch itself), so the change is taken against the base you saw. Throws on a
 * read that failed or a PR that moved on — the caller tries again later; no
 * clone, or a base that can't be found, is "changed": the re-review runs.
 */
export async function checkBaseOnly(gh: GhRunner, pr: BaseOnlyTarget, local: LocalRepo | null): Promise<BaseOnlyCheck> {
  const changed = (note: string): BaseOnlyCheck => ({ verdict: "changed", note, baseRefName: pr.baseRefName });
  if (!local) return changed("no clone of the repository to check the push in");
  if (!pr.viewerReviewedOid || !pr.viewerReviewedAt || !pr.headOid) return changed("no review commit to compare with");
  const read = async (query: string, variables: Record<string, unknown>) => {
    const r = await gh(["api", "graphql", "--input", "-", ...hostFlag(pr.url)], { input: JSON.stringify({ query, variables }) });
    if (r.code !== 0) throw new Error(`couldn't read the PR's base: ${ghError(r)}`);
    return JSON.parse(r.stdout) as { data?: Record<string, unknown> };
  };
  type Node = { state?: string; headRefOid?: string; baseRefName?: string; timelineItems?: { nodes?: Array<{ createdAt?: string; previousRefName?: string } | null> } };
  const node = (await read(BASE_CHANGES_QUERY, { id: pr.id })).data?.node as Node | null | undefined;
  if (!node) throw new Error("couldn't read the PR's base");
  if (node.state !== "OPEN") return changed("the PR is not open");
  if (node.headRefOid !== pr.headOid || node.baseRefName !== pr.baseRefName) throw new Error("the PR has moved on since the dashboard saw it");
  const since = pr.viewerReviewedAt;
  const retargets = (node.timelineItems?.nodes ?? [])
    .filter((e): e is { createdAt: string; previousRefName?: string } => typeof e?.createdAt === "string" && e.createdAt > since)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let reviewedOn: string | null = null;
  if (retargets.length > 0) {
    const was = retargets[0].previousRefName ?? "";
    if (!isPlainBranch(was)) return changed("the base the PR had at your review can't be read");
    const [owner, name] = pr.repo.split("/");
    const found = (await read(HEAD_BRANCH_QUERY, { owner, name, ref: was })).data?.repository as { pullRequests?: { nodes?: Array<{ headRefOid?: string } | null> } } | null | undefined;
    reviewedOn = found?.pullRequests?.nodes?.[0]?.headRefOid ?? null;
    if (!reviewedOn) {
      const tip = await withNoHooks(async (hooks) => lines(await local.git([...safeGit(hooks), "ls-remote", local.remote, `refs/heads/${was}`], local.checkout))[0]?.split(/\s+/)[0]);
      reviewedOn = tip ?? null;
    }
    if (!reviewedOn) return changed(`the base the PR had at your review (${was}) is gone`);
  }
  const why = await sameChangeOnNewBase(local, { number: pr.number, baseRefName: pr.baseRefName }, pr.viewerReviewedOid, pr.headOid, reviewedOn);
  if (why !== null) return changed(why);
  return { verdict: "same", note: `only the base changed since ${pr.viewerReviewedOid.slice(0, 7)}`, baseRefName: pr.baseRefName };
}

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
    const { git, succeeds, baseTip } = await fetchPrTips(local, hooks, pr, newHead);
    if (!baseTip) return `no base branch ${pr.baseRefName} on the remote`;
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
