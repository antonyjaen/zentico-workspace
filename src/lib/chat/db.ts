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
  // Apps and bots. Each one is also a `users` row (bot_id set, synthetic address on
  // BOT_EMAIL_DOMAIN, no sub) so it can be a member and an author like anyone else.
  // Rows are soft-deleted so old messages keep their author's identity.
  `
  ALTER TABLE users ADD COLUMN bot_id TEXT;

  CREATE TABLE bots (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('http', 'webhook', 'claude')),
    owner_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color INTEGER,
    avatar TEXT,
    -- HTTP apps: event endpoint, signing secret (sealed: it is needed in clear to sign), API token (sha256).
    endpoint_url TEXT,
    signing_secret TEXT,
    token_hash TEXT UNIQUE,
    token_prefix TEXT,
    -- Any member may add a shared app; a private one only its owner.
    shared INTEGER NOT NULL DEFAULT 0,
    -- Incoming webhooks: their conversation and key (sha256).
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    key_hash TEXT UNIQUE,
    deleted INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE INDEX bots_owner ON bots(owner_id, kind);
  CREATE INDEX bots_conv ON bots(conversation_id);

  CREATE TABLE bot_commands (
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (bot_id, name)
  );

  -- Last delivery attempts of each HTTP app (trimmed to 50).
  CREATE TABLE bot_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    event TEXT NOT NULL,
    conversation_id TEXT,
    status INTEGER,
    latency_ms INTEGER,
    error TEXT
  );
  CREATE INDEX bot_deliveries_bot ON bot_deliveries(bot_id, id);

  -- Webhook thread keys → the thread they started.
  CREATE TABLE webhook_threads (
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    root_id INTEGER NOT NULL REFERENCES messages(id),
    PRIMARY KEY (bot_id, key)
  );
  `,
  // Built-in apps (e.g. the GitHub app of Connected apps): one workspace-wide identity per app,
  // named in the "builtin" column. SQLite can't change a CHECK in place, so the table is rebuilt (foreign
  // keys are off while migrating, see open()).
  `
  CREATE TABLE bots_new (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('http', 'webhook', 'claude', 'builtin')),
    owner_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color INTEGER,
    avatar TEXT,
    endpoint_url TEXT,
    signing_secret TEXT,
    token_hash TEXT UNIQUE,
    token_prefix TEXT,
    shared INTEGER NOT NULL DEFAULT 0,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    key_hash TEXT UNIQUE,
    deleted INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    builtin TEXT UNIQUE
  );
  INSERT INTO bots_new (id, user_id, kind, owner_id, name, description, color, avatar, endpoint_url, signing_secret, token_hash,
    token_prefix, shared, conversation_id, key_hash, deleted, created, updated)
  SELECT id, user_id, kind, owner_id, name, description, color, avatar, endpoint_url, signing_secret, token_hash,
    token_prefix, shared, conversation_id, key_hash, deleted, created, updated FROM bots;
  DROP TABLE bots;
  ALTER TABLE bots_new RENAME TO bots;
  CREATE INDEX bots_owner ON bots(owner_id, kind);
  CREATE INDEX bots_conv ON bots(conversation_id);
  `,
  // Ringing calls (lib/chat/calls.ts): one row per call, one per person being called.
  // meeting_id is set only when the call started its own meeting (and owns that meeting's card).
  `
  CREATE TABLE calls (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    meeting_id INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
    room TEXT NOT NULL,
    caller_id INTEGER NOT NULL REFERENCES users(id),
    media TEXT NOT NULL CHECK (media IN ('audio', 'video')),
    state TEXT NOT NULL CHECK (state IN ('ringing', 'answered', 'cancelled', 'missed', 'declined', 'ended')),
    created INTEGER NOT NULL,
    answered_at INTEGER,
    ended_at INTEGER
  );
  CREATE INDEX calls_conv ON calls(conversation_id, created);
  CREATE INDEX calls_state ON calls(state, created);

  CREATE TABLE call_members (
    call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    state TEXT NOT NULL CHECK (state IN ('ringing', 'accepted', 'declined', 'missed', 'cancelled')),
    updated INTEGER NOT NULL,
    reply TEXT,
    PRIMARY KEY (call_id, user_id)
  );
  CREATE INDEX call_members_user ON call_members(user_id, state);
  `,
  // Shared tasks (lib/chat/tasks.ts): they live in a conversation; subtasks point at their task
  // (one level). due_at is the due instant (end of the day for date-only tasks); due_date/due_time
  // are the wall clock in due_tz as entered. due_notified: 1 = "due soon" sent, 2 = "overdue" sent.
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done')),
    priority TEXT CHECK (priority IN ('low', 'medium', 'high')),
    due_at INTEGER,
    due_date TEXT,
    due_time TEXT,
    due_tz TEXT,
    due_notified INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    completed_at INTEGER,
    completed_by INTEGER REFERENCES users(id)
  );
  CREATE INDEX tasks_conv ON tasks(conversation_id, parent_id, position);
  CREATE INDEX tasks_parent ON tasks(parent_id);
  CREATE INDEX tasks_due ON tasks(status, due_at);

  CREATE TABLE task_assignees (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    assigned_by INTEGER REFERENCES users(id),
    assigned INTEGER NOT NULL,
    PRIMARY KEY (task_id, user_id)
  );
  CREATE INDEX task_assignees_user ON task_assignees(user_id);
  `,
];

function open(): Database {
  const path = resolve(process.env.CHAT_DB_PATH?.trim() || "./data/chat.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  // Table rebuilds (DROP + RENAME) must not cascade: foreign keys are off while migrating and
  // checked afterwards (https://www.sqlite.org/lang_altertable.html#otheralter).
  if (version < MIGRATIONS.length) db.exec("PRAGMA foreign_keys = OFF;");
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      db.exec("PRAGMA foreign_keys = ON;");
      throw e;
    }
  }
  if (version < MIGRATIONS.length) {
    db.exec("PRAGMA foreign_keys = ON;");
    if (db.prepare("PRAGMA foreign_key_check").all().length) console.error("[chat] foreign key check failed after migrating");
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
