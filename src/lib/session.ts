import { seal, unseal } from "./crypto";
import { fetchUserInfo, refreshTokens, type TokenSet, type UserInfo } from "./oidc";

export const TX_COOKIE = "zw_tx";

/**
 * Short-lived result of the one-off MCP setup authorization (oidc.ts MCP_SETUP_SCOPES): an access
 * token able to create the user's Stalwart API key for an MCP token. Consumed and revoked by
 * Settings → Integrations.
 */
export const MCP_SETUP_COOKIE = "zw_mcp_setup";
export const MCP_SETUP_MAX_AGE = 10 * 60;
export type McpSetup = { sub: string; accessToken: string; expiresAt: number };

// Multi-account layout: each signed-in account's sealed Session lives in its own cookie
// (`zw_s0`…`zw_s4`), and `zw_active` holds the slots in most-recently-used order ("2.0.1"); its
// first entry is the active account. `zw_session` is the pre-multi-account cookie, migrated to a
// slot by the middleware.
export const LEGACY_SESSION_COOKIE = "zw_session";
export const ACTIVE_COOKIE = "zw_active";
export const MAX_ACCOUNTS = 5;
export const SLOTS: readonly number[] = Array.from({ length: MAX_ACCOUNTS }, (_, i) => i);
export const slotCookie = (slot: number) => `zw_s${slot}`;

export type Session = {
  sub: string;
  email: string;
  name: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
  /** Set when a refresh failed: the account stays listed but must sign in again. */
  stale?: boolean;
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

/** Exchanges the refresh token for a fresh session. Throws when the provider refuses it. */
export async function refreshSession(s: Session): Promise<Session> {
  if (!s.refreshToken) throw new Error("No refresh token");
  const tokens = await refreshTokens(s.refreshToken);
  const user = await fetchUserInfo(tokens.access_token);
  return sessionFromTokens(tokens, user, s);
}

/** True when the account can't be used without signing in again. */
export const isSignedOut = (s: Session) => !!s.stale || (!s.refreshToken && s.expiresAt <= Date.now());

/** Same person/mailbox: matched by OIDC subject or (case-insensitive) email. */
export const sameAccount = (a: Pick<Session, "sub" | "email">, b: Pick<Session, "sub" | "email">) =>
  a.sub === b.sub || (!!a.email && a.email.toLowerCase() === b.email.toLowerCase());

/** Parses an untrusted slot number ("0".."4"); null for anything else. */
export function parseSlot(value: unknown): number | null {
  const s = typeof value === "number" ? String(value) : value;
  if (typeof s !== "string" || !/^\d$/.test(s)) return null;
  const n = Number(s);
  return n < MAX_ACCOUNTS ? n : null;
}

/** Parses the `zw_active` MRU list, dropping invalid and duplicate entries. */
export function parseOrder(value: string | undefined): number[] {
  const out: number[] = [];
  for (const part of (value ?? "").split(".")) {
    const slot = parseSlot(part);
    if (slot !== null && !out.includes(slot)) out.push(slot);
  }
  return out;
}

export const serializeOrder = (order: number[]) => order.join(".");

/** Moves `slot` to the front (makes it active). */
export const promote = (order: number[], slot: number) => [slot, ...order.filter((s) => s !== slot)];

type CookieGetter = { get(name: string): { value: string } | undefined };

export type Accounts = {
  /** Unsealed session per slot (null when empty, tampered or unreadable). */
  sessions: (Session | null)[];
  /** Occupied slots, most recently used first; `order[0]` is the active account. */
  order: number[];
};

/** Reads every account cookie. Pure decryption, no network. Usable from Edge and Node. */
export async function readAccounts(jar: CookieGetter): Promise<Accounts> {
  const sessions = await Promise.all(SLOTS.map((slot) => unsealSession(jar.get(slotCookie(slot))?.value)));
  const occupied = SLOTS.filter((slot) => sessions[slot]);
  const order = parseOrder(jar.get(ACTIVE_COOKIE)?.value).filter((slot) => sessions[slot]);
  for (const slot of occupied) if (!order.includes(slot)) order.push(slot);
  return { sessions, order };
}

/** Slot for a newly added account: the first free one, else the least recently used non-active. */
export function freeSlot({ sessions, order }: Accounts): number {
  const free = SLOTS.find((slot) => !sessions[slot]);
  return free ?? order[order.length - 1];
}

/** Minimal response-cookie interface shared by NextResponse and the request cookie jar. */
type CookieWriter = {
  set(name: string, value: string, options?: ReturnType<typeof cookieOptions>): unknown;
};

/** Writes (or, with null, expires) an account cookie with the standard secure options. */
export function writeCookie(res: { cookies: CookieWriter }, name: string, value: string | null) {
  res.cookies.set(name, value ?? "", cookieOptions(value === null ? 0 : SESSION_MAX_AGE));
}
