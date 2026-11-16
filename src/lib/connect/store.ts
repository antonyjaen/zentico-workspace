// Per-user connections: save after the OAuth callback, list for Settings, hand out access tokens
// (refreshing them when needed) and disconnect. Every lookup is keyed by the user's OIDC sub, so
// one person's tokens are never used for another.
//
// Refresh safety (rotating refresh tokens, e.g. Atlassian): at most one refresh is in flight per
// connection (in-process single flight; the app runs as one instance), the new token set is
// persisted with a version compare-and-swap BEFORE anyone uses it, and a failed grant marks the
// connection "reauth" instead of retrying with a refresh token that may already be spent.
// Server-only.
import { seal, unseal } from "../crypto";
import { all, get, run, tx, type Row } from "./db";
import { ProviderError } from "./http";
import { ReauthNeeded, refreshTokens, revokeAtProvider, type Account, type TokenSet } from "./oauth";
import { isConfigured, isProviderId, provider, type ProviderId } from "./providers";

export type Connection = {
  id: number;
  userSub: string;
  provider: ProviderId;
  accountId: string;
  accountName: string;
  accountLogin: string;
  avatarUrl: string | null;
  scopes: string;
  meta: Record<string, string>;
  status: "ok" | "reauth";
  version: number;
  created: number;
  updated: number;
  lastUsed: number | null;
};

const strv = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => Number(v ?? 0);

function toConnection(r: Row): Connection | null {
  const p = strv(r.provider);
  if (!isProviderId(p)) return null;
  let meta: Record<string, string> = {};
  try {
    const parsed = JSON.parse(strv(r.meta) || "{}") as unknown;
    if (parsed && typeof parsed === "object") meta = parsed as Record<string, string>;
  } catch {
    // keep {}
  }
  return {
    id: num(r.id),
    userSub: strv(r.user_sub),
    provider: p,
    accountId: strv(r.account_id),
    accountName: strv(r.account_name),
    accountLogin: strv(r.account_login),
    avatarUrl: r.avatar_url == null ? null : strv(r.avatar_url),
    scopes: strv(r.scopes),
    meta,
    status: strv(r.status) === "reauth" ? "reauth" : "ok",
    version: num(r.version),
    created: num(r.created),
    updated: num(r.updated),
    lastUsed: r.last_used == null ? null : num(r.last_used),
  };
}

export function getConnection(sub: string, id: ProviderId): Connection | null {
  if (!sub) return null;
  const r = get("SELECT * FROM connections WHERE user_sub = ? AND provider = ?", sub, id);
  return r ? toConnection(r) : null;
}

export function listConnections(sub: string): Connection[] {
  if (!sub) return [];
  return all("SELECT * FROM connections WHERE user_sub = ? ORDER BY provider", sub)
    .map(toConnection)
    .filter((c): c is Connection => !!c);
}

/** Providers this user can use right now (connected, healthy, and still configured by the admin). */
export function connectedProviders(sub: string): Set<ProviderId> {
  return new Set(listConnections(sub).filter((c) => c.status === "ok" && isConfigured(c.provider)).map((c) => c.provider));
}

/** Stores (or replaces) the user's connection after a successful OAuth callback. */
export async function saveConnection(user: { sub: string; email: string }, id: ProviderId, account: Account, tokens: TokenSet): Promise<void> {
  const sealed = await seal(tokens);
  const now = Date.now();
  const scopes = provider(id).scopes.join(" ");
  run(
    `INSERT INTO connections (user_sub, user_email, provider, account_id, account_name, account_login, avatar_url, scopes, tokens_sealed, meta, status, version, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', 1, ?, ?)
     ON CONFLICT (user_sub, provider) DO UPDATE SET
       user_email = excluded.user_email, account_id = excluded.account_id, account_name = excluded.account_name,
       account_login = excluded.account_login, avatar_url = excluded.avatar_url, scopes = excluded.scopes,
       tokens_sealed = excluded.tokens_sealed, meta = excluded.meta, status = 'ok', version = connections.version + 1,
       updated = excluded.updated`,
    user.sub,
    user.email,
    id,
    account.id.slice(0, 200),
    account.name.slice(0, 200),
    account.login.slice(0, 200),
    account.avatarUrl && /^https:\/\//.test(account.avatarUrl) ? account.avatarUrl.slice(0, 1000) : null,
    scopes,
    sealed,
    JSON.stringify(account.meta),
    now,
    now,
  );
}

const lastUsedWrites = new Map<number, number>();
function noteUsed(connId: number) {
  const now = Date.now();
  if (now - (lastUsedWrites.get(connId) ?? 0) < 60_000) return;
  lastUsedWrites.set(connId, now);
  if (lastUsedWrites.size > 10_000) lastUsedWrites.clear();
  run("UPDATE connections SET last_used = ? WHERE id = ?", now, connId);
}

/* ------------------------------------------------------------------ tokens */

const g = globalThis as typeof globalThis & { __zwConnectRefresh?: Map<number, Promise<TokenSet>> };
const inflight = (g.__zwConnectRefresh ??= new Map());

/** Refresh this much before expiry. */
const EARLY_MS = 60_000;

const notConnected = (id: ProviderId) =>
  new ProviderError("notConnected", `${provider(id).name} is not connected. Connect it in Settings → Apps & bots (Connected apps).`);
const needsReauth = (id: ProviderId) =>
  new ProviderError("reauth", `The ${provider(id).name} connection expired or was revoked. Reconnect it in Settings → Apps & bots.`);

async function readTokens(r: Row): Promise<TokenSet> {
  const t = await unseal<TokenSet>(strv(r.tokens_sealed));
  if (!t?.accessToken) throw new ProviderError("reauth", "stored token unreadable");
  return t;
}

async function doRefresh(conn: Connection, seenVersion: number): Promise<TokenSet> {
  const r = get("SELECT * FROM connections WHERE id = ?", conn.id);
  if (!r) throw notConnected(conn.provider);
  if (strv(r.status) === "reauth") throw needsReauth(conn.provider);
  const current = await readTokens(r);
  // Someone else refreshed since we read: use theirs.
  if (num(r.version) !== seenVersion && (!current.expiresAt || current.expiresAt - EARLY_MS > Date.now())) return current;
  let next: TokenSet;
  try {
    next = await refreshTokens(conn.provider, current);
  } catch (e) {
    if (e instanceof ReauthNeeded) {
      run("UPDATE connections SET status = 'reauth', updated = ? WHERE id = ? AND version = ?", Date.now(), conn.id, num(r.version));
      throw needsReauth(conn.provider);
    }
    throw e;
  }
  // Persist before use: if this write doesn't land, the rotated refresh token must not be relied on.
  const sealed = await seal(next);
  const changed = num(
    run("UPDATE connections SET tokens_sealed = ?, version = version + 1, updated = ? WHERE id = ? AND version = ?", sealed, Date.now(), conn.id, num(r.version)).changes,
  );
  if (!changed) throw needsReauth(conn.provider);
  return next;
}

function refreshOnce(conn: Connection, seenVersion: number): Promise<TokenSet> {
  let p = inflight.get(conn.id);
  if (!p) {
    p = doRefresh(conn, seenVersion).finally(() => inflight.delete(conn.id));
    inflight.set(conn.id, p);
  }
  return p;
}

async function currentToken(conn: Connection, force: boolean): Promise<string> {
  const pending = inflight.get(conn.id);
  if (pending) return (await pending).accessToken;
  const r = get("SELECT * FROM connections WHERE id = ?", conn.id);
  if (!r) throw notConnected(conn.provider);
  if (strv(r.status) === "reauth") throw needsReauth(conn.provider);
  const tokens = await readTokens(r);
  const expiring = tokens.expiresAt != null && tokens.expiresAt - EARLY_MS <= Date.now();
  if (!force && !expiring) return tokens.accessToken;
  if (!tokens.refreshToken) {
    // Expired (or refused) and nothing to refresh with.
    run("UPDATE connections SET status = 'reauth', updated = ? WHERE id = ?", Date.now(), conn.id);
    throw needsReauth(conn.provider);
  }
  return (await refreshOnce(conn, num(r.version))).accessToken;
}

/**
 * Runs fn with the user's access token for a provider. A 401 from the provider triggers one
 * refresh and retry (when the connection has a refresh token); otherwise it is marked "reauth".
 */
export async function withToken<T>(sub: string, id: ProviderId, fn: (token: string, conn: Connection) => Promise<T>): Promise<T> {
  if (!isConfigured(id)) throw new ProviderError("notConfigured", `${provider(id).name} is not available on this workspace (not configured by the admin).`);
  const conn = getConnection(sub, id);
  if (!conn) throw notConnected(id);
  if (conn.status === "reauth") throw needsReauth(id);
  noteUsed(conn.id);
  const token = await currentToken(conn, false);
  try {
    return await fn(token, conn);
  } catch (e) {
    if (!(e instanceof ProviderError) || e.code !== "unauthorized") throw e;
    const retryToken = await currentToken(conn, true);
    try {
      return await fn(retryToken, conn);
    } catch (e2) {
      if (e2 instanceof ProviderError && e2.code === "unauthorized") {
        run("UPDATE connections SET status = 'reauth', updated = ? WHERE id = ?", Date.now(), conn.id);
        throw needsReauth(id);
      }
      throw e2;
    }
  }
}

/* -------------------------------------------------------------- disconnect */

/**
 * Removes the connection and everything that runs on it (subscriptions), then revokes the grant at
 * the provider when supported. Returns whether the provider confirmed the revocation.
 */
export async function disconnect(sub: string, id: ProviderId): Promise<{ revoked: boolean; conversations: string[] }> {
  const r = get("SELECT * FROM connections WHERE user_sub = ? AND provider = ?", sub, id);
  if (!r) return { revoked: false, conversations: [] };
  let tokens: TokenSet | null = null;
  try {
    tokens = await readTokens(r);
  } catch {
    tokens = null;
  }
  const conversations = tx(() => {
    const convs = all("SELECT DISTINCT conversation_id FROM subscriptions WHERE user_sub = ? AND provider = ?", sub, id).map((x) => strv(x.conversation_id));
    run("DELETE FROM subscriptions WHERE user_sub = ? AND provider = ?", sub, id);
    run("DELETE FROM connections WHERE id = ?", num(r.id));
    return convs;
  });
  inflight.delete(num(r.id));
  const revoked = tokens ? await revokeAtProvider(id, tokens) : false;
  return { revoked, conversations };
}
