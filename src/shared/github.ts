import { DEFAULT_SEARCH_LIMIT, validateSearchLimit } from "./config";
import { ISSUE_KEY_PATTERN } from "./issue-key";
import type {
  CheckItem,
  CheckState,
  HostConfig,
  MergeMethod,
  PrRole,
  PrStack,
  PrStackEntry,
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
 * `reviewThreads(last: 100)` is the other load-bearing page. GitHub lists
 * threads oldest first, so a `first:` page drops the NEWEST threads — the ones
 * most likely still open. With `first: 50` a PR with 53 threads whose last two
 * were unresolved read as 0 unresolved and painted green. `last:` keeps the
 * newest, and past 100 threads the ones that did not fit are counted as
 * unresolved and unaddressed (`hiddenThreads` in `mapPr`), so an oversized PR
 * fails closed — red — instead of reading clean. The price: each thread also
 * pulls `comments(last: 1)`, so GitHub bills about 1 point per 100 threads per
 * PR — measured, a 25-PR read by id costs 30 points. That is why this fragment
 * travels only in the hydrate (`buildHydrateQuery`), once per distinct PR, and
 * never inside a search. Node count stays far below the 500 000 limit
 * (≈ 25 × 100 × 1 thread comments + 25 × 30 check contexts per read).
 *
 * Deliberately out here rather than as a `#` comment inside the template: every
 * byte in there is sent to GitHub on each poll, and prose inside a template
 * literal is exactly how a stray backtick broke this build once.
 */
const PR_FIELDS_TEMPLATE = /* GraphQL */ `
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
  mergeStateStatus
  additions
  deletions
  changedFiles
  isCrossRepository
  __STACK__
  author { login avatarUrl }
  repository {
    nameWithOwner
    defaultBranchRef { name }
    viewerDefaultMergeMethod
    squashMergeAllowed
    mergeCommitAllowed
    rebaseMergeAllowed
  }
  reviewDecision
  reviewRequests(first: 15) {
    totalCount
    nodes { requestedReviewer { __typename ... on User { login avatarUrl } } }
  }
  # 15 is load-bearing — see the note above this fragment before changing it.
  latestOpinionatedReviews(first: 15) {
    nodes {
      author { __typename login avatarUrl } state submittedAt body updatedAt
      commit { oid }
      reactions(first: 100, content: EYES) { nodes { content createdAt user { login } } }
    }
  }
  # Every reviewer's latest review of any kind, DISMISSED and COMMENTED included —
  # only for the avatar row, so an approval a push dismissed still shows who it was.
  latestReviews(first: 15) {
    nodes { author { __typename login avatarUrl } state }
  }
  comments { totalCount }
  # last, not first — see the note above this fragment before changing it.
  reviewThreads(last: 100) {
    totalCount
    nodes {
      isResolved
      comments(last: 1) { totalCount nodes { author { login } createdAt } }
    }
  }
  commits(last: 1) {
    nodes {
      commit {
        oid
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
 * GitHub's native PR stacks. Measured on creatio.ghe.com: the selection leaves
 * a 25-PR read at the same cost (1 point by dryRun), since stacks are short and
 * `entries(first: 10)` is billed per page, not per node.
 *
 * Not every host has the fields yet — an older GitHub Enterprise Server answers
 * `Field 'stack' doesn't exist on type 'PullRequest'` and fails the whole read.
 * `hydrate` drops this selection for such a host and remembers it
 * (`hostsWithoutStacks`), rather than probing every host with an extra request.
 * Entries carry `state` because a merged PR can still be listed for a moment
 * after GitHub merges it; the bottom is the lowest OPEN entry.
 */
const STACK_SELECTION = `stackEntry { position }
  stack {
    number
    size
    baseRefName
    entries(first: 10) { nodes { position pullRequest { number title url state } } }
  }`;

function prFieldsFragment(withStacks: boolean): string {
  return PR_FIELDS_TEMPLATE.replace("__STACK__", withStacks ? STACK_SELECTION : "");
}

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
 * and each request is far from the timeout.
 *
 * The searches carry only `id` and the author's login, and every PR they found
 * is then read ONCE, by id, through `nodes(ids:)` — `buildHydrateQuery`. The
 * full selection is what GitHub bills for (`reviewThreads(last: 100)` with its
 * comments above all): measured on github.com, a search carrying it costs 30
 * points whatever it matched, a search of ids costs 1, and `nodes(ids:)` costs
 * about 1.2 points per PR (6 for 5, 19 for 16, 30 for 25). With nine searches —
 * three personal, six teams — that took a tick from 270 points to ~9 + 1.2 per
 * distinct PR, and the searches overlap heavily (your own PRs match `author`,
 * `reviewed-by` and the team searches alike), so a PR they share is no longer
 * paid for once per search. `cost` is still summed across every response, or
 * the poller would read github.com as a cheap host and poll it far more often.
 *
 * Each search is filtered by all of the host's repositories (multiple `repo:`
 * qualifiers act as OR) — or by none on an `allRepos` host, where the `@me`
 * qualifiers alone scope it. `first` is the host's `searchLimit` (default 25).
 */
function buildQuery(alias: string, varName: string, first = DEFAULT_SEARCH_LIMIT): string {
  return /* GraphQL */ `
query ($${varName}: String!) {
  rateLimit { limit remaining cost resetAt }
  viewer { login }
  ${alias}: search(query: $${varName}, type: ISSUE, first: ${first}) { nodes { ... on PullRequest { id author { login } } } }
}`;
}

/**
 * PRs read by id per hydrate request. 25 is the page the full selection used to
 * travel with inside a search, so one request stays as far from GitHub's ~10 s
 * proxy timeout and its 500 000-node limit as a search ever was; more PRs than
 * that go out as parallel requests, for the same reason the searches are split.
 */
const HYDRATE_CHUNK = 25;

function buildHydrateQuery(withStacks = true): string {
  return /* GraphQL */ `
query ($ids: [ID!]!) {
  rateLimit { limit remaining cost resetAt }
  hydrated: nodes(ids: $ids) { ...PrFields }
}
${prFieldsFragment(withStacks)}`;
}

/** Hosts whose schema has no PR stacks — see `STACK_SELECTION`. Per app run. */
const hostsWithoutStacks = new Set<string>();

/** The error an older server answers a stack selection with. */
function isMissingStackField(e: unknown): boolean {
  return e instanceof Error && /Field '(stack|stackEntry)' doesn't exist on type 'PullRequest'/.test(e.message);
}

/** One read by id, without the stack selection on a host known to lack it. */
async function hydrate(host: HostConfig, ids: string[]): Promise<NonNullable<RawResponse["data"]>> {
  const withStacks = !hostsWithoutStacks.has(host.graphqlUrl);
  try {
    return await postSearch(host, buildHydrateQuery(withStacks), { ids }, { allowNotFound: true });
  } catch (e) {
    if (!withStacks || !isMissingStackField(e)) throw e;
    hostsWithoutStacks.add(host.graphqlUrl);
    return postSearch(host, buildHydrateQuery(false), { ids }, { allowNotFound: true });
  }
}

/** A PR read fresh, with what the dashboard's search can't say: whether it is still open. */
export interface FreshPullRequest {
  pr: PullRequest;
  state: "OPEN" | "MERGED" | "CLOSED";
  /** Your login on that host. */
  viewer: string | null;
}

/**
 * One PR read again by id, right before the agent posts to it or merges it —
 * the snapshot can be minutes old, and its search only ever sees open PRs.
 * Mapped by the same `mapPr` as the dashboard, so "ready to merge" means the
 * same thing in both places. Roles come from the caller: a read by id doesn't
 * say how you relate to the PR. Null when the PR is gone or out of reach.
 */
export async function fetchPullRequest(host: HostConfig, id: string, roles: PrRole[]): Promise<FreshPullRequest | null> {
  const query = (withStacks: boolean) => /* GraphQL */ `
query ($ids: [ID!]!) {
  viewer { login }
  hydrated: nodes(ids: $ids) { ...PrFields }
  status: nodes(ids: $ids) { ... on PullRequest { state } }
}
${prFieldsFragment(withStacks)}`;
  const withStacks = !hostsWithoutStacks.has(host.graphqlUrl);
  let data: NonNullable<RawResponse["data"]>;
  try {
    data = await postSearch(host, query(withStacks), { ids: [id] }, { allowNotFound: true });
  } catch (e) {
    if (!withStacks || !isMissingStackField(e)) throw e;
    hostsWithoutStacks.add(host.graphqlUrl);
    data = await postSearch(host, query(false), { ids: [id] }, { allowNotFound: true });
  }
  const node = (data.hydrated as HydratedNodes | undefined)?.[0] ?? null;
  if (!isRawPr(node)) return null;
  const state = ((data.status as Array<{ state?: string } | null> | undefined)?.[0]?.state ?? "OPEN") as FreshPullRequest["state"];
  const viewer = (data.viewer as { login: string } | null | undefined)?.login ?? null;
  return { pr: mapPr(node, host.label, [...roles], viewer), state, viewer };
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
  mergeStateStatus: string;
  // Absent (undefined) when the host's schema has no stacks; null outside one.
  stackEntry?: { position: number } | null;
  stack?: {
    number: number;
    size: number;
    baseRefName: string;
    entries: {
      nodes: Array<{ position: number; pullRequest: { number: number; title: string; url: string; state: string } | null }>;
    };
  } | null;
  // Optional so hand-built fixtures stay valid; GitHub always sends them.
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  isCrossRepository?: boolean;
  author: { login: string; avatarUrl: string } | null;
  repository: {
    nameWithOwner: string;
    defaultBranchRef: { name: string } | null;
    // GitHub's PullRequestMergeMethod enum: "MERGE" | "SQUASH" | "REBASE".
    viewerDefaultMergeMethod?: string | null;
    squashMergeAllowed?: boolean;
    mergeCommitAllowed?: boolean;
    rebaseMergeAllowed?: boolean;
  };
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
      body?: string;
      updatedAt?: string;
      commit?: { oid: string } | null;
      reactions?: { nodes: Array<{ content: string; createdAt: string; user: { login: string } | null }> };
    }>;
  };
  // Optional: fixtures and older cached reads may lack it.
  latestReviews?: {
    nodes: Array<{ author: { __typename: string; login: string; avatarUrl: string } | null; state: string }>;
  };
  comments: { totalCount: number };
  reviewThreads: {
    totalCount: number;
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
        oid?: string;
        pushedDate: string | null;
        committedDate: string | null;
        statusCheckRollup: { state: string | null; contexts: { nodes: RawContext[] } } | null;
      };
    }>;
  };
}

/** What a search returns per PR: just enough to merge roles and spot your own PRs. */
interface RawSearchPr {
  id: string;
  author: { login: string } | null;
}
type SearchNodes = { nodes: Array<RawSearchPr | Record<string, never>> };
type HydratedNodes = Array<RawPr | Record<string, never> | null>;

interface RawResponse {
  data?: {
    rateLimit: { limit?: number; remaining: number; cost: number; resetAt: string };
    viewer: { login: string } | null;
    // The one search alias this request carried (authored / reviewing /
    // reviewed / team0..teamN), or `hydrated` on a read by id.
    [alias: string]:
      | SearchNodes
      | HydratedNodes
      | { limit?: number; remaining: number; cost: number; resetAt: string }
      | { login: string }
      | null;
  };
  errors?: Array<{ message: string; type?: string; code?: string }>;
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

/** Only plain approvals are safe to interpret automatically. Unknown prose is
 * kept for human review: text length and a keyword list cannot prove intent.
 * Author EYES acknowledgement on that specific review also clears feedback.
 * It must postdate the body's last edit; another user's reaction never counts.
 * Pushes, author replies and re-requests alone do not clear feedback.
 */
export function approvalBodyNeedsAttention(body: string | undefined): boolean {
  const text = (body ?? "").trim().toLowerCase().replace(/[.!✅👍]+$/u, "").trim();
  return text !== "" && !/^(?:lgtm|looks good(?: to me)?|approved|approve|thanks|thank you|good job|nice work|ship it|✅|👍)$/.test(text);
}

/**
 * The PR's place in a native GitHub stack, or null outside one. The bottom is
 * the lowest-positioned OPEN entry other than this PR, and only when it sits
 * below this one — the PR GitHub merges first.
 */
function mapStack(pr: RawPr): PrStack | null {
  if (!pr.stack || !pr.stackEntry) return null;
  const position = pr.stackEntry.position;
  const entries: PrStackEntry[] = pr.stack.entries.nodes
    .flatMap((e) => (e.pullRequest ? [{ position: e.position, ...e.pullRequest }] : []))
    .sort((a, b) => a.position - b.position);
  const bottom = entries.find((e) => e.state === "OPEN" && e.position < position);
  return {
    number: pr.stack.number,
    position,
    size: pr.stack.size,
    baseRefName: pr.stack.baseRefName,
    entries,
    bottom: bottom ? { number: bottom.number, url: bottom.url } : null,
  };
}

/** Maps a raw PR into the domain model (without activity fields — those are added by state.ts). */
export function mapPr(
  pr: RawPr,
  hostLabel: string,
  roles: PrRole[],
  viewerLogin: string | null,
): PullRequest {
  const threads = pr.reviewThreads.nodes;
  // Threads past the `last: 100` page (the oldest ones) were never fetched, so
  // their state is unknown. They count as unresolved and unaddressed: a PR too
  // big to read in full must not read as clean. `?? threads.length` keeps a
  // response without totalCount (older fixtures) at zero hidden threads.
  const hiddenThreads = Math.max(0, (pr.reviewThreads.totalCount ?? threads.length) - threads.length);
  const unresolvedThreads = threads.filter((t) => !t.isResolved).length + hiddenThreads;
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
  }).length + hiddenThreads;
  const hasUnaddressedComments = unaddressedThreads > 0;

  // When the author last answered in a thread, and when someone else last
  // wrote in one — from the latest comment of each thread, which the query
  // already reads. The PR agent keys its re-review and drive runs on these, so
  // a reply without a push is new work too. Whose thread it is would take the
  // first comment's author, which doubles the read (measured: 26 → 51 points
  // for 25 PRs); the review skill sorts out its own threads instead.
  let authorRepliedAt: string | null = null;
  let reviewerRepliedAt: string | null = null;
  for (const t of threads) {
    const last = t.comments.nodes[t.comments.nodes.length - 1];
    if (!last?.createdAt) continue;
    if (authorLogin != null && last.author?.login === authorLogin) {
      if (authorRepliedAt === null || last.createdAt > authorRepliedAt) authorRepliedAt = last.createdAt;
    } else if (!t.isResolved && (reviewerRepliedAt === null || last.createdAt > reviewerRepliedAt)) {
      reviewerRepliedAt = last.createdAt;
    }
  }
  const hasUnaddressedReviewFeedback = pr.latestOpinionatedReviews.nodes.some(
    (r) => r.state === "APPROVED" && r.author?.__typename === "User" &&
      r.author.login !== authorLogin && approvalBodyNeedsAttention(r.body) &&
      !r.reactions?.nodes.some((reaction) =>
        authorLogin != null && reaction.content === "EYES" &&
        reaction.user?.login.toLowerCase() === authorLogin.toLowerCase() &&
        // Invalid/missing dates fail closed; edited feedback requires a new acknowledgement.
        Date.parse(reaction.createdAt) >= Date.parse(r.updatedAt ?? "")),
  );

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

  const stack = mapStack(pr);
  // Keyed on an open PR below this one rather than on `position > 1` alone, so
  // a stack whose lower PRs were just merged does not keep this one blocked.
  const blockedByStack = stack?.bottom != null;

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
  // Your latest opinionated review sits on the current head commit, so there is
  // no push you have not reviewed — whatever the commit dates say. The date
  // comparisons below fall back to `committedDate`, which GitHub can set later
  // than the review on the very commit you reviewed (a commit GitHub creates
  // itself has `pushedDate: null`); the oid is the only exact answer.
  const headOid = latestCommit?.oid ?? null;
  const viewerReviewedHead =
    headOid != null && viewerReview?.commit?.oid === headOid;

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
    ((lastCommitPushedAt != null && lastCommitPushedAt > viewerReviewedAt && !viewerReviewedHead) ||
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
  // Then everyone else who reviewed: an approval a push dismissed (GitHub's grey
  // check) and plain comments. The PR's author and bots are left out — GitHub's
  // sidebar lists neither as a reviewer.
  for (const r of pr.latestReviews?.nodes ?? []) {
    if (!r.author || r.author.__typename !== "User" || seenLogins.has(r.author.login)) continue;
    if (r.author.login === authorLogin) continue;
    if (r.state !== "DISMISSED" && r.state !== "COMMENTED") continue;
    reviewers.push({
      login: r.author.login,
      avatarUrl: r.author.avatarUrl,
      reviewState: r.state === "DISMISSED" ? "dismissed" : "commented",
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
  // requirement — null/REVIEW_REQUIRED (unprotected repos) still pass, unless
  // GitHub also reports the merge BLOCKED (`requiredReviewPending`): then the
  // approval in hand is not the one the rules ask for, e.g. a code owner's.
  const requiredReviewPending =
    hasHumanApproval && pr.reviewDecision === "REVIEW_REQUIRED" && pr.mergeStateStatus === "BLOCKED";
  const canBeMerged =
    !pr.isDraft &&
    pr.mergeable === "MERGEABLE" &&
    pr.mergeStateStatus !== "BEHIND" &&
    !blockedByStack &&
    hasHumanApproval &&
    !hasUnaddressedChangeRequest &&
    !hasUnaddressedReviewFeedback &&
    unresolvedThreads === 0 &&
    pr.reviewDecision !== "CHANGES_REQUESTED" &&
    !requiredReviewPending &&
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
    stack,
    blockedByStack,
    requiredReviewPending,
    author: pr.author,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    lastCommitPushedAt,
    headRefName: pr.headRefName,
    headOid,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? 0,
    isCrossRepository: pr.isCrossRepository === true,
    authorRepliedAt,
    reviewerRepliedAt,
    mergeMethods: mapMergeMethods(pr.repository),
    // Set by fetchHost when the personal review-request search found it.
    requestedOfMe: false,
    issueKey,
    reviewDecision: pr.reviewDecision,
    roles,
    viewerHasReviewed,
    viewerApproved,
    viewerReviewedAt,
    viewerReviewedHead,
    viewerReviewedOid: viewerReview?.commit?.oid ?? null,
    myReReviewDue,
    hasNoReviews,
    // The threshold is a setting — the poller sets the real value.
    isStale: false,
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
    hasUnaddressedReviewFeedback,
    hasHumanApproval,
    hasConflicts,
    isBehindBase: pr.mergeStateStatus === "BEHIND",
    canBeMerged,
    // Resolved later by the poller's Jira enricher (null without Jira):
    issueSummary: null,
    parentKey: null,
    parentSummary: null,
    grandparentKey: null,
    grandparentSummary: null,
    // Activity fields are overwritten in state.ts:
    hasNewActivity: false,
    returnedToMe: false,
    lastSeenAt: null,
    needsAttention: false,
    // Overwritten in ignored.ts from the persistent ignored set:
    isIgnored: false,
  };
}

const MERGE_METHOD: Record<string, MergeMethod> = { MERGE: "merge", SQUASH: "squash", REBASE: "rebase" };

/**
 * GitHub's suggestion for this viewer and the methods the repository allows.
 * A host that sends no flags reads as "all allowed" — a refused merge is then
 * GitHub's answer, not a guess here.
 */
export function mapMergeMethods(repo: RawPr["repository"]): PullRequest["mergeMethods"] {
  const known = repo.squashMergeAllowed !== undefined || repo.mergeCommitAllowed !== undefined || repo.rebaseMergeAllowed !== undefined;
  const allowed: MergeMethod[] = known
    ? [
        ...(repo.mergeCommitAllowed ? (["merge"] as const) : []),
        ...(repo.squashMergeAllowed ? (["squash"] as const) : []),
        ...(repo.rebaseMergeAllowed ? (["rebase"] as const) : []),
      ]
    : ["merge", "squash", "rebase"];
  const suggested = MERGE_METHOD[repo.viewerDefaultMergeMethod ?? ""] ?? null;
  return { suggested: suggested && allowed.includes(suggested) ? suggested : (allowed[0] ?? null), allowed };
}

function isRawPr(node: RawPr | Record<string, never> | null): node is RawPr {
  return typeof (node as RawPr | null)?.id === "string";
}

function isSearchPr(node: RawSearchPr | Record<string, never>): node is RawSearchPr {
  return typeof (node as RawSearchPr).id === "string";
}

function buildSearchQuery(repos: string[], qualifier: string): string {
  return ["is:open is:pr", ...repos.map((r) => `repo:${r}`), qualifier].join(" ");
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
 * The host refused the request because the account's GraphQL budget is spent.
 * Not a failure of the host: every `gh` client on the same account (scheduled
 * routines, the sessions they start, another machine running this app) draws
 * from one 5000-point hourly budget, so it can run out without this app having
 * spent much of it. `resetAt` is when the budget refills — ISO, or "" when the
 * response named no time — so the poller can wait exactly that long instead of
 * retrying on its floor and keeping the error up for the rest of the hour.
 *
 * GitHub answers a spent budget with a 200 whose error is
 * `{ type: "RATE_LIMIT", code: "graphql_rate_limit" }` (message "API rate limit
 * already exceeded for user ID …") — `isRateLimitError` also takes the
 * `RATE_LIMITED` spelling the docs use — and a secondary limit with 403/429 plus
 * `retry-after`; all of them land here. Matching only `RATE_LIMITED` is what
 * left 1.18.3 showing the red failure strip and retrying all hour: that is not
 * the type github.com actually sends.
 */
export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly resetAt: string,
  ) {
    super(message);
    this.name = "RateLimitedError";
  }
}

/**
 * When the budget refills, from the response headers: `retry-after` (seconds,
 * secondary limits) wins over `x-ratelimit-reset` (epoch seconds, the primary
 * hourly window); "" when neither is present or parseable.
 */
function rateLimitResetAt(header: (name: string) => string | null): string {
  const retryAfter = Number(header("retry-after"));
  if (header("retry-after") !== null && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return new Date(Date.now() + retryAfter * 1000).toISOString();
  }
  const reset = Number(header("x-ratelimit-reset"));
  if (header("x-ratelimit-reset") !== null && Number.isFinite(reset) && reset > 0) {
    return new Date(reset * 1000).toISOString();
  }
  return "";
}

/**
 * Sends one GraphQL request (a search or a hydrate) to a host and returns its
 * `data` block.
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
  variables: Record<string, string | string[]>,
  { allowNotFound = false } = {},
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
    const message = `HTTP ${res.status} ${res.statusText}${detail}`.trimEnd();
    const header = (name: string) => res.headers?.get?.(name) ?? null;
    if (
      (res.status === 403 || res.status === 429) &&
      (header("x-ratelimit-remaining") === "0" || header("retry-after") !== null)
    ) {
      throw new RateLimitedError(message, rateLimitResetAt(header));
    }
    throw new Error(message);
  }

  const json = (await res.json()) as RawResponse;
  // A read by id answers a PR that went away since the search with a null node
  // AND a NOT_FOUND error next to the data for the rest; that is not a failed
  // request, and failing it would fail the whole host for one deleted PR.
  if (allowNotFound && json.data && json.errors?.every((e) => e.type === "NOT_FOUND")) {
    return json.data;
  }
  if (json.errors?.length) {
    const message = json.errors.map((e) => e.message).join("; ");
    if (json.errors.some(isRateLimitError)) {
      throw new RateLimitedError(message, rateLimitResetAt((name) => res.headers?.get?.(name) ?? null));
    }
    throw new Error(message);
  }
  if (!json.data) {
    throw new Error("Empty GraphQL response.");
  }
  return json.data;
}

/** Whether a GraphQL error is a spent budget — see `RateLimitedError` for the shapes. */
function isRateLimitError(e: { type?: string; code?: string }): boolean {
  return e.type === "RATE_LIMIT" || e.type === "RATE_LIMITED" || e.code === "graphql_rate_limit";
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
  const allRepos = host.allRepos === true;
  if (!allRepos && host.repos.length === 0) {
    return {
      pullRequests: [],
      rateLimit: { hostLabel: host.label, remaining: 0, cost: 0, resetAt: "" },
    };
  }
  // An `allRepos` host searches without `repo:` qualifiers — the `@me` ones
  // already scope every search to you. Any listed repos are ignored there.
  const repos = allRepos ? [] : host.repos;
  const first = validateSearchLimit(host.searchLimit);

  // `review-requested:@me` only matches *personal* requests. When a review is
  // asked of a team the user belongs to, the PR is invisible to it — so we also
  // search `team-review-requested:org/team` for each of the user's teams whose
  // org owns a configured repo (every team, on an `allRepos` host). Team
  // discovery is best-effort: a failure here must not take down the dashboard,
  // so we fall back to no team searches.
  const repoOrgs = new Set(host.repos.map((r) => r.split("/")[0]));
  let teamSlugs: string[] = [];
  try {
    teamSlugs = (await fetchViewerTeams(host)).filter(
      (slug) => allRepos || repoOrgs.has(slug.split("/")[0]),
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
      query: buildSearchQuery(repos, "author:@me"),
      role: "author",
      required: true,
    },
    {
      alias: "reviewing",
      varName: "reviewingQuery",
      query: buildSearchQuery(repos, "review-requested:@me"),
      role: "reviewer",
      required: true,
    },
    // Team-requested PRs count as a "reviewer" role, same as personal requests —
    // except on your own PRs, where `isOwnPr` turns it back into `author`.
    ...teamSlugs.map((slug, i) => ({
      alias: `team${i}`,
      varName: `teamQuery${i}`,
      query: buildSearchQuery(repos, `team-review-requested:${slug}`),
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
      query: buildSearchQuery(repos, "reviewed-by:@me sort:updated-desc"),
      role: "reviewed",
      required: true,
    },
  ];

  const settled = await Promise.allSettled(
    specs.map((spec) =>
      postSearch(host, buildQuery(spec.alias, spec.varName, first), { [spec.varName]: spec.query }),
    ),
  );

  const failedRequired = specs.findIndex(
    (spec, i) => spec.required && settled[i].status === "rejected",
  );
  if (failedRequired >= 0) {
    throw (settled[failedRequired] as PromiseRejectedResult).reason;
  }

  // `cost` is the sum of every request's own cost — the searches and the
  // hydrate alike — or `hostIntervalMs` would read this host as cheap and poll
  // it far more often. `remaining` is the lowest reading — the budget only falls
  // within a window, so the smallest number is the most recent one.
  let cost = 0;
  let remaining: number | null = null;
  let resetAt = "";
  let limit: number | undefined;
  let viewerLogin: string | null = null;
  const nodesByAlias = new Map<string, Array<RawSearchPr | Record<string, never>>>();
  const readBudget = (data: NonNullable<RawResponse["data"]>) => {
    cost += data.rateLimit?.cost ?? 0;
    if (typeof data.rateLimit?.limit === "number") limit = data.rateLimit.limit;
    if (data.rateLimit && (remaining === null || data.rateLimit.remaining < remaining)) {
      remaining = data.rateLimit.remaining;
      resetAt = data.rateLimit.resetAt;
    }
  };

  settled.forEach((result, i) => {
    const spec = specs[i];
    if (result.status === "rejected") {
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn(`[github] "${spec.alias}" search failed for "${host.label}": ${message}`);
      return;
    }
    const data = result.value;
    readBudget(data);
    // `isOwnPr` needs it, and a null login silently re-opens the bug where a
    // team request on your own PR claims a review from you — so take it from
    // whichever response carries one.
    const viewer = data.viewer as { login: string } | null | undefined;
    if (viewerLogin === null && viewer?.login) viewerLogin = viewer.login;
    const search = data[spec.alias] as SearchNodes | undefined;
    if (search?.nodes) nodesByAlias.set(spec.alias, search.nodes);
  });

  // Every distinct PR the searches found, read in full once. Unlike a failed
  // team search, a failed hydrate fails the host: the searches only say which
  // PRs exist, and writing them out without their data would blank every card.
  const ids = [
    ...new Set(
      specs.flatMap((spec) => (nodesByAlias.get(spec.alias) ?? []).filter(isSearchPr).map((n) => n.id)),
    ),
  ];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += HYDRATE_CHUNK) chunks.push(ids.slice(i, i + HYDRATE_CHUNK));
  const hydrated = await Promise.all(
    chunks.map((chunk) => hydrate(host, chunk)),
  );
  const fullById = new Map<string, RawPr>();
  for (const data of hydrated) {
    readBudget(data);
    // A null entry is a PR that went away (or out of reach) between the search
    // and the read; dropping it is what the next search would do anyway.
    for (const node of (data.hydrated as HydratedNodes | undefined) ?? []) {
      if (isRawPr(node)) fullById.set(node.id, node);
    }
  }

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
  //
  // The same holds for `reviewed`: a reply in a thread of your own PR is a
  // "Commented" review, so `reviewed-by:@me` matches it, and past that cap it
  // would arrive as a PR you reviewed — listed under `Reviewed`.
  const isOwnPr = (node: RawSearchPr) =>
    viewerLogin != null && node.author?.login.toLowerCase() === viewerLogin.toLowerCase();

  // `personal`: the node came from `review-requested:@me`, which — unlike the
  // team searches — means a review asked of you by name (`requestedOfMe`).
  const addNodes = (nodes: Array<RawSearchPr | Record<string, never>>, role: PrRole, personal: boolean) => {
    for (const node of nodes) {
      if (!isSearchPr(node)) continue;
      const full = fullById.get(node.id);
      if (!full) continue;
      const effectiveRole: PrRole = role !== "author" && isOwnPr(node) ? "author" : role;
      let pr = byId.get(node.id);
      if (pr) {
        if (!pr.roles.includes(effectiveRole)) pr.roles.push(effectiveRole);
      } else {
        pr = mapPr(full, host.label, [effectiveRole], viewerLogin);
        byId.set(node.id, pr);
      }
      if (personal && effectiveRole === "reviewer") pr.requestedOfMe = true;
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
    if (nodes) addNodes(nodes, spec.role, spec.alias === "reviewing");
  }

  return {
    pullRequests: [...byId.values()],
    rateLimit: { hostLabel: host.label, remaining: remaining ?? 0, cost, resetAt, limit },
  };
}

/**
 * Closes a PR, posting `comment` on it first when one is given — so whoever
 * opens the closed PR later reads why. Two mutations, comment first: a comment
 * that fails leaves the PR open rather than closed without its explanation.
 * Throws on any failure; nothing is retried, since a mutation is not a poll.
 */
export async function closePullRequest(
  host: Pick<HostConfig, "label" | "graphqlUrl" | "token">,
  prId: string,
  comment: string,
): Promise<void> {
  const target = { ...host, repos: [] } as HostConfig;
  if (comment.trim()) {
    await postSearch(
      target,
      "mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { clientMutationId } }",
      { id: prId, body: comment.trim() },
    );
  }
  await postSearch(
    target,
    "mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { pullRequest { state } } }",
    { id: prId },
  );
}
