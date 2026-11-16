// Personal access tokens for the MCP endpoint: creation, verification, offline JMAP sessions and
// per-token rate limiting. Server-only.
//
// Each token is backed by its own Stalwart API key (see credential.ts for why). Rows created before
// that carry a sealed OIDC refresh token instead; they keep working on it until they are
// reconnected, which moves them to an API key.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { seal, unseal } from "../crypto";
import { refreshTokens } from "../oidc";
import type { Session } from "../session";
import { apiKeyWorks, createApiKey, CredentialError, destroyApiKey, type StalwartKey } from "./credential";
import {
  countUserTokens,
  insertToken,
  markNeedsReauth,
  revokeToken as revokeRow,
  tokenByHash,
  touchToken,
  updateCredential,
  updateRefresh,
  userTokens,
  type Scope,
  type TokenRow,
} from "./db";

export const TOKEN_PREFIX = "zwmcp_";
const TOKEN_PATTERN = /^zwmcp_[A-Za-z0-9_-]{43}$/;
export const MAX_TOKENS_PER_USER = 20;
export const MAX_EXPIRY_DAYS = 365;

/**
 * Codes besides input validation: `authorize` = creating the Stalwart API key needs the one-off
 * MCP setup authorization (the web session lacks Stalwart's "security" scope); `not_allowed` =
 * even that authorization can't create API keys; `key_quota` = Stalwart's per-account API key
 * limit was reached.
 */
export class TokenError extends Error {}
/** The token's credential no longer works: the user must reconnect it. */
export class ReauthError extends Error {
  constructor() {
    super("This token needs re-authorization; reconnect it in Settings → Integrations.");
  }
}

/** The OIDC access token used to create Stalwart API keys, and whether it is the MCP setup one. */
export type KeyAuth = { accessToken: string; setup: boolean };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const keyName = (tokenName: string) => `Zentico MCP: ${tokenName}`;

/** Creates the API key with `auth`, mapping failures to TokenError codes. */
async function newKey(auth: KeyAuth, name: string, expires: number | null): Promise<StalwartKey> {
  try {
    return await createApiKey(auth.accessToken, { description: keyName(name), expires });
  } catch (e) {
    if (e instanceof CredentialError) {
      if (e.code === "authorize") throw new TokenError(auth.setup ? "not_allowed" : "authorize");
      if (e.code === "quota") throw new TokenError("key_quota");
    }
    throw e;
  }
}

/** Creates a token for the signed-in user, backed by a new Stalwart API key on their account. */
export async function createToken(
  session: Session,
  input: { name: string; scope: Scope; expiresInDays: number | null },
  auth: KeyAuth,
): Promise<{ id: string; token: string }> {
  // null (or 0) = never expires; otherwise 1…MAX_EXPIRY_DAYS whole days.
  const days = input.expiresInDays || null;
  if (days != null && (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS)) throw new TokenError("invalid_expiry");
  if (countUserTokens(session.sub) >= MAX_TOKENS_PER_USER) throw new TokenError("too_many");

  const expires = days ? Date.now() + days * 86_400_000 : null;
  const key = await newKey(auth, input.name, expires);

  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const id = randomUUID();
  try {
    insertToken({
      id,
      userSub: session.sub,
      userEmail: session.email,
      userName: session.name,
      name: input.name,
      scope: input.scope,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 6),
      credentialSealed: await seal(key),
      expires,
    });
  } catch (e) {
    await destroyApiKey(key);
    throw e;
  }
  return { id, token };
}

/**
 * Re-binds an existing token to a fresh Stalwart API key (migrating legacy refresh-token rows), so
 * a token whose credential died works again without being recreated and pasted into every client.
 */
export async function reauthorizeToken(id: string, userSub: string, auth: KeyAuth): Promise<boolean> {
  const row = userTokens(userSub).find((t) => t.id === id);
  if (!row) return false;
  const key = await newKey(auth, row.name, row.expires);
  const old = await unseal<StalwartKey>(row.credentialSealed || undefined);
  updateCredential(row.id, await seal(key));
  accessCache.delete(row.id);
  if (old) await destroyApiKey(old);
  return true;
}

/** Revokes one of the user's tokens and (best effort) destroys its Stalwart API key. */
export async function revokeToken(id: string, userSub: string): Promise<boolean> {
  const row = userTokens(userSub).find((t) => t.id === id);
  const ok = revokeRow(id, userSub);
  if (!ok) return false;
  accessCache.delete(id);
  const key = await unseal<StalwartKey>(row?.credentialSealed || undefined);
  if (key) await destroyApiKey(key);
  return true;
}

/** Resolves a bearer token to its active row, or null (unknown, revoked or expired). */
export function verifyToken(bearer: string | null | undefined): TokenRow | null {
  if (!bearer || !TOKEN_PATTERN.test(bearer)) return null;
  const row = tokenByHash(hashToken(bearer));
  if (!row || row.revoked || (row.expires != null && row.expires <= Date.now())) return null;
  return row;
}

/** The token from an "Authorization: Bearer <token>" header, or null. */
export function bearerOf(req: Request): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m ? m[1] : null;
}

/* --------------------------------------------------------- offline sessions */

type Cached = { session: Session; expiresAt: number };
const g = globalThis as typeof globalThis & {
  __zwMcpAccess?: Map<string, Cached>;
  __zwMcpInflight?: Map<string, Promise<Session>>;
};
const accessCache = (g.__zwMcpAccess ??= new Map());
const inflight = (g.__zwMcpInflight ??= new Map());

/** How long an API key is trusted before checking again that Stalwart still accepts it. */
const KEY_RECHECK_MS = 10 * 60_000;

const sessionOf = (row: TokenRow, accessToken: string, expiresAt: number): Session => ({
  sub: row.userSub,
  email: row.userEmail,
  name: row.userName || row.userEmail,
  accessToken,
  expiresAt,
});

/** Session on the token's Stalwart API key (sent as a Bearer token like any OAuth access token). */
async function keySession(row: TokenRow): Promise<Session> {
  const key = await unseal<StalwartKey>(row.credentialSealed);
  if (!key) throw new ReauthError();
  if (!(await apiKeyWorks(key.apiKey))) {
    markNeedsReauth(row.id);
    throw new ReauthError();
  }
  return sessionOf(row, key.apiKey, Date.now() + KEY_RECHECK_MS);
}

/** Legacy rows: refresh the stored OIDC refresh token (rotations are persisted). */
async function refreshSession(row: TokenRow): Promise<Session> {
  const refresh = await unseal<string>(row.refreshSealed);
  if (!refresh) throw new ReauthError();
  let tokens;
  try {
    tokens = await refreshTokens(refresh);
  } catch (e) {
    // 400/401 from the token endpoint = invalid/expired grant; anything else may be transient.
    if (e instanceof Error && /: (400|401)$/.test(e.message)) {
      markNeedsReauth(row.id);
      throw new ReauthError();
    }
    throw e;
  }
  if (tokens.refresh_token && tokens.refresh_token !== refresh) {
    updateRefresh(row.id, await seal(tokens.refresh_token));
  }
  return sessionOf(row, tokens.access_token, Date.now() + (tokens.expires_in ?? 3600) * 1000);
}

/**
 * A JMAP-capable session for the token's user, shaped like a browser session (jmap() and friends
 * send its accessToken as Bearer, which Stalwart accepts for API keys too). Cached while valid;
 * concurrent calls share one lookup.
 */
export async function sessionForToken(row: TokenRow): Promise<Session> {
  const hit = accessCache.get(row.id);
  if (hit && hit.expiresAt - Date.now() > 60_000) return hit.session;
  if (row.needsReauth) throw new ReauthError();

  const pending = inflight.get(row.id);
  if (pending) return pending;
  const p = (async () => {
    const session = row.credentialSealed ? await keySession(row) : await refreshSession(row);
    accessCache.set(row.id, { session, expiresAt: session.expiresAt });
    return session;
  })();
  inflight.set(row.id, p);
  try {
    return await p;
  } finally {
    inflight.delete(row.id);
  }
}

/* ------------------------------------------------------------- rate limits */

export const RATE_LIMIT = 120;
const WINDOW_MS = 60_000;
const hitsByToken = new Map<string, number[]>();

/** Sliding one-minute window per token. Returns seconds to wait when over the limit, else 0. */
export function rateLimit(tokenId: string): number {
  const now = Date.now();
  const hits = (hitsByToken.get(tokenId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= RATE_LIMIT) {
    hitsByToken.set(tokenId, hits);
    return Math.max(1, Math.ceil((hits[0] + WINDOW_MS - now) / 1000));
  }
  hits.push(now);
  hitsByToken.set(tokenId, hits);
  if (hitsByToken.size > 10_000) hitsByToken.clear();
  return 0;
}

// Last-used timestamps are written at most once a minute per token.
const lastTouch = new Map<string, number>();
export function noteUse(tokenId: string): void {
  const now = Date.now();
  if (now - (lastTouch.get(tokenId) ?? 0) < 60_000) return;
  lastTouch.set(tokenId, now);
  touchToken(tokenId);
}
