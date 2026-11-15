import { seal, unseal } from "./crypto";
import type { TokenSet, UserInfo } from "./oidc";

export const SESSION_COOKIE = "zw_session";
export const TX_COOKIE = "zw_tx";

export type Session = {
  sub: string;
  email: string;
  name: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
};

export const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: maxAgeSeconds,
});

/** Session cookie lives 30 days; the refresh token keeps the access token fresh within it. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

export function sessionFromTokens(tokens: TokenSet, user: UserInfo, previous?: Session): Session {
  const email = user.email ?? previous?.email ?? user.preferred_username ?? "";
  return {
    sub: user.sub,
    email,
    name: user.name ?? previous?.name ?? email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

export const sealSession = (s: Session) => seal(s);
export const unsealSession = (v: string | undefined) => unseal<Session>(v);

/** True when the access token is expired or about to expire within a minute. */
export const needsRefresh = (s: Session) => s.expiresAt - Date.now() < 60_000;
