// The Board in plain words. Each card `stageColumns` places is said as a
// person would say it: whose move it is, what is happening, what is needed
// from you now, what to read before deciding, what each button does, and what
// happens after. The Board is laid out from these (Your turn first, then what
// needs nothing from you); the rules of where a PR stands stay in
// `agent-view.ts`. Node-free: the renderer value-imports it.

import { resultCard, type RunAsk, type RunFinding } from "./agent-result";
import type { PublishSummary } from "./agent-publish";
import { currentStep } from "./agent-stream";
import { isOwnSessionWhy, queueOrder, runFor, stageColumns, stageLine, type BoardStage, type StageCard, type StageContext } from "./agent-view";
import type { AgentAction, AgentItem, AgentState, PullRequest } from "./types";

/** Whose move it is: yours, the agent's, someone else's (the author, reviewers), or nobody's. */
export type BoardOwner = "you" | "agent" | "others" | "done";

export interface BoardChoice {
  label: string;
  /** What pressing it does, in a sentence. */
  does: string;
  act?: AgentAction;
  /** Opens this in the browser instead of acting. */
  url?: string;
  primary?: boolean;
  /** The Board draws it with its own control: a Merge with the method beside it. */
  control?: "merge";
}

export interface BoardEntry {
  prId: string;
  card: StageCard;
  pr: PullRequest | null;
  item: AgentItem | null;
  stage: BoardStage;
  lane: "mine" | "review";
  /** "Your PR" / "You review". */
  laneLabel: string;
  owner: BoardOwner;
  /** Who the PR waits on, in words: "The author", "anna, oleg", "Reviewers". */
  waitingOn: string | null;
  number: number;
  repo: string;
  title: string;
  url: string;
  since: string;
  /** What is happening, one sentence with a subject. */
  now: string;
  /** What is needed from you now, as an instruction — null when nothing is. */
  ask: string | null;
  /** What to read before deciding. */
  read: {
    summary: string | null;
    findings: RunFinding[];
    plan: PublishSummary | null;
    asks: RunAsk[];
    error: string | null;
    questions: string[];
    /** The run's full report, when it says more than the summary. */
    report: string | null;
    /** The brief a big PR's review followed: written first, kept readable on the review's card. */
    brief: string | null;
  };
  choices: BoardChoice[];
  /** What happens after, whoever acts. */
  next: string;
  /** A run in progress: its current step and how far along. */
  progress: { step: string; done: number; total: number; activity: string | null } | null;
  /** In the line, its place (1 = next). */
  place: number;
}

export interface ExplainedBoard {
  entries: BoardEntry[];
  /** Approvals of yours from earlier days, under Done today as "+N earlier". */
  earlier: number;
  /** Moves the agent prepared on PRs the dashboard's filters hide. */
  hiddenReady: number;
}

const OWNER_ORDER: Record<BoardOwner, number> = { you: 0, agent: 1, others: 2, done: 3 };

/** Within Your turn: a move ready in one click first, then a question or a brief, a failure, then what nothing has started on. */
const KIND_RANK: Record<string, number> = { merge: 0, reapprove: 0, send: 1, push: 1, reask: 1, draftReview: 2, decide: 2, fix: 3, review: 4, rereview: 4, fixYourself: 4, draft: 9 };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lower = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

/** The whole Board in plain words, every card once: Your turn first (readiest first), then the agent's, others', done. */
export function explainBoard(prs: readonly PullRequest[], all: readonly PullRequest[], state: AgentState, ctx: StageContext): ExplainedBoard {
  const board = stageColumns(prs, all, state, ctx);
  // The queue is one queue: a card's place in it, the order the agent runs them in.
  const place = new Map(queueOrder(state.items.filter((i) => i.state === "queued")).map((i, n) => [i.runId, n + 1]));
  const entries: BoardEntry[] = [];
  for (const lane of ["mine", "review"] as const) {
    for (const col of ["you", "agent", "waiting", "done"] as const) {
      for (const card of board[lane][col]) entries.push(explainCard(card, lane, state, place));
    }
  }
  entries.sort((a, b) => OWNER_ORDER[a.owner] - OWNER_ORDER[b.owner] || rankOf(a) - rankOf(b) || (a.owner === "agent" ? agentOrder(a) - agentOrder(b) : 0) || order(a, b));
  return { entries, earlier: board.mine.earlier + board.review.earlier, hiddenReady: board.hiddenReady };
}

function rankOf(e: BoardEntry): number {
  return e.owner === "you" ? (KIND_RANK[e.stage.action?.kind ?? ""] ?? 5) : 0;
}

/** The agent's: what runs now, then the line in its order. */
function agentOrder(e: BoardEntry): number {
  return e.item?.state === "working" ? 0 : e.place || 1_000;
}

/** Your turn and the waiting ones: longest waiting first. Done: newest first. */
function order(a: BoardEntry, b: BoardEntry): number {
  return a.owner === "done" ? b.since.localeCompare(a.since) : a.since.localeCompare(b.since);
}

/** What the agent does on a PR, after "The agent is …". */
function doing(item: AgentItem): string {
  switch (item.scenario) {
    case "review":
      return "reviewing it";
    case "rereview":
      return "re-reviewing it";
    case "brief":
      return "writing a brief of this big PR";
    case "drive": {
      const r = item.reasons ?? [];
      if (r.includes("self")) return "self-reviewing your PR before reviewers see it";
      if (r.includes("comments") && r.length === 1) return "answering the reviewers' comments";
      if (r.includes("conflicts")) return "resolving the conflict";
      return "fixing the failing CI";
    }
    case "afterMerge":
      return "preparing the Jira update";
    default:
      return "working on it";
  }
}

export function explainCard(card: StageCard, lane: "mine" | "review", state: AgentState, place: ReadonlyMap<string, number> = new Map()): BoardEntry {
  const { stage, pr } = card;
  const item = stage.item;
  const url = pr?.url ?? item?.url ?? "";
  const res = item ? resultCard(item) : null;
  const summary = res?.summary?.trim() || null;
  const report = item?.output && item.output.trim() !== summary ? item.output : null;
  const read: BoardEntry["read"] = {
    summary,
    findings: res?.findings ?? [],
    plan: item?.plan ?? null,
    asks: res?.asks ?? [],
    error: item?.state === "error" ? (item.error ?? null) : null,
    questions: res?.authorQuestions ?? [],
    report,
    brief: item?.brief?.trim() ? item.brief : null,
  };
  const runId = item?.runId ?? "";
  const prId = card.prId;
  const kind = stage.action?.kind ?? null;
  // Starting a run only works while the agent is on, never on a PR an SDLC run
  // has, and never beside a Claude session of yours on it: the main process
  // refuses that too, since two sessions on one PR answer the same threads twice.
  const sessionOnIt = isOwnSessionWhy(stage.why);
  const canStart = state.enabled && !stage.sdlc && !sessionOnIt;
  const open = (label = lane === "review" ? "Review on GitHub myself" : "Open on GitHub"): BoardChoice => ({ label, does: "Opens the PR in your browser.", url });
  let owner: BoardOwner = "done";
  let waitingOn: string | null = null;
  let now = stageLine(stage, pr) || item?.headline || "";
  let ask: string | null = null;
  let choices: BoardChoice[] = [];
  let next = "";
  let progress: BoardEntry["progress"] = null;

  if (stage.column === "agent") {
    owner = "agent";
    if (stage.sdlc && !(item && (item.state === "working" || item.state === "queued"))) {
      now = `An SDLC run drives it (${stage.sdlc.key}${stage.sdlc.stage ? ` — ${stage.sdlc.stage}` : ""}): it reviews, fixes and answers on its own.`;
      next = "It comes to you once it is ready to merge.";
    } else if (item?.state === "queued") {
      const n = place.get(item.runId) ?? 0;
      now = `The agent starts ${doing(item)} ${n === 1 ? "next" : n > 1 ? `after ${plural(n - 1, "other")}` : "soon"}.`;
      choices = [{ label: "Don't run it", does: "Takes it out of the line; the agent won't take this commit up again by itself.", act: { type: "skip", runId } }];
      next = lane === "review" ? "Its draft comes to Your turn. Nothing is posted until you send it." : "Its commits come to Your turn. Nothing is pushed until you push them.";
    } else if (item) {
      now = `The agent is ${doing(item)}.`;
      const r = runFor(state, item.runId);
      if (r) {
        const steps = r.progress.steps;
        progress = { step: currentStep(r.progress)?.subject ?? item.headline, done: steps.filter((s) => s.status === "completed").length, total: steps.length, activity: r.progress.activity ?? null };
        if (r.paused) now = `The agent paused while ${doing(item)}.`;
      }
      choices = [{ label: "Stop", does: "Stops the run; what it found so far stays as a note on the card.", act: { type: "stop", runId } }];
      next =
        item.scenario === "afterMerge"
          ? "The Jira changes come to you to apply; nothing in Jira changes on its own."
          : lane === "review"
            ? "Its draft comes to Your turn. Nothing is posted on GitHub until you send it."
            : "Its commits come to Your turn. Nothing is pushed to your branch until you push them.";
    }
  } else if (stage.column === "waiting") {
    owner = "others";
    if (lane === "mine") {
      const pending = pr?.reviewers.filter((r) => r.reviewState !== "approved").map((r) => r.login) ?? [];
      const changes = pr?.reviewers.filter((r) => r.reviewState === "changes_requested").map((r) => r.login) ?? [];
      waitingOn = pr?.blockedByStack ? "The PR below it" : pending.length > 0 ? pending.join(", ") : "Reviewers";
      now = pr?.blockedByStack
        ? "It waits for the PR below it in the stack to merge first."
        : changes.length > 0
          ? `${changes.join(", ")} asked for changes.`
          : pending.length > 0
            ? `Waiting for ${pending.join(", ")} to review.`
            : "Waiting for reviewers.";
      next = "Once they approve and CI is green, Merge comes to Your turn. If they comment, the agent answers what it can and asks you the rest.";
      if (canStart) choices = [{ label: "Self-review again", does: "The agent reviews it again now, before the reviewers do; its fixes come to you to push.", act: { type: "enqueue", prId } }];
    } else {
      waitingOn = "The author";
      const verdict = pr?.viewerApproved ? "You approved it" : pr?.viewerHasReviewed ? "You asked for changes" : pr?.roles.includes("reviewed") ? "You commented" : "It waits for its author";
      now = `${verdict}${pr && pr.unresolvedThreads > 0 ? ` · ${plural(pr.unresolvedThreads, "thread")} open` : ""} — the author's turn.`;
      next = "When the author pushes or answers you, the agent re-reviews it by itself and brings you the result.";
      if (canStart) choices = [{ label: "Re-review now", does: "The agent looks at it again right away instead of waiting for the author.", act: { type: "enqueue", prId } }];
    }
  } else if (stage.column === "done") {
    owner = "done";
    if (kind === "updateJira" && item) {
      now = "Merged — the agent prepared the Jira update.";
      ask = null;
      choices = [{ label: "Update Jira…", does: "Opens the dry run's session in your terminal; it asks before every change.", act: { type: "continue", runId } }];
      next = "Nothing in Jira changes until you say so in the session.";
    } else if (stage.askedAgain) {
      now = "Your review was asked for again — but your approval still stands on this exact commit.";
      choices = [{ label: "Approve again", does: "Answers the request with your approval on the same commit: one line, signed by the agent.", act: { type: "approveAgain", prId } }];
      next = "Nothing waits on you. Approve again only clears the request on GitHub.";
    } else {
      now = lane === "review" && pr?.viewerApproved ? "You approved it." : lane === "mine" && !pr ? "Merged." : (item?.headline ?? "Done.");
      next = "Nothing more to do.";
    }
  } else {
    owner = "you";
    const plan = read.plan;
    /**
     * A drive's result from before the app restarted (`needsRerun`) that is
     * still a card of yours: commits in its worktree the app couldn't read
     * (a push card), or replies with a worktree it couldn't read again (a
     * send card). A restarted run with questions or plain commits is stale
     * (`staleRun`) and never reaches here.
     */
    const rerunCard = (it: AgentItem) => {
      const lw = it.localWork && !it.localWork.kept && it.localWork.ahead !== 0 ? it.localWork : null;
      if (lw) {
        // Work the app couldn't read sits in the worktree: never "nothing to push", never a Run again that drops it unsaid.
        const many = lw.ahead === null ? "commits" : plural(lw.ahead, "commit");
        now = `Your session left ${many} in ${lw.worktree} that the app couldn't read (${lw.reason}). They are not on the PR, and its replies may cite them.`;
        ask = "Push them from the session, then come back — the card reads them again.";
        choices = [
          ...(it.sessionId ? [{ label: "Open in Claude", primary: true, does: "Opens the session in that worktree; push from there. What it ends with comes back to this card.", act: { type: "continue", runId } } as BoardChoice] : []),
          { label: "Run again", does: `Starts over from the PR's head without the ${many} — the worktree stays with them.`, act: { type: "retry", runId } },
          { label: "Discard", does: "Closes the card; the worktree stays with the commits, and a ref keeps them.", act: { type: "skip", runId } },
        ];
        next = "Once they are on the PR, the replies can go out.";
        return;
      }
      const n = it.drive?.commits.length ?? 0;
      now = `The app restarted after this run, so it can't push ${n > 0 ? `its ${plural(n, "commit")}` : "anything"} or go on with your answer any more.`;
      ask = "Run it again — the new run redoes the work and asks you again if it still needs to.";
      choices = [
        { label: "Run again", primary: true, does: "Starts it over with a fresh session on the PR as it is now; its commits and questions come back here.", act: { type: "retry", runId } },
        ...(it.sessionId && it.worktree ? [{ label: "Open in Claude", does: "Opens the old session in your terminal — its commits and pushes are then yours to make.", act: { type: "continue", runId } } as BoardChoice] : []),
        { label: "Discard", does: "Drops it; the agent leaves this commit to you.", act: { type: "skip", runId } },
      ];
      next = "A new run starts; its result comes back here.";
    };
    switch (kind) {
      case "send": {
        if (item?.scenario === "drive" && item.needsRerun && item.localWork) {
          rerunCard(item);
          break;
        }
        if (item?.scenario === "drive") {
          // Your own PR, nothing to push: only its answers to the reviewers wait to go out.
          const replies = plan?.replies.length ?? 0;
          now = `The agent answered the reviewers without changing the code: ${plural(replies, "reply", "replies")}, nothing to push.`;
          ask = "Read the replies, then send them — or discard them.";
          choices = [
            {
              label: stage.action?.label ?? "Send",
              primary: true,
              does: `Posts ${replies === 1 ? "the reply" : "the replies"} in the reviewers' threads under your name, signed by the agent. Nothing is pushed.`,
              act: { type: "publish", runId },
            },
            ...(item.sessionId && item.worktree ? [{ label: "Open in Claude", does: "Opens the session in your terminal to change them; what it ends with comes back to this card.", act: { type: "continue", runId } } as BoardChoice] : []),
            { label: "Discard", does: "Drops the replies; the agent leaves this commit to you.", act: { type: "skip", runId } },
          ];
          next = "The reviewers read your answers; when they comment again, the agent picks it up.";
          break;
        }
        const n = plan?.comments.length ?? 0;
        const approve = plan?.event === "APPROVE";
        const replies = plan?.replies.length ?? 0;
        const resolves = plan?.resolves ?? 0;
        const pushedBack = plan?.escalations.length ?? 0;
        if (item?.scenario === "rereview") {
          const did = [resolves > 0 && `would resolve ${plural(resolves, "thread")}`, replies > 0 && `drafted ${plural(replies, "reply", "replies")}`, n > 0 && `added ${plural(n, "comment")}`].filter(Boolean).join(", ");
          now = `The author answered. The agent checked the answers${did ? ` — ${did}` : ""}${approve ? ", and suggests approving now" : ""}.`;
        } else {
          now = approve
            ? "The agent reviewed the latest commit and suggests approving."
            : `The agent drafted a review that ${plan?.event === "REQUEST_CHANGES" ? "requests changes" : "comments"}: ${plural(n, "inline comment")}.`;
        }
        if (pushedBack > 0) now += ` The author pushed back on ${plural(pushedBack, "comment")} — your call below.`;
        const held = plan?.held ?? [];
        // A reply with no author answers a comment mid-thread whose thread GitHub didn't name — maybe yours, so not "a colleague's".
        const handedBack = held.filter((h) => h.kind === "reply" && h.escalated).length;
        const midThread = held.filter((h) => h.kind === "reply" && !h.author && !h.escalated).length;
        const theirs = held.length - midThread - handedBack;
        const where = [
          theirs > 0 && (theirs === 1 ? "in a colleague's thread" : `in ${theirs} colleagues' threads`),
          handedBack > 0 && (handedBack === 1 ? "in a thread it handed back to you" : `in ${handedBack} threads it handed back to you`),
          midThread > 0 && (midThread === 1 ? "to a comment whose thread GitHub didn't name" : `to ${midThread} comments whose threads GitHub didn't name`),
        ].filter(Boolean);
        if (held.length > 0) {
          now += ` It also wrote ${where.join(" and ")}; a review answers only in threads you opened, and not where the author pushed back, so ${held.length === 1 ? "that stays" : "those stay"} out — shown below.`;
        }
        ask = approve ? "Read the summary, then approve — or discard it." : pushedBack > 0 ? "Decide on the pushed-back comments, check the rest, then send." : "Check what goes out, then send — or edit or discard it.";
        choices = [
          {
            label: stage.action?.label ?? "Send",
            primary: true,
            does: `Posts ${approve ? "an approval" : `the review${n > 0 ? ` with ${plural(n, "comment")}` : ""}${replies > 0 ? ` and ${plural(replies, "reply", "replies")}` : ""}`} on GitHub under your name, signed by the agent.`,
            act: { type: "publish", runId },
          },
          ...(item?.sessionId && item.worktree ? [{ label: "Edit in Claude", does: "Opens the session in your terminal to change the draft; the new draft comes back here.", act: { type: "continue", runId } } as BoardChoice] : []),
          { label: "Discard", does: "Throws the draft away; the agent leaves this commit to you.", act: { type: "skip", runId } },
        ];
        next = approve
          ? "The author can merge once you approve. If they push again, the agent reviews the new commits."
          : "The author answers; the agent checks the answers and brings you a re-review here.";
        break;
      }
      case "draftReview": {
        const lines = pr ? pr.additions + pr.deletions : 0;
        // A big PR's review follows its brief on its own; a brief waits here only when none did (reviews off, the request gone).
        now = `A big PR${lines ? ` (${lines.toLocaleString("en-US")} lines)` : ""} — the agent wrote a brief${read.questions.length > 0 ? ` with ${plural(read.questions.length, "question")} for the author` : ""}; no review followed on its own.`;
        ask = "Read the brief, then let the agent draft the review — or review it yourself.";
        choices = [
          { label: "Draft a review", primary: true, does: "Starts a full review that carries the brief's questions; the draft comes back here for you to send.", act: { type: "reviewAnyway", runId } },
          { label: "I'll review myself", does: "Drops the brief; the agent leaves this commit to you.", act: { type: "skip", runId } },
        ];
        next = "The draft comes back to Your turn. Nothing is posted until you send it.";
        break;
      }
      case "reapprove":
      case "reask": {
        const logins = item?.reapproval?.logins ?? [];
        now =
          kind === "reapprove"
            ? "Only the base branch changed since you approved, and GitHub took your approval away — the PR's own changes are the ones you approved."
            : `Only the base branch changed, and GitHub dismissed the approval${logins.length === 1 ? "" : "s"} of ${logins.join(", ")} — nothing they approved changed.`;
        ask = kind === "reapprove" ? "Give your approval back." : `Ask ${logins.join(", ")} again.`;
        choices = [
          {
            label: stage.action?.label ?? "Re-approve",
            primary: true,
            does: kind === "reapprove" ? "Posts your approval again on the new commit, signed by the agent." : "Requests their review again; GitHub notifies them, nothing is written in the PR.",
            act: { type: "reapprove", runId },
          },
          open(),
          { label: kind === "reapprove" ? "I'll look myself" : "Don't ask", does: "Turns the offer down; the other rules decide this commit.", act: { type: "skip", runId } },
        ];
        next = kind === "reapprove" ? "The PR is approved again; nothing else changes." : "They get a notification; the PR waits for them.";
        break;
      }
      case "merge": {
        const approved = pr?.reviewers.filter((r) => r.reviewState === "approved").map((r) => r.login) ?? [];
        now = `Ready to merge${approved.length > 0 ? ` — approved by ${approved.join(", ")}` : ""}${pr?.ciState === "success" ? ", CI green" : ""}.`;
        ask = "Merge it.";
        choices = [
          { label: "Merge", primary: true, control: "merge", does: "Merges exactly this commit on GitHub — GitHub refuses it if anyone pushes first.", act: { type: "merge", runId } },
          open(),
        ];
        next = "Then the agent prepares the Jira update for you to apply.";
        break;
      }
      case "push": {
        // After a restart only commits the app couldn't read keep a push card (a stale run is no move of yours).
        if (item?.needsRerun && item.localWork) {
          rerunCard(item);
          break;
        }
        const n = item?.drive?.commits.length ?? 0;
        const reasons = item?.reasons ?? [];
        const what = reasons.includes("self") ? "what its self-review found" : reasons.includes("ci") ? "the failing CI" : reasons.includes("conflicts") ? "the conflict" : "what reviewers asked";
        const replies = plan && !item?.published ? plan.replies.length : 0;
        now = `The agent fixed ${what}: ${plural(n, "commit")}${replies > 0 ? ` and ${plural(replies, "answer")} to reviewers` : ""}, ready.`;
        ask = "Look at the commits, then push them.";
        choices = [
          { label: stage.action?.label ?? "Push", primary: true, does: `Pushes these commits to your branch — a fast-forward, never forced${replies > 0 ? ", then posts the answers" : ""}. CI runs again.`, act: { type: "push", runId } },
          ...(item?.sessionId && item.worktree ? [{ label: "Open in Claude", does: "Opens the session in your terminal to change them; what it ends with comes back to this card.", act: { type: "continue", runId } } as BoardChoice] : []),
          { label: "Discard", does: "Drops the commits; the agent leaves this commit to you.", act: { type: "skip", runId } },
        ];
        next = "CI runs on them. Green and approved, Merge comes to Your turn.";
        break;
      }
      case "decide": {
        const q = read.asks[0];
        now = `The agent needs your decision${read.asks.length > 1 ? ` on ${read.asks.length} questions` : q ? `: ${q.question}` : ""}.`;
        ask = "Answer below — only you can decide this.";
        const n = item?.drive && !item.pushed ? item.drive.commits.length : 0;
        // Nothing to push but answers for the reviewers: they can go out as they are, too.
        const replies = item?.scenario === "drive" && n === 0 && plan && !item.published ? plan.replies.length : 0;
        choices = [
          ...(n > 0 ? [{ label: `Push ${plural(n, "fix", "fixes")} as they are`, does: "Pushes what it has without answering.", act: { type: "push", runId } } as BoardChoice] : []),
          ...(replies > 0
            ? [{ label: `Send ${plural(replies, "reply", "replies")} as ${replies === 1 ? "it is" : "they are"}`, does: "Posts them in the reviewers' threads without answering.", act: { type: "publish", runId } } as BoardChoice]
            : []),
          ...(item?.sessionId && item.worktree ? [{ label: "Open in Claude", does: "Answers it in the session instead; once a turn there ends with a new result, this card shows it — and closes when nothing is left to send or push.", act: { type: "continue", runId } } as BoardChoice] : []),
          { label: "Discard", does: "Drops it; the agent leaves this commit to you.", act: { type: "skip", runId } },
        ];
        next = "The same session goes on with your answer and brings the result back here.";
        break;
      }
      case "fix": {
        // A run the agent planned itself is tried once more on its own (`retryAt`); a second failure is yours.
        const retryAt = item?.retryAt ? new Date(item.retryAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
        now = `The agent couldn't finish: ${lower(item?.headline ?? "it stopped")}${retryAt ? ` — it tries again by itself at ${retryAt}` : item?.retryOf ? " — the second time in a row" : ""}.`;
        ask = retryAt ? "Nothing needed — or see what went wrong and try again now." : "See what went wrong, then try again — or leave it.";
        const inClaude = stage.action?.label === "Open in Claude";
        choices = [
          { label: stage.action?.label ?? "Try again", primary: true, does: inClaude ? "Opens the session in your terminal where it stopped." : "Starts it over with a fresh session.", act: inClaude ? { type: "continue", runId } : { type: "retry", runId } },
          ...(inClaude ? [{ label: "Try again", does: "Starts it over with a fresh session.", act: { type: "retry", runId } } as BoardChoice] : []),
          { label: "Leave it", does: "The agent won't try this commit again.", act: { type: "skip", runId } },
        ];
        next = "A new run starts; its result comes back here.";
        break;
      }
      case "review":
      case "rereview": {
        const again = kind === "rereview";
        const who = again ? (pr?.myReReviewDue ? "The author answered your review" : "Your review was asked for again") : pr?.requestedOfMe ? "Your review is requested" : "Your team's review is requested";
        const why = stage.why ? ` — the agent didn't ${again ? "re-review" : "review"} it: ${lower(stage.why)}` : "";
        now = `${who}${why}.`;
        ask = canStart ? `Let the agent ${again ? "re-review" : "review"} it — or do it yourself.` : sessionOnIt ? "Carry on in your Claude session — the agent stays off this PR while it is open." : "Review it on GitHub.";
        choices = canStart
          ? [{ label: again ? "Let the agent re-review" : "Let the agent review", primary: true, does: "The agent starts now; its draft comes back here. Nothing is posted until you send it.", act: { type: "enqueue", prId } }, open()]
          : [{ ...open(), primary: true }];
        next = canStart ? "The draft comes back to Your turn." : "The author sees your review on GitHub.";
        break;
      }
      case "fixYourself": {
        const why = stage.why ? ` The agent: ${lower(stage.why)}.` : "";
        now = `${now}.${why}`;
        ask = canStart ? "Let the agent fix it — or fix it yourself." : sessionOnIt ? "Carry on in your Claude session — the agent stays off this PR while it is open." : "Fix it on GitHub or in your clone.";
        choices = canStart
          ? [{ label: "Let the agent fix it", primary: true, does: "The agent fixes it in a separate checkout; you see the commits before anything is pushed.", act: { type: "enqueue", prId } }, open()]
          : [{ ...open(), primary: true }];
        next = canStart ? "Its commits come back to Your turn to push." : "CI runs again on your push.";
        break;
      }
      case "draft":
        now = "It's a draft.";
        ask = "Mark it ready for review on GitHub when it is.";
        choices = [{ ...open(), primary: true }];
        next = "Once it's ready, the agent self-reviews it before reviewers look.";
        break;
      default:
        ask = "Open it on GitHub.";
        choices = [{ ...open(), primary: true }];
        next = "";
    }
  }

  // A run whose result can't be acted on any more: GitHub placed the card; the run is told as out of date, with Discard.
  if (stage.stale && item) {
    now = `${now ? `${now.replace(/\.$/, "")}. ` : ""}The agent's earlier run is out of date: ${lower(stage.note ?? "")}.`;
    const first = !choices.some((c) => c.primary);
    choices = [
      ...choices,
      {
        label: "Discard",
        primary: first,
        does: "Closes the out-of-date run. Its worktree stays while it holds commits that are not on the PR, and a ref keeps them.",
        act: { type: "skip", runId },
      },
      ...(item.sessionId && item.worktree ? [{ label: "Open in Claude", does: "Opens the old session in your terminal — anything from it is then yours to push or post.", act: { type: "continue", runId } } as BoardChoice] : []),
    ];
    if (first && !ask) ask = "Nothing to do on its result — discard it.";
  }

  return {
    prId,
    card,
    pr,
    item,
    stage,
    lane,
    laneLabel: lane === "mine" ? "Your PR" : "You review",
    owner,
    waitingOn,
    number: pr?.number ?? item?.prNumber ?? 0,
    repo: pr?.repo ?? item?.repo ?? "",
    title: pr?.title ?? item?.title ?? "",
    url,
    since: stage.since,
    now,
    ask,
    read,
    choices,
    next,
    progress,
    place: item && item.state === "queued" ? (place.get(item.runId) ?? 0) : 0,
  };
}
