import type {
  CheckItem,
  CheckState,
  HostConfig,
  PrRole,
  PullRequest,
  RateLimitInfo,
  ReviewDecision,
} from "./types";

/**
 * One GraphQL request per host: two searches (authored + review-requested)
 * merged into a single HTTP call via aliases. Each search is filtered by all
 * of the host's repositories (multiple `repo:` qualifiers act as OR).
 */
const QUERY = /* GraphQL */ `
query ($authoredQuery: String!, $reviewingQuery: String!) {
  rateLimit { remaining cost resetAt }
  authored: search(query: $authoredQuery, type: ISSUE, first: 100) {
    nodes { ...PrFields }
  }
  reviewing: search(query: $reviewingQuery, type: ISSUE, first: 100) {
    nodes { ...PrFields }
  }
}
fragment PrFields on PullRequest {
  id
  number
  title
  url
  isDraft
  createdAt
  updatedAt
  author { login avatarUrl }
  repository { nameWithOwner }
  reviewDecision
  comments { totalCount }
  reviewThreads(first: 100) {
    nodes { isResolved comments { totalCount } }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun { name conclusion status detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
}
`;

// --- Raw GraphQL response types (narrowed to the fields we need) ---

interface RawCheckRun {
  __typename: "CheckRun";
  name: string;
  conclusion: string | null;
  status: string | null;
  detailsUrl: string | null;
}
interface RawStatusContext {
  __typename: "StatusContext";
  context: string;
  state: string | null;
  targetUrl: string | null;
}
type RawContext = RawCheckRun | RawStatusContext | { __typename: string };

interface RawPr {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  author: { login: string; avatarUrl: string } | null;
  repository: { nameWithOwner: string };
  reviewDecision: ReviewDecision;
  comments: { totalCount: number };
  reviewThreads: { nodes: Array<{ isResolved: boolean; comments: { totalCount: number } }> };
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: { state: string | null; contexts: { nodes: RawContext[] } } | null;
      };
    }>;
  };
}

interface RawResponse {
  data?: {
    rateLimit: { remaining: number; cost: number; resetAt: string };
    authored: { nodes: Array<RawPr | Record<string, never>> };
    reviewing: { nodes: Array<RawPr | Record<string, never>> };
  };
  errors?: Array<{ message: string }>;
}

/** Result of a query against a single host. */
export interface HostFetchResult {
  pullRequests: PullRequest[];
  rateLimit: RateLimitInfo;
}

// --- Check-state normalization ---

const STATE_WEIGHT: Record<CheckState, number> = {
  failure: 5,
  pending: 4,
  success: 3,
  neutral: 2,
  skipped: 1,
  unknown: 0,
};

function normalizeCheckRun(conclusion: string | null, status: string | null): CheckState {
  if (status && status !== "COMPLETED") return "pending";
  switch (conclusion) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    case "ACTION_REQUIRED":
      return "failure";
    case "NEUTRAL":
    case "CANCELLED":
    case "STALE":
      return "neutral";
    case "SKIPPED":
      return "skipped";
    default:
      return "unknown";
  }
}

function normalizeStatusContext(state: string | null): CheckState {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "unknown";
  }
}

function mapRollupState(state: string | null | undefined): CheckState {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "unknown";
  }
}

/**
 * Deduplicates checks by name, keeping the worst state (e.g. a failure wins
 * over a later success after a re-run).
 */
function dedupeChecks(items: CheckItem[]): CheckItem[] {
  const byName = new Map<string, CheckItem>();
  for (const item of items) {
    const existing = byName.get(item.name);
    if (!existing || STATE_WEIGHT[item.state] > STATE_WEIGHT[existing.state]) {
      byName.set(item.name, item);
    }
  }
  return [...byName.values()];
}

function extractChecks(pr: RawPr): CheckItem[] {
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
  if (!rollup) return [];
  const items: CheckItem[] = [];
  for (const ctx of rollup.contexts.nodes) {
    if (ctx.__typename === "CheckRun") {
      const c = ctx as RawCheckRun;
      items.push({
        name: c.name,
        kind: "check",
        state: normalizeCheckRun(c.conclusion, c.status),
        url: c.detailsUrl,
      });
    } else if (ctx.__typename === "StatusContext") {
      const s = ctx as RawStatusContext;
      items.push({
        name: s.context,
        kind: "status",
        state: normalizeStatusContext(s.state),
        url: s.targetUrl,
      });
    }
  }
  return dedupeChecks(items);
}

/** Maps a raw PR into the domain model (without activity fields — those are added by state.ts). */
function mapPr(pr: RawPr, hostLabel: string, roles: PrRole[]): PullRequest {
  const threads = pr.reviewThreads.nodes;
  const unresolvedThreads = threads.filter((t) => !t.isResolved).length;
  const reviewCommentCount = threads.reduce((sum, t) => sum + t.comments.totalCount, 0);
  const totalComments = pr.comments.totalCount + reviewCommentCount;

  const checks = extractChecks(pr);
  const failingChecks = checks.filter((c) => c.state === "failure");
  const pendingChecks = checks.filter((c) => c.state === "pending");

  const rollupState = mapRollupState(pr.commits.nodes[0]?.commit.statusCheckRollup?.state);
  const ciState: CheckState =
    failingChecks.length > 0 ? "failure" : checks.length === 0 ? "unknown" : rollupState;

  return {
    id: pr.id,
    hostLabel,
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: pr.isDraft,
    author: pr.author,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    reviewDecision: pr.reviewDecision,
    roles,
    unresolvedThreads,
    totalComments,
    checks,
    failingChecks,
    pendingChecks,
    ciState,
    // Activity fields are overwritten in state.ts:
    hasNewActivity: false,
    lastSeenAt: null,
    needsAttention: false,
  };
}

function isRawPr(node: RawPr | Record<string, never>): node is RawPr {
  return typeof (node as RawPr).id === "string";
}

function buildSearchQuery(repos: string[], qualifier: string): string {
  const repoFilter = repos.map((r) => `repo:${r}`).join(" ");
  return `is:open is:pr ${repoFilter} ${qualifier}`;
}

/**
 * Queries a single host and returns the list of PRs (author or requested
 * reviewer) along with rate-limit info. Throws on network/GraphQL failures.
 */
export async function fetchHost(host: HostConfig): Promise<HostFetchResult> {
  if (host.repos.length === 0) {
    return {
      pullRequests: [],
      rateLimit: { hostLabel: host.label, remaining: 0, cost: 0, resetAt: "" },
    };
  }

  const variables = {
    authoredQuery: buildSearchQuery(host.repos, "author:@me"),
    reviewingQuery: buildSearchQuery(host.repos, "review-requested:@me"),
  };

  const res = await fetch(host.graphqlUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${host.token}`,
      "Content-Type": "application/json",
      "User-Agent": "github-pr-manager",
    },
    body: JSON.stringify({ query: QUERY, variables }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }

  const json = (await res.json()) as RawResponse;
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) {
    throw new Error("Empty GraphQL response.");
  }

  // Merge authored + reviewing, unioning roles.
  const byId = new Map<string, PullRequest>();

  const addNodes = (nodes: Array<RawPr | Record<string, never>>, role: PrRole) => {
    for (const node of nodes) {
      if (!isRawPr(node)) continue;
      const existing = byId.get(node.id);
      if (existing) {
        if (!existing.roles.includes(role)) existing.roles.push(role);
      } else {
        byId.set(node.id, mapPr(node, host.label, [role]));
      }
    }
  };

  addNodes(json.data.authored.nodes, "author");
  addNodes(json.data.reviewing.nodes, "reviewer");

  return {
    pullRequests: [...byId.values()],
    rateLimit: { hostLabel: host.label, ...json.data.rateLimit },
  };
}
