// Minimal OpenID Connect (authorization code + PKCE) client for Stalwart.
import { base64url, randomToken, sha256 } from "./crypto";
import { env } from "./env";

/** Scopes: sign-in, refresh tokens, and JMAP access to the user's data. */
export const SCOPES = [
  "openid",
  "offline_access",
  "urn:ietf:params:oauth:scope:mail",
  "urn:ietf:params:oauth:scope:contacts",
  "urn:ietf:params:oauth:scope:calendars",
  "urn:ietf:params:oauth:scope:files",
].join(" ");

/**
 * One-off authorization used only to create the dedicated Stalwart API key behind an MCP token:
 * the data scopes (so the key can be granted them) plus Stalwart's "security" scope, which is what
 * allows managing API keys. No offline_access: nothing from this grant is kept; it is revoked
 * right after use. The OAuth client in Stalwart must allow the Security scope.
 */
export const MCP_SETUP_SCOPES = [
  "openid",
  "urn:ietf:params:oauth:scope:mail",
  "urn:ietf:params:oauth:scope:contacts",
  "urn:ietf:params:oauth:scope:calendars",
  "urn:ietf:params:oauth:scope:files",
  "urn:stalwart:oauth:scope:security",
].join(" ");

/**
 * Short-lived authorization for Settings → Security: Stalwart's "security" scope is the one that
 * grants managing the user's own password credential (TOTP) and app passwords. No offline_access
 * and nothing kept beyond a 10-minute cookie.
 */
export const SECURITY_SCOPES = ["openid", "urn:stalwart:oauth:scope:security"].join(" ");

/** `check` reuses the provider's single sign-on session; `manage` asks for a fresh sign-in. */
export type SecurityMode = "check" | "manage";

type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
};

let discovery: Promise<Discovery> | undefined;
export function getDiscovery(): Promise<Discovery> {
  discovery ??= fetch(`${env.issuer}/.well-known/openid-configuration`, { cache: "no-store" })
    .then((r) => {
      if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
      return r.json() as Promise<Discovery>;
    })
    .catch((e) => {
      discovery = undefined;
      throw e;
    });
  return discovery;
}

export const redirectUri = () => `${env.appUrl}/api/auth/callback`;

/**
 * Short-lived login transaction kept in an encrypted cookie between /login and /callback.
 * `add` = sign in an additional account instead of replacing the active one.
 * `mcp` = the one-off authorization for creating an MCP token's Stalwart API key (it doesn't
 * touch the account cookies).
 */
export type AuthTransaction = {
  state: string;
  verifier: string;
  returnTo: string;
  add?: boolean;
  mcp?: boolean;
  /** The security grant for Settings → Security (doesn't touch the account cookies). */
  security?: SecurityMode;
};

export async function buildAuthorizeUrl(
  returnTo: string,
  {
    add = false,
    loginHint,
    mcp = false,
    security,
  }: { add?: boolean; loginHint?: string; mcp?: boolean; security?: SecurityMode } = {},
) {
  const { authorization_endpoint } = await getDiscovery();
  const tx: AuthTransaction = { state: randomToken(), verifier: randomToken(48), returnTo, add, mcp, security };
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.clientId,
    redirect_uri: redirectUri(),
    scope: mcp ? MCP_SETUP_SCOPES : security ? SECURITY_SCOPES : SCOPES,
    state: tx.state,
    code_challenge: base64url(await sha256(tx.verifier)),
    code_challenge_method: "S256",
  });
  // Adding or re-authenticating a specific account must not silently reuse the provider's
  // current single sign-on session (which belongs to whichever account signed in last). The MCP
  // authorization may reuse it: its callback checks it's the same account.
  // The security "manage" grant is a step-up: it always asks for the password (and code) again.
  if (add || security === "manage" || (loginHint && !mcp && !security)) params.set("prompt", "login");
  if (loginHint) params.set("login_hint", loginHint);
  const url = new URL(authorization_endpoint);
  url.search = params.toString();
  return { url: url.toString(), tx };
}

/** Validates an untrusted login hint: a plain email address, or undefined. */
export function safeLoginHint(value: string | null | undefined): string | undefined {
  if (!value || value.length > 254) return undefined;
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value) ? value : undefined;
}

export type TokenSet = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const { token_endpoint } = await getDiscovery();
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...params,
      client_id: env.clientId,
      client_secret: env.clientSecret,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  return res.json();
}

export const exchangeCode = (code: string, verifier: string) =>
  tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });

export const refreshTokens = (refreshToken: string) =>
  tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });

/** Revokes a token and, with it, its whole grant (RFC 7009). Best effort: errors are swallowed. */
export async function revokeGrant(token: string): Promise<void> {
  try {
    const { revocation_endpoint } = await getDiscovery();
    if (!revocation_endpoint) return;
    await fetch(revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: env.clientId, client_secret: env.clientSecret }),
      cache: "no-store",
    });
  } catch {
    // The grant just idles out.
  }
}

export type UserInfo = { sub: string; email?: string; name?: string; preferred_username?: string };

export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const { userinfo_endpoint } = await getDiscovery();
  const res = await fetch(userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Userinfo failed: ${res.status}`);
  return res.json();
}

/** Only allow same-origin relative paths as post-login destinations (prevents open redirects). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return "/mail";
  }
  return value;
}

/**
 * The root of the app a path belongs to ("/mail/inbox/abc" -> "/mail"). Used when switching
 * accounts, because mailbox/thread/file ids in deeper URLs belong to the previous account.
 */
export function appRoot(path: string | null | undefined): string {
  const segment = safeReturnTo(path).split(/[/?#]/)[1] ?? "";
  return /^[a-z][a-z0-9-]*$/.test(segment) && segment !== "api" && segment !== "signin"
    ? `/${segment}`
    : "/mail";
}

/** CSRF guard for state-changing auth POSTs: the request must come from this app's own pages. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === new URL(env.appUrl).origin;
  return req.headers.get("sec-fetch-site") === "same-origin";
}
