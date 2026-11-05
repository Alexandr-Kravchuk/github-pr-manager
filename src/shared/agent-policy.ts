import type { AgentRunKind, AgentSettings, PullRequest } from "./types";

// Which PRs the agent should work on, and how. Decided from the PR's current
// state rather than from a transition between two snapshots: a transition seen
// while the app was closed would be lost, while a state is still there on the
// next tick. The ledger key (`jobKey`) is what keeps one state from being
// worked twice. Node-free so the Board can say why a PR is idle with the very
// same rules.

/** What the agent does with a PR. Stage 2 runs `review` and `brief`; the rest land in later stages. */
export type AgentScenario = "review" | "brief";

export interface AgentJob {
  /** Ledger key: the same key is never run twice. */
  key: string;
  prId: string;
  prNumber: number;
  repo: string;
  url: string;
  scenario: AgentScenario;
  kind: AgentRunKind;
  /** Shadow prepares and waits for you; on posts. A brief never posts, whatever the mode. */
  mode: "shadow" | "on";
  /** When the PR was opened — the queue runs oldest first. */
  createdAt: string;
}

export interface PlanContext {
  /** A Claude session of yours is on this PR — the agent stays out of its way. */
  hasOwnSession: (pr: PullRequest) => boolean;
}

export interface PlanResult {
  jobs: AgentJob[];
  /** Why each PR the agent leaves alone is idle — shown on the Board's Idle column. */
  idle: Map<string, string>;
}

/** Over the review limit: too big for the agent to review on its own. */
export function isBigPr(pr: Pick<PullRequest, "additions" | "deletions" | "changedFiles">, s: AgentSettings): boolean {
  const { maxLines, maxFiles } = s.scenarios.review;
  return pr.additions + pr.deletions > maxLines || pr.changedFiles > maxFiles;
}

/**
 * The ledger key: PR + scenario + head commit. Later stages add an activity
 * cursor (the latest reply in your threads) so a reply without a push is a
 * new key too.
 */
export function jobKey(pr: Pick<PullRequest, "id" | "headOid">, scenario: AgentScenario): string {
  return `${pr.id}|${scenario}|${pr.headOid ?? "-"}`;
}

/** A first review asked of you that you haven't given — the trigger for `review` and `brief`. */
function wantsFirstReview(pr: PullRequest, s: AgentSettings): string | null {
  if (!pr.roles.includes("reviewer")) return "Not a review request";
  if (!pr.requestedOfMe && !s.scenarios.review.teamRequests) return "Asked of a team — team requests are off";
  if (pr.viewerHasReviewed) return "You already reviewed it";
  if (pr.isDraft && !s.scenarios.review.drafts) return "Draft — picked up once it's ready for review";
  return null;
}

export function planJobs(prs: readonly PullRequest[], s: AgentSettings, ctx: PlanContext): PlanResult {
  const jobs: AgentJob[] = [];
  const idle = new Map<string, string>();
  if (!s.enabled) {
    for (const pr of prs) idle.set(pr.id, "The agent is off");
    return { jobs, idle };
  }
  for (const pr of prs) {
    const skip = (reason: string) => idle.set(pr.id, reason);
    if (pr.isIgnored) {
      skip("Ignored");
      continue;
    }
    if (s.repos.length > 0 && !s.repos.some((r) => r.toLowerCase() === pr.repo.toLowerCase())) {
      skip("Not one of the agent's repositories");
      continue;
    }
    if (pr.roles.includes("author")) {
      // Your own PRs: merge and drive land in later stages.
      skip(pr.awaitingReview ? "Waiting for reviewers" : "Yours — nothing for the agent yet");
      continue;
    }
    const notWanted = wantsFirstReview(pr, s);
    if (notWanted) {
      skip(notWanted);
      continue;
    }
    if (ctx.hasOwnSession(pr)) {
      skip("Your Claude session is on it");
      continue;
    }
    const big = isBigPr(pr, s);
    const scenario: AgentScenario = big ? "brief" : "review";
    const mode = big ? s.scenarios.brief.mode : s.scenarios.review.mode;
    if (mode === "off") {
      skip(big ? "Too big to review on its own — briefs are off" : "Reviews are off");
      continue;
    }
    jobs.push({
      key: jobKey(pr, scenario),
      prId: pr.id,
      prNumber: pr.number,
      repo: pr.repo,
      url: pr.url,
      scenario,
      kind: scenario === "brief" ? "brief" : "review",
      mode: scenario === "brief" ? "on" : mode,
      createdAt: pr.createdAt,
    });
  }
  jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { jobs, idle };
}

/** `{url}` filled in; an empty template falls back to the given default. */
export function renderAgentPrompt(template: string, fallback: string, url: string): string {
  return (template.trim() || fallback).split("{url}").join(url);
}
