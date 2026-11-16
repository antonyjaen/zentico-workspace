// Connected apps (third-party OAuth connections) on Node's built-in SQLite:
// ${DATA_DIR:-./data}/connect.sqlite. Tokens are stored sealed (lib/crypto seal, AES-256-GCM),
// never in clear. Single instance → one process owns the file; the connection is cached on
// globalThis so dev hot reloads don't reopen it. Server-only.
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
  -- One connection per user and provider. tokens_sealed = seal({ accessToken, refreshToken, expiresAt }).
  -- version is bumped on every token write (compare-and-swap for refreshes).
  CREATE TABLE connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_sub TEXT NOT NULL,
    user_email TEXT NOT NULL,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL DEFAULT '',
    account_name TEXT NOT NULL DEFAULT '',
    account_login TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    scopes TEXT NOT NULL DEFAULT '',
    tokens_sealed TEXT NOT NULL,
    -- Provider-specific, non-secret data (e.g. Atlassian cloud id and site URL).
    meta TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'reauth')),
    version INTEGER NOT NULL DEFAULT 1,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    last_used INTEGER,
    UNIQUE (user_sub, provider)
  );

  -- "/github subscribe owner/repo" in a chat conversation, polled with the subscriber's token.
  CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_sub TEXT NOT NULL,
    chat_user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    target TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    etag TEXT,
    created INTEGER NOT NULL,
    last_polled INTEGER,
    last_error TEXT,
    UNIQUE (conversation_id, provider, target)
  );
  CREATE INDEX subscriptions_user ON subscriptions(user_sub, provider);

  -- Items already seen by a subscription (dedupe; trimmed to the newest 500 per subscription).
  CREATE TABLE subscription_seen (
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (subscription_id, item)
  );
  `,
];

function open(): Database {
  const dir = resolve(process.env.DATA_DIR?.trim() || "./data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "connect.sqlite"), { timeout: 5000 });
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

const g = globalThis as typeof globalThis & { __zwConnectDb?: Database };
const db = () => (g.__zwConnectDb ??= open());

export const all = (sql: string, ...params: SQLValue[]) => db().prepare(sql).all(...params);
export const get = (sql: string, ...params: SQLValue[]) => db().prepare(sql).get(...params);
export const run = (sql: string, ...params: SQLValue[]) => db().prepare(sql).run(...params);

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
