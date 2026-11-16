// OAuth 2.1 for remote MCP servers, per the MCP authorization spec: protected-resource metadata
// (RFC 9728) → authorization-server metadata (RFC 8414 / OIDC discovery) → dynamic client
// registration (RFC 7591) when supported → authorization code + PKCE (S256) with the RFC 8707
// resource parameter → token refresh → best-effort revocation (RFC 7009). The SDK helpers do the
// protocol; every request goes through safeFetch, so metadata, token and registration endpoints
// pass the SSRF guard too. Tokens only travel between this server and the authorization server.
// Server-only.
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { env } from "../env";
import { oneLine, UserMcpError } from "./errors";
import { checkServerUrl, safeFetch } from "./net";

export type McpTokenSet = { accessToken: string; refreshToken: string | null; expiresAt: number | null };

/** Non-token OAuth state kept (sealed) with the server. */
export type McpOAuthConfig = {
  authServerUrl: string;
  metadata: AuthorizationServerMetadata | null;
  client: OAuthClientInformationMixed;
  /** RFC 8707 resource indicator (the MCP server's canonical URL). */
  resource: string;
  scope: string | null;
  /** True when we registered the client ourselves (dynamic registration). */
  registered: boolean;
};

/** The transaction kept in the sealed, short-lived cookie between /oauth/start and /oauth/callback. */
export type McpOAuthTx = { serverId: string; state: string; verifier: string; sub: string; exp: number };

export const MCP_OAUTH_COOKIE = "zw_mcp_oauth";
export const MCP_OAUTH_COOKIE_PATH = "/api/user-mcp/oauth";
export const MCP_OAUTH_TX_MAX_AGE = 10 * 60;

export const mcpOAuthCallbackUrl = () => `${env.appUrl}/api/user-mcp/oauth/callback`;

/** The grant is gone (or the client was refused): the person must authorize again. */
export class McpReauthNeeded extends Error {}

/** RFC 7009 endpoint (the SDK's metadata type doesn't list it for every variant). */
const revocationEndpoint = (m: AuthorizationServerMetadata | null) => {
  const v = (m as { revocation_endpoint?: unknown } | null)?.revocation_endpoint;
  return typeof v === "string" && v ? v : undefined;
};

const REAUTH = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "invalid_token"]);

function protocolError(stage: string, e: unknown): UserMcpError {
  if (e instanceof UserMcpError) return e;
  if (e instanceof OAuthError) return new UserMcpError("auth_required", `${stage} failed (${oneLine(e.errorCode, 60)})`);
  return new UserMcpError("upstream_error", `${stage} failed${e instanceof Error ? `: ${oneLine(e.message, 160)}` : ""}`);
}

function toTokenSet(t: OAuthTokens, previous?: McpTokenSet): McpTokenSet {
  if (!t.access_token) throw new UserMcpError("auth_required", "the authorization server returned no access token");
  const expiresIn = Number(t.expires_in);
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || previous?.refreshToken || null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
  };
}

/** Canonical resource URL of an MCP server (no fragment; the spec's RFC 8707 resource value). */
function canonicalResource(serverUrl: URL): string {
  const u = new URL(serverUrl.toString());
  u.hash = "";
  return u.toString();
}

/**
 * Discovers the authorization server for an MCP server and gets a client for it: the one the user
 * supplied, or a dynamically registered one. Returns the config to store with the server.
 */
export async function prepareOAuth(serverUrl: string, manual: { clientId?: string; clientSecret?: string; scope?: string }): Promise<McpOAuthConfig> {
  const url = checkServerUrl(serverUrl);
  let info;
  try {
    info = await discoverOAuthServerInfo(url, { fetchFn: safeFetch });
  } catch (e) {
    throw protocolError("OAuth discovery", e);
  }
  const authServerUrl = checkServerUrl(info.authorizationServerUrl).toString();
  const metadata = info.authorizationServerMetadata ?? null;
  if (metadata) {
    for (const ep of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint, revocationEndpoint(metadata)]) {
      if (ep) checkServerUrl(ep);
    }
    const methods = metadata.code_challenge_methods_supported;
    if (methods && !methods.includes("S256")) throw new UserMcpError("auth_required", "the authorization server does not support PKCE (S256)");
  }
  const resource = info.resourceMetadata?.resource ? canonicalResource(new URL(info.resourceMetadata.resource)) : canonicalResource(url);
  const scope = manual.scope?.trim() || info.resourceMetadata?.scopes_supported?.join(" ") || null;

  if (manual.clientId) {
    return {
      authServerUrl,
      metadata,
      client: { client_id: manual.clientId, ...(manual.clientSecret ? { client_secret: manual.clientSecret } : {}) },
      resource,
      scope,
      registered: false,
    };
  }
  if (metadata && !metadata.registration_endpoint) {
    throw new UserMcpError("auth_required", "this server does not support dynamic client registration; enter a client ID");
  }
  try {
    const client = await registerClient(authServerUrl, {
      metadata: metadata ?? undefined,
      clientMetadata: {
        client_name: "Zentico Workspace",
        redirect_uris: [mcpOAuthCallbackUrl()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_uri: env.appUrl,
      },
      scope: scope ?? undefined,
      fetchFn: safeFetch,
    });
    return { authServerUrl, metadata, client, resource, scope, registered: true };
  } catch (e) {
    throw protocolError("client registration", e);
  }
}

/** Authorization URL (PKCE S256 + state + resource) for the browser, plus the verifier to keep. */
export async function authorizeUrl(cfg: McpOAuthConfig, state: string): Promise<{ url: string; verifier: string }> {
  try {
    const { authorizationUrl, codeVerifier } = await startAuthorization(cfg.authServerUrl, {
      metadata: cfg.metadata ?? undefined,
      clientInformation: cfg.client,
      redirectUrl: mcpOAuthCallbackUrl(),
      scope: cfg.scope ?? undefined,
      state,
      resource: cfg.resource,
    });
    if (authorizationUrl.protocol !== "https:") throw new UserMcpError("unsafe_url", "the authorization endpoint must use https");
    return { url: authorizationUrl.toString(), verifier: codeVerifier };
  } catch (e) {
    throw protocolError("authorization", e);
  }
}

export async function exchangeCode(cfg: McpOAuthConfig, code: string, verifier: string): Promise<McpTokenSet> {
  try {
    const t = await exchangeAuthorization(cfg.authServerUrl, {
      metadata: cfg.metadata ?? undefined,
      clientInformation: cfg.client,
      authorizationCode: code,
      codeVerifier: verifier,
      redirectUri: mcpOAuthCallbackUrl(),
      resource: cfg.resource,
      fetchFn: safeFetch,
    });
    return toTokenSet(t);
  } catch (e) {
    throw protocolError("code exchange", e);
  }
}

/** Exchanges the refresh token. Throws McpReauthNeeded when the grant is gone. */
export async function refreshTokens(cfg: McpOAuthConfig, previous: McpTokenSet): Promise<McpTokenSet> {
  if (!previous.refreshToken) throw new McpReauthNeeded("no refresh token");
  try {
    const t = await refreshAuthorization(cfg.authServerUrl, {
      metadata: cfg.metadata ?? undefined,
      clientInformation: cfg.client,
      refreshToken: previous.refreshToken,
      resource: cfg.resource,
      fetchFn: safeFetch,
    });
    return toTokenSet(t, previous);
  } catch (e) {
    if (e instanceof OAuthError && REAUTH.has(e.errorCode)) throw new McpReauthNeeded(e.errorCode);
    throw protocolError("token refresh", e);
  }
}

/** Best effort RFC 7009 revocation of the refresh and access tokens. Never throws. */
export async function revokeTokens(cfg: McpOAuthConfig, tokens: McpTokenSet): Promise<boolean> {
  const endpoint = revocationEndpoint(cfg.metadata);
  if (!endpoint) return false;
  let ok = false;
  for (const [token, hint] of [
    [tokens.refreshToken, "refresh_token"],
    [tokens.accessToken, "access_token"],
  ] as const) {
    if (!token) continue;
    try {
      const params = new URLSearchParams({ token, token_type_hint: hint, client_id: cfg.client.client_id });
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
      const secret = "client_secret" in cfg.client ? cfg.client.client_secret : undefined;
      if (secret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.client.client_id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
      const res = await safeFetch(endpoint, { method: "POST", headers, body: params, signal: AbortSignal.timeout(10_000) });
      void res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) ok = true;
    } catch {
      // best effort
    }
  }
  return ok;
}
