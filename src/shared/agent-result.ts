// What an agent run's final message means for the user, in the shape the
// Needs-you card shows: one sentence, the questions only the user can answer,
// and the findings worth their attention. Every session is asked to end with
// a fenced `prd-result` block holding that as JSON (`RESULT_RULE`); the app
// reads it here and keeps the rest of the message as the full report. A
// message without the block — an older run, a skill that ignored the rule —
// still gets a summary: its first real paragraph.
//
// Node-free (the renderer value-imports it for results stored before the
// block existed) and pure, so it is unit-tested without a session.

export type FindingSeverity = "blocker" | "major" | "minor" | "note";

export interface RunAsk {
  question: string;
  /** Short answers to pick from; empty for a free answer. */
  options: string[];
}

export interface RunFinding {
  severity: FindingSeverity;
  text: string;
  /** "path:line", or "" when it is about the PR as a whole. */
  where: string;
}

export interface RunResultCard {
  summary: string;
  asks: RunAsk[];
  findings: RunFinding[];
  /** Read from the session's own block, not guessed from its prose. */
  structured: boolean;
}

/** The rule every session gets: how to end its final message so the card can show it. */
export const RESULT_RULE =
  "Finish your final message with a block the app reads for the user's card: a fenced code block whose language is prd-result, holding one JSON object — " +
  '{"summary": one sentence (under 200 characters) on what you found or did and what it means for the user, ' +
  '"asks": the questions only the user can answer before this moves on, each {"question": one or two sentences, "options": up to 4 short answers, or [] for a free answer}, ' +
  '"findings": the issues worth the user\'s attention, most severe first, each {"severity": "blocker" | "major" | "minor" | "note", "text": one line, "where": "path:line" or ""}}. ' +
  "Use [] where there is nothing; keep the rest of your message above the block as usual.";

const SEVERITIES: readonly FindingSeverity[] = ["blocker", "major", "minor", "note"];
const MAX = { summary: 300, asks: 5, question: 500, options: 4, option: 80, findings: 20, text: 300, where: 200 };

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const s = value.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Strips markdown down to the words: emphasis, code ticks, links, list and quote marks. */
function plain(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/^\s*(?:[-*+]|\d+\.|>)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A summary for a message with no block: its first paragraph that is not a
 * heading, a rule or a code fence, without the markdown.
 */
export function summarizeOutput(text: string): string {
  let inFence = false;
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line.trim()) {
      if (current.length) paragraphs.push(current.join(" "));
      current = [];
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line) || /^\s*([-*_])\1{2,}\s*$/.test(line) || /^\s*\|/.test(line)) continue;
    // A list item or a quote reads as its words: the marks go per line, before the lines join.
    current.push(line.trim().replace(/^(?:[-*+]|\d+\.|>)\s+/, ""));
  }
  if (current.length) paragraphs.push(current.join(" "));
  const first = paragraphs.map(plain).find((p) => p.length > 0) ?? "";
  return clip(first, 240);
}

/** The last fenced prd-result block of a message, and the message without it. */
function splitBlock(text: string): { json: string | null; body: string } {
  const re = /```prd-result[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return { json: null, body: text.trim() };
  return { json: last[1], body: (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim() };
}

/**
 * Reads a run's final message. The block's values are held to their shapes and
 * lengths — it is the model's text, shown as text, never trusted further.
 */
export function parseRunResult(text: string): { card: RunResultCard; body: string } {
  const { json, body } = splitBlock(text ?? "");
  let raw: Record<string, unknown> | null = null;
  if (json !== null) {
    try {
      const v = JSON.parse(json) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) raw = v as Record<string, unknown>;
    } catch {
      raw = null;
    }
  }
  if (!raw) return { card: { summary: summarizeOutput(body), asks: [], findings: [], structured: false }, body };
  const asks: RunAsk[] = (Array.isArray(raw.asks) ? raw.asks : [])
    .map((a): RunAsk | null => {
      if (!a || typeof a !== "object") return null;
      const o = a as Record<string, unknown>;
      const question = clip(o.question, MAX.question);
      if (!question) return null;
      const options = (Array.isArray(o.options) ? o.options : [])
        .map((x) => clip(x, MAX.option))
        .filter(Boolean)
        .slice(0, MAX.options);
      return { question, options };
    })
    .filter((a): a is RunAsk => a !== null)
    .slice(0, MAX.asks);
  const findings: RunFinding[] = (Array.isArray(raw.findings) ? raw.findings : [])
    .map((f): RunFinding | null => {
      if (!f || typeof f !== "object") return null;
      const o = f as Record<string, unknown>;
      const t = clip(o.text, MAX.text);
      if (!t) return null;
      const sev = typeof o.severity === "string" ? o.severity.toLowerCase() : "";
      return { severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as FindingSeverity) : "note", text: t, where: clip(o.where, MAX.where) };
    })
    .filter((f): f is RunFinding => f !== null)
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    .slice(0, MAX.findings);
  const summary = clip(raw.summary, MAX.summary) || summarizeOutput(body);
  return { card: { summary, asks, findings, structured: true }, body };
}

/** The card of an item: what main stored, else read from its output now (results from before the block). */
export function resultCard(item: { result?: RunResultCard; output?: string }): RunResultCard | null {
  if (item.result) return item.result;
  if (!item.output) return null;
  return parseRunResult(item.output).card;
}

/** What the session hears when you answer one of its questions from the card. */
export function answerMessage(answer: string, hasWrapper: boolean): string {
  return (
    `The user answered from the app: ${answer}\n\nCarry on from there and finish the task, ending with the prd-result block again.` +
    (hasWrapper ? " Whatever you recorded through the publish wrapper before is gone: record what should go out again — once." : "")
  );
}
