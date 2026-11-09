/**
 * The `twg` (Atlassian Teamwork Graph CLI) side of the Jira lookup: the
 * arguments, the output parsing and the failure classification. Pure — the
 * process itself is spawned by `main/twg.ts` and injected as a `TwgRunner` — so
 * all of it is unit-tested in the plain-Node runner.
 *
 * twg is the primary Jira source because it signs in with OAuth and refreshes
 * itself: there is no API token to expire. It mirrors how the app gets GitHub
 * tokens from `gh`.
 */

/** What one run of `twg` produced. `notFound` is true when no `twg` binary was found. */
export interface TwgRunResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when the process was killed (timeout) or never started. */
  code: number | null;
  notFound?: boolean;
}

/** Runs `twg` with the given arguments. */
export type TwgRunner = (args: string[]) => Promise<TwgRunResult>;

/** One issue as `twg jira workitem query` prints it, or as the REST search returns it. */
export interface RawJiraIssue {
  key: string;
  summary?: string;
  parent?: { key: string; fields?: { summary?: string } };
  issuetype?: { subtask?: boolean; hierarchyLevel?: number };
  fields?: {
    summary?: string;
    parent?: { key: string; fields?: { summary?: string } };
    issuetype?: { subtask?: boolean; hierarchyLevel?: number };
  };
}

/**
 * Arguments that make every run print one JSON document on stdout, whatever
 * the environment says: `--mode user` overrides an inherited
 * `TWG_AGENT_DEFAULTS`, and `--output-summary none` turns off the YAML envelope
 * that agent mode writes instead of the payload.
 */
const JSON_OUTPUT = ["--mode", "user", "--output", "json", "--output-summary", "none"];

/** The site host twg's `--site` takes, from the configured base URL. */
export function twgSite(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** `twg jira workitem query` for the given keys. */
export function twgQueryArgs(baseUrl: string, keys: string[]): string[] {
  return [
    ...JSON_OUTPUT,
    "--site",
    twgSite(baseUrl),
    "jira",
    "workitem",
    "query",
    "--jql",
    `key in (${keys.join(",")})`,
    "--fields",
    "summary,parent,issuetype",
    "--limit",
    "100",
  ];
}

/** `twg whoami`: the account twg is signed in as. */
export function twgWhoamiArgs(): string[] {
  return [...JSON_OUTPUT, "whoami"];
}

/** Why a twg run gave no data. */
export type TwgFailure =
  | { kind: "not-installed" }
  | { kind: "auth"; message: string }
  | { kind: "error"; message: string };

interface TwgErrorDoc {
  ok?: boolean;
  error?: { code?: unknown; message?: unknown };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Classifies a run that did not produce data. twg reports its failures as a
 * JSON document `{ ok: false, error: { code, message } }`; every `AUTH_*` code
 * (`AUTH_REQUIRED`, `AUTH_PROFILE_MISSING`, …) means its sign-in is unusable.
 * Returns null for a successful run.
 */
export function classifyTwgRun(run: TwgRunResult): TwgFailure | null {
  if (run.notFound) return { kind: "not-installed" };
  const doc = parseJson(run.stdout) as TwgErrorDoc | undefined;
  const err = doc && typeof doc === "object" ? doc.error : undefined;
  if (err && typeof err === "object") {
    const code = typeof err.code === "string" ? err.code : "";
    const message = typeof err.message === "string" && err.message ? err.message : code || "twg failed";
    if (/^AUTH_/i.test(code)) return { kind: "auth", message };
    return { kind: "error", message: `twg: ${message}` };
  }
  if (run.code === 0 && doc !== undefined) return null;
  if (run.code === null) return { kind: "error", message: "twg: timed out" };
  const detail = (run.stderr || run.stdout).trim().split(/\r?\n/)[0] ?? "";
  return { kind: "error", message: `twg exited with code ${run.code}${detail ? `: ${detail.slice(0, 200)}` : ""}` };
}

/** The issues of a successful `twg jira workitem query` run; throws on an unexpected shape. */
export function parseTwgIssues(stdout: string): RawJiraIssue[] {
  const doc = parseJson(stdout) as { data?: { issues?: unknown } } | undefined;
  const issues = doc?.data?.issues;
  if (!Array.isArray(issues)) throw new Error("twg: unexpected output from jira workitem query");
  return issues.filter(
    (i): i is RawJiraIssue => typeof i === "object" && i !== null && typeof (i as RawJiraIssue).key === "string",
  );
}

/** The display name of a successful `twg whoami` run, or null when it names none. */
export function parseTwgAccount(stdout: string): string | null {
  const doc = parseJson(stdout) as { data?: { name?: unknown; email?: unknown } } | undefined;
  const name = doc?.data?.name ?? doc?.data?.email;
  return typeof name === "string" && name ? name : null;
}

/**
 * Reads summary / parent / issue type from either shape: the REST search nests
 * them under `fields`, twg lifts them onto the issue itself.
 */
export function issueFields(issue: RawJiraIssue): {
  summary?: string;
  parent?: { key: string; fields?: { summary?: string } };
  issuetype?: { subtask?: boolean; hierarchyLevel?: number };
} {
  return {
    summary: issue.fields?.summary ?? issue.summary,
    parent: issue.fields?.parent ?? issue.parent,
    issuetype: issue.fields?.issuetype ?? issue.issuetype,
  };
}
