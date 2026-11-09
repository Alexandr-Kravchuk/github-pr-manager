/**
 * Pure classification of a Jira parent-enrichment pass into a `JiraHealth`
 * signal, split out of the Electron-bound `main/jira-store.ts` so the decision
 * logic — the PR's "no more silent empty groups" behaviour — is unit-testable in
 * the plain-Node test runner (which can't `require` anything importing electron).
 */
import type { JiraIssue } from "./jira";
import type { JiraHealth, JiraSettings, JiraSource, Settings, TwgStatus } from "./types";

/** Why a parent-enrichment pass has nothing to do; null when it should run. */
export type EnrichmentSkipReason = "no-config" | "no-keys";

/**
 * The one "Jira connection is configured" predicate, shared by the settings
 * status, the skip decision, and the enricher — a type guard so callers get
 * compiler-checked narrowing instead of `!` assertions that can drift. Only the
 * site is required: twg signs in on its own, and the email matters only to the
 * API-token fallback (`canUseToken`).
 */
export function hasJiraConfig(jira: JiraSettings | undefined): jira is JiraSettings {
  return Boolean(jira?.baseUrl);
}

/** Whether the API-token fallback can run: it needs the account email as well as a stored token. */
export function canUseToken(
  jira: JiraSettings | undefined,
  hasToken: boolean,
): jira is JiraSettings & { email: string } {
  return hasJiraConfig(jira) && Boolean(jira.email) && hasToken;
}

/**
 * Whether Jira grouping is set up: a site, and a source — twg installed (in any
 * sign-in state), or an API token with its email. Deliberately not "works right
 * now": the renderer drops a saved "Group by parent task" and hides the option
 * when this is false, so an expired twg session or token must not flip it —
 * that is the `auth` health banner's job, and the grouping comes back by itself
 * once the user signs in again.
 */
export function jiraConfigured(jira: JiraSettings | undefined, twg: TwgStatus, hasToken: boolean): boolean {
  return hasJiraConfig(jira) && (twg.state !== "not-installed" || canUseToken(jira, hasToken));
}

/**
 * The source a pass can sign in with now: twg when it is signed in, else the API
 * token when it and the email are stored. Unlike `jiraConfigured`, a signed-out
 * or still-checking twg does not count.
 */
export function signInSource(jira: JiraSettings | undefined, twg: TwgStatus, hasToken: boolean): JiraSource | null {
  if (!hasJiraConfig(jira)) return null;
  if (twg.state === "signed-in") return "twg";
  return canUseToken(jira, hasToken) ? "token" : null;
}

/** The settings half of `JiraStatus`: is the connection configured, and where does the site live. */
export interface JiraSiteState {
  hasConfig: boolean;
  /** The configured site, or null — which the renderer reads as "render no issue-key link". */
  baseUrl: string | null;
}

/**
 * Reads the Jira connection out of settings, failing CLOSED: any error from
 * `loadSettings` — an unreadable file, a `ConfigError` from a hand-edited site
 * URL — yields no config and no site rather than propagating, so a broken
 * settings file degrades to "no Jira" instead of taking down the status call.
 *
 * Lives here rather than in `main/jira-store.ts` for the reason this whole module
 * exists: the caller there also touches `fs` and Electron `safeStorage`, so this
 * branch would be untestable in the plain-Node runner. Both fields come from one
 * load, so they can't disagree about which settings they describe.
 */
export function jiraSiteState(loadSettings: () => Settings): JiraSiteState {
  try {
    const jira = loadSettings().jira;
    return { hasConfig: hasJiraConfig(jira), baseUrl: jira?.baseUrl ?? null };
  } catch {
    return { hasConfig: false, baseUrl: null };
  }
}

/**
 * Decides whether enrichment is applicable, returning the skip reason if not.
 * Checked in order: connection config, then any issue keys. Whether a source
 * can sign in is only known by trying twg, so the enricher decides that itself.
 */
export function enrichmentSkipReason(
  jira: JiraSettings | undefined,
  keyCount: number,
): EnrichmentSkipReason | null {
  if (!hasJiraConfig(jira)) return "no-config";
  if (keyCount === 0) return "no-keys";
  return null;
}

/**
 * Health for a completed pass: `ok` when at least one parent resolved, else
 * `empty` (the call succeeded but nothing resolved — the account can't see the
 * issues, or none are subtasks).
 */
export function healthFromResolution(queried: number, resolved: number, source?: JiraSource): JiraHealth {
  return { state: resolved > 0 ? "ok" : "empty", queried, resolved, ...(source ? { source } : {}) };
}

/**
 * Health for a completed pass, counted from what the lookup returned. `resolved`
 * is the number of keys that resolved a **parent**, not the number of issues that
 * came back — the two diverged when the lookup started returning parentless
 * issues for their own summaries. A batch can resolve every summary and still
 * leave "Group by parent task" with nothing to cluster, which is exactly the
 * `empty` the banner exists to name; counting issues here would report `ok` and
 * silence it, while the by-issue heading needs no banner at all (it degrades to
 * the bare key, as it does with Jira switched off).
 *
 * Lives beside the other health rules rather than in the Electron-bound
 * `main/jira-store.ts` for this module's whole reason to exist: here the
 * distinction is pinned by the plain-Node runner.
 */
export function healthFromIssues(
  queried: number,
  issues: Iterable<Pick<JiraIssue, "parentKey">>,
  source?: JiraSource,
): JiraHealth {
  let withParent = 0;
  for (const issue of issues) if (issue.parentKey) withParent++;
  return healthFromResolution(queried, withParent, source);
}

/**
 * Health for a failed pass — `error` carrying the failure detail, or `auth` when
 * the error says the credentials were rejected. Duck-typed on the error's `name`
 * and `source` rather than `instanceof JiraAuthError`, so this module keeps
 * importing nothing but types from `jira.ts`.
 */
export function healthFromError(queried: number, error: unknown, source?: JiraSource): JiraHealth {
  const message = error instanceof Error ? error.message : String(error);
  const auth = authSourceOf(error);
  if (auth) return { state: "auth", message, queried, resolved: 0, source: auth };
  return { state: "error", message, queried, resolved: 0, ...(source ? { source } : {}) };
}

/** The rejected source when `error` is a `JiraAuthError`, else null. */
export function authSourceOf(error: unknown): JiraSource | null {
  if (!(error instanceof Error) || error.name !== "JiraAuthError") return null;
  const source = (error as Error & { source?: unknown }).source;
  return source === "twg" || source === "token" ? source : null;
}

/**
 * Whether to raise the one-time OS notification for a credentials problem: only
 * on the transition INTO `auth` (or onto a different rejected source), never on
 * every tick that stays there — the banner carries the state from then on.
 */
export function shouldNotifyJiraAuth(prev: JiraHealth | undefined, next: JiraHealth | undefined): boolean {
  if (next?.state !== "auth") return false;
  return prev?.state !== "auth" || prev.source !== next.source;
}
