// Chat storage on Node's built-in SQLite (node:sqlite). Server-only.
// One database file (CHAT_DB_PATH, default ./data/chat.sqlite) in WAL mode. The app runs as a
// single instance, so one process owns the file; the connection is cached on globalThis so dev
// hot reloads don't open it again.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync as Database, Row, SQLParam } from "node:sqlite";

// Loaded at runtime via process.getBuiltinModule so neither webpack nor Turbopack tries to
// resolve/bundle the (newer) builtin.
const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule(
  "node:sqlite",
) as typeof import("node:sqlite");

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sub TEXT UNIQUE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    last_seen INTEGER
  );

  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id),
    created INTEGER NOT NULL
  );

  CREATE TABLE team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined INTEGER NOT NULL,
    PRIMARY KEY (team_id, user_id)
  );
  CREATE INDEX team_members_user ON team_members(user_id);

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'channel')),
    name TEXT,
    description TEXT NOT NULL DEFAULT '',
    team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
    is_private INTEGER NOT NULL DEFAULT 0,
    -- "<lowId>:<highId>" for DMs, so each pair of people has exactly one.
    dm_key TEXT UNIQUE,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created INTEGER NOT NULL,
    last_activity INTEGER NOT NULL
  );
  CREATE INDEX conversations_team ON conversations(team_id);

  CREATE TABLE conversation_members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    last_read_id INTEGER NOT NULL DEFAULT 0,
    joined INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE INDEX conversation_members_user ON conversation_members(user_id);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_id INTEGER REFERENCES users(id),
    body TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL,
    edited INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0,
    thread_root_id INTEGER REFERENCES messages(id),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'meeting', 'system', 'file')),
    meta TEXT
  );
  CREATE INDEX messages_conv ON messages(conversation_id, thread_root_id, id);
  CREATE INDEX messages_thread ON messages(thread_root_id, id);

  CREATE TABLE reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE INDEX files_conv ON files(conversation_id);

  CREATE TABLE meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('instant', 'scheduled')),
    title TEXT NOT NULL DEFAULT '',
    starts_at INTEGER NOT NULL,
    ends_at INTEGER,
    ended_at INTEGER,
    created_by INTEGER NOT NULL REFERENCES users(id),
    message_id INTEGER REFERENCES messages(id),
    calendar_event_id TEXT
  );
  CREATE INDEX meetings_conv ON meetings(conversation_id, starts_at);
  `,
];

function open(): Database {
  const path = resolve(process.env.CHAT_DB_PATH?.trim() || "./data/chat.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
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

const g = globalThis as typeof globalThis & { __zwChatDb?: Database };

export function db(): Database {
  g.__zwChatDb ??= open();
  return g.__zwChatDb;
}

export const all = <T = Row>(sql: string, ...params: SQLParam[]) => db().prepare(sql).all(...params) as T[];
export const get = <T = Row>(sql: string, ...params: SQLParam[]) => db().prepare(sql).get(...params) as T | undefined;
export const run = (sql: string, ...params: SQLParam[]) => db().prepare(sql).run(...params);

/** Runs fn in a transaction (synchronous: node:sqlite is sync, so nothing interleaves). */
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
