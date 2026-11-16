// MCP personal access tokens and their audit log on Node's built-in SQLite. Server-only.
// Separate file from Chat: ${DATA_DIR:-./data}/mcp.sqlite. Single instance → one process owns it;
// the connection is cached on globalThis so dev hot reloads don't reopen it.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type SQLValue = null | number | bigint | string | Uint8Array;
type Row = Record<string, SQLValue>;
type Statement = {
  run(...params: SQLValue[]): { changes: number | bigint };
  get(...params: SQLValue[]): Row | undefined;
  all(...params: SQLValue[]): Row[];
};
type Database = { exec(sql: string): void; prepare(sql: string): Statement };

// Loaded at runtime so neither webpack nor Turbopack tries to bundle the builtin.
const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule(
  "node:sqlite",
) as { DatabaseSync: new (path: string) => Database };

const MIGRATIONS = [
  `
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    user_sub TEXT NOT NULL,
    user_email TEXT NOT NULL,
    user_name TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    -- OIDC refresh token sealed with lib/crypto seal(); '' once revoked.
    refresh_sealed TEXT NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER,
    last_used INTEGER,
    revoked INTEGER,
    needs_reauth INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX tokens_user ON tokens(user_sub);

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT NOT NULL,
    user_sub TEXT NOT NULL,
    tool TEXT NOT NULL,
    at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT
  );
  CREATE INDEX audit_user ON audit(user_sub, id);
  `,
  // Dedicated Stalwart API key (lib/mcp/credential.ts) sealed with seal(); '' for rows still on a
  // refresh token (until reconnected) and once revoked.
  `ALTER TABLE tokens ADD COLUMN credential_sealed TEXT NOT NULL DEFAULT '';`,
];

function open(): Database {
  const dir = process.env.DATA_DIR?.trim() || "./data";
  const path = resolve(join(dir, "mcp.sqlite"));
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

const g = globalThis as typeof globalThis & { __zwMcpDb?: Database };
const db = () => (g.__zwMcpDb ??= open());

/* ------------------------------------------------------------------ tokens */

export type Scope = "read" | "write";

export type TokenRow = {
  id: string;
  userSub: string;
  userEmail: string;
  userName: string;
  name: string;
  scope: Scope;
  tokenPrefix: string;
  refreshSealed: string;
  credentialSealed: string;
  created: number;
  expires: number | null;
  lastUsed: number | null;
  revoked: number | null;
  needsReauth: boolean;
};

const num = (v: SQLValue | undefined) => (v == null ? null : Number(v));

function toToken(r: Row): TokenRow {
  return {
    id: String(r.id),
    userSub: String(r.user_sub),
    userEmail: String(r.user_email),
    userName: String(r.user_name ?? ""),
    name: String(r.name),
    scope: r.scope === "write" ? "write" : "read",
    tokenPrefix: String(r.token_prefix),
    refreshSealed: String(r.refresh_sealed ?? ""),
    credentialSealed: String(r.credential_sealed ?? ""),
    created: Number(r.created),
    expires: num(r.expires),
    lastUsed: num(r.last_used),
    revoked: num(r.revoked),
    needsReauth: Number(r.needs_reauth) === 1,
  };
}

export function insertToken(t: {
  id: string;
  userSub: string;
  userEmail: string;
  userName: string;
  name: string;
  scope: Scope;
  tokenHash: string;
  tokenPrefix: string;
  credentialSealed: string;
  expires: number | null;
}): void {
  db()
    .prepare(
      `INSERT INTO tokens (id, user_sub, user_email, user_name, name, scope, token_hash, token_prefix, refresh_sealed, credential_sealed, created, expires)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
    )
    .run(t.id, t.userSub, t.userEmail, t.userName, t.name, t.scope, t.tokenHash, t.tokenPrefix, t.credentialSealed, Date.now(), t.expires);
}

export function tokenByHash(hash: string): TokenRow | null {
  const r = db().prepare("SELECT * FROM tokens WHERE token_hash = ?").get(hash);
  return r ? toToken(r) : null;
}

/** Active (not revoked) tokens of a user, newest first. */
export function userTokens(userSub: string): TokenRow[] {
  return db()
    .prepare("SELECT * FROM tokens WHERE user_sub = ? AND revoked IS NULL ORDER BY created DESC")
    .all(userSub)
    .map(toToken);
}

export function countUserTokens(userSub: string): number {
  return Number(db().prepare("SELECT COUNT(*) AS n FROM tokens WHERE user_sub = ? AND revoked IS NULL").get(userSub)?.n ?? 0);
}

/** Revokes one of the user's tokens and drops its stored credentials. True if it was active. */
export function revokeToken(id: string, userSub: string): boolean {
  const r = db()
    .prepare("UPDATE tokens SET revoked = ?, refresh_sealed = '', credential_sealed = '' WHERE id = ? AND user_sub = ? AND revoked IS NULL")
    .run(Date.now(), id, userSub);
  return Number(r.changes) > 0;
}

/** Binds the token to a (new) Stalwart API key; the legacy refresh token, if any, is dropped. */
export function updateCredential(id: string, credentialSealed: string): void {
  db()
    .prepare("UPDATE tokens SET credential_sealed = ?, refresh_sealed = '', needs_reauth = 0 WHERE id = ? AND revoked IS NULL")
    .run(credentialSealed, id);
}

export function markNeedsReauth(id: string): void {
  db().prepare("UPDATE tokens SET needs_reauth = 1 WHERE id = ?").run(id);
}

export function touchToken(id: string): void {
  db().prepare("UPDATE tokens SET last_used = ? WHERE id = ?").run(Date.now(), id);
}

/* ------------------------------------------------------------------- audit */

export type AuditRow = { id: number; tokenId: string; tokenName: string; tool: string; at: number; ok: boolean; error: string | null };

const AUDIT_KEEP_PER_USER = 1000;
let auditWrites = 0;

export function writeAudit(e: { tokenId: string; userSub: string; tool: string; ok: boolean; error?: string | null }): void {
  db()
    .prepare("INSERT INTO audit (token_id, user_sub, tool, at, ok, error) VALUES (?, ?, ?, ?, ?, ?)")
    .run(e.tokenId, e.userSub, e.tool.slice(0, 64), Date.now(), e.ok ? 1 : 0, e.error ? e.error.slice(0, 300) : null);
  // Prune occasionally: keep the newest rows per user.
  if (++auditWrites % 200 === 0) {
    db()
      .prepare(
        `DELETE FROM audit WHERE user_sub = ? AND id <= COALESCE(
           (SELECT id FROM audit WHERE user_sub = ? ORDER BY id DESC LIMIT 1 OFFSET ?), -1)`,
      )
      .run(e.userSub, e.userSub, AUDIT_KEEP_PER_USER);
  }
}

export function recentAudit(userSub: string, limit = 20): AuditRow[] {
  return db()
    .prepare(
      `SELECT a.id, a.token_id, COALESCE(t.name, '') AS token_name, a.tool, a.at, a.ok, a.error
       FROM audit a LEFT JOIN tokens t ON t.id = a.token_id
       WHERE a.user_sub = ? ORDER BY a.id DESC LIMIT ?`,
    )
    .all(userSub, limit)
    .map((r) => ({
      id: Number(r.id),
      tokenId: String(r.token_id),
      tokenName: String(r.token_name ?? ""),
      tool: String(r.tool),
      at: Number(r.at),
      ok: Number(r.ok) === 1,
      error: r.error == null ? null : String(r.error),
    }));
}
