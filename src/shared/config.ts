import { execFileSync } from "node:child_process";

import {
  AGENT_BOUNDS,
  DEFAULT_AGENT_PROMPTS,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_AGENT_SIGNATURE,
  AGENT_TOOLS_VERSION,
  DEFAULT_AGENT_TOOLS,
  isClockTime,
  migrateTools,
  PREVIOUS_DEFAULT_AGENT_PROMPTS,
  type AgentBoundKey,
} from "./agent-defaults";
import { DEFAULT_CLAUDE_PROMPTS, DEFAULT_CLAUDE_SETTINGS, PREVIOUS_DEFAULT_PROMPTS } from "./claude-launch";
import { DEFAULT_NOTIFICATION_SETTINGS } from "./notify";
import { DEFAULT_STALE_AFTER_DAYS, validateStaleAfterDays } from "./stale";
import type {
  AgentMode,
  AgentPromptKey,
  AgentRunKind,
  AgentSettings,
  ClaudeSettings,
  GhStatus,
  HostConfig,
  JiraSettings,
  NotificationSettings,
  PublicConfig,
  Settings,
  SettingsHost,
} from "./types";

/** Error with a friendly message — the UI surfaces its text. */
export class ConfigError extends Error {}

/**
 * Extracts `build.appId` from a raw `package.json` string — the identifier
 * electron-builder stamps the installer with, reused at runtime for the Windows
 * AppUserModelID so the two can't drift. Pure (no fs/Electron) so the
 * present/absent/malformed/non-string branches unit-test in plain Node; the
 * caller does the file read and passes the text in. Returns `fallback` when the
 * JSON is malformed or `build.appId` is missing or not a non-empty string.
 */
export function pickAppId(rawPackageJson: string, fallback: string): string {
  try {
    const appId = (JSON.parse(rawPackageJson) as { build?: { appId?: unknown } }).build?.appId;
    return typeof appId === "string" && appId.trim() ? appId : fallback;
  } catch {
    return fallback;
  }
}

export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
export const MIN_POLL_INTERVAL_SECONDS = 10;

/** Cache of gh-resolved tokens per hostname, to avoid spawning a process per request. */
const ghTokenCache = new Map<string, string>();

/**
 * Derives the gh CLI hostname from a GraphQL endpoint URL:
 *  - https://api.github.com/graphql        -> github.com
 *  - https://api.<tenant>.ghe.com/graphql  -> <tenant>.ghe.com  (Enterprise Cloud)
 *  - https://github.company.com/api/graphql -> github.company.com (Enterprise Server)
 */
export function ghHostnameFromUrl(graphqlUrl: string): string {
  let host: string;
  try {
    host = new URL(graphqlUrl).hostname;
  } catch {
    throw new ConfigError(`Invalid graphqlUrl: ${graphqlUrl}`);
  }
  if (host === "api.github.com") return "github.com";
  if (host.startsWith("api.")) return host.slice("api.".length);
  return host;
}

/**
 * Resolves the access token for a host via the `gh` CLI:
 * `gh auth token --hostname <host derived from graphqlUrl>`.
 *
 * Per the desktop (single-identity) model, the token is never stored — it is
 * resolved fresh from the CLI the user is already logged into. Cached per host
 * for the process lifetime.
 */
export function resolveGhToken(graphqlUrl: string): string {
  const hostname = ghHostnameFromUrl(graphqlUrl);
  const cached = ghTokenCache.get(hostname);
  if (cached) return cached;
  try {
    const token = execFileSync("gh", ["auth", "token", "--hostname", hostname], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!token) throw new Error("empty output");
    ghTokenCache.set(hostname, token);
    return token;
  } catch (e) {
    // ENOENT means the `gh` binary wasn't found at all (not on PATH / not
    // installed) — a different problem from being installed but not signed in.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new ConfigError(
        `GitHub CLI (gh) was not found. Install it from https://cli.github.com and make sure it's on your PATH, then refresh.`,
      );
    }
    throw new ConfigError(
      `Not signed in to ${hostname}. Run \`gh auth login --hostname ${hostname}\`, then refresh.`,
    );
  }
}

/** Drops any cached gh token for the host so the next resolve re-runs the CLI. */
export function clearGhTokenCache(): void {
  ghTokenCache.clear();
}

/**
 * Notification defaults: the whole feature is OFF (opt-in) so an existing user
 * updating doesn't suddenly start getting OS toasts — they turn it on in
 * Settings. Once enabled, native is on and sound is off, with all event groups on.
 */
export function defaultNotificationSettings(): NotificationSettings {
  // Single source of truth lives in shared/notify.ts (also value-imported by the
  // renderer); clone it so callers can't mutate the shared constant.
  const d = DEFAULT_NOTIFICATION_SETTINGS;
  return { ...d, events: { ...d.events } };
}

/**
 * Coerces a raw `notifications` blob into a valid {@link NotificationSettings},
 * filling any missing/garbage field from {@link defaultNotificationSettings}.
 * Never throws — a bad shape falls back rather than blocking a settings save.
 */
export function validateNotifications(raw: unknown): NotificationSettings {
  const d = defaultNotificationSettings();
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
  const ev = (typeof obj.events === "object" && obj.events !== null ? obj.events : {}) as Record<
    string,
    unknown
  >;
  return {
    enabled: bool(obj.enabled, d.enabled),
    native: bool(obj.native, d.native),
    sound: bool(obj.sound, d.sound),
    events: {
      yourTurn: bool(ev.yourTurn, d.events.yourTurn),
      ciFailed: bool(ev.ciFailed, d.events.ciFailed),
      goodNews: bool(ev.goodNews, d.events.goodNews),
    },
  };
}

/** Validates a raw settings object and throws ConfigError with a clear message. */
export function validateSettings(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("settings: expected an object.");
  }
  const obj = raw as Record<string, unknown>;

  const pollIntervalSeconds =
    typeof obj.pollIntervalSeconds === "number" && obj.pollIntervalSeconds >= MIN_POLL_INTERVAL_SECONDS
      ? obj.pollIntervalSeconds
      : DEFAULT_POLL_INTERVAL_SECONDS;

  // Launch-at-login defaults OFF (opt-in); auto-update defaults ON.
  const launchAtLogin = typeof obj.launchAtLogin === "boolean" ? obj.launchAtLogin : false;
  const autoUpdate = typeof obj.autoUpdate === "boolean" ? obj.autoUpdate : true;
  // Close-to-tray defaults ON: the app is a background watcher, and a stray
  // click on the close button shouldn't silence notifications for the day.
  const closeToTray = typeof obj.closeToTray === "boolean" ? obj.closeToTray : true;

  // Appearance defaults to following the OS; anything unrecognized falls back.
  const theme = obj.theme === "light" || obj.theme === "dark" ? obj.theme : "system";

  // Comment tracking defaults ON — it is the app's original behavior, so an
  // existing settings file (which has no such key) must keep it.
  const trackComments = typeof obj.trackComments === "boolean" ? obj.trackComments : true;

  const notifications = validateNotifications(obj.notifications);

  // An empty hosts list is valid — it's the first-run / unconfigured state, not
  // an error (the UI guides the user to add a host).
  const rawHosts = Array.isArray(obj.hosts) ? obj.hosts : [];

  const hosts: SettingsHost[] = rawHosts.map((h, i) => {
    if (typeof h !== "object" || h === null) {
      throw new ConfigError(`settings: hosts[${i}] must be an object.`);
    }
    const host = h as Record<string, unknown>;
    const label =
      typeof host.label === "string" && host.label.trim() ? host.label.trim() : `Host ${i + 1}`;
    if (typeof host.graphqlUrl !== "string" || !host.graphqlUrl.trim()) {
      throw new ConfigError(`settings: hosts[${i}] (${label}) — missing graphqlUrl.`);
    }
    // Validate the URL shape early so a typo surfaces on save, not mid-poll.
    ghHostnameFromUrl(host.graphqlUrl);
    const repos = Array.isArray(host.repos)
      ? host.repos.filter((r): r is string => typeof r === "string" && r.includes("/"))
      : [];
    return {
      label,
      graphqlUrl: host.graphqlUrl.trim(),
      repos,
      allRepos: host.allRepos === true,
      searchLimit: validateSearchLimit(host.searchLimit),
    };
  });

  return {
    pollIntervalSeconds,
    launchAtLogin,
    autoUpdate,
    closeToTray,
    theme,
    trackComments,
    notifications,
    hosts,
    jira: validateJira(obj.jira),
    claude: validateClaude(obj.claude),
    agent: validateAgent(obj.agent),
    staleAfterDays: validateStaleAfterDays(obj.staleAfterDays),
    // A city name is free text; only its length is bounded, since it goes
    // into a URL query and into the header's tooltip.
    weatherCity: typeof obj.weatherCity === "string" ? obj.weatherCity.trim().slice(0, 100) : "",
  };
}

/** A host's per-search page size when none is set — the size the app always used. */
export const DEFAULT_SEARCH_LIMIT = 25;
/** GitHub's own ceiling for `first:` on a connection. */
export const MAX_SEARCH_LIMIT = 100;

/**
 * Coerces a host's `searchLimit` into a whole number within 1–100. Missing or
 * garbage falls back to the default rather than failing the save, and an
 * out-of-range number is clamped, since GitHub rejects `first:` above 100.
 */
export function validateSearchLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.round(n)));
}

/**
 * Coerces the Claude launcher block, filling anything missing from the
 * defaults. Never throws — like notifications, a bad shape falls back (to OFF)
 * rather than blocking a settings save or making the app look unconfigured.
 */
export function validateClaude(raw: unknown): ClaudeSettings {
  const d = DEFAULT_CLAUDE_SETTINGS;
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const repoPaths: Record<string, string> = {};
  if (typeof obj.repoPaths === "object" && obj.repoPaths !== null) {
    for (const [repo, dir] of Object.entries(obj.repoPaths as Record<string, unknown>)) {
      if (repo.includes("/") && str(dir)) repoPaths[repo] = str(dir);
    }
  }
  const rawPrompts = (typeof obj.prompts === "object" && obj.prompts !== null ? obj.prompts : {}) as Record<
    string,
    unknown
  >;
  // An empty prompt, or a saved copy of a default it has since replaced, is the
  // current default: a copy saved verbatim would otherwise hide every later
  // change to that default from the user.
  const prompt = (k: keyof typeof DEFAULT_CLAUDE_PROMPTS): string => {
    const saved = str(rawPrompts[k]);
    return !saved || PREVIOUS_DEFAULT_PROMPTS[k]?.includes(saved) ? DEFAULT_CLAUDE_PROMPTS[k] : saved;
  };
  const rawAgentPrompts = (
    typeof obj.agentPrompts === "object" && obj.agentPrompts !== null ? obj.agentPrompts : {}
  ) as Record<string, unknown>;
  // The same rule for the agent's prompts: stored empty while default, an old default read as today's.
  const agentPrompt = (k: AgentPromptKey): string => {
    const saved = str(rawAgentPrompts[k]);
    return !saved || PREVIOUS_DEFAULT_AGENT_PROMPTS[k]?.includes(saved) ? DEFAULT_AGENT_PROMPTS[k] : saved;
  };
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : d.enabled,
    projectsRoot: str(obj.projectsRoot),
    repoPaths,
    prompts: {
      drive: prompt("drive"),
      review: prompt("review"),
      close: prompt("close"),
      explain: prompt("explain"),
      open: prompt("open"),
      explainGroup: prompt("explainGroup"),
      reviewGroup: prompt("reviewGroup"),
    },
    agentPrompts: {
      triage: agentPrompt("triage"),
      rereview: agentPrompt("rereview"),
      afterMerge: agentPrompt("afterMerge"),
      selfReview: agentPrompt("selfReview"),
      validateComments: agentPrompt("validateComments"),
    },
    terminal:
      obj.terminal === "iterm" || obj.terminal === "terminal" || obj.terminal === "desktop"
        ? obj.terminal
        : d.terminal,
  };
}

const AGENT_RUN_KINDS: readonly AgentRunKind[] = ["review", "brief", "rereview", "drive", "afterMerge"];

/**
 * Coerces the PR agent block, filling anything missing from the defaults and
 * clamping every number into `AGENT_BOUNDS`. Never throws — like the Claude
 * block, a bad shape falls back (to OFF) rather than blocking a save or making
 * the app look unconfigured, and a settings file from before the agent existed
 * simply reads as the defaults.
 */
export function validateAgent(raw: unknown): AgentSettings {
  const d = DEFAULT_AGENT_SETTINGS;
  const o = (v: unknown): Record<string, unknown> =>
    (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown, key: AgentBoundKey, fallback: number): number => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    if (!Number.isFinite(n)) return fallback;
    const { min, max } = AGENT_BOUNDS[key];
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;
  const MODES: readonly AgentMode[] = ["off", "shadow", "on"];
  const clock = (v: unknown, fallback: string): string => (typeof v === "string" && isClockTime(v) ? v : fallback);
  const list = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : null;

  const obj = o(raw);
  const sc = o(obj.scenarios);
  const review = o(sc.review);
  const brief = o(sc.brief);
  const rereview = o(sc.rereview);
  const merge = o(sc.merge);
  const selfReview = o(sc.selfReview);
  const driveCi = o(sc.driveCi);
  const driveComments = o(sc.driveComments);
  const reapprove = o(sc.reapprove);
  const limits = o(obj.limits);
  const quiet = o(limits.quietHours);
  const permissions = o(obj.permissions);
  const rawTools = o(permissions.tools);
  const companion = o(obj.companion);
  const notifications = o(obj.notifications);
  const policy = o(obj.policy);
  const diagrams = o(obj.diagrams);

  // A list saved before a newer default rule existed gets that rule; one saved without a version is from before versions (1).
  const savedVersion = typeof permissions.toolsVersion === "number" && Number.isInteger(permissions.toolsVersion) ? permissions.toolsVersion : 1;
  const tools = {} as Record<AgentRunKind, string[]>;
  for (const kind of AGENT_RUN_KINDS) {
    const saved = list(rawTools[kind]);
    tools[kind] = saved ? migrateTools(kind, saved, savedVersion) : [...DEFAULT_AGENT_TOOLS[kind]];
  }

  return {
    enabled: bool(obj.enabled, d.enabled),
    model: str(obj.model),
    effort: oneOf(obj.effort, ["", "low", "medium", "high"] as const, d.effort),
    worktreeDir: str(obj.worktreeDir),
    removeWorktree: bool(obj.removeWorktree, d.removeWorktree),
    cloneMissing: bool(obj.cloneMissing, d.cloneMissing),
    repos: (list(obj.repos) ?? []).filter((r) => /^[^/\s]+\/[^/\s]+$/.test(r)),
    scenarios: {
      review: {
        mode: oneOf(review.mode, MODES, d.scenarios.review.mode),
        maxLines: num(review.maxLines, "maxLines", d.scenarios.review.maxLines),
        maxFiles: num(review.maxFiles, "maxFiles", d.scenarios.review.maxFiles),
        teamRequests: bool(review.teamRequests, d.scenarios.review.teamRequests),
        drafts: bool(review.drafts, d.scenarios.review.drafts),
        holdApproveOnChangeRequest: bool(review.holdApproveOnChangeRequest, d.scenarios.review.holdApproveOnChangeRequest),
      },
      brief: { mode: oneOf(brief.mode, ["off", "on"] as const, d.scenarios.brief.mode) },
      rereview: {
        mode: oneOf(rereview.mode, MODES, d.scenarios.rereview.mode),
        resolve: bool(rereview.resolve, d.scenarios.rereview.resolve),
        approve: bool(rereview.approve, d.scenarios.rereview.approve),
      },
      merge: {
        mode: oneOf(merge.mode, ["off", "offer"] as const, d.scenarios.merge.mode),
        requireAllReviewers: bool(merge.requireAllReviewers, d.scenarios.merge.requireAllReviewers),
        requireThreadsResolved: bool(merge.requireThreadsResolved, d.scenarios.merge.requireThreadsResolved),
        requireChecksGreen: bool(merge.requireChecksGreen, d.scenarios.merge.requireChecksGreen),
        method: oneOf(merge.method, ["github", "merge", "squash", "rebase"] as const, d.scenarios.merge.method),
        deleteBranch: bool(merge.deleteBranch, d.scenarios.merge.deleteBranch),
      },
      selfReview: { mode: oneOf(selfReview.mode, MODES, d.scenarios.selfReview.mode) },
      driveCi: {
        mode: oneOf(driveCi.mode, MODES, d.scenarios.driveCi.mode),
        maxAttempts: num(driveCi.maxAttempts, "maxAttempts", d.scenarios.driveCi.maxAttempts),
      },
      driveComments: { mode: oneOf(driveComments.mode, MODES, d.scenarios.driveComments.mode) },
      reapprove: {
        mode: oneOf(reapprove.mode, MODES, d.scenarios.reapprove.mode),
        askReviewers: bool(reapprove.askReviewers, d.scenarios.reapprove.askReviewers),
      },
    },
    limits: {
      parallel: num(limits.parallel, "parallel", d.limits.parallel),
      perDay: num(limits.perDay, "perDay", d.limits.perDay),
      maxMinutes: num(limits.maxMinutes, "maxMinutes", d.limits.maxMinutes),
      quietHours: {
        enabled: bool(quiet.enabled, d.limits.quietHours.enabled),
        from: clock(quiet.from, d.limits.quietHours.from),
        to: clock(quiet.to, d.limits.quietHours.to),
      },
      promoteAfter: num(limits.promoteAfter, "promoteAfter", d.limits.promoteAfter),
    },
    permissions: { tools, toolsVersion: AGENT_TOOLS_VERSION, pushOwnBranch: bool(permissions.pushOwnBranch, d.permissions.pushOwnBranch) },
    diagrams: {
      enabled: bool(diagrams.enabled, d.diagrams.enabled),
      minLines: num(diagrams.minLines, "diagramMinLines", d.diagrams.minLines),
      post: bool(diagrams.post, d.diagrams.post),
      // Absent: the default model; saved empty: Claude Code's default. A name only — it goes on a command line.
      model:
        typeof diagrams.model === "string" && (diagrams.model.trim() === "" || /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/.test(diagrams.model.trim()))
          ? diagrams.model.trim()
          : d.diagrams.model,
    },
    companion: {
      headerChip: bool(companion.headerChip, d.companion.headerChip),
      trayState: bool(companion.trayState, d.companion.trayState),
    },
    notifications: {
      needsYou: bool(notifications.needsYou, d.notifications.needsYou),
      failed: bool(notifications.failed, d.notifications.failed),
      finished: bool(notifications.finished, d.notifications.finished),
    },
    policy: {
      // Rewording is allowed; an empty signature is not — it falls back.
      signature: str(policy.signature) || DEFAULT_AGENT_SIGNATURE,
      logRetentionDays: num(policy.logRetentionDays, "logRetentionDays", d.policy.logRetentionDays),
    },
  };
}

/**
 * Validates the optional Jira connection. Returns undefined when absent or
 * without a site — that just means Jira grouping stays off, not a hard error.
 * The email is optional: only the API-token fallback needs it, `twg` signs in on
 * its own. The baseUrl is normalized to an origin.
 */
function validateJira(raw: unknown): JiraSettings | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const email = typeof obj.email === "string" ? obj.email.trim() : "";
  const rawUrl = typeof obj.baseUrl === "string" ? obj.baseUrl.trim() : "";
  if (!rawUrl) return undefined;
  const baseUrl = normalizeJiraBaseUrl(rawUrl);
  if (!baseUrl) throw new ConfigError(`settings: jira.baseUrl is not a valid URL: ${rawUrl}`);
  return email ? { baseUrl, email } : { baseUrl };
}

/**
 * What `persistSettings` writes: the settings with every Claude prompt and
 * every agent prompt that is still its default stored empty. An empty prompt
 * reads back as the default, so a later release that changes a default reaches
 * every user who never edited it — a verbatim copy would keep the old text in
 * force.
 */
export function toStoredSettings(settings: Settings): Settings {
  const prompts = { ...settings.claude.prompts };
  for (const k of Object.keys(prompts) as (keyof typeof prompts)[]) {
    if (prompts[k] === DEFAULT_CLAUDE_PROMPTS[k]) prompts[k] = "";
  }
  const agentPrompts = { ...settings.claude.agentPrompts };
  for (const k of Object.keys(agentPrompts) as AgentPromptKey[]) {
    if (agentPrompts[k] === DEFAULT_AGENT_PROMPTS[k]) agentPrompts[k] = "";
  }
  return { ...settings, claude: { ...settings.claude, prompts, agentPrompts } };
}

/**
 * Normalizes a Jira site to its origin (https://host), tolerating input with no
 * scheme ("org.atlassian.net") or a trailing path. Returns null if unparseable.
 */
export function normalizeJiraBaseUrl(input: string): string | null {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

/** A fresh, empty settings object (first run). */
export function defaultSettings(): Settings {
  return {
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
    launchAtLogin: false,
    autoUpdate: true,
    closeToTray: true,
    theme: "system",
    trackComments: true,
    notifications: defaultNotificationSettings(),
    hosts: [],
    claude: validateClaude(undefined),
    agent: validateAgent(undefined),
    staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
    weatherCity: "",
  };
}

/**
 * Resolves settings hosts into fetch-ready {@link HostConfig}s by pulling each
 * host's token from the `gh` CLI. Throws ConfigError if a host is not
 * authenticated, so the poller can surface a friendly message.
 */
export function toHostConfigs(settings: Settings): HostConfig[] {
  return settings.hosts.map((h) => ({
    label: h.label,
    graphqlUrl: h.graphqlUrl,
    repos: h.repos,
    allRepos: h.allRepos === true,
    searchLimit: validateSearchLimit(h.searchLimit),
    token: resolveGhToken(h.graphqlUrl),
  }));
}

/** Builds the sanitized (token-free) config for the renderer's filter bar. */
export function toPublicConfig(settings: Settings): PublicConfig {
  return {
    pollIntervalSeconds: settings.pollIntervalSeconds,
    hosts: settings.hosts.map((h) => ({ label: h.label, repos: h.repos })),
    trackComments: settings.trackComments,
    claudeEnabled: settings.claude.enabled,
    claudeDesktop: settings.claude.terminal === "desktop",
  };
}

/** Whether the `gh` CLI is installed and on PATH. */
function isGhInstalled(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reports `gh` CLI availability and, for each configured host, whether the user
 * is authenticated — so the settings UI can guide them to `gh auth login`.
 */
export function getGhStatus(settings: Settings): GhStatus {
  const installed = isGhInstalled();
  const seen = new Set<string>();
  const hosts: GhStatus["hosts"] = [];

  for (const host of settings.hosts) {
    let hostname: string;
    try {
      hostname = ghHostnameFromUrl(host.graphqlUrl);
    } catch {
      continue;
    }
    if (seen.has(hostname)) continue;
    seen.add(hostname);

    let authenticated = false;
    if (installed) {
      try {
        const token = execFileSync("gh", ["auth", "token", "--hostname", hostname], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        authenticated = Boolean(token);
      } catch {
        authenticated = false;
      }
    }
    hosts.push({ hostname, label: host.label, authenticated });
  }

  return { installed, hosts };
}
