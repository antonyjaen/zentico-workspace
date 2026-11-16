// Connected MCP servers (per user) on Node's built-in SQLite: ${DATA_DIR:-./data}/user-mcp.sqlite.
// Server URLs, static credentials, OAuth client data and tokens are stored sealed (lib/crypto seal,
// AES-256-GCM), never in clear. One process owns the file; the connection is cached on globalThis
// so dev hot reloads don't reopen it. Server-only.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

type SQLValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SQLValue>;
type Statement = {
  run(...params: SQLValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SQLValue[]): Row | undefined;
  all(...params: SQLValue[]): Row[];
};
type Database = { exec(sql: string): void; prepare(sql: string): Statement };

// Loaded at runtime so neither webpack nor Turbopack tries to bundle the builtin.
const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { timeout?: number }) => Database;
};

const MIGRATIONS = [
  `
  -- One row per MCP server a user connected.
  --   url_sealed    = seal(string)  (URLs may embed API keys in their path or query)
  --   host          = hostname, safe to display
  --   auth_sealed   = seal({ token } | { name, value }) for auth_type bearer / header
  --   oauth_sealed  = seal({ authServerUrl, metadata, client, resource, scope }) for auth_type oauth
  --   tokens_sealed = seal({ accessToken, refreshToken, expiresAt }) for auth_type oauth
  -- token_version is bumped on every token write (compare-and-swap for refreshes).
  CREATE TABLE servers (
    id TEXT PRIMARY KEY,
    user_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    url_sealed TEXT NOT NULL,
    host TEXT NOT NULL,
    transport TEXT NOT NULL DEFAULT 'auto' CHECK (transport IN ('auto', 'streamable', 'sse')),
    auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header', 'oauth')),
    auth_sealed TEXT,
    oauth_sealed TEXT,
    tokens_sealed TEXT,
    token_version INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'pending', 'reauth')),
    enabled INTEGER NOT NULL DEFAULT 1,
    -- JSON array of tool names the user switched off.
    disabled_tools TEXT NOT NULL DEFAULT '[]',
    -- Last known server info / tool catalog (JSON, no secrets) so lists work while a server is down.
    server_info TEXT,
    catalog TEXT,
    catalog_at INTEGER,
    last_error TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    last_used INTEGER,
    UNIQUE (user_sub, slug)
  );
  CREATE INDEX servers_user ON servers(user_sub);

  -- What a dashboard mod may call without asking again. tool = '*' covers the whole server.
  -- access 'write' = tools that may have side effects (anything not annotated readOnlyHint=true).
  CREATE TABLE mod_grants (
    user_sub TEXT NOT NULL,
    mod_id TEXT NOT NULL,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    access TEXT NOT NULL CHECK (access IN ('read', 'write')),
    created INTEGER NOT NULL,
    PRIMARY KEY (user_sub, mod_id, server_id, tool)
  );
  CREATE INDEX mod_grants_server ON mod_grants(server_id);
  `,
];

function open(): Database {
  const dir = resolve(process.env.DATA_DIR?.trim() || "./data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "user-mcp.sqlite"), { timeout: 5000 });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
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

const g = globalThis as typeof globalThis & { __zwUserMcpDb?: Database };
const db = () => (g.__zwUserMcpDb ??= open());

export const all = (sql: string, ...params: SQLValue[]) => db().prepare(sql).all(...params);
export const get = (sql: string, ...params: SQLValue[]) => db().prepare(sql).get(...params);
export const run = (sql: string, ...params: SQLValue[]) => db().prepare(sql).run(...params);
