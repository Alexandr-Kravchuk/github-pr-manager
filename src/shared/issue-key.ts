/**
 * What an issue-tracker key looks like, where it lives in Jira, and how to keep
 * it from being said twice on one card.
 *
 * Its own module, and deliberately free of `node:` builtins, because the
 * renderer value-imports it to turn a PR's `issueKey` into a clickable link on
 * the card (see the carve-out rule in AGENTS.md and the guard test in
 * `tests/run-tests.cjs`). Keeping it pure also lets the "no site configured" and
 * trailing-slash cases be unit-tested without Electron.
 */

/**
 * A Jira-style project key (two or more uppercase alphanumerics) plus a number,
 * e.g. "ENG-93374".
 *
 * Exported as a source string rather than a RegExp because the two users need
 * different anchoring: `github.ts` searches for a key *inside* a PR title or
 * branch name, while {@link jiraBrowseUrl} validates a whole string. A second
 * copy of the shape would drift silently — widening the parser without widening
 * the validator would just stop rendering links, with no test failing and
 * nothing to see but a missing badge.
 */
export const ISSUE_KEY_PATTERN = "[A-Z][A-Z0-9]+-\\d+";

/** The pattern as a whole-string check — what a key must match to become a URL. */
const WHOLE_KEY_RE = new RegExp(`^${ISSUE_KEY_PATTERN}$`);

/**
 * `<site>/browse/<KEY>`, or null when there is no site configured, no key, or a
 * key that isn't the shape above. Null means "there is no link", and the card
 * renders no badge at all rather than a dead one.
 *
 * The key is validated rather than trusted, so a future change to the parser
 * can't produce one that escapes the `/browse/` path.
 */
export function jiraBrowseUrl(
  baseUrl: string | null | undefined,
  issueKey: string | null,
): string | null {
  if (!baseUrl || !issueKey || !WHOLE_KEY_RE.test(issueKey)) return null;
  // `validateJira` normalizes the stored site to an origin, but a hand-edited
  // settings.json can still carry a trailing slash — strip it so the result is
  // never `https://site.atlassian.net//browse/ENG-1`.
  return `${baseUrl.replace(/\/+$/, "")}/browse/${issueKey}`;
}

/** A key at the very start, with whatever separator follows it: ": ", " - ", " ". */
const LEADING_SEPARATOR_RE = /^[\s:\u2013\u2014-]+/;

/**
 * The title with a leading issue key removed — `"ENG-1: Fix the thing"` becomes
 * `"Fix the thing"`. For the card only, and only where the key is already shown
 * as its own badge, so the prefix there is pure duplication; everything that
 * *reasons* about a PR — search, grouping, notification bodies — keeps using the
 * raw title, so a key stays findable by typing it.
 *
 * Returns the title untouched when it doesn't start with this PR's key. That
 * covers the two ordinary cases: a key parsed from the branch rather than the
 * title, and a key sitting mid-title ("Fix ENG-1: ..."), where cutting anything
 * would mangle the sentence. Also untouched when the key is the whole title,
 * since the alternative is a card with no title at all.
 */
export function stripLeadingIssueKey(title: string, issueKey: string | null): string {
  if (!issueKey || !title.startsWith(issueKey)) return title;
  const after = title.slice(issueKey.length);
  // What follows a real key is a separator, or nothing. Without this, the key
  // "ENG-1" would cut the title "ENG-12 Fix" down to "2 Fix".
  if (after && !LEADING_SEPARATOR_RE.test(after)) return title;
  const rest = after.replace(LEADING_SEPARATOR_RE, "");
  return rest || title;
}
