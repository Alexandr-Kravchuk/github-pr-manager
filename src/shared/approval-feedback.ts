// What an approval's text asks of the PR's author. GitHub has no state for
// "approved, with these points": the text is all there is, and a keyword list
// can't prove what prose means, so prose the app can't read counts as feedback
// until the author marks the review read (👀 on it). Two formats it can read
// by their structure, not their wording: the app's own approvals (one of its
// one-line texts, and nothing after it but a signature's length) and
// creatio-code-review's (its hidden marker, then each finding as a list item
// that names its severity). Node-free: github.ts reads it.

import type { FeedbackPoint } from "./types";

/** The hidden line every creatio-code-review review carries (its marker and its meta line both start so). */
const CREATIO_REVIEW_MARKER = "<!-- creatio-code-review";

type FeedbackSeverity = FeedbackPoint["severity"];

/** What an approval's text asks of the author. */
export interface ApprovalReading {
  /** There is something to read before merging. */
  feedback: boolean;
  /** The points its format lists — creatio-code-review's findings; empty for prose. */
  points: FeedbackPoint[];
  /** The text as GitHub shows it, cut short: no hidden comments. */
  excerpt: string;
}

const PLAIN = /^(?:lgtm|looks good(?: to me)?|approved|approve|thanks|thank you|good job|nice work|ship it|✅|👍)$/;
const SHA = "`[0-9a-f]{7,40}`";
/** The one-line approvals the app posts (`main/agent/reapprove.ts`). */
const APP_LINES = [
  new RegExp(`^Approved ${SHA}: nothing blocking is left\\.$`),
  new RegExp(`^Approved again: nothing changed since my approval of ${SHA}\\.$`),
  new RegExp(`^Re-approved: only the base branch changed since my approval at ${SHA} — the PR's own changes are the same\\.$`),
];
/** What may follow one of those lines: the agent's signature, nothing longer. */
const SIGNATURE_MAX = 300;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
const SEVERITY = /\b(blocker|major|minor)\b/i;
/** A point's leading label — "**Major (low confidence)**", "Minor:" — read off its text. */
const LEADING_LABEL = /^\*{0,2}(blocker|major|minor)\b\s*(\([^)]*\))?\s*\*{0,2}\s*[:—–-]?\s*/i;
/** creatio-code-review's own words for an approval that still lists points. */
const CREATIO_HAS_POINTS = /approve \(minor issues\)|low-confidence major/i;
const EXCERPT_MAX = 280;
const POINT_MAX = 220;
const POINTS_MAX = 10;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string) => clip(s.replace(/\s+/g, " ").trim(), EXCERPT_MAX);

/**
 * The text a reader sees: hidden comments out. A folded `<details>` section
 * stays — GitHub shows its `<summary>`, and the fold may hold the very points
 * the reviewer wants read.
 */
function visible(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function point(line: string): FeedbackPoint | null {
  const m = SEVERITY.exec(line);
  if (!m) return null;
  const text = line.replace(/\s+/g, " ").trim();
  const label = LEADING_LABEL.exec(text);
  const rest = label ? `${label[2] ? `${label[2].slice(1, -1)} — ` : ""}${text.slice(label[0].length)}` : text;
  return { severity: m[1].toLowerCase() as FeedbackSeverity, text: clip(rest.replace(/\*\*/g, "").trim(), POINT_MAX) };
}

/**
 * Reads an approval's text: nothing for the author (a plain yes, the app's own
 * approval, a creatio-code-review approval that lists no finding) or feedback
 * to read, with the points it lists when its format lists them. Anything else
 * is feedback: the safe side, since the author can always mark it read.
 */
export function readApproval(body: string | undefined): ApprovalReading {
  const raw = body ?? "";
  const shown = visible(raw);
  const plain = shown.toLowerCase().replace(/[.!✅👍]+$/u, "").trim();
  if (plain === "" || PLAIN.test(plain)) return { feedback: false, points: [], excerpt: oneLine(shown) };
  // The app's own: its one line first, then no more than a signature — a reviewer's words added to it are prose again.
  const [first = "", ...rest] = shown.split(/\r?\n/);
  if (APP_LINES.some((re) => re.test(first.trim())) && rest.join("\n").trim().length <= SIGNATURE_MAX) {
    return { feedback: false, points: [], excerpt: oneLine(shown) };
  }
  if (raw.includes(CREATIO_REVIEW_MARKER)) {
    // Its folded sections are the checklist tables it adds itself: every fail there is also a finding above.
    const text = shown.replace(/<details[\s\S]*?<\/details>/gi, "").trim();
    const points = text
      .split(/\r?\n/)
      .map((l) => LIST_ITEM.exec(l)?.[1] ?? null)
      .map((t) => (t ? point(t) : null))
      .filter((p): p is FeedbackPoint => p !== null)
      .slice(0, POINTS_MAX);
    return { feedback: points.length > 0 || CREATIO_HAS_POINTS.test(text), points, excerpt: oneLine(text) };
  }
  return { feedback: true, points: [], excerpt: oneLine(shown) };
}

/**
 * Only plain approvals are safe to read as "nothing for the author"; unknown
 * prose is kept for the author to read — see `readApproval`. Author EYES on that
 * specific review, after its last edit, clears it (`github.ts`); another user's
 * reaction never counts. Pushes, author replies and re-requests alone do not.
 */
export function approvalBodyNeedsAttention(body: string | undefined): boolean {
  return readApproval(body).feedback;
}
