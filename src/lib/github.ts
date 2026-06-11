import type {
  CheckItem,
  CheckState,
  HostConfig,
  PrRole,
  PullRequest,
  RateLimitInfo,
  ReviewDecision,
  Reviewer,
} from "./types";

const PR_FIELDS_FRAGMENT = /* GraphQL */ `
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
  reviewRequests(first: 50) {
    totalCount
    nodes { requestedReviewer { __typename ... on User { login avatarUrl } } }
  }
  latestOpinionatedReviews(first: 50) {
    nodes { author { login avatarUrl } state }
  }
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

/**
 * One GraphQL request per host, merged into a single HTTP call via aliases:
 *  - authored        — PRs the current user opened (author:@me)
 *  - reviewing        — PRs the user is *personally* asked to review (review-requested:@me)
 *  - team0..teamN     — PRs asked of a *team* the user belongs to
 *                       (team-review-requested:org/team). `review-requested:@me`
 *                       does NOT cover team requests, so these are searched
 *                       separately — one alias per team — and merged by id.
 *
 * Each search is filtered by all of the host's repositories (multiple `repo:`
 * qualifiers act as OR).
 */
function buildQuery(teamCount: number): string {
  const teamVarDecls = Array.from({ length: teamCount }, (_, i) => `, $teamQuery${i}: String!`).join("");
  const teamSearches = Array.from(
    { length: teamCount },
    (_, i) => `  team${i}: search(query: $teamQuery${i}, type: ISSUE, first: 100) { nodes { ...PrFields } }`,
  ).join("\n");
  return /* GraphQL */ `
query ($authoredQuery: String!, $reviewingQuery: String!${teamVarDecls}) {
  rateLimit { remaining cost resetAt }
  authored: search(query: $authoredQuery, type: ISSUE, first: 100) { nodes { ...PrFields } }
  reviewing: search(query: $reviewingQuery, type: ISSUE, first: 100) { nodes { ...PrFields } }
${teamSearches}
}
${PR_FIELDS_FRAGMENT}`;
}

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
  reviewRequests: {
    totalCount: number;
    // requestedReviewer is a union (User/Team/…); only Users have `login`.
    nodes: Array<{ requestedReviewer: { __typename: string; login?: string; avatarUrl?: string } | null }>;
  };
  latestOpinionatedReviews: { nodes: Array<{ author: { login: string; avatarUrl: string } | null; state: string }> };
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

type SearchNodes = { nodes: Array<RawPr | Record<string, never>> };

interface RawResponse {
  data?: {
    rateLimit: { remaining: number; cost: number; resetAt: string };
    authored: SearchNodes;
    reviewing: SearchNodes;
    // team0, team1, … — one per team-review-requested search.
    [alias: string]: SearchNodes | { remaining: number; cost: number; resetAt: string };
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

  // awaitingReview: someone's review is still pending (GitHub's "yellow dots").
  // hasUnaddressedChangeRequest: a reviewer requested changes and has NOT been
  // re-requested — i.e. the ball is in the author's court. If the change-requester
  // was re-requested they reappear in reviewRequests, so the ball is back on them.
  // (Capped at 50 reviewers/reviews — ample for normal PRs.)
  const pendingReviewers = new Set(
    pr.reviewRequests.nodes
      .map((n) => n.requestedReviewer?.login)
      .filter((login): login is string => Boolean(login)),
  );
  const hasUnaddressedChangeRequest = pr.latestOpinionatedReviews.nodes.some(
    (r) =>
      r.state === "CHANGES_REQUESTED" && r.author != null && !pendingReviewers.has(r.author.login),
  );
  const awaitingReview = pr.reviewRequests.totalCount > 0;

  // Build reviewer list: pending first (requested but not yet reviewed, or re-requested),
  // then opinionated reviews that are still the "latest" state for that person.
  const reviewers: Reviewer[] = [];
  const seenLogins = new Set<string>();
  for (const n of pr.reviewRequests.nodes) {
    const r = n.requestedReviewer;
    if (r?.__typename === "User" && r.login) {
      reviewers.push({ login: r.login, avatarUrl: r.avatarUrl ?? "", reviewState: "pending" });
      seenLogins.add(r.login);
    }
  }
  for (const r of pr.latestOpinionatedReviews.nodes) {
    if (!r.author || seenLogins.has(r.author.login)) continue;
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") continue;
    reviewers.push({
      login: r.author.login,
      avatarUrl: r.author.avatarUrl,
      reviewState: r.state === "APPROVED" ? "approved" : "changes_requested",
    });
    seenLogins.add(r.author.login);
  }

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
    reviewers,
    awaitingReview,
    hasUnaddressedChangeRequest,
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
 * Derives the REST `/user/teams` endpoint from a host's GraphQL URL:
 *  - https://api.github.com/graphql        -> https://api.github.com/user/teams
 *  - https://api.<tenant>.ghe.com/graphql  -> https://api.<tenant>.ghe.com/user/teams
 *  - https://github.company.com/api/graphql -> https://github.company.com/api/v3/user/teams
 */
function userTeamsUrl(graphqlUrl: string): string {
  const url = new URL(graphqlUrl);
  // Enterprise Server keeps REST under /api/v3; Cloud serves it from the root.
  const prefix = url.pathname.endsWith("/api/graphql") ? "/api/v3" : "";
  return `${url.origin}${prefix}/user/teams`;
}

interface RawTeam {
  slug: string;
  organization: { login: string };
}

/**
 * Teams the authenticated user belongs to, as `org/team-slug` combined slugs
 * (the form `team-review-requested:` expects). Cached per host for a few
 * minutes — membership changes rarely and the poller runs every ~30s.
 */
const teamCache = new Map<string, { slugs: string[]; fetchedAt: number }>();
const TEAM_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchViewerTeams(host: HostConfig): Promise<string[]> {
  const cacheKey = host.graphqlUrl;
  const cached = teamCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TEAM_CACHE_TTL_MS) {
    return cached.slugs;
  }

  const headers = {
    Authorization: `Bearer ${host.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "github-pr-manager",
  };
  const slugs: string[] = [];
  const baseUrl = userTeamsUrl(host.graphqlUrl);
  // Paginate defensively; almost everyone fits in the first page.
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${baseUrl}?per_page=100&page=${page}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const teams = (await res.json()) as RawTeam[];
    for (const t of teams) {
      if (t?.organization?.login && t.slug) slugs.push(`${t.organization.login}/${t.slug}`);
    }
    if (teams.length < 100) break;
  }

  teamCache.set(cacheKey, { slugs, fetchedAt: Date.now() });
  return slugs;
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

  // `review-requested:@me` only matches *personal* requests. When a review is
  // asked of a team the user belongs to, the PR is invisible to it — so we also
  // search `team-review-requested:org/team` for each of the user's teams whose
  // org owns a configured repo. Team discovery is best-effort: a failure here
  // must not take down the dashboard, so we fall back to no team searches.
  const repoOrgs = new Set(host.repos.map((r) => r.split("/")[0]));
  let teamSlugs: string[] = [];
  try {
    teamSlugs = (await fetchViewerTeams(host)).filter((slug) =>
      repoOrgs.has(slug.split("/")[0]),
    );
  } catch (e) {
    console.warn(`[github] team discovery failed for "${host.label}": ${(e as Error).message}`);
  }

  const variables: Record<string, string> = {
    authoredQuery: buildSearchQuery(host.repos, "author:@me"),
    reviewingQuery: buildSearchQuery(host.repos, "review-requested:@me"),
  };
  teamSlugs.forEach((slug, i) => {
    variables[`teamQuery${i}`] = buildSearchQuery(host.repos, `team-review-requested:${slug}`);
  });

  const res = await fetch(host.graphqlUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${host.token}`,
      "Content-Type": "application/json",
      "User-Agent": "github-pr-manager",
    },
    body: JSON.stringify({ query: buildQuery(teamSlugs.length), variables }),
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
  // Team-requested PRs count as a "reviewer" role, same as personal requests.
  for (let i = 0; i < teamSlugs.length; i++) {
    const teamResult = json.data[`team${i}`] as SearchNodes | undefined;
    if (teamResult?.nodes) addNodes(teamResult.nodes, "reviewer");
  }

  return {
    pullRequests: [...byId.values()],
    rateLimit: { hostLabel: host.label, ...json.data.rateLimit },
  };
}
