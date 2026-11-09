// Re-approve / re-ask: the GitHub reads and writes behind
// `shared/agent-reapprove.ts`. Once per head of a PR the policy points at, one
// GraphQL read of the PR's timeline tells a dismissed approval from a plain
// comment, and two diffs tell a base-only push from one that changed the PR.
// Only then is anything offered — and what is posted is the app's own: an
// approval with one line and the signature, or a review request.

import { signedBody, type PublishRequest } from "../../shared/agent-publish";
import { dismissedApprovals, reapprovalBody, sameChanges, type ReviewTimelineNode } from "../../shared/agent-reapprove";
import { ghError, hostFlag, type GhRunner } from "./publish";

const TIMELINE_QUERY = `query($id: ID!) {
  viewer { login }
  node(id: $id) {
    ... on PullRequest {
      state headRefOid baseRefName author { login }
      timelineItems(last: 100, itemTypes: [PULL_REQUEST_REVIEW, REVIEW_DISMISSED_EVENT]) {
        nodes {
          __typename
          ... on PullRequestReview { author { login } state submittedAt commit { oid } }
          ... on ReviewDismissedEvent { previousReviewState review { author { login } commit { oid } } }
        }
      }
    }
  }
}`;

/** `runGh` keeps the tail of a longer output: a diff that fills it may be cut, and two cut diffs could look alike. */
const GH_STDOUT_MAX = 200_000;

export interface ReapprovalCheck {
  verdict: "same" | "pass";
  /** Whose dismissed approvals cover exactly the PR's changes now. */
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

const pass = (note: string): ReapprovalCheck => ({ verdict: "pass", logins: [], note });

/** The PR's diff at an endpoint; null when it is too big to compare whole. */
async function readDiff(gh: GhRunner, url: string, endpoint: string): Promise<string | null> {
  const r = await gh(["api", endpoint, "-H", "Accept: application/vnd.github.v3.diff", ...hostFlag(url)], { timeoutMs: 90_000 });
  if (r.code !== 0) {
    // GitHub refuses a diff past its own limits: that is an answer, not an outage.
    if (/too large|too_large|diff is taking too long|406|422/i.test(`${r.stderr}\n${r.stdout}`)) return null;
    throw new Error(`couldn't read a diff: ${ghError(r)}`);
  }
  return r.stdout.length >= GH_STDOUT_MAX ? null : r.stdout;
}

/**
 * Whether a base-only push dismissed approvals on this head: yours on someone's
 * PR (`reapprove`), or your reviewers' on your PR (`reask`). Throws on a read
 * that failed — the caller tries again later — and answers "pass" for every
 * case where nothing should be given again.
 */
export async function checkReapproval(gh: GhRunner, pr: ReapprovalTarget, scenario: "reapprove" | "reask"): Promise<ReapprovalCheck> {
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

  const now = await readDiff(gh, pr.url, `repos/${pr.repo}/pulls/${pr.number}`);
  if (now === null) return pass("too big to compare");
  const base = encodeURIComponent(node.baseRefName ?? "").replace(/%2F/g, "/");
  const same = new Set<string>();
  for (const oldHead of new Set(found.map((d) => d.head))) {
    // Three dots: from where the old head left the base, so the base's own commits since are not in it.
    const before = await readDiff(gh, pr.url, `repos/${pr.repo}/compare/${base}...${oldHead}`);
    if (before === null) return pass("too big to compare");
    if (sameChanges(before, now)) same.add(oldHead);
  }
  const ok = found.filter((d) => same.has(d.head));
  if (ok.length === 0) return pass("the PR's own changes differ since the approval");
  return {
    verdict: "same",
    logins: ok.map((d) => d.login),
    oldHead: ok[0].head,
    note: `only the base changed since ${ok[0].head.slice(0, 7)}`,
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
