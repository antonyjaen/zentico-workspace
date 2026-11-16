// OAuth 2.0 protocol for connected apps: authorize URL (state + PKCE), code exchange, refresh,
// account info and revocation, with the per-provider quirks (GitHub errors in 200 responses,
// Slack user tokens under authed_user, Notion basic auth + JSON, Atlassian cloud sites).
// Tokens only travel between this server and the provider. Server-only.
import { base64url, randomToken } from "../crypto";
import { arr, obj, parseJson, ProviderError, providerFetch, str } from "./http";
import { callbackUrl, clientConfig, provider, type ClientConfig, type ProviderId } from "./providers";

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null = doesn't expire (or unknown). */
  expiresAt: number | null;
};

export type Account = {
  id: string;
  name: string;
  login: string;
  avatarUrl: string | null;
  /** Non-secret provider data kept with the connection. */
  meta: Record<string, string>;
};

/** The provider refused the refresh token / grant: the person must connect again. */
export class ReauthNeeded extends Error {}

/* --------------------------------------------------------------- authorize */

/** The transaction kept in the sealed, short-lived connect cookie. */
export type ConnectTx = { provider: ProviderId; state: string; verifier: string | null; sub: string; exp: number };

export const CONNECT_COOKIE = "zw_connect";
export const CONNECT_TX_MAX_AGE = 10 * 60;

export async function buildAuthorize(id: ProviderId, sub: string): Promise<{ url: string; tx: ConnectTx }> {
  const p = provider(id);
  const cfg = clientConfig(id);
  if (!cfg) throw new ProviderError("notConfigured", `${p.name} is not configured`);
  const state = randomToken(24);
  const verifier = p.pkce ? randomToken(48) : null;
  const url = new URL(p.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(id));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (p.scopes.length) url.searchParams.set(p.scopeParam, p.scopes.join(p.scopeSeparator));
  for (const [k, v] of Object.entries(p.extraAuthorize ?? {})) url.searchParams.set(k, v);
  if (verifier) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    url.searchParams.set("code_challenge", base64url(digest));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return { url: url.toString(), tx: { provider: id, state, verifier, sub, exp: Date.now() + CONNECT_TX_MAX_AGE * 1000 } };
}

/* ----------------------------------------------------------- token endpoint */

async function tokenRequest(id: ProviderId, cfg: ClientConfig, params: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const p = provider(id);
  const headers: Record<string, string> = { Accept: "application/json" };
  const fields: Record<string, string> = { ...params };
  if (p.tokenAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
  } else {
    fields.client_id = cfg.clientId;
    fields.client_secret = cfg.clientSecret;
  }
  let body: string;
  if (p.tokenFormat === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(fields);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(fields).toString();
  }
  const res = await providerFetch(p.tokenUrl, { method: "POST", headers, body, hosts: p.hosts.concat(new URL(p.tokenUrl).hostname), maxBytes: 256 * 1024 });
  return { status: res.status, json: obj(parseJson(res.text)) };
}

/** Error code of a token response (OAuth `error`, or Slack's ok:false), or null when it succeeded. */
function tokenError(status: number, json: Record<string, unknown>): string | null {
  if (typeof json.error === "string" && json.error) return json.error;
  if (json.ok === false) return "failed";
  if (status < 200 || status >= 300) return `http_${status}`;
  return null;
}

function toTokenSet(json: Record<string, unknown>, previous?: TokenSet): TokenSet {
  // Slack user tokens come under authed_user on the first exchange.
  const src = obj(json.authed_user).access_token ? obj(json.authed_user) : json;
  const accessToken = str(src.access_token);
  if (!accessToken) throw new ProviderError("failed", "the service returned no access token");
  const expiresIn = Number(src.expires_in);
  return {
    accessToken,
    // Providers that don't rotate omit the refresh token on refresh: keep the previous one.
    refreshToken: str(src.refresh_token) || previous?.refreshToken || null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
  };
}

export async function exchangeCode(id: ProviderId, code: string, verifier: string | null): Promise<{ tokens: TokenSet; raw: Record<string, unknown> }> {
  const cfg = clientConfig(id);
  if (!cfg) throw new ProviderError("notConfigured", "not configured");
  const params: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: callbackUrl(id) };
  if (verifier) params.code_verifier = verifier;
  const { status, json } = await tokenRequest(id, cfg, params);
  const err = tokenError(status, json);
  if (err) throw new ProviderError("exchangeFailed", `code exchange failed (${err.slice(0, 60)})`);
  return { tokens: toTokenSet(json), raw: json };
}

const REAUTH_ERRORS = new Set(["invalid_grant", "invalid_refresh_token", "token_revoked", "invalid_token", "unauthorized_client", "http_401"]);

/** Exchanges a refresh token. Throws ReauthNeeded when the grant is gone, ProviderError otherwise. */
export async function refreshTokens(id: ProviderId, previous: TokenSet): Promise<TokenSet> {
  if (!previous.refreshToken) throw new ReauthNeeded("no refresh token");
  const cfg = clientConfig(id);
  if (!cfg) throw new ProviderError("notConfigured", "not configured");
  const { status, json } = await tokenRequest(id, cfg, { grant_type: "refresh_token", refresh_token: previous.refreshToken });
  const err = tokenError(status, json);
  if (err) {
    if (REAUTH_ERRORS.has(err) || status === 400) throw new ReauthNeeded(err);
    throw new ProviderError("failed", `token refresh failed (${err.slice(0, 60)})`);
  }
  return toTokenSet(json, previous);
}

/* --------------------------------------------------------------- accounts */

async function getJson(id: ProviderId, url: string, token: string, extra: Record<string, string> = {}, method = "GET"): Promise<Record<string, unknown> | unknown[]> {
  const res = await providerFetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...extra },
    hosts: provider(id).hosts,
    maxBytes: 512 * 1024,
  });
  if (res.status < 200 || res.status >= 300) throw new ProviderError("accountFailed", `account lookup failed (HTTP ${res.status})`);
  const parsed = parseJson(res.text);
  return Array.isArray(parsed) ? parsed : obj(parsed);
}

/** Who the token belongs to (plus provider data such as the Jira site). */
export async function fetchAccount(id: ProviderId, tokens: TokenSet, raw: Record<string, unknown>): Promise<Account> {
  const t = tokens.accessToken;
  switch (id) {
    case "github": {
      const u = obj(await getJson(id, "https://api.github.com/user", t, { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }));
      return { id: str(u.id), login: str(u.login), name: str(u.name) || str(u.login), avatarUrl: str(u.avatar_url) || null, meta: {} };
    }
    case "google": {
      const u = obj(await getJson(id, "https://openidconnect.googleapis.com/v1/userinfo", t));
      return { id: str(u.sub), login: str(u.email), name: str(u.name) || str(u.email), avatarUrl: str(u.picture) || null, meta: {} };
    }
    case "atlassian": {
      const u = obj(await getJson(id, "https://api.atlassian.com/me", t));
      const sites = arr(await getJson(id, "https://api.atlassian.com/oauth/token/accessible-resources", t)).map(obj);
      const site = sites.find((s) => arr(s.scopes).includes("read:jira-work")) ?? sites[0];
      if (!site || !str(site.id)) throw new ProviderError("noSite", "no Jira site was authorized");
      return {
        id: str(u.account_id),
        login: str(u.email),
        name: str(u.name) || str(u.email),
        avatarUrl: str(u.picture) || null,
        meta: { cloudId: str(site.id), siteUrl: str(site.url).replace(/\/+$/, ""), siteName: str(site.name) },
      };
    }
    case "notion": {
      // Notion describes the owner and workspace in the token response.
      const owner = obj(obj(raw.owner).user);
      const icon = str(raw.workspace_icon);
      return {
        id: str(owner.id) || str(raw.bot_id),
        login: str(obj(owner.person).email) || str(raw.workspace_name),
        name: str(owner.name) || str(raw.workspace_name) || "Notion",
        avatarUrl: str(owner.avatar_url) || (/^https:\/\//.test(icon) ? icon : null),
        meta: { workspace: str(raw.workspace_name), workspaceId: str(raw.workspace_id) },
      };
    }
    case "slack": {
      const r = obj(await getJson(id, "https://slack.com/api/auth.test", t, {}, "POST"));
      if (r.ok !== true) throw new ProviderError("accountFailed", "account lookup failed");
      const team = obj(raw.team);
      return {
        id: str(r.user_id),
        login: str(r.user),
        name: `${str(r.user)}${str(r.team) ? ` (${str(r.team)})` : ""}`,
        avatarUrl: null,
        meta: { teamId: str(r.team_id) || str(team.id), team: str(r.team) || str(team.name), teamUrl: str(r.url) },
      };
    }
  }
}

/* ------------------------------------------------------------- revocation */

/** Best effort: revokes the grant at the provider when it supports it. Never throws. */
export async function revokeAtProvider(id: ProviderId, tokens: TokenSet): Promise<boolean> {
  const p = provider(id);
  const cfg = clientConfig(id);
  if (!p.revocable || !cfg) return false;
  const basic = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
  try {
    let status = 0;
    switch (id) {
      case "github":
        // Deletes the whole OAuth authorization (all of this app's tokens for the user).
        status = (
          await providerFetch(`https://api.github.com/applications/${encodeURIComponent(cfg.clientId)}/grant`, {
            method: "DELETE",
            headers: { Authorization: basic, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
            body: JSON.stringify({ access_token: tokens.accessToken }),
            hosts: p.hosts,
          })
        ).status;
        break;
      case "google":
        status = (
          await providerFetch("https://oauth2.googleapis.com/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: tokens.refreshToken || tokens.accessToken }).toString(),
            hosts: p.hosts,
          })
        ).status;
        break;
      case "notion":
        status = (
          await providerFetch("https://api.notion.com/v1/oauth/revoke", {
            method: "POST",
            headers: { Authorization: basic, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
            body: JSON.stringify({ token: tokens.accessToken }),
            hosts: p.hosts,
          })
        ).status;
        break;
      case "slack": {
        const res = await providerFetch("https://slack.com/api/auth.revoke", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: "",
          hosts: p.hosts,
        });
        status = obj(parseJson(res.text)).ok === true ? 200 : 400;
        break;
      }
      default:
        return false;
    }
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}
