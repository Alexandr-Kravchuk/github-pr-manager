import { execFileSync } from "node:child_process";

import type { GhStatus, HostConfig, PublicConfig, Settings, SettingsHost } from "./types";

/** Error with a friendly message — the UI surfaces its text. */
export class ConfigError extends Error {}

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
  } catch {
    throw new ConfigError(
      `Not signed in to ${hostname}. Run \`gh auth login --hostname ${hostname}\` (install the GitHub CLI from https://cli.github.com if needed), then refresh.`,
    );
  }
}

/** Drops any cached gh token for the host so the next resolve re-runs the CLI. */
export function clearGhTokenCache(): void {
  ghTokenCache.clear();
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
    return { label, graphqlUrl: host.graphqlUrl.trim(), repos };
  });

  return { pollIntervalSeconds, hosts };
}

/** A fresh, empty settings object (first run). */
export function defaultSettings(): Settings {
  return { pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS, hosts: [] };
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
    token: resolveGhToken(h.graphqlUrl),
  }));
}

/** Builds the sanitized (token-free) config for the renderer's filter bar. */
export function toPublicConfig(settings: Settings): PublicConfig {
  return {
    pollIntervalSeconds: settings.pollIntervalSeconds,
    hosts: settings.hosts.map((h) => ({ label: h.label, repos: h.repos })),
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
