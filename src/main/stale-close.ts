/**
 * Closing a stale PR of yours and applying the chosen action to its Jira task.
 *
 * The renderer sends only the PR id and its choices: which PR, on which host,
 * with which issue key all come from main's own snapshot, and the guard that it
 * is stale and yours (`canCloseStale`) is re-checked here rather than trusted.
 * Every outside call is injected, so the step order and the partial-failure
 * reporting are unit-tested without the network.
 */
import { canCloseStale, type CloseStaleOptions, type CloseStaleResult, type JiraTaskInfo } from "../shared/stale";
import type { JiraSettings, PullRequest, Settings } from "../shared/types";

/** Jira settings with the account email the API token's Basic auth needs. */
type JiraTokenConfig = JiraSettings & { email: string };

export interface StaleCloseDeps {
  loadSettings: () => Settings;
  /** The token `gh` holds for a GraphQL endpoint. */
  resolveGhToken: (graphqlUrl: string) => string;
  getJiraToken: () => string | null;
  closePullRequest: (
    host: { label: string; graphqlUrl: string; token: string },
    prId: string,
    comment: string,
  ) => Promise<void>;
  fetchTaskInfo: (config: JiraTokenConfig, token: string, key: string) => Promise<JiraTaskInfo>;
  transitionTask: (
    config: JiraTokenConfig,
    token: string,
    key: string,
    transitionId: string,
    resolutionId: string | null,
  ) => Promise<void>;
  deleteTask: (config: JiraTokenConfig, token: string, key: string, deleteSubtasks: boolean) => Promise<void>;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The Jira connection and token, or why there is none. */
function jiraAccess(
  deps: StaleCloseDeps,
): { config: JiraTokenConfig; token: string } | { error: string } {
  let config: JiraSettings | undefined;
  try {
    config = deps.loadSettings().jira;
  } catch (e) {
    return { error: message(e) };
  }
  if (!config) return { error: "Jira isn't set up — add the site and email in Settings → Integrations." };
  const email = config.email;
  if (!email) return { error: "No Jira account email is set — add it in Settings → Integrations." };
  const token = deps.getJiraToken();
  if (!token) return { error: "No Jira API token is stored — add one in Settings → Integrations." };
  return { config: { ...config, email }, token };
}

/** The close dialog's view of the PR's task. */
export async function staleJiraTask(
  pr: PullRequest | undefined,
  deps: StaleCloseDeps,
): Promise<{ ok: true; task: JiraTaskInfo } | { ok: false; error: string }> {
  if (!pr) return { ok: false, error: "This PR is no longer on the dashboard." };
  if (!pr.issueKey) return { ok: false, error: "No Jira key in this PR's title or branch." };
  const access = jiraAccess(deps);
  if ("error" in access) return { ok: false, error: access.error };
  try {
    return { ok: true, task: await deps.fetchTaskInfo(access.config, access.token, pr.issueKey) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/**
 * Closes the PR, then applies the Jira action. In that order on purpose: the
 * PR is what the user came to close, and a task moved back to To Do while its
 * PR then failed to close would describe work that is still open as abandoned.
 * A Jira failure after a closed PR is reported as such, so the dialog can say
 * the PR is gone and only the task is left to handle.
 */
export async function closeStale(
  pr: PullRequest | undefined,
  options: CloseStaleOptions,
  deps: StaleCloseDeps,
): Promise<CloseStaleResult> {
  const fail = (error: string): CloseStaleResult => ({ ok: false, prClosed: false, jira: null, error });
  if (!pr) return fail("This PR is no longer on the dashboard.");
  if (!canCloseStale(pr)) return fail("Only your own PRs that have been open past the stale threshold can be closed here.");

  // Jira access is checked before anything changes, so a missing token cannot
  // leave the PR closed with the chosen task action silently undone.
  let access: { config: JiraTokenConfig; token: string } | null = null;
  if (options.jira.action !== "keep") {
    if (!pr.issueKey) return fail("No Jira key in this PR's title or branch.");
    const a = jiraAccess(deps);
    if ("error" in a) return fail(a.error);
    access = a;
  }

  let host: { label: string; graphqlUrl: string; token: string };
  try {
    const h = deps.loadSettings().hosts.find((x) => x.label === pr.hostLabel);
    if (!h) return fail(`The host "${pr.hostLabel}" is no longer in Settings.`);
    host = { label: h.label, graphqlUrl: h.graphqlUrl, token: deps.resolveGhToken(h.graphqlUrl) };
  } catch (e) {
    return fail(message(e));
  }

  try {
    await deps.closePullRequest(host, pr.id, options.comment);
  } catch (e) {
    return fail(`Couldn't close the PR: ${message(e)}`);
  }

  if (!access || !pr.issueKey) return { ok: true, prClosed: true, jira: null };
  const key = pr.issueKey;
  const jira = options.jira;
  try {
    if (jira.action === "delete") {
      await deps.deleteTask(access.config, access.token, key, jira.deleteSubtasks);
      return { ok: true, prClosed: true, jira: { ok: true, message: `${key} deleted.` } };
    }
    if (jira.action === "todo" || jira.action === "wontDo") {
      await deps.transitionTask(access.config, access.token, key, jira.transitionId, jira.resolutionId);
      const what = jira.action === "todo" ? "moved back to To Do" : "closed as Won't Do";
      return { ok: true, prClosed: true, jira: { ok: true, message: `${key} ${what}.` } };
    }
  } catch (e) {
    const error = `The PR was closed, but ${key} was not changed: ${message(e)}`;
    return { ok: false, prClosed: true, jira: { ok: false, message: error }, error };
  }
  return { ok: true, prClosed: true, jira: null };
}
