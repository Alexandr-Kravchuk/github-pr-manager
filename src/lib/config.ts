import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { AppConfig, HostConfig, PublicConfig } from "./types";

const CONFIG_PATH = path.join(process.cwd(), "config.json");

/** Error with a friendly message — the API surfaces its text in the UI. */
export class ConfigError extends Error {}

/** Cache of gh-resolved tokens per hostname, to avoid spawning a process per request. */
const ghTokenCache = new Map<string, string>();

/**
 * Derives the gh CLI hostname from a GraphQL endpoint URL:
 *  - https://api.github.com/graphql        -> github.com
 *  - https://api.<tenant>.ghe.com/graphql  -> <tenant>.ghe.com  (Enterprise Cloud)
 *  - https://github.company.com/api/graphql -> github.company.com (Enterprise Server)
 */
function ghHostnameFromUrl(graphqlUrl: string): string {
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
 * Resolves a config token value into an actual token.
 * Supported forms:
 *  - literal:      "ghp_xxx"
 *  - env variable: "env:GITHUB_TOKEN"
 *  - gh CLI:       "gh"  (uses `gh auth token --hostname <host>` for this host)
 */
function resolveToken(host: HostConfig): string {
  const value = host.token?.trim();
  if (!value) {
    throw new ConfigError(`Host "${host.label}": token is not set.`);
  }

  if (value === "gh") {
    const hostname = ghHostnameFromUrl(host.graphqlUrl);
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
        `Host "${host.label}": token "gh" is set, but \`gh auth token --hostname ${hostname}\` failed. Run \`gh auth login --hostname ${hostname}\` or set the token explicitly.`,
      );
    }
  }

  if (value.startsWith("env:")) {
    const envName = value.slice("env:".length);
    const token = process.env[envName];
    if (!token) {
      throw new ConfigError(
        `Host "${host.label}": expected env variable ${envName}, but it is empty.`,
      );
    }
    return token;
  }

  return value;
}

/** Validates the raw config object and throws ConfigError with a clear message. */
function validate(raw: unknown): AppConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("config.json: expected an object.");
  }
  const obj = raw as Record<string, unknown>;

  const pollIntervalSeconds =
    typeof obj.pollIntervalSeconds === "number" && obj.pollIntervalSeconds >= 10
      ? obj.pollIntervalSeconds
      : 60;

  if (!Array.isArray(obj.hosts) || obj.hosts.length === 0) {
    throw new ConfigError("config.json: the hosts array is empty or missing.");
  }

  const hosts: HostConfig[] = obj.hosts.map((h, i) => {
    if (typeof h !== "object" || h === null) {
      throw new ConfigError(`config.json: hosts[${i}] must be an object.`);
    }
    const host = h as Record<string, unknown>;
    const label =
      typeof host.label === "string" && host.label.trim()
        ? host.label.trim()
        : `Host ${i + 1}`;
    if (typeof host.graphqlUrl !== "string" || !host.graphqlUrl.trim()) {
      throw new ConfigError(`config.json: hosts[${i}] (${label}) — missing graphqlUrl.`);
    }
    if (typeof host.token !== "string") {
      throw new ConfigError(`config.json: hosts[${i}] (${label}) — missing token.`);
    }
    const repos = Array.isArray(host.repos)
      ? host.repos.filter((r): r is string => typeof r === "string" && r.includes("/"))
      : [];
    return {
      label,
      graphqlUrl: host.graphqlUrl.trim(),
      token: host.token,
      repos,
    };
  });

  return { pollIntervalSeconds, hosts };
}

/** Reads and validates config.json WITHOUT resolving tokens (token stays a raw string). */
function readAndValidate(): AppConfig {
  let text: string;
  try {
    text = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    throw new ConfigError(
      "config.json not found. Copy config.example.json to config.json and fill in your hosts, repositories and tokens.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`config.json: JSON parse error — ${(e as Error).message}`);
  }

  return validate(parsed);
}

/**
 * Loads the config and resolves tokens (for talking to GitHub).
 * Throws ConfigError if the file is missing, invalid, or a token cannot be resolved.
 */
export function loadConfig(): AppConfig {
  const config = readAndValidate();
  // Resolve tokens eagerly so misconfiguration surfaces immediately.
  for (const host of config.hosts) {
    host.token = resolveToken(host);
  }
  return config;
}

/** Loads a sanitized config for the client — without reading or resolving tokens. */
export function loadPublicConfig(): PublicConfig {
  return toPublicConfig(readAndValidate());
}

/** Builds a sanitized (token-free) version of the config for the client. */
export function toPublicConfig(config: AppConfig): PublicConfig {
  return {
    pollIntervalSeconds: config.pollIntervalSeconds,
    hosts: config.hosts.map((h) => ({ label: h.label, repos: h.repos })),
  };
}
