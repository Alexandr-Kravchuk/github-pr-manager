import { brokenLayerBelow, STACK_REBASE_HINT } from "./agent-stack";
import type { AgentRunKind, AgentScenario, AgentSettings, PullRequest } from "./types";

export type { AgentScenario };

// Which PRs the agent should work on, and how. Decided from the PR's current
// state rather than from a transition between two snapshots: a transition seen
// while the app was closed would be lost, while a state is still there on the
// next tick. The ledger key (`jobKey`) is what keeps one state from being
// worked twice. Node-free so the Board can say why a PR is idle with the very
// same rules.

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
  /** Drive: what it is driven for — "ci", "conflicts", "comments". */
  reasons?: string[];
}

/** Why a run on your PR: CI, a conflict, reviewers' comments — or "self", a self-review before reviewers see it. */
export type DriveReason = "ci" | "conflicts" | "comments" | "self";

export interface PlanContext {
  /** A Claude session of yours is on this PR — the agent stays out of its way. */
  hasOwnSession: (pr: PullRequest) => boolean;
  /**
   * Drive: why a PR is out of attempts, or null. The core keeps the count
   * (an attempt is a run that ended in a push) and resets it when CI goes
   * green or someone else pushes.
   */
  driveExhausted?: (pr: PullRequest) => string | null;
  /** This head of your PR had its self-review already — or is the agent's own push, which needs none. */
  selfReviewed?: (pr: PullRequest) => boolean;
  /**
   * Your PR is driven by an SDLC orchestrator run — why the agent leaves it
   * alone, or null. The run reviews it, fixes the findings, answers the
   * reviewers and watches CI itself.
   */
  orchestrated?: (pr: PullRequest) => string | null;
  /**
   * Re-approve / re-ask, for this head (`agent-reapprove.ts`): "unchecked" —
   * main hasn't read the PR's dismissals yet; "checking"; "same" — only the
   * base changed, an offer is (or was) made; "pass" — nothing to give again,
   * the other rules decide. Absent: "pass".
   */
  reapproveState?: (pr: PullRequest, scenario: "reapprove" | "reask") => "unchecked" | "checking" | "same" | "pass";
  /**
   * A PR you reviewed that got a push and nothing else since: whether its new
   * head is the change you reviewed on a new base — a stack GitHub rebased
   * after a lower layer merged, the base merged in. "unchecked" — main hasn't
   * looked yet; "checking"; "same" — no re-review needed; "changed" — the
   * re-review runs. Absent: "changed".
   */
  baseOnlyState?: (pr: PullRequest) => "unchecked" | "checking" | "same" | "changed";
  /**
   * Why no session can work on this PR's code — no clone of its repository —
   * or null. A run needs one; without it the PR waits with this reason
   * instead of being queued only to fail, and to notify, on every new trigger.
   */
  noCheckout?: (pr: PullRequest) => string | null;
}

/** Why your PR gets no self-review now, or null when it should get one. */
function selfReviewBlock(pr: PullRequest, s: AgentSettings, ctx: PlanContext): string | null {
  if (s.scenarios.selfReview.mode === "off") return "self-reviews are off";
  if (pr.isDraft) return "a draft — self-reviewed once it is ready for review";
  if (pr.isCrossRepository) return "from a fork — the agent pushes only to branches of the repository itself";
  if (ctx.hasOwnSession(pr)) return "your Claude session is on it";
  if (ctx.selfReviewed?.(pr)) return "self-reviewed at this head";
  return null;
}

export interface PlanResult {
  jobs: AgentJob[];
  /** Your PRs ready to merge: an offer with a button, never a run. */
  merges: AgentJob[];
  /**
   * Approvals a base-only push may have dismissed — never a run either: those
   * main still has to check, and those it found the same (their offers stand).
   */
  reapprovals: AgentJob[];
  /**
   * Re-reviews held until main has checked whether only the base changed
   * under the reviewed change (`baseOnlyState` "unchecked") — never a run.
   */
  baseChecks: AgentJob[];
  /** Why each PR the agent leaves alone is idle — shown on the Board's Idle column. */
  idle: Map<string, string>;
}

/**
 * Why your PR is not ready to merge, or null when it is: the dashboard's own
 * `canBeMerged` (not a draft, mergeable and up to date, not waiting on a stack
 * below it, approved by a human, no change request or review feedback left,
 * CI neither red nor running) and no reviewer still to answer — then each
 * switch in Settings only narrows it.
 */
export function mergeBlocker(pr: PullRequest, s: AgentSettings): string | null {
  const m = s.scenarios.merge;
  if (pr.isDraft) return "Draft";
  if (pr.blockedByStack) return "Waits for the PR below it in the stack";
  if (pr.hasConflicts) return "Has conflicts";
  if (pr.ciState === "failure") return "CI is red";
  if (pr.ciState === "pending") return "CI is still running";
  if (pr.awaitingReview) return "Waiting for reviewers";
  if (!pr.canBeMerged) return "Not mergeable yet";
  if (m.requireAllReviewers && pr.reviewers.some((r) => r.reviewState !== "approved")) return "Not every requested reviewer approved";
  if (m.requireThreadsResolved && pr.unresolvedThreads > 0) return `${pr.unresolvedThreads} unresolved thread${pr.unresolvedThreads === 1 ? "" : "s"}`;
  if (m.requireChecksGreen && pr.checks.length > 0 && pr.ciState !== "success") return "Not every check is green";
  return null;
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
export function jobKey(pr: Pick<PullRequest, "id" | "headOid">, scenario: AgentScenario, cursor?: string): string {
  return `${pr.id}|${scenario}|${pr.headOid ?? "-"}${cursor ? `|${cursor}` : ""}`;
}

/**
 * The latest thing the author did after your review — a push, or an answer in
 * a thread — or null when nothing since. Your review is the latest
 * opinionated one (approve / request changes); after a plain "Comment" review
 * there is no time to compare with, and nothing triggers.
 */
export function authorActivitySince(
  pr: Pick<PullRequest, "viewerReviewedAt" | "viewerReviewedHead" | "lastCommitPushedAt" | "authorRepliedAt">,
): string | null {
  const since = pr.viewerReviewedAt;
  if (!since) return null;
  let latest: string | null = null;
  if (!pr.viewerReviewedHead && pr.lastCommitPushedAt && pr.lastCommitPushedAt > since) latest = pr.lastCommitPushedAt;
  if (pr.authorRepliedAt && pr.authorRepliedAt > since && (latest === null || pr.authorRepliedAt > latest)) latest = pr.authorRepliedAt;
  return latest;
}

/** What your own PR needs driving for, by the scenarios that are on. */
export function driveReasons(pr: PullRequest, s: AgentSettings): DriveReason[] {
  const out: DriveReason[] = [];
  if (s.scenarios.driveCi.mode !== "off") {
    if (pr.ciState === "failure") out.push("ci");
    if (pr.hasConflicts) out.push("conflicts");
  }
  if (s.scenarios.driveComments.mode !== "off" && (pr.hasUnaddressedChangeRequest || pr.hasUnaddressedComments)) out.push("comments");
  return out;
}

/** A first review asked of you that you haven't given — the trigger for `review` and `brief`. */
function wantsFirstReview(pr: PullRequest, s: AgentSettings): string | null {
  if (!pr.roles.includes("reviewer")) return "Not a review request";
  if (!pr.requestedOfMe && !s.scenarios.review.teamRequests) return "Asked of a team — team requests are off";
  if (pr.viewerHasReviewed) return "You already reviewed it";
  if (pr.isDraft && !s.scenarios.review.drafts) return "Draft — picked up once it's ready for review";
  return null;
}

/**
 * A PR where a base-only push may have dismissed an approval, from its state
 * alone: someone's PR you reviewed with no approval or change request of yours
 * standing — or your own PR with no approval left. Main reads the timeline once
 * per head to tell a dismissed approval from a plain comment.
 */
function mayHaveDismissed(pr: PullRequest, s: AgentSettings): "reapprove" | "reask" | null {
  const r = s.scenarios.reapprove;
  if (r.mode === "off" || pr.isDraft || !pr.headOid) return null;
  if (pr.roles.includes("author")) return r.askReviewers && !pr.hasHumanApproval ? "reask" : null;
  return pr.roles.includes("reviewed") && !pr.viewerHasReviewed ? "reapprove" : null;
}

function reapproveJob(pr: PullRequest, scenario: "reapprove" | "reask", s: AgentSettings): AgentJob {
  return {
    key: jobKey(pr, scenario),
    prId: pr.id,
    prNumber: pr.number,
    repo: pr.repo,
    url: pr.url,
    scenario,
    // Never run as a session: what it posts is the app's own, a line and a signature.
    kind: "review",
    mode: s.scenarios.reapprove.mode === "on" ? "on" : "shadow",
    createdAt: pr.createdAt,
  };
}

/** A Merge button offered on your ready PR: no session, the merge itself only on your click. */
function mergeJob(pr: PullRequest): AgentJob {
  return {
    key: jobKey(pr, "merge"),
    prId: pr.id,
    prNumber: pr.number,
    repo: pr.repo,
    url: pr.url,
    scenario: "merge",
    kind: "afterMerge",
    mode: "on",
    createdAt: pr.createdAt,
  };
}

export function planJobs(prs: readonly PullRequest[], s: AgentSettings, ctx: PlanContext): PlanResult {
  const jobs: AgentJob[] = [];
  const merges: AgentJob[] = [];
  const reapprovals: AgentJob[] = [];
  const baseChecks: AgentJob[] = [];
  const idle = new Map<string, string>();
  if (!s.enabled) {
    for (const pr of prs) idle.set(pr.id, "The agent is off");
    return { jobs, merges, reapprovals, baseChecks, idle };
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
    const dismissed = mayHaveDismissed(pr, s);
    const dismissedState = dismissed ? (ctx.reapproveState?.(pr, dismissed) ?? "pass") : "pass";
    if (dismissed && dismissedState !== "pass") reapprovals.push(reapproveJob(pr, dismissed, s));
    // Someone's PR: while that is open, a review of its head would only repeat
    // the approval the base took away. Your PR goes on below — re-asking your
    // reviewers stands beside driving it.
    if (dismissed === "reapprove" && dismissedState !== "pass") {
      skip(dismissedState === "same" ? "Only the base changed since your approval" : "Checking whether only the base changed since your approval");
      continue;
    }
    if (pr.roles.includes("author")) {
      // An SDLC orchestrator run has it: everything a run here would do is that run's job.
      const orchestrated = ctx.orchestrated?.(pr) ?? null;
      if (orchestrated) {
        // Its run waits for someone to merge it: once it is ready, the Merge
        // button is yours as on any PR of yours — an offer starts no session.
        if (s.scenarios.merge.mode !== "off" && !mergeBlocker(pr, s)) {
          merges.push(mergeJob(pr));
          continue;
        }
        skip(`Yours — ${orchestrated}`);
        continue;
      }
      // A layer of a stack that conflicts with its base: only a rebase of the
      // stack mends it — a merge of the base in would break the linear history
      // the stack needs to merge — and the agent never rebases or force-pushes.
      if (pr.stack && pr.hasConflicts) {
        skip(`Yours — in a stack with conflicts; ${STACK_REBASE_HINT}`);
        continue;
      }
      // Your own PRs: driven to green when something is wrong, a Merge button once they're ready.
      const reasons = driveReasons(pr, s);
      if (reasons.length > 0) {
        if (pr.isDraft) {
          skip("Yours — a draft; the agent drives it once it is ready for review");
          continue;
        }
        if (pr.isCrossRepository) {
          skip("Yours, from a fork — the agent pushes only to branches of the repository itself");
          continue;
        }
        if (ctx.hasOwnSession(pr)) {
          skip("Your Claude session is on it");
          continue;
        }
        const exhausted = ctx.driveExhausted?.(pr) ?? null;
        if (exhausted) {
          skip(exhausted);
          continue;
        }
        // In a stack, the lowest broken layer first: what breaks a layer usually
        // comes from below, and a fix there rebases this one anyway.
        const below = brokenLayerBelow(pr, prs, (p) => p.roles.includes("author") && !p.isDraft && (p.hasConflicts || driveReasons(p, s).length > 0));
        if (below) {
          skip(`Yours — #${below.number} below it in the stack comes first`);
          continue;
        }
        // On only when every reason's scenario is On; one Shadow reason makes the run Shadow.
        const modes = reasons.map((r) => (r === "comments" ? s.scenarios.driveComments.mode : s.scenarios.driveCi.mode));
        const cursor = [reasons.join("+"), reasons.includes("comments") ? (pr.reviewerRepliedAt ?? "-") : ""].filter(Boolean).join("@");
        jobs.push({
          key: jobKey(pr, "drive", cursor),
          prId: pr.id,
          prNumber: pr.number,
          repo: pr.repo,
          url: pr.url,
          scenario: "drive",
          kind: "drive",
          mode: modes.every((m) => m === "on") ? "on" : "shadow",
          createdAt: pr.createdAt,
          reasons,
        });
        continue;
      }
      const blocker = mergeBlocker(pr, s);
      if (blocker) {
        // Not ready yet, nothing broken: a self-review of this head before reviewers see
        // it — the review in dry run, its findings validated, the confirmed ones fixed.
        const noSelf = selfReviewBlock(pr, s, ctx);
        if (!noSelf) {
          jobs.push({
            key: jobKey(pr, "drive", "self"),
            prId: pr.id,
            prNumber: pr.number,
            repo: pr.repo,
            url: pr.url,
            scenario: "drive",
            kind: "drive",
            mode: s.scenarios.selfReview.mode === "on" ? "on" : "shadow",
            createdAt: pr.createdAt,
            reasons: ["self"],
          });
          continue;
        }
        const why = `${blocker.charAt(0).toLowerCase()}${blocker.slice(1)}`;
        skip(noSelf === "self-reviewed at this head" ? `Yours — self-reviewed; ${why}` : `Yours — ${why}`);
        continue;
      }
      if (s.scenarios.merge.mode === "off") {
        skip("Yours — ready; merge offers are off");
        continue;
      }
      merges.push(mergeJob(pr));
      continue;
    }
    // Reviewed before: a re-review once the author answers — a push, a reply in
    // a thread — or asks you again. The cursor (that moment) makes each answer
    // its own ledger key, so a reply without a push is new work too.
    if (pr.viewerHasReviewed) {
      const rr = s.scenarios.rereview.mode;
      if (rr === "off") {
        skip("Reviewed — re-reviews are off");
        continue;
      }
      const asked = pr.roles.includes("reviewer") && (pr.requestedOfMe || s.scenarios.review.teamRequests);
      const since = authorActivitySince(pr);
      if (!asked && !since) {
        skip("Reviewed — nothing new from the author since");
        continue;
      }
      // Asked again with nothing new: your review is on this very head and the
      // author hasn't answered since, so a re-review could only repeat it.
      if (!since && pr.viewerReviewedHead) {
        skip("Asked again — your review is on this head and the author hasn't answered since");
        continue;
      }
      if (pr.isDraft && !s.scenarios.review.drafts) {
        skip("Draft — picked up once it's ready for review");
        continue;
      }
      if (ctx.hasOwnSession(pr)) {
        skip("Your Claude session is on it");
        continue;
      }
      // A push and nothing else since your review: it may be the change you
      // reviewed on a new base — GitHub rebasing a stack after a lower layer
      // merged, the base merged in. Main checks that in your clone first.
      const replied = pr.authorRepliedAt !== null && pr.viewerReviewedAt !== null && pr.authorRepliedAt > pr.viewerReviewedAt;
      if (!asked && !replied && pr.viewerReviewedOid && pr.headOid) {
        const state = ctx.baseOnlyState?.(pr) ?? "changed";
        if (state === "same") {
          skip("Reviewed — only the base changed under your review since");
          continue;
        }
        if (state !== "changed") {
          baseChecks.push({ key: jobKey(pr, "rereview", "base"), prId: pr.id, prNumber: pr.number, repo: pr.repo, url: pr.url, scenario: "rereview", kind: "rereview", mode: rr, createdAt: pr.createdAt });
          skip("Reviewed — checking whether only the base changed under your review");
          continue;
        }
      }
      jobs.push({
        key: jobKey(pr, "rereview", `${asked ? "asked" : "reply"}@${since ?? "-"}`),
        prId: pr.id,
        prNumber: pr.number,
        repo: pr.repo,
        url: pr.url,
        scenario: "rereview",
        kind: "rereview",
        mode: rr,
        createdAt: pr.createdAt,
      });
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
  // A session works in a clone of the PR's repository: without one the PR
  // waits and says so. Offers (merge, re-approve) need no session.
  const byId = new Map(prs.map((p) => [p.id, p]));
  const runnable = jobs.filter((job) => {
    const pr = byId.get(job.prId);
    const why = pr ? (ctx.noCheckout?.(pr) ?? null) : null;
    if (why) idle.set(job.prId, why);
    return !why;
  });
  runnable.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { jobs: runnable, merges, reapprovals, baseChecks, idle };
}

/** `{url}` filled in; an empty template falls back to the given default. */
export function renderAgentPrompt(template: string, fallback: string, url: string): string {
  return (template.trim() || fallback).split("{url}").join(url);
}
