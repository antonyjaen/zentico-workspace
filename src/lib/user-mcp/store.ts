// Per-user MCP server records: create / update / remove, sealed credentials and OAuth tokens,
// the last known catalog. Every lookup is keyed by the user's OIDC sub, so one person's servers
// and credentials are never used for another.
//
// OAuth refresh safety (rotating refresh tokens): at most one refresh is in flight per server
// (in-process single flight; the app runs as one instance), the new token set is persisted with a
// version compare-and-swap BEFORE anyone uses it, and a refused grant marks the server "reauth"
// instead of retrying with a refresh token that may already be spent. Server-only.
import { randomToken, seal, unseal } from "../crypto";
import { all, get, run, type Row } from "./db";
import { UserMcpError } from "./errors";
import { checkServerUrl } from "./net";
import { McpReauthNeeded, refreshTokens, revokeTokens, type McpOAuthConfig, type McpTokenSet } from "./oauth";
import type { McpServerInfo, McpServerSummary, McpToolAnnotations, McpToolInfo } from "./types";

export type AuthType = "none" | "bearer" | "header" | "oauth";
export type StaticAuth = { token: string } | { name: string; value: string };

export type RawTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

export type ServerRecord = {
  id: string;
  userSub: string;
  name: string;
  slug: string;
  host: string;
  transport: "auto" | "streamable" | "sse";
  authType: AuthType;
  status: "ok" | "pending" | "reauth";
  enabled: boolean;
  disabledTools: Set<string>;
  serverInfo: McpServerInfo | null;
  catalog: RawTool[] | null;
  catalogAt: number | null;
  lastError: string | null;
  tokenVersion: number;
  created: number;
  updated: number;
  lastUsed: number | null;
};

export const MAX_SERVERS_PER_USER = 20;
export const SERVER_ID = /^[A-Za-z0-9_-]{8,40}$/;

const strv = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => Number(v ?? 0);
function json<T>(v: unknown, fallback: T): T {
  try {
    return typeof v === "string" && v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function toRecord(r: Row): ServerRecord {
  const transport = strv(r.transport);
  const auth = strv(r.auth_type);
  const status = strv(r.status);
  return {
    id: strv(r.id),
    userSub: strv(r.user_sub),
    name: strv(r.name),
    slug: strv(r.slug),
    host: strv(r.host),
    transport: transport === "streamable" || transport === "sse" ? transport : "auto",
    authType: auth === "bearer" || auth === "header" || auth === "oauth" ? auth : "none",
    status: status === "pending" || status === "reauth" ? status : "ok",
    enabled: num(r.enabled) === 1,
    disabledTools: new Set(json<string[]>(r.disabled_tools, []).filter((x) => typeof x === "string")),
    serverInfo: json<McpServerInfo | null>(r.server_info, null),
    catalog: r.catalog == null ? null : json<RawTool[]>(r.catalog, []),
    catalogAt: r.catalog_at == null ? null : num(r.catalog_at),
    lastError: r.last_error == null ? null : strv(r.last_error),
    tokenVersion: num(r.token_version),
    created: num(r.created),
    updated: num(r.updated),
    lastUsed: r.last_used == null ? null : num(r.last_used),
  };
}

export function getServer(sub: string, id: string): ServerRecord | null {
  if (!sub || !SERVER_ID.test(id)) return null;
  const r = get("SELECT * FROM servers WHERE user_sub = ? AND id = ?", sub, id);
  return r ? toRecord(r) : null;
}

export function listServers(sub: string): ServerRecord[] {
  if (!sub) return [];
  return all("SELECT * FROM servers WHERE user_sub = ? ORDER BY name COLLATE NOCASE", sub).map(toRecord);
}

export function serverBySlug(sub: string, slug: string): ServerRecord | null {
  if (!sub || !slug) return null;
  const r = get("SELECT * FROM servers WHERE user_sub = ? AND slug = ?", sub, slug);
  return r ? toRecord(r) : null;
}

/** Tools as the browser / mods see them (adds access and the user's on/off switch). */
export function toolInfo(rec: ServerRecord, t: RawTool): McpToolInfo {
  return { ...t, access: t.annotations?.readOnlyHint === true ? "read" : "write", enabled: !rec.disabledTools.has(t.name) };
}

export function summary(rec: ServerRecord): McpServerSummary {
  return {
    id: rec.id,
    name: rec.name,
    slug: rec.slug,
    host: rec.host,
    authType: rec.authType,
    status: rec.status,
    enabled: rec.enabled,
    server: rec.serverInfo,
    catalogAt: rec.catalogAt,
    lastError: rec.lastError,
  };
}

/* ------------------------------------------------------------- validation */

export function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (!s || s.length > 60) throw new UserMcpError("invalid_request", "name must be 1–60 characters");
  return s;
}

const FORBIDDEN_HEADERS = new Set([
  "host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "cookie", "upgrade",
  "mcp-session-id", "mcp-protocol-version", "last-event-id", "te", "trailer", "keep-alive", "proxy-authorization", "expect",
]);

export function cleanStaticAuth(type: AuthType, input: { token?: unknown; headerName?: unknown; headerValue?: unknown }): StaticAuth | null {
  const safeValue = (v: unknown, what: string) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s || s.length > 4096 || /[\r\n\0]/.test(s)) throw new UserMcpError("invalid_request", `${what} is missing or invalid`);
    return s;
  };
  if (type === "bearer") return { token: safeValue(input.token, "token").replace(/^Bearer\s+/i, "") };
  if (type === "header") {
    const name = typeof input.headerName === "string" ? input.headerName.trim() : "";
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith("sec-")) {
      throw new UserMcpError("invalid_request", "header name is not allowed");
    }
    return { name, value: safeValue(input.headerValue, "header value") };
  }
  return null;
}

function slugFrom(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18)
    .replace(/-+$/g, "");
  return base || "mcp";
}

function uniqueSlug(sub: string, name: string, exceptId?: string): string {
  const base = slugFrom(name);
  for (let i = 1; i < 100; i++) {
    const slug = i === 1 ? base : `${base.slice(0, 16)}-${i}`;
    const r = get("SELECT id FROM servers WHERE user_sub = ? AND slug = ?", sub, slug);
    if (!r || strv(r.id) === exceptId) return slug;
  }
  return `${base.slice(0, 12)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

/* ----------------------------------------------------------------- writes */

export async function createServer(
  sub: string,
  input: { name: string; url: string; authType: AuthType; auth: StaticAuth | null },
): Promise<ServerRecord> {
  const url = checkServerUrl(input.url);
  if (url.toString().length > 2048) throw new UserMcpError("invalid_request", "URL too long");
  const count = num(get("SELECT COUNT(*) AS n FROM servers WHERE user_sub = ?", sub)?.n);
  if (count >= MAX_SERVERS_PER_USER) throw new UserMcpError("invalid_request", `at most ${MAX_SERVERS_PER_USER} MCP servers`);
  const id = randomToken(12);
  const now = Date.now();
  run(
    `INSERT INTO servers (id, user_sub, name, slug, url_sealed, host, auth_type, auth_sealed, status, enabled, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    id,
    sub,
    input.name,
    uniqueSlug(sub, input.name),
    await seal(url.toString()),
    url.hostname,
    input.authType,
    input.auth ? await seal(input.auth) : null,
    input.authType === "oauth" ? "pending" : "ok",
    now,
    now,
  );
  return getServer(sub, id)!;
}

export function renameServer(sub: string, id: string, name: string): void {
  run("UPDATE servers SET name = ?, slug = ?, updated = ? WHERE user_sub = ? AND id = ?", name, uniqueSlug(sub, name, id), Date.now(), sub, id);
}

export function setEnabled(sub: string, id: string, enabled: boolean): void {
  run("UPDATE servers SET enabled = ?, updated = ? WHERE user_sub = ? AND id = ?", enabled ? 1 : 0, Date.now(), sub, id);
}

export function setToolEnabled(rec: ServerRecord, tool: string, enabled: boolean): void {
  const set = new Set(rec.disabledTools);
  if (enabled) set.delete(tool);
  else set.add(tool);
  run("UPDATE servers SET disabled_tools = ?, updated = ? WHERE id = ?", JSON.stringify([...set].slice(0, 1000)), Date.now(), rec.id);
}

/** Replaces static credentials (bearer / header). */
export async function setStaticAuth(sub: string, id: string, type: AuthType, auth: StaticAuth | null): Promise<void> {
  run(
    "UPDATE servers SET auth_type = ?, auth_sealed = ?, oauth_sealed = NULL, tokens_sealed = NULL, token_version = token_version + 1, status = ?, updated = ? WHERE user_sub = ? AND id = ?",
    type,
    auth ? await seal(auth) : null,
    type === "oauth" ? "pending" : "ok",
    Date.now(),
    sub,
    id,
  );
}

export function saveCatalog(id: string, info: McpServerInfo | null, tools: RawTool[]): void {
  run(
    "UPDATE servers SET server_info = ?, catalog = ?, catalog_at = ?, last_error = NULL WHERE id = ?",
    info ? JSON.stringify(info) : null,
    JSON.stringify(tools),
    Date.now(),
    id,
  );
}

export function setLastError(id: string, message: string | null): void {
  run("UPDATE servers SET last_error = ? WHERE id = ?", message ? message.slice(0, 300) : null, id);
}

export function setTransport(id: string, transport: "streamable" | "sse"): void {
  run("UPDATE servers SET transport = ? WHERE id = ?", transport, id);
}

const lastUsedWrites = new Map<string, number>();
export function noteUsed(id: string): void {
  const now = Date.now();
  if (now - (lastUsedWrites.get(id) ?? 0) < 60_000) return;
  lastUsedWrites.set(id, now);
  if (lastUsedWrites.size > 10_000) lastUsedWrites.clear();
  run("UPDATE servers SET last_used = ? WHERE id = ?", now, id);
}

export function markReauth(id: string): void {
  run("UPDATE servers SET status = 'reauth', updated = ? WHERE id = ?", Date.now(), id);
}

/* ---------------------------------------------------------- secrets (read) */

export async function serverUrl(id: string): Promise<URL> {
  const r = get("SELECT url_sealed FROM servers WHERE id = ?", id);
  const raw = await unseal<string>(strv(r?.url_sealed));
  if (!raw) throw new UserMcpError("failed", "stored server URL is unreadable");
  return checkServerUrl(raw);
}

export async function oauthConfig(id: string): Promise<McpOAuthConfig | null> {
  return unseal<McpOAuthConfig>(strv(get("SELECT oauth_sealed FROM servers WHERE id = ?", id)?.oauth_sealed) || undefined);
}

export async function setOAuthConfig(id: string, cfg: McpOAuthConfig): Promise<void> {
  run("UPDATE servers SET oauth_sealed = ?, updated = ? WHERE id = ?", await seal(cfg), Date.now(), id);
}

/** Stores tokens from a completed authorization (status back to ok). */
export async function saveTokens(id: string, tokens: McpTokenSet): Promise<void> {
  run(
    "UPDATE servers SET tokens_sealed = ?, token_version = token_version + 1, status = 'ok', last_error = NULL, updated = ? WHERE id = ?",
    await seal(tokens),
    Date.now(),
    id,
  );
}

/* ------------------------------------------------------------ oauth tokens */

const g = globalThis as typeof globalThis & { __zwUserMcpRefresh?: Map<string, Promise<McpTokenSet>> };
const inflight = (g.__zwUserMcpRefresh ??= new Map());
const EARLY_MS = 60_000;

const reauthError = () => new UserMcpError("auth_required", "the MCP server authorization expired or was revoked; reconnect it in Settings → Apps & bots");

async function readTokens(r: Row): Promise<McpTokenSet> {
  const t = await unseal<McpTokenSet>(strv(r.tokens_sealed) || undefined);
  if (!t?.accessToken) throw reauthError();
  return t;
}

async function doRefresh(id: string, seenVersion: number): Promise<McpTokenSet> {
  const r = get("SELECT * FROM servers WHERE id = ?", id);
  if (!r) throw new UserMcpError("not_found", "server not found");
  if (strv(r.status) === "reauth") throw reauthError();
  const current = await readTokens(r);
  // Someone else refreshed since we read: use theirs.
  if (num(r.token_version) !== seenVersion && (!current.expiresAt || current.expiresAt - EARLY_MS > Date.now())) return current;
  const cfg = await oauthConfig(id);
  if (!cfg) throw reauthError();
  let next: McpTokenSet;
  try {
    next = await refreshTokens(cfg, current);
  } catch (e) {
    if (e instanceof McpReauthNeeded) {
      run("UPDATE servers SET status = 'reauth', updated = ? WHERE id = ? AND token_version = ?", Date.now(), id, num(r.token_version));
      throw reauthError();
    }
    throw e;
  }
  // Persist before use: if this write doesn't land, the rotated refresh token must not be relied on.
  const changed = num(
    run(
      "UPDATE servers SET tokens_sealed = ?, token_version = token_version + 1, updated = ? WHERE id = ? AND token_version = ?",
      await seal(next),
      Date.now(),
      id,
      num(r.token_version),
    ).changes,
  );
  if (!changed) throw reauthError();
  return next;
}

function refreshOnce(id: string, seenVersion: number): Promise<McpTokenSet> {
  let p = inflight.get(id);
  if (!p) {
    p = doRefresh(id, seenVersion).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

async function oauthAccessToken(id: string, force: boolean): Promise<string> {
  const pending = inflight.get(id);
  if (pending) return (await pending).accessToken;
  const r = get("SELECT * FROM servers WHERE id = ?", id);
  if (!r) throw new UserMcpError("not_found", "server not found");
  if (strv(r.status) !== "ok") throw reauthError();
  const tokens = await readTokens(r);
  const expiring = tokens.expiresAt != null && tokens.expiresAt - EARLY_MS <= Date.now();
  if (!force && !expiring) return tokens.accessToken;
  if (!tokens.refreshToken) {
    markReauth(id);
    throw reauthError();
  }
  return (await refreshOnce(id, num(r.token_version))).accessToken;
}

/**
 * Credential headers for a request to the server. force=true after a 401: OAuth refreshes once;
 * static credentials can't be fixed here, so the server is marked as needing new credentials.
 */
export async function authHeaders(rec: Pick<ServerRecord, "id" | "authType">, force = false): Promise<Record<string, string>> {
  switch (rec.authType) {
    case "none":
      return {};
    case "oauth":
      return { Authorization: `Bearer ${await oauthAccessToken(rec.id, force)}` };
    case "bearer":
    case "header": {
      const a = await unseal<StaticAuth>(strv(get("SELECT auth_sealed FROM servers WHERE id = ?", rec.id)?.auth_sealed) || undefined);
      if (!a) throw new UserMcpError("auth_required", "stored credentials are unreadable; enter them again");
      if (force) {
        markReauth(rec.id);
        throw new UserMcpError("auth_required", "the MCP server refused the stored credentials; update them in Settings → Apps & bots");
      }
      return "token" in a ? { Authorization: `Bearer ${a.token}` } : { [a.name]: a.value };
    }
  }
}

/* ----------------------------------------------------------------- remove */

/** Deletes the server (grants cascade) and revokes OAuth tokens when the server supports it. */
export async function deleteServer(sub: string, id: string): Promise<{ revoked: boolean } | null> {
  const r = get("SELECT * FROM servers WHERE user_sub = ? AND id = ?", sub, id);
  if (!r) return null;
  let tokens: McpTokenSet | null = null;
  let cfg: McpOAuthConfig | null = null;
  if (strv(r.auth_type) === "oauth") {
    tokens = await unseal<McpTokenSet>(strv(r.tokens_sealed) || undefined);
    cfg = await oauthConfig(id);
  }
  run("DELETE FROM servers WHERE user_sub = ? AND id = ?", sub, id);
  inflight.delete(id);
  const revoked = tokens && cfg ? await revokeTokens(cfg, tokens) : false;
  return { revoked };
}

/** Forgets OAuth tokens (and revokes them) before a fresh authorization. */
export async function forgetTokens(id: string): Promise<void> {
  const r = get("SELECT tokens_sealed FROM servers WHERE id = ?", id);
  const tokens = await unseal<McpTokenSet>(strv(r?.tokens_sealed) || undefined);
  const cfg = await oauthConfig(id);
  run("UPDATE servers SET tokens_sealed = NULL, token_version = token_version + 1, status = 'pending', updated = ? WHERE id = ?", Date.now(), id);
  inflight.delete(id);
  if (tokens && cfg) await revokeTokens(cfg, tokens);
}
