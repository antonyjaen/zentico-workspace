// Per-user dashboards and the Dashboard's Claude chat. Server-only.
// ${DATA_DIR:-./data}/dashboard.sqlite holds each user's current document, the last
// VERSIONS_KEPT previous documents (undo) and the chat turns (each one a command for the user's
// own bridge, see src/lib/dashboard/commands.ts). Every function takes the acting user's email and
// scopes its queries by it. Single instance: the change notifier below is in memory.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  applyOps,
  defaultDoc,
  isFinalTurn,
  sanitizeDoc,
  VERSIONS_KEPT,
  type DashboardDoc,
  type DashOp,
  type TurnStatus,
  type TurnView,
} from "@/app/(apps)/dashboard/model";
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

export type DashboardEvent = { type: "doc"; doc: DashboardDoc } | { type: "chat" };

const g = globalThis as typeof globalThis & {
  __zwDashDb?: Database;
  __zwDashListeners?: Map<string, Set<(e: DashboardEvent) => void>>;
};
const db = () => (g.__zwDashDb ??= open());
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

/* --------------------------------------------------------------- documents */

export const newWidgetId = () => `w_${randomBytes(6).toString("hex")}`;

function parse(json: string): DashboardDoc | null {
  try {
    return sanitizeDoc(JSON.parse(json));
  } catch {
    return null;
  }
}

/** The user's dashboard (created from the default on first use, in the user's locale). */
export function getDashboard(email: string, locale = "es"): DashboardDoc {
  const key = norm(email);
  const row = db().prepare("SELECT doc, version FROM dashboards WHERE user_email = ?").get(key);
  const doc = row ? parse(s(row.doc)) : null;
  if (row && doc) return { ...doc, version: Number(row.version) };
  const fresh = defaultDoc(locale, newWidgetId);
  db()
    .prepare(
      `INSERT INTO dashboards (user_email, doc, version, updated) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_email) DO UPDATE SET doc = excluded.doc, version = dashboards.version + 1, updated = excluded.updated`,
    )
    .run(key, JSON.stringify(fresh), fresh.version, Date.now());
  return getDashboard(email, locale);
}

/** Stores `next` as the current document, keeping `prev` for undo. Returns the saved document. */
function save(email: string, prev: DashboardDoc | null, next: DashboardDoc): DashboardDoc {
  const key = norm(email);
  const now = Date.now();
  const d = db();
  const current = Number(d.prepare("SELECT version FROM dashboards WHERE user_email = ?").get(key)?.version ?? 0);
  const saved: DashboardDoc = { ...next, version: Math.max(current, next.version) + 1 };
  d.exec("BEGIN");
  try {
    if (prev) {
      d.prepare("INSERT INTO versions (user_email, doc, created) VALUES (?, ?, ?)").run(key, JSON.stringify(prev), now);
      d.prepare(
        "DELETE FROM versions WHERE user_email = ? AND id NOT IN (SELECT id FROM versions WHERE user_email = ? ORDER BY id DESC LIMIT ?)",
      ).run(key, key, VERSIONS_KEPT);
    }
    d.prepare(
      `INSERT INTO dashboards (user_email, doc, version, updated) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_email) DO UPDATE SET doc = excluded.doc, version = excluded.version, updated = excluded.updated`,
    ).run(key, JSON.stringify(saved), saved.version, now);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  publish(email, { type: "doc", doc: saved });
  return saved;
}

/** Applies edit operations (validated; throws DashError) and saves one undo step. */
export function editDashboard(email: string, ops: DashOp[], locale?: string): { doc: DashboardDoc; added: string[] } {
  const prev = getDashboard(email, locale);
  const { doc, added } = applyOps(prev, ops, newWidgetId);
  return { doc: save(email, prev, doc), added };
}

/** Restores the previous version. Returns null when there is nothing to undo. */
export function undoDashboard(email: string, locale?: string): DashboardDoc | null {
  const key = norm(email);
  const row = db().prepare("SELECT id, doc FROM versions WHERE user_email = ? ORDER BY id DESC LIMIT 1").get(key);
  if (!row) return null;
  const prevDoc = parse(s(row.doc));
  db().prepare("DELETE FROM versions WHERE id = ?").run(Number(row.id));
  if (!prevDoc) return undoDashboard(email, locale);
  const current = getDashboard(email, locale);
  return save(email, null, { ...prevDoc, version: current.version });
}

export const undoCount = (email: string) => Number(db().prepare("SELECT COUNT(*) AS n FROM versions WHERE user_email = ?").get(norm(email))?.n ?? 0);

/** Back to the default dashboard (undoable). */
export function resetDashboard(email: string, locale = "es"): DashboardDoc {
  const prev = getDashboard(email, locale);
  return save(email, prev, { ...defaultDoc(locale, newWidgetId), version: prev.version });
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
