import { describePlan } from "./agent-publish";
import { parseRunResult, type RunResultCard } from "./agent-result";
import type { AgentItem } from "./types";

// "Open in Claude" resumes a run's session in your terminal. Whatever you
// settle there — answer its question, let it commit, record replies through
// the run's publish wrapper — ends, like the run itself, with a fenced
// prd-result block. The app follows that session's transcript and, once a
// turn of it has ended with a new block, puts that result on the card in
// place of the run's own (`main/agent/index.ts`, `followSessions`).
//
// Node-free and pure: what a transcript's tail says and what becomes of the
// card are decided here, unit-tested without a session or a file.

/** The scenarios whose card follows a session you continued: their move is a Publish or a Push. */
export const FOLLOWED: ReadonlySet<AgentItem["scenario"]> = new Set(["drive", "review", "rereview"]);

/** How a transcript ends, read from its last lines. */
export type TurnEnd =
  /** No message of the conversation in what was read. */
  | { state: "none" }
  /** A turn is going on: the last message is yours, a tool's, or the model's before a tool. */
  | { state: "open" }
  /** The model ended its turn with this message. */
  | { state: "ended"; uuid: string; at: string; text: string };

interface Line {
  type?: unknown;
  subtype?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  message?: { id?: unknown; stop_reason?: unknown; content?: unknown };
}

function blocks(line: Line): Array<{ type?: unknown; text?: unknown }> {
  const c = line.message?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? (c as Array<{ type?: unknown; text?: unknown }>) : [];
}

/**
 * A user line that starts no model turn: a skill body or caveat (`isMeta`),
 * the summary written after a compaction, or the echo of a slash command and
 * its output (`/exit` written after the turn's final message). Counted as a
 * prompt, it would hold the turn open for good once the file stops changing.
 */
function startsNoTurn(line: Line): boolean {
  if (line.type !== "user") return false;
  if (line.isMeta === true || line.isCompactSummary === true) return true;
  const first = blocks(line).find((b) => b.type === "text" && typeof b.text === "string");
  const t = typeof first?.text === "string" ? first.text.trimStart() : "";
  return t.startsWith("<command-name>") || t.startsWith("<command-message>") || t.startsWith("<local-command-");
}

/**
 * Where the conversation of a Claude Code transcript (JSON lines) stands.
 * Only the main conversation counts — a subagent's lines (`isSidechain`) and
 * the bookkeeping lines (hooks, summaries, modes) are skipped. Claude Code
 * writes one line per content block, all with the message's id, so the final
 * message's text is joined from every line of that id. The turn has ended
 * when that message stopped by itself (`end_turn`), or — for a transcript that
 * writes no stop reason per block — when it calls no tool and Claude Code
 * logged the turn's end after it. A last line cut off mid-write is skipped.
 */
export function readTurnEnd(text: string): TurnEnd {
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) lines.push(v as Line);
    } catch {
      // A partial line: the first of a tail read from the middle, or the last one still being written.
    }
  }
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if ((l.type === "user" || l.type === "assistant") && l.isSidechain !== true && !startsNoTurn(l)) {
      last = i;
      break;
    }
  }
  if (last < 0) return { state: "none" };
  const end = lines[last];
  if (end.type !== "assistant") return { state: "open" };
  const id = end.message?.id;
  // Every line of the final message: the run of assistant lines with its id, back from the last.
  const parts: Line[] = [];
  for (let i = last; i >= 0; i--) {
    const l = lines[i];
    if (l.isSidechain === true || (l.type !== "assistant" && l.type !== "user") || startsNoTurn(l)) continue;
    if (l.type !== "assistant" || (id !== undefined && l.message?.id !== id)) break;
    parts.unshift(l);
    if (id === undefined) break;
  }
  if (parts.some((l) => blocks(l).some((b) => b.type === "tool_use"))) return { state: "open" };
  const stopped = parts.some((l) => l.message?.stop_reason === "end_turn");
  const logged = lines.slice(last + 1).some((l) => l.type === "system" && (l.subtype === "turn_duration" || l.subtype === "stop_hook_summary"));
  if (!stopped && !logged) return { state: "open" };
  const body = parts
    .flatMap((l) => blocks(l))
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
  const uuid = typeof end.uuid === "string" ? end.uuid : "";
  const at = typeof end.timestamp === "string" ? end.timestamp : "";
  return { state: "ended", uuid, at, text: body };
}

/**
 * The result of a turn's final message — or null when it has no prd-result
 * block: you only talked with the session, and the card stays as it is.
 */
export function resultOfTurn(text: string, scenario: string): { card: RunResultCard; body: string } | null {
  if (!/```prd-result/.test(text)) return null;
  const read = parseRunResult(text, scenario);
  return read.card.structured ? read : null;
}

/** A turn the card has not taken yet: ended after you continued the session, and not the one it took last. */
export function isNewTurn(end: TurnEnd, follow: { since: string; seen?: string }): end is Extract<TurnEnd, { state: "ended" }> {
  if (end.state !== "ended") return false;
  if (follow.seen && end.uuid === follow.seen) return false;
  const at = Date.parse(end.at);
  return Number.isFinite(at) && at > Date.parse(follow.since);
}

export interface FollowedOutcome {
  state: "needsYou" | "done";
  headline: string;
}

/**
 * What a card becomes once the session you continued ended with `card`:
 * still asks you something → its questions; nothing asked, yet replies or a
 * review left to post, or commits left to push → that move; nothing left →
 * done, as after Discard. `onBranch`: the commits are on the PR's branch
 * already (you pushed from the session), so there is nothing to push.
 */
export function followedOutcome(
  item: Pick<AgentItem, "scenario" | "plan" | "published" | "drive" | "pushed">,
  card: RunResultCard,
  onBranch = false,
): FollowedOutcome {
  const blocker = card.findings.some((f) => f.severity === "blocker");
  if (card.asks.length > 0) {
    return { state: "needsYou", headline: `Your call: ${card.asks[0].question}` };
  }
  const n = item.scenario === "drive" && !item.pushed && !onBranch ? (item.drive?.commits.length ?? 0) : 0;
  const plan = item.plan && !item.published ? item.plan : null;
  if (n > 0) {
    const last = item.drive!.commits[n - 1].subject;
    return { state: "needsYou", headline: `Would push ${n} commit${n === 1 ? "" : "s"}: ${last}` };
  }
  if (plan && (item.scenario !== "drive" || plan.replies.length > 0)) {
    return { state: "needsYou", headline: `Would post: ${describePlan(plan)}` };
  }
  if (blocker) return { state: "needsYou", headline: `Blocker left: ${card.findings.find((f) => f.severity === "blocker")!.text}` };
  return { state: "done", headline: "Settled in your session" };
}
