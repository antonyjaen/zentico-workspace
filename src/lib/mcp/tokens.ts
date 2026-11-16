// Personal access tokens for the MCP endpoint: creation, verification, offline JMAP sessions
// (via the stored OIDC refresh token) and per-token rate limiting. Server-only.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { seal, unseal } from "../crypto";
import { refreshTokens } from "../oidc";
import type { Session } from "../session";
import {
  countUserTokens,
  insertToken,
  markNeedsReauth,
  revokeToken as revokeRow,
  tokenByHash,
  touchToken,
  updateRefresh,
  userTokens,
  type Scope,
  type TokenRow,
} from "./db";

export const TOKEN_PREFIX = "zwmcp_";
const TOKEN_PATTERN = /^zwmcp_[A-Za-z0-9_-]{43}$/;
export const MAX_TOKENS_PER_USER = 20;
export const MAX_EXPIRY_DAYS = 365;

export class TokenError extends Error {}
/** The stored refresh token no longer works: the user must create a new token. */
export class ReauthError extends Error {
  constructor() {
    super("This token needs re-authorization; recreate it in Settings → Integrations.");
  }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Creates a token for the signed-in user. A fresh refresh is done first so the stored refresh
 * token is known to work (and, when the server rotates, is distinct from the browser's).
 */
export async function createToken(
  session: Session,
  input: { name: string; scope: Scope; expiresInDays: number | null },
): Promise<{ id: string; token: string }> {
  // null (or 0) = never expires; otherwise 1…MAX_EXPIRY_DAYS whole days.
  const days = input.expiresInDays || null;
  if (days != null && (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS)) throw new TokenError("invalid_expiry");
  if (!session.refreshToken) throw new TokenError("no_refresh");
  if (countUserTokens(session.sub) >= MAX_TOKENS_PER_USER) throw new TokenError("too_many");

  let refreshToken = session.refreshToken;
  try {
    const fresh = await refreshTokens(session.refreshToken);
    if (fresh.refresh_token) refreshToken = fresh.refresh_token;
  } catch {
    throw new TokenError("no_refresh");
  }

  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const id = randomUUID();
  insertToken({
    id,
    userSub: session.sub,
    userEmail: session.email,
    userName: session.name,
    name: input.name,
    scope: input.scope,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 6),
    refreshSealed: await seal(refreshToken),
    expires: days ? Date.now() + days * 86_400_000 : null,
  });
  return { id, token };
}

/**
 * Re-binds an existing token to a fresh refresh token from the signed-in user's session, so a
 * token whose grant died (e.g. after a Stalwart key change) works again without being recreated
 * and pasted into every client.
 */
export async function reauthorizeToken(session: Session, id: string): Promise<boolean> {
  const row = userTokens(session.sub).find((t) => t.id === id && !t.revoked);
  if (!row) return false;
  if (!session.refreshToken) throw new TokenError("no_refresh");
  let refreshToken = session.refreshToken;
  try {
    const fresh = await refreshTokens(session.refreshToken);
    if (fresh.refresh_token) refreshToken = fresh.refresh_token;
  } catch {
    throw new TokenError("no_refresh");
  }
  updateRefresh(row.id, await seal(refreshToken));
  accessCache.delete(row.id);
  return true;
}

export function revokeToken(id: string, userSub: string): boolean {
  const ok = revokeRow(id, userSub);
  if (ok) accessCache.delete(id);
  return ok;
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

/**
 * A JMAP-capable session for the token's user: a cached access token while valid, otherwise a
 * refresh with the stored refresh token (rotations are persisted). Concurrent calls share one refresh.
 */
export async function sessionForToken(row: TokenRow): Promise<Session> {
  const hit = accessCache.get(row.id);
  if (hit && hit.expiresAt - Date.now() > 60_000) return hit.session;
  if (row.needsReauth) throw new ReauthError();

  const pending = inflight.get(row.id);
  if (pending) return pending;
  const p = (async () => {
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
    const session: Session = {
      sub: row.userSub,
      email: row.userEmail,
      name: row.userName || row.userEmail,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    };
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
