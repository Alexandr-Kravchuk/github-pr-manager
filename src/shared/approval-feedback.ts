// What an approval's text asks of the PR's author. GitHub has no state for
// "approved, with these points": the text is all there is, and a keyword list
// can't prove what prose means, so prose the app can't read counts as feedback
// until the author marks the review read (👀 on it). Two formats it can read
// by their structure, not their wording: the app's own approvals (one of the
// lines below, built and matched from one place, and nothing after it but a
// signature's length) and creatio-code-review's (its hidden marker — clean only
// on a positive sign that the review had no finding to list). Node-free:
// github.ts reads it, and main posts the app's lines from here.

import type { FeedbackPoint } from "./types";

/** The hidden line every creatio-code-review review carries (its marker and its meta line both start so). */
const CREATIO_REVIEW_MARKER = "<!-- creatio-code-review";

/**
 * The one-line approvals the app posts, by the commit they name. One source for
 * the writer (`main/agent/reapprove.ts`) and the reader (`APP_LINES` below): a
 * reworded line still reads as the app's own.
 */
export const APP_APPROVAL_LINES = {
  approved: (sha: string) => `Approved \`${sha.slice(0, 7)}\`: nothing blocking is left.`,
  approvedAgain: (sha: string) => `Approved again: nothing changed since my approval of \`${sha.slice(0, 7)}\`.`,
  reapproved: (sha: string) => `Re-approved: only the base branch changed since my approval at \`${sha.slice(0, 7)}\` — the PR's own changes are the same.`,
};

/** What an approval's text asks of the author. */
export interface ApprovalReading {
  /** There is something to read before merging. */
  feedback: boolean;
  /** The points it lists, each list item one — creatio-code-review's findings; empty for prose. */
  points: FeedbackPoint[];
  /** The text as GitHub shows it, cut short: no hidden comments. */
  excerpt: string;
}

const PLAIN = /^(?:lgtm|looks good(?: to me)?|approved|approve|thanks|thank you|good job|nice work|ship it|✅|👍)$/;
const SHA_SLOT = "\u0000";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The app's lines as patterns: each template with its commit as any short hash. */
const APP_LINES = Object.values(APP_APPROVAL_LINES).map(
  (line) => new RegExp(`^${escapeRe(line(SHA_SLOT)).split(escapeRe(SHA_SLOT)).join("[0-9a-f]{7}")}$`),
);
/** What may follow one of those lines: the agent's signature, nothing longer. */
const SIGNATURE_MAX = 300;
/** GitHub caps a review body at 65,536 characters; nothing past that is read. */
const BODY_MAX = 65_536;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
const SEVERITY = /\b(blocker|major|minor)\b/i;
/** A point's leading label — "**Major (low confidence)**", "Minor:" — read off its text. */
const LEADING_LABEL = /^\*{0,2}(blocker|major|minor)\b\s*(\([^)]*\))?\s*\*{0,2}\s*[:—–-]?\s*/i;
/** creatio-code-review's own words for an approval that still lists points. */
const CREATIO_HAS_POINTS = /approve \(minor issues\)|low-confidence major/i;
/** …and for one with none. A positive sign, never a default. */
const CREATIO_NO_FINDINGS = /approve \(no findings\)/i;
/** The meta line's mode, written by the workflow's code, not its model. */
const CREATIO_MODE = /<!-- creatio-code-review:meta [^>]*?\bmode=([a-z-]+)/;
const EXCERPT_MAX = 280;
const POINT_MAX = 220;
const POINTS_MAX = 10;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string) => clip(s.replace(/\s+/g, " ").trim(), EXCERPT_MAX);

/**
 * The text a reader sees: hidden comments out — an unclosed one hides the rest,
 * as GitHub renders it. A folded `<details>` section stays: GitHub shows its
 * `<summary>`, and the fold may hold the very points the reviewer wants read.
 * One pass with indexOf, so text a reviewer writes can't make it slow.
 */
function visible(body: string): string {
  const text = body.length > BODY_MAX ? body.slice(0, BODY_MAX) : body;
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<!--", at);
    if (open < 0) return (out + text.slice(at)).trim();
    out += text.slice(at, open);
    const close = text.indexOf("-->", open + 4);
    if (close < 0) return out.trim();
    at = close + 3;
  }
}

/** A list item as a point: its severity when it names one, else a note — never dropped. */
function point(line: string): FeedbackPoint {
  const text = line.replace(/\s+/g, " ").trim();
  const m = SEVERITY.exec(text);
  if (!m) return { severity: "note", text: clip(text.replace(/\*\*/g, ""), POINT_MAX) };
  const label = LEADING_LABEL.exec(text);
  const rest = label ? `${label[2] ? `${label[2].slice(1, -1)} — ` : ""}${text.slice(label[0].length)}` : text;
  return { severity: m[1].toLowerCase() as FeedbackPoint["severity"], text: clip(rest.replace(/\*\*/g, "").trim(), POINT_MAX) };
}

/**
 * Reads an approval's text: nothing for the author (a plain yes, the app's own
 * approval, a creatio-code-review approval that shows it had no finding) or
 * feedback to read, with its list items as points. Anything else is feedback:
 * the safe side, since the author can always mark it read.
 */
export function readApproval(body: string | undefined): ApprovalReading {
  const raw = body ?? "";
  const shown = visible(raw);
  const excerpt = oneLine(shown);
  const plain = shown.toLowerCase().replace(/[.!✅👍]+$/u, "").trim();
  if (plain === "" || PLAIN.test(plain)) return { feedback: false, points: [], excerpt };
  // The app's own: its one line first, then no more than a signature — a reviewer's words added to it are prose again.
  const [first = "", ...rest] = shown.split(/\r?\n/);
  if (APP_LINES.some((re) => re.test(first.trim())) && rest.join("\n").trim().length <= SIGNATURE_MAX) {
    return { feedback: false, points: [], excerpt };
  }
  if (raw.includes(CREATIO_REVIEW_MARKER)) {
    // Its findings go out as list items, but nothing makes an item name its
    // severity: every list item is a point, folded ones too. Clean only with no
    // item at all and a sign of no finding — a lenient round, which raises
    // only Blockers and never approves with one, or its own "no findings".
    const points = shown
      .split(/\r?\n/)
      .map((l) => LIST_ITEM.exec(l)?.[1] ?? null)
      .filter((t): t is string => t !== null)
      .map(point)
      .slice(0, POINTS_MAX);
    const lenient = CREATIO_MODE.exec(raw.length > BODY_MAX ? raw.slice(0, BODY_MAX) : raw)?.[1] === "lenient";
    const clean = points.length === 0 && !CREATIO_HAS_POINTS.test(shown) && (lenient || CREATIO_NO_FINDINGS.test(shown));
    return { feedback: !clean, points, excerpt };
  }
  return { feedback: true, points: [], excerpt };
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
