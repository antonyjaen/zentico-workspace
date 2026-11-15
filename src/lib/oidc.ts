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

type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
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
 */
export type AuthTransaction = { state: string; verifier: string; returnTo: string; add?: boolean };

export async function buildAuthorizeUrl(
  returnTo: string,
  { add = false, loginHint }: { add?: boolean; loginHint?: string } = {},
) {
  const { authorization_endpoint } = await getDiscovery();
  const tx: AuthTransaction = { state: randomToken(), verifier: randomToken(48), returnTo, add };
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.clientId,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state: tx.state,
    code_challenge: base64url(await sha256(tx.verifier)),
    code_challenge_method: "S256",
  });
  // Adding or re-authenticating a specific account must not silently reuse the provider's
  // current single sign-on session (which belongs to whichever account signed in last).
  if (add || loginHint) params.set("prompt", "login");
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
