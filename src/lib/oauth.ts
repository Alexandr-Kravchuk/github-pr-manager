/**
 * OAuth provider resolution.
 *
 * We deliberately do NOT use NextAuth: the dashboard needs one user logged into
 * *both* hosts simultaneously (github.com + a GHE tenant), with the server
 * holding both tokens at once — something NextAuth's single-provider session
 * model fights. This is a hand-rolled Authorization Code (web-redirect) flow
 * for a confidential client (the server holds `client_secret`).
 *
 * Every endpoint is derived from the host's `graphqlUrl`, so adding the GHE
 * provider later is purely a config + env-var change — no code edit.
 */

import type { HostConfig } from "./types";

/** Default scopes: `repo` for private PRs, `read:org` for `/user/teams`. */
const DEFAULT_SCOPES = ["repo", "read:org"];

export interface OAuthProvider {
  /** Provider id (matches HostConfig.oauthProvider), e.g. "github" or "ghe". */
  id: string;
  /** API origin for viewer/teams calls, e.g. https://api.github.com. */
  apiOrigin: string;
  /** Web base that serves the OAuth pages, e.g. https://github.com. */
  webBase: string;
  /** Full authorize endpoint. */
  authorizeUrl: string;
  /** Full token-exchange endpoint. */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

/**
 * Derives the OAuth *web* base (where authorize/token live) from a GraphQL URL:
 *  - https://api.github.com/graphql          -> https://github.com
 *  - https://api.<tenant>.ghe.com/graphql    -> https://<tenant>.ghe.com  (Enterprise Cloud)
 *  - https://github.company.com/api/graphql  -> https://github.company.com (Enterprise Server)
 *
 * The leading `api.` is stripped for hosts that front their API on that
 * subdomain; Enterprise Server (API under /api/graphql on the web host) keeps
 * the origin as-is. We never point at `auth.ghe.com` — that's only the IdP
 * sign-in, not the OAuth authorize/token base.
 */
export function oauthWebBaseFromUrl(graphqlUrl: string): string {
  const url = new URL(graphqlUrl);
  const host = url.hostname.startsWith("api.")
    ? url.hostname.slice("api.".length)
    : url.hostname;
  return `${url.protocol}//${host}`;
}

/** API origin (where viewer/`/user/teams` REST live) for a GraphQL URL. */
export function apiOriginFromUrl(graphqlUrl: string): string {
  return new URL(graphqlUrl).origin;
}

/** Env var prefix for a provider id: "github" -> "GITHUB", "ghe" -> "GHE". */
function envPrefix(providerId: string): string {
  return providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Resolves the full OAuth provider config for a host. Throws if the host has no
 * `oauthProvider` or its client credentials are not in the environment.
 */
export function resolveProvider(host: HostConfig): OAuthProvider {
  const id = host.oauthProvider?.trim();
  if (!id) {
    throw new Error(`Host "${host.label}" has no oauthProvider configured.`);
  }
  const prefix = envPrefix(id);
  const clientId = process.env[`${prefix}_OAUTH_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_OAUTH_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    throw new Error(
      `OAuth provider "${id}" is missing ${prefix}_OAUTH_CLIENT_ID / ${prefix}_OAUTH_CLIENT_SECRET.`,
    );
  }
  const webBase = oauthWebBaseFromUrl(host.graphqlUrl);
  const scopesEnv = process.env[`${prefix}_OAUTH_SCOPES`]?.trim();
  return {
    id,
    apiOrigin: apiOriginFromUrl(host.graphqlUrl),
    webBase,
    authorizeUrl: `${webBase}/login/oauth/authorize`,
    tokenUrl: `${webBase}/login/oauth/access_token`,
    clientId,
    clientSecret,
    scopes: scopesEnv ? scopesEnv.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES,
  };
}

/**
 * Public origin used to build OAuth callback URLs. Behind IIS/ARR the request
 * arrives as 127.0.0.1:3737, so `AUTH_URL` must pin the real external origin
 * (mirrors the value registered in the OAuth App). Falls back to the request
 * origin for local `next start`.
 */
export function publicBaseUrl(req: Request): string {
  const configured = process.env.AUTH_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(req.url).origin;
}

/** Callback URL for a provider, e.g. https://prdash.creatio/api/auth/callback/github. */
export function callbackUrl(req: Request, providerId: string): string {
  return `${publicBaseUrl(req)}/api/auth/callback/${providerId}`;
}

/**
 * Whether the deployment is served over HTTPS — drives the `Secure` cookie flag.
 * Tied to the scheme (AUTH_URL), NOT NODE_ENV: a production deployment over plain
 * http (e.g. http://host:3737 on an internal network) must NOT mark cookies
 * Secure, or the browser silently refuses to send them and login never sticks.
 */
export function isSecureDeployment(): boolean {
  return (process.env.AUTH_URL ?? "").startsWith("https://");
}
