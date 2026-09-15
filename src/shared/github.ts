import { ISSUE_KEY_PATTERN } from "./issue-key";
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

/**
 * The per-PR selection, shared by every search alias.
 *
 * `latestOpinionatedReviews(first: 15)` returns one node per reviewer — their
 * latest approve / request-changes — and that cap is load-bearing well beyond
 * the reviewer avatars. Six things are derived by scanning this one array:
 * `hasUnaddressedChangeRequest` (and `canBeMerged` through it),
 * `hasHumanApproval`, `hasNoReviews`, `viewerHasReviewed`, `viewerApproved` and
 * the `reviewers` list itself. The one to keep in mind is `viewerApproved`,
 * which decides whether "Hide my approvals" takes a card off the board: past 15
 * distinct opinionated reviewers the viewer's own node can fall outside the page
 * and read as "not approved". That is the fail-safe direction — the card stays
 * visible, nothing is hidden that shouldn't be — but a false negative all the
 * same.
 *
 * `myReReviewDue` (with `viewerRequestedChanges` and `viewerReviewedAt`, which
 * also read the viewer's node here) shares that cap and inverts its direction:
 * past 15 reviewers it reads false, so a PR whose merge is blocked on your
 * re-review stops claiming attention. That loses work rather than failing safe,
 * which makes it the stronger argument for the `reviews(author:, states:)`
 * route below — an extra cached per-host lookup buys both signals correctness.
 *
 * There is no viewer-keyed field to sidestep it. `viewerLatestOpinionatedReview`
 * does not exist (introspected on github.com and GHE alike), and
 * `viewerLatestReview` is the latest review of ANY kind, so a plain comment left
 * after an approval would read as not-approved — worse, and far more common. The
 * route that works is `reviews(author: <viewer login>, states: [APPROVED,
 * CHANGES_REQUESTED])`, which needs the login as a query variable and therefore
 * a cached per-host lookup, on the pattern of the team-slug cache.
 *
 * Deliberately out here rather than as a `#` comment inside the template: every
 * byte in there is sent to GitHub on each poll, and prose inside a template
 * literal is exactly how a stray backtick broke this build once.
 */
const PR_FIELDS_FRAGMENT = /* GraphQL */ `
fragment PrFields on PullRequest {
  id
  number
  title
  url
  isDraft
  createdAt
  updatedAt
  baseRefName
  headRefName
  mergeable
  author { login avatarUrl }
  repository { nameWithOwner defaultBranchRef { name } }
  reviewDecision
  reviewRequests(first: 15) {
    totalCount
    nodes { requestedReviewer { __typename ... on User { login avatarUrl } } }
  }
  # 15 is load-bearing — see the note above this fragment before changing it.
  latestOpinionatedReviews(first: 15) {
    nodes { author { __typename login avatarUrl } state submittedAt }
  }
  comments { totalCount }
  reviewThreads(first: 50) {
    nodes {
      isResolved
      comments(last: 1) { totalCount nodes { author { login } createdAt } }
    }
  }
  commits(last: 1) {
    nodes {
      commit {
        pushedDate
        committedDate
        statusCheckRollup {
          state
          contexts(first: 30) {
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
 * ONE HTTP request per search, all of a host's searches issued in parallel:
 *  - authored        — PRs the current user opened (author:@me)
 *  - reviewing        — PRs the user is *personally* asked to review (review-requested:@me)
 *  - reviewed         — PRs the user has already reviewed (reviewed-by:@me).
 *                       GitHub CLEARS the review request the moment you submit a
 *                       review, so a reviewed PR drops out of `review-requested:@me`
 *                       — without this search it vanishes from the dashboard exactly
 *                       when the author starts addressing your comments, which is
 *                       the case `returnedToMe` exists to catch.
 *  - team0..teamN     — PRs asked of a *team* the user belongs to
 *                       (team-review-requested:org/team). `review-requested:@me`
 *                       does NOT cover team requests, so these are searched
 *                       separately — one per team — and merged by id.
 *
 * These used to travel as aliases inside a SINGLE request. GitHub runs aliased
 * searches one after another and its GraphQL proxy gives the whole request about
 * 10 seconds, so the durations ADD UP: measured on github.com at peak hours,
 * authored 2.6s + reviewing 1.0s + reviewed 4.6s + six team searches ≈ 10.5s,
 * and 9 of 10 polls came back `HTTP 502 Bad Gateway` from nginx — every day from
 * roughly 15:00 Kyiv time, when GitHub's backend is busiest. Nothing in the repo
 * had changed when this started — the sum crept over the limit on its own, and
 * every team the user joins adds another search to it. Split
 * across requests the wait is the SLOWEST search (~4.6s) instead of their sum,
 * and each request is far from the timeout. The rate-limit price is unchanged —
 * each search still costs its own ~14 points wherever it is sent — so `cost` is
 * summed back up across the responses, or the poller would read github.com as a
 * cheap host and poll it several times more often.
 *
 * Each search is filtered by all of the host's repositories (multiple `repo:`
 * qualifiers act as OR).
 */
function buildQuery(alias: string, varName: string): string {
  return /* GraphQL */ `
query ($${varName}: String!) {
  rateLimit { remaining cost resetAt }
  viewer { login }
  ${alias}: search(query: $${varName}, type: ISSUE, first: 25) { nodes { ...PrFields } }
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
  baseRefName: string;
  headRefName: string;
  // GitHub's mergeability enum: "MERGEABLE" | "CONFLICTING" | "UNKNOWN".
  // Computed asynchronously — "UNKNOWN" right after a push, settles on a re-poll.
  mergeable: string;
  author: { login: string; avatarUrl: string } | null;
  repository: { nameWithOwner: string; defaultBranchRef: { name: string } | null };
  reviewDecision: ReviewDecision;
  reviewRequests: {
    totalCount: number;
    // requestedReviewer is a union (User/Team/…); only Users have `login`.
    nodes: Array<{ requestedReviewer: { __typename: string; login?: string; avatarUrl?: string } | null }>;
  };
  latestOpinionatedReviews: {
    nodes: Array<{
      author: { __typename: string; login: string; avatarUrl: string } | null;
      state: string;
      submittedAt: string | null;
    }>;
  };
  comments: { totalCount: number };
  reviewThreads: {
    nodes: Array<{
      isResolved: boolean;
      comments: {
        totalCount: number;
        nodes: Array<{ author: { login: string } | null; createdAt: string }>;
      };
    }>;
  };
  commits: {
    nodes: Array<{
      commit: {
        pushedDate: string | null;
        committedDate: string | null;
        statusCheckRollup: { state: string | null; contexts: { nodes: RawContext[] } } | null;
      };
    }>;
  };
}

type SearchNodes = { nodes: Array<RawPr | Record<string, never>> };

interface RawResponse {
  data?: {
    rateLimit: { remaining: number; cost: number; resetAt: string };
    viewer: { login: string } | null;
    // The one search alias this request carried: authored / reviewing /
    // reviewed / team0..teamN.
    [alias: string]:
      | SearchNodes
      | { remaining: number; cost: number; resetAt: string }
      | { login: string }
      | null;
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

/**
 * Matches an issue-tracker key like "ENG-93374" anywhere in a string. Used to
 * group related PRs, and — via the same shared shape — to decide whether the
 * card can link the key to Jira.
 */
const ISSUE_KEY_RE = new RegExp(`\\b(${ISSUE_KEY_PATTERN})\\b`);

/** Parses an issue key from the PR title, falling back to the head branch. */
function parseIssueKey(title: string, headRefName: string): string | null {
  const fromTitle = title.match(ISSUE_KEY_RE);
  if (fromTitle) return fromTitle[1];
  // Branches are often lowercase (feature/eng-93374-foo) — normalize before matching.
  const fromBranch = (headRefName ?? "").toUpperCase().match(ISSUE_KEY_RE);
  return fromBranch ? fromBranch[1] : null;
}

/** Maps a raw PR into the domain model (without activity fields — those are added by state.ts). */
export function mapPr(
  pr: RawPr,
  hostLabel: string,
  roles: PrRole[],
  viewerLogin: string | null,
): PullRequest {
  const threads = pr.reviewThreads.nodes;
  const unresolvedThreads = threads.filter((t) => !t.isResolved).length;
  const reviewCommentCount = threads.reduce((sum, t) => sum + t.comments.totalCount, 0);
  const totalComments = pr.comments.totalCount + reviewCommentCount;

  // "Comments without an answer": an unresolved thread whose latest comment is
  // not by the PR author. If the author already replied (last comment is theirs)
  // the ball is back on the reviewer, so it does not count. A null author (PR
  // with no resolvable author) makes every reviewer comment count, which is the
  // safe side.
  const authorLogin = pr.author?.login ?? null;
  const unaddressedThreads = threads.filter((t) => {
    if (t.isResolved) return false;
    const lastCommentLogin = t.comments.nodes[t.comments.nodes.length - 1]?.author?.login ?? null;
    return lastCommentLogin !== authorLogin;
  }).length;
  const hasUnaddressedComments = unaddressedThreads > 0;

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

  // defaultBranchRef is null only on an empty repository; treat that as
  // "default" so the stacked-PR marker doesn't light up on every card.
  const defaultBranch = pr.repository.defaultBranchRef?.name ?? null;
  const baseIsDefaultBranch = defaultBranch === null || pr.baseRefName === defaultBranch;

  // Latest commit's push time — pushedDate can be null on some commits, so fall
  // back to committedDate. Basis for detecting new pushes since a review.
  const latestCommit = pr.commits.nodes[0]?.commit;
  const lastCommitPushedAt = latestCommit?.pushedDate ?? latestCommit?.committedDate ?? null;

  // The viewer's own opinionated review clears GitHub's `reviewer` role, so this
  // is how a reviewed PR stays recognizable as "mine" for the returned-to-me signal.
  const viewerHasReviewed =
    viewerLogin != null &&
    pr.latestOpinionatedReviews.nodes.some((r) => r.author?.login === viewerLogin);
  // The narrower half of the same signal: your latest word on this PR is
  // "approved". `latestOpinionatedReviews` returns one node per reviewer, so a
  // later change request of yours replaces the approval here rather than adding
  // to it, and a dismissed approval stops being opinionated at all — both make
  // this false again without any bookkeeping of ours.
  const viewerApproved =
    viewerLogin != null &&
    pr.latestOpinionatedReviews.nodes.some(
      (r) => r.author?.login === viewerLogin && r.state === "APPROVED",
    );
  const hasNoReviews = pr.latestOpinionatedReviews.nodes.length === 0;

  // The other half of `viewerApproved`: your latest word is "request changes",
  // so the merge is blocked on YOU re-reviewing. One node per reviewer means a
  // later approval of yours replaces this rather than adding to it.
  const viewerReview =
    viewerLogin == null
      ? undefined
      : pr.latestOpinionatedReviews.nodes.find((r) => r.author?.login === viewerLogin);
  const viewerRequestedChanges = viewerReview?.state === "CHANGES_REQUESTED";
  const viewerReviewedAt = viewerReview?.submittedAt ?? null;

  // "My re-review is due": your change request still stands AND the author has
  // since acted, so the ball is back in your court. Deliberately computed here,
  // at fetch time, from live PR state only — unlike `returnedToMe` it must NOT
  // depend on the seen-snapshot, because opening the card is exactly what used
  // to silence this case forever while the re-review stayed outstanding.
  //
  // Author action is required in BOTH branches. A change request left as a
  // review body alone (no line threads) has zero unresolved threads from the
  // start, so keying off resolution alone would light the card up while the
  // ball is still with the author. `.some()` rather than `.every()` on the
  // replies: a thread where YOU commented last must not mask the author's
  // replies on the others. The last commenter must be the PR author — a
  // co-reviewer or a bot answering after your review does not move the ball
  // back to you — and an unresolvable author (deleted account, or a PR with no
  // author) reads as "no reply", the safe side for a signal that demands
  // attention. This is the mirror image of `unaddressedThreads` above, where
  // counting a null author is instead the safe side.
  //
  // The push comparison inherits the `committedDate` fallback caveat above — a
  // rebase that preserves old committer dates can read as "no push since your
  // review". Same tradeoff `returnedToMe`'s newPush already lives with.
  const authorRepliedAfterReview =
    viewerReviewedAt != null &&
    threads.some((t) => {
      const last = t.comments.nodes[t.comments.nodes.length - 1];
      return last != null && last.author?.login === authorLogin && last.createdAt > viewerReviewedAt;
    });
  const myReReviewDue =
    viewerRequestedChanges &&
    viewerReviewedAt != null &&
    ((lastCommitPushedAt != null && lastCommitPushedAt > viewerReviewedAt) ||
      (unresolvedThreads === 0 && authorRepliedAfterReview));

  const issueKey = parseIssueKey(pr.title, pr.headRefName);

  // Build reviewer list: pending first (requested but not yet reviewed, or re-requested),
  // then opinionated reviews that are still the "latest" state for that person.
  const reviewers: Reviewer[] = [];
  const seenLogins = new Set<string>();
  // A single human approve marks the PR good-to-go (see PullRequest.hasHumanApproval).
  // Bots that leave an APPROVED review (rare — agents usually only COMMENT) don't count.
  let hasHumanApproval = false;
  for (const n of pr.reviewRequests.nodes) {
    const r = n.requestedReviewer;
    if (r?.__typename === "User" && r.login && !seenLogins.has(r.login)) {
      reviewers.push({ login: r.login, avatarUrl: r.avatarUrl ?? "", reviewState: "pending" });
      seenLogins.add(r.login);
    }
  }
  for (const r of pr.latestOpinionatedReviews.nodes) {
    if (!r.author || seenLogins.has(r.author.login)) continue;
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") continue;
    if (r.state === "APPROVED" && r.author.__typename === "User") hasHumanApproval = true;
    reviewers.push({
      login: r.author.login,
      avatarUrl: r.author.avatarUrl,
      reviewState: r.state === "APPROVED" ? "approved" : "changes_requested",
    });
    seenLogins.add(r.author.login);
  }

  // "Can be merged": the composite readiness signal behind the filter chip. Ready
  // means no conflicts (GitHub says MERGEABLE — not CONFLICTING and not the
  // transient UNKNOWN), a human has approved, no change request is waiting on the
  // author, and CI is neither failing nor still running. Drafts are never ready.
  // The `reviewDecision !== "CHANGES_REQUESTED"` guard catches the case
  // `hasUnaddressedChangeRequest` deliberately misses: a second reviewer's
  // change request that was re-requested (so the ball looks like it's on them)
  // still gates the merge under branch protection. It's a disqualifier, not a
  // requirement — null/REVIEW_REQUIRED (unprotected repos) still pass.
  const canBeMerged =
    !pr.isDraft &&
    pr.mergeable === "MERGEABLE" &&
    hasHumanApproval &&
    !hasUnaddressedChangeRequest &&
    pr.reviewDecision !== "CHANGES_REQUESTED" &&
    failingChecks.length === 0 &&
    pendingChecks.length === 0;

  // Hard conflict only. GitHub reports UNKNOWN while it recomputes mergeability
  // right after a push; treating that as a conflict would falsely flag a PR the
  // instant it is pushed, so key strictly off CONFLICTING.
  const hasConflicts = pr.mergeable === "CONFLICTING";

  return {
    id: pr.id,
    hostLabel,
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: pr.isDraft,
    baseRefName: pr.baseRefName,
    baseIsDefaultBranch,
    author: pr.author,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    lastCommitPushedAt,
    headRefName: pr.headRefName,
    issueKey,
    reviewDecision: pr.reviewDecision,
    roles,
    viewerHasReviewed,
    viewerApproved,
    viewerReviewedAt,
    myReReviewDue,
    hasNoReviews,
    unresolvedThreads,
    unaddressedThreads,
    totalComments,
    checks,
    failingChecks,
    pendingChecks,
    ciState,
    reviewers,
    awaitingReview,
    hasUnaddressedChangeRequest,
    hasUnaddressedComments,
    hasHumanApproval,
    hasConflicts,
    canBeMerged,
    // Resolved later by the poller's Jira enricher (null without Jira):
    issueSummary: null,
    parentKey: null,
    parentSummary: null,
    // Activity fields are overwritten in state.ts:
    hasNewActivity: false,
    returnedToMe: false,
    lastSeenAt: null,
    needsAttention: false,
    // Overwritten in ignored.ts from the persistent ignored set:
    isIgnored: false,
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
 * Derives the REST API base from a host's GraphQL URL:
 *  - https://api.github.com/graphql         -> https://api.github.com
 *  - https://api.<tenant>.ghe.com/graphql   -> https://api.<tenant>.ghe.com
 *  - https://github.company.com/api/graphql -> https://github.company.com/api/v3
 *
 * Enterprise Server keeps REST under `/api/v3`; Cloud (and GHE.com data
 * residency) serves it from the origin. Shared by every REST caller on a host
 * (team discovery, the notifications detector).
 */
export function restBaseUrl(graphqlUrl: string): string {
  const url = new URL(graphqlUrl);
  const prefix = url.pathname.endsWith("/api/graphql") ? "/api/v3" : "";
  return `${url.origin}${prefix}`;
}

/** REST `/user/teams` endpoint for a host. */
function userTeamsUrl(graphqlUrl: string): string {
  return `${restBaseUrl(graphqlUrl)}/user/teams`;
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
 * Sends one GraphQL search to a host and returns its `data` block.
 *
 * The error text deliberately does NOT carry an HTML body: a 502 from GitHub's
 * nginx answers with a full HTML page, and pasting its first 200 characters into
 * the message turned the dashboard's error strip into a wall of
 * `<html><head><title>502 Bad Gateway</title>…` markup that says nothing the
 * status line does not. JSON bodies (GitHub's own error payloads) are still
 * included — those name the actual problem.
 */
async function postSearch(
  host: HostConfig,
  query: string,
  variables: Record<string, string>,
): Promise<NonNullable<RawResponse["data"]>> {
  const res = await fetch(host.graphqlUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${host.token}`,
      "Content-Type": "application/json",
      "User-Agent": "github-pr-manager",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = isJsonBody(text) ? ` — ${text.slice(0, 200)}` : "";
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail}`.trimEnd());
  }

  const json = (await res.json()) as RawResponse;
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) {
    throw new Error("Empty GraphQL response.");
  }
  return json.data;
}

/** Whether a response body is worth quoting in an error message. */
function isJsonBody(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
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

  // One search per request, all in flight at once. `required` marks the three
  // core searches: if any of them fails the whole host fails, so the poller keeps
  // its last good PR list instead of writing a truncated one over it (a short
  // list would read as "these PRs disappeared" and fire notifications). The team
  // searches are best-effort, like team discovery above.
  interface SearchSpec {
    alias: string;
    varName: string;
    query: string;
    role: PrRole;
    required: boolean;
  }
  const specs: SearchSpec[] = [
    {
      alias: "authored",
      varName: "authoredQuery",
      query: buildSearchQuery(host.repos, "author:@me"),
      role: "author",
      required: true,
    },
    {
      alias: "reviewing",
      varName: "reviewingQuery",
      query: buildSearchQuery(host.repos, "review-requested:@me"),
      role: "reviewer",
      required: true,
    },
    // Team-requested PRs count as a "reviewer" role, same as personal requests —
    // except on your own PRs, where `isOwnPr` turns it back into `author`.
    ...teamSlugs.map((slug, i) => ({
      alias: `team${i}`,
      varName: `teamQuery${i}`,
      query: buildSearchQuery(host.repos, `team-review-requested:${slug}`),
      role: "reviewer" as PrRole,
      required: false,
    })),
    {
      alias: "reviewed",
      varName: "reviewedQuery",
      // Sorted, unlike its siblings, because this is the one set that only grows:
      // a PR stays matched by `reviewed-by:@me` for its whole open life, while the
      // other qualifiers clear themselves (you merge your PR, the request is
      // satisfied). Past the `first: 25` cap the default "best match" order is
      // neither recency-ordered nor stable — measured: it returned an older PR
      // ahead of a newer one — so the window would both hide the PRs you care
      // about and shuffle between polls, flickering cards in and out.
      query: buildSearchQuery(host.repos, "reviewed-by:@me sort:updated-desc"),
      role: "reviewed",
      required: true,
    },
  ];

  const settled = await Promise.allSettled(
    specs.map((spec) =>
      postSearch(host, buildQuery(spec.alias, spec.varName), { [spec.varName]: spec.query }),
    ),
  );

  const failedRequired = specs.findIndex(
    (spec, i) => spec.required && settled[i].status === "rejected",
  );
  if (failedRequired >= 0) {
    throw (settled[failedRequired] as PromiseRejectedResult).reason;
  }

  // The rate-limit price did not change by splitting the request, so neither may
  // the number the poller sees: `cost` is the sum of every search's own cost, or
  // `hostIntervalMs` would read this host as cheap and poll it far more often.
  // `remaining` is the lowest reading — the budget only falls within a window,
  // so the smallest number is the most recent one.
  let cost = 0;
  let remaining: number | null = null;
  let resetAt = "";
  let viewerLogin: string | null = null;
  const nodesByAlias = new Map<string, Array<RawPr | Record<string, never>>>();

  settled.forEach((result, i) => {
    const spec = specs[i];
    if (result.status === "rejected") {
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn(`[github] "${spec.alias}" search failed for "${host.label}": ${message}`);
      return;
    }
    const data = result.value;
    cost += data.rateLimit?.cost ?? 0;
    if (data.rateLimit && (remaining === null || data.rateLimit.remaining < remaining)) {
      remaining = data.rateLimit.remaining;
      resetAt = data.rateLimit.resetAt;
    }
    // `isOwnPr` needs it, and a null login silently re-opens the bug where a
    // team request on your own PR claims a review from you — so take it from
    // whichever response carries one.
    const viewer = data.viewer as { login: string } | null | undefined;
    if (viewerLogin === null && viewer?.login) viewerLogin = viewer.login;
    const search = data[spec.alias] as SearchNodes | undefined;
    if (search?.nodes) nodesByAlias.set(spec.alias, search.nodes);
  });

  // Merge authored + reviewing, unioning roles.
  const byId = new Map<string, PullRequest>();

  // You cannot review your own PR, but a review requested of a TEAM you belong
  // to matches `team-review-requested:` on your OWN pull requests as well — so
  // the team searches were handing your authored PRs a `reviewer` role. That
  // role is what paints the card violet (`prSignal` -> myReview), adds the
  // "Reviewer" pill, and counts the PR into "Needs attention", i.e. it claimed a
  // review from you that you can never submit. Keyed on the node's author rather
  // than on an already-collected `author` role: the authored search is capped at
  // `first: 25`, so your own PR can arrive from a team search with no entry yet,
  // and it must still land as `author` (dropping it would lose the card).
  const isOwnPr = (node: RawPr) =>
    viewerLogin != null && node.author?.login.toLowerCase() === viewerLogin.toLowerCase();

  const addNodes = (nodes: Array<RawPr | Record<string, never>>, role: PrRole) => {
    for (const node of nodes) {
      if (!isRawPr(node)) continue;
      const effectiveRole: PrRole = role === "reviewer" && isOwnPr(node) ? "author" : role;
      const existing = byId.get(node.id);
      if (existing) {
        if (!existing.roles.includes(effectiveRole)) existing.roles.push(effectiveRole);
      } else {
        byId.set(node.id, mapPr(node, host.label, [effectiveRole], viewerLogin));
      }
    }
  };

  // Spec order is what decides the roles: "author" and the outstanding requests
  // first, "reviewed" last so its passive role unions onto an outstanding one
  // rather than replacing it (a PR you reviewed and were then re-requested on
  // carries both, and "reviewer" is what claims your attention).
  // `reviewed-by:@me` also matches your own PRs, where the role is redundant
  // next to "author"; harmless, and dropping it would need a lookahead.
  for (const spec of specs) {
    const nodes = nodesByAlias.get(spec.alias);
    if (nodes) addNodes(nodes, spec.role);
  }

  return {
    pullRequests: [...byId.values()],
    rateLimit: { hostLabel: host.label, remaining: remaining ?? 0, cost, resetAt },
  };
}
