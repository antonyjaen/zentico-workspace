// The Dashboard's server state. Server-only.
// ${DATA_DIR:-./data}/dashboard.sqlite holds the Dashboard's Claude chat turns (each one a command
// for the user's own bridge, see src/lib/dashboard/commands.ts), the classic per-user widget
// documents (read once to migrate them into `Zentico UI/` files) and, since the UI moved to files
// in the user's Drive, the tables of src/lib/ui/store.ts (last valid UI, undo snapshots, mod grants
// and storage, gallery). Every function takes the acting user's email and scopes its queries by it.
// Single instance: the change notifier below is in memory.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isFinalTurn, sanitizeDoc, type DashboardDoc, type TurnStatus, type TurnView } from "@/app/(apps)/dashboard/model";
import { getCommand } from "../mcp/agent";

type SQLValue = null | number | bigint | string | Uint8Array;
type Row = Record<string, SQLValue>;
type Statement = {
  run(...params: SQLValue[]): { changes: number | bigint };
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
  CREATE TABLE dashboards (
    user_email TEXT PRIMARY KEY,
    doc TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE TABLE versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    doc TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE INDEX versions_user ON versions(user_email, id);
  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    text TEXT NOT NULL,
    command_id TEXT,
    status TEXT NOT NULL,
    result TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE INDEX turns_user ON turns(user_email, created);
  `,
  `
  CREATE TABLE ui_state (
    user_email TEXT PRIMARY KEY,
    folder_id TEXT,
    sig TEXT,
    valid_sig TEXT,
    compiled TEXT,
    files TEXT,
    errors TEXT NOT NULL DEFAULT '[]',
    updated INTEGER NOT NULL
  );
  CREATE TABLE ui_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    files TEXT NOT NULL,
    reason TEXT,
    created INTEGER NOT NULL
  );
  CREATE INDEX ui_history_user ON ui_history(user_email, id);
  CREATE TABLE ui_grants (
    user_email TEXT NOT NULL,
    mod_id TEXT NOT NULL,
    perms TEXT NOT NULL,
    always TEXT NOT NULL DEFAULT '[]',
    updated INTEGER NOT NULL,
    PRIMARY KEY (user_email, mod_id)
  );
  CREATE TABLE ui_storage (
    user_email TEXT NOT NULL,
    mod_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (user_email, mod_id, key)
  );
  CREATE TABLE ui_gallery (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    icon TEXT,
    author_email TEXT NOT NULL,
    author_name TEXT NOT NULL,
    payload TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '[]',
    installs INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
  );
  CREATE INDEX ui_gallery_created ON ui_gallery(created);
  CREATE TABLE ui_mod_asks (
    command_id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    mod_id TEXT NOT NULL,
    mod_name TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  `,
  // Where the user was ("Customize with Claude" from another app) when they sent a chat message.
  `
  CREATE TABLE ui_chat_where (
    command_id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    app TEXT NOT NULL,
    path TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  `,
];

function open(): Database {
  const dir = resolve(process.env.DATA_DIR?.trim() || "./data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "dashboard.sqlite"), { timeout: 5000 });
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

/** ui: the user's UI state changed (new valid UI or new errors); reload: open dashboards should re-sync with Drive. */
export type DashboardEvent = { type: "ui" } | { type: "reload" } | { type: "chat" };

const g = globalThis as typeof globalThis & {
  __zwDashDb?: Database;
  __zwDashListeners?: Map<string, Set<(e: DashboardEvent) => void>>;
};
const db = () => (g.__zwDashDb ??= open());
/** The shared database (also used by src/lib/ui/store.ts). */
export const dashboardDb = db;
export type { Database as DashboardDatabase, Row as DashboardRow, SQLValue as DashboardValue };
const listeners = (g.__zwDashListeners ??= new Map());

const norm = (email: string) => email.trim().toLowerCase();
const s = (v: SQLValue | undefined) => (v == null ? "" : String(v));

/* ---------------------------------------------------------------- notifier */

export function publish(email: string, event: DashboardEvent) {
  for (const fn of listeners.get(norm(email)) ?? []) {
    try {
      fn(event);
    } catch {
      // a closed stream unsubscribes itself
    }
  }
}

export function subscribe(email: string, fn: (e: DashboardEvent) => void): () => void {
  const key = norm(email);
  const set = listeners.get(key) ?? new Set();
  set.add(fn);
  listeners.set(key, set);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(key);
  };
}

/* ------------------------------------------------------- classic dashboard */

/** The classic (pre-files) dashboard of a user, if they ever had one; used once for migration. */
export function legacyDashboard(email: string): DashboardDoc | null {
  const row = db().prepare("SELECT doc FROM dashboards WHERE user_email = ?").get(norm(email));
  if (!row) return null;
  try {
    return sanitizeDoc(JSON.parse(s(row.doc)));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- chat */

export const TURNS_SHOWN = 60;

function toTurn(r: Row): TurnView {
  return {
    id: s(r.id),
    text: s(r.text),
    createdAt: Number(r.created),
    commandId: r.command_id == null ? null : s(r.command_id),
    status: s(r.status) as TurnStatus,
    progress: null,
    result: r.result == null ? null : s(r.result),
  };
}

export function addTurn(email: string, text: string, commandId: string, status: TurnStatus): TurnView {
  const id = randomUUID();
  const now = Date.now();
  db()
    .prepare("INSERT INTO turns (id, user_email, text, command_id, status, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, norm(email), text, commandId, status, now, now);
  publish(email, { type: "chat" });
  return { id, text, createdAt: now, commandId, status, progress: null, result: null };
}

/**
 * The user's latest turns (oldest first). Unfinished turns are refreshed from the command queue
 * (status, live progress); finished results are copied into the turn so the chat outlives the queue.
 */
export function listTurns(email: string, limit = TURNS_SHOWN): TurnView[] {
  const key = norm(email);
  const turns = db()
    .prepare("SELECT * FROM turns WHERE user_email = ? ORDER BY created DESC LIMIT ?")
    .all(key, limit)
    .map(toTurn)
    .reverse();
  for (const t of turns) {
    if (isFinalTurn(t.status) || !t.commandId) continue;
    const c = getCommand(t.commandId, email);
    if (!c) {
      t.status = "failed";
      t.result = "This request was lost.";
    } else {
      t.status = c.status;
      t.progress = c.progress;
      t.result = c.result;
    }
    if (isFinalTurn(t.status)) {
      db().prepare("UPDATE turns SET status = ?, result = ?, updated = ? WHERE id = ? AND user_email = ?").run(t.status, t.result, Date.now(), t.id, key);
    }
  }
  return turns;
}

export function clearTurns(email: string): void {
  db().prepare("DELETE FROM turns WHERE user_email = ?").run(norm(email));
  publish(email, { type: "chat" });
}
