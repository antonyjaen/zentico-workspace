// Notification center storage and live delivery. Server-only.
// ${DATA_DIR:-./data}/notifications.sqlite keeps each user's recent notifications (30 days) with
// their read state, and their notification preferences; both keyed by the user's email, so they
// are the same across tabs and devices. Live delivery is an in-process bus (single instance, like
// Chat): every function only ever emits to the owning user's channel.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_PREFS,
  KEEP_MS,
  LIST_LIMIT,
  parsePrefs,
  prefAllows,
  type AppNotification,
  type NotificationCategory,
  type NotificationKind,
  type NotificationPrefs,
  type NotifyEvent,
} from "./types";

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
) as { DatabaseSync: new (path: string, options?: { timeout?: number }) => Database };

const MIGRATIONS = [
  `
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    category TEXT NOT NULL,
    kind TEXT NOT NULL,
    -- Coalescing / dedupe key (e.g. "chat:<conversation>"), unique per user while unread.
    key TEXT,
    ref TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    href TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    count INTEGER NOT NULL DEFAULT 1,
    created INTEGER NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX notifications_user ON notifications(user_email, created);
  CREATE INDEX notifications_key ON notifications(user_email, key);

  CREATE TABLE prefs (
    user_email TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated INTEGER NOT NULL
  );
  `,
  // Removed from the list by the user. Kept (read) rather than deleted so one-shot notifications
  // such as reminders are not recorded again.
  `ALTER TABLE notifications ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;`,
];

function open(): Database {
  const dir = resolve(process.env.DATA_DIR?.trim() || "./data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "notifications.sqlite"), { timeout: 5000 });
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

const g = globalThis as typeof globalThis & {
  __zwNotifyDb?: Database;
  __zwNotifyBus?: EventEmitter;
  __zwNotifyPrefs?: Map<string, NotificationPrefs>;
  __zwNotifyPruned?: number;
};
const db = () => (g.__zwNotifyDb ??= open());
const prefsCache = (g.__zwNotifyPrefs ??= new Map());

function bus(): EventEmitter {
  if (!g.__zwNotifyBus) {
    g.__zwNotifyBus = new EventEmitter();
    g.__zwNotifyBus.setMaxListeners(0);
  }
  return g.__zwNotifyBus;
}

export const normEmail = (email: string) => email.trim().toLowerCase();
const channel = (email: string) => `n:${normEmail(email)}`;

function emit(email: string, event: NotifyEvent) {
  bus().emit(channel(email), event);
}

/** Pushes a live-only event (not stored) to all of a user's open tabs, e.g. a ringing call. */
export function pushEvent(email: string, event: NotifyEvent): void {
  emit(email, event);
}

export function subscribe(email: string, listener: (event: NotifyEvent) => void): () => void {
  const b = bus();
  const ch = channel(email);
  b.on(ch, listener);
  return () => b.off(ch, listener);
}

const s = (v: SQLValue | undefined) => (v == null ? "" : String(v));

function toNotification(r: Row): AppNotification {
  return {
    id: s(r.id),
    category: s(r.category) as NotificationCategory,
    kind: s(r.kind) as NotificationKind,
    title: s(r.title),
    body: s(r.body),
    href: s(r.href),
    priority: r.priority === "high" ? "high" : "normal",
    ref: r.ref == null ? null : s(r.ref),
    count: Number(r.count ?? 1),
    created: Number(r.created),
    read: Number(r.read) === 1,
  };
}

/** Drops notifications older than 30 days; at most once an hour. */
function prune(now = Date.now()) {
  if (g.__zwNotifyPruned && now - g.__zwNotifyPruned < 3_600_000) return;
  g.__zwNotifyPruned = now;
  db().prepare("DELETE FROM notifications WHERE created < ?").run(now - KEEP_MS);
}

/* ------------------------------------------------------------------ prefs */

export function getPrefs(email: string): NotificationPrefs {
  const key = normEmail(email);
  const hit = prefsCache.get(key);
  if (hit) return hit;
  const r = db().prepare("SELECT data FROM prefs WHERE user_email = ?").get(key);
  let prefs = DEFAULT_PREFS;
  if (r) {
    try {
      prefs = parsePrefs(JSON.parse(s(r.data)));
    } catch {
      prefs = DEFAULT_PREFS;
    }
  }
  if (prefsCache.size > 5000) prefsCache.clear();
  prefsCache.set(key, prefs);
  return prefs;
}

export function savePrefs(email: string, input: unknown): NotificationPrefs {
  const key = normEmail(email);
  const prefs = parsePrefs(input, getPrefs(key));
  db()
    .prepare(
      "INSERT INTO prefs (user_email, data, updated) VALUES (?, ?, ?) ON CONFLICT(user_email) DO UPDATE SET data = excluded.data, updated = excluded.updated",
    )
    .run(key, JSON.stringify(prefs), Date.now());
  prefsCache.set(key, prefs);
  emit(key, { type: "prefs", prefs });
  return prefs;
}

/* ---------------------------------------------------------- notifications */

export type NotifyInput = {
  category: NotificationCategory;
  kind: NotificationKind;
  title: string;
  body?: string;
  href: string;
  priority?: "high" | "normal";
  ref?: string | null;
  /**
   * Coalescing key: while an unread notification with the same key exists it is updated (count+1,
   * newest text) instead of adding another one.
   */
  key?: string;
  /** With `key`: skip entirely if a notification with this key was ever stored (30 days). */
  once?: boolean;
};

const clean = (v: string, max: number) =>
  v
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * Records a notification for one user and pushes it to their open tabs. Respects the user's
 * category preferences (switched-off categories are not recorded). Never throws: notifications
 * must not break the action that caused them.
 */
export function notify(email: string, input: NotifyInput): AppNotification | null {
  try {
    const user = normEmail(email);
    if (!user || !prefAllows(getPrefs(user), input.category)) return null;
    if (!input.href.startsWith("/") || input.href.startsWith("//")) return null;
    const now = Date.now();
    prune(now);
    const d = db();
    const title = clean(input.title, 200) || "—";
    const body = clean(input.body ?? "", 300);
    const key = input.key ? input.key.slice(0, 300) : null;

    if (key && input.once) {
      if (d.prepare("SELECT 1 AS x FROM notifications WHERE user_email = ? AND key = ? LIMIT 1").get(user, key)) return null;
    }
    if (key && !input.once) {
      const existing = d
        .prepare("SELECT id FROM notifications WHERE user_email = ? AND key = ? AND read = 0 ORDER BY created DESC LIMIT 1")
        .get(user, key);
      if (existing) {
        d.prepare("UPDATE notifications SET title = ?, body = ?, href = ?, priority = ?, count = count + 1, created = ? WHERE id = ?").run(
          title,
          body,
          input.href,
          input.priority ?? "normal",
          now,
          s(existing.id),
        );
        const row = d.prepare("SELECT * FROM notifications WHERE id = ?").get(s(existing.id));
        if (!row) return null;
        const n = toNotification(row);
        emit(user, { type: "notification", notification: n });
        return n;
      }
    }

    const n: AppNotification = {
      id: randomUUID(),
      category: input.category,
      kind: input.kind,
      title,
      body,
      href: input.href,
      priority: input.priority ?? "normal",
      ref: input.ref ?? null,
      count: 1,
      created: now,
      read: false,
    };
    d.prepare(
      `INSERT INTO notifications (id, user_email, category, kind, key, ref, title, body, href, priority, count, created, read)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0)`,
    ).run(n.id, user, n.category, n.kind, key, n.ref, n.title, n.body, n.href, n.priority, now);
    emit(user, { type: "notification", notification: n });
    return n;
  } catch (e) {
    console.error("[notifications] notify failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

export function listNotifications(email: string): { items: AppNotification[]; unread: number } {
  const user = normEmail(email);
  prune();
  const items = db()
    .prepare("SELECT * FROM notifications WHERE user_email = ? AND dismissed = 0 ORDER BY created DESC LIMIT ?")
    .all(user, LIST_LIMIT)
    .map(toNotification);
  const unread = Number(
    db()
      .prepare("SELECT count(*) AS n FROM notifications WHERE user_email = ? AND read = 0 AND dismissed = 0 AND created >= ?")
      .get(user, Date.now() - KEEP_MS)
      ?.n ?? 0,
  );
  return { items, unread };
}

export function markRead(email: string, ids: string[]): void {
  const user = normEmail(email);
  const list = [...new Set(ids)].filter((id) => /^[0-9a-f-]{36}$/.test(id)).slice(0, 200);
  if (!list.length) return;
  const r = db()
    .prepare(`UPDATE notifications SET read = 1 WHERE user_email = ? AND read = 0 AND id IN (${list.map(() => "?").join(",")})`)
    .run(user, ...list);
  if (Number(r.changes)) emit(user, { type: "read", ids: list });
}

export function markAllRead(email: string): void {
  const user = normEmail(email);
  const r = db().prepare("UPDATE notifications SET read = 1 WHERE user_email = ? AND read = 0").run(user);
  if (Number(r.changes)) emit(user, { type: "readAll" });
}

/** Removes notifications from the user's list (they stay recorded as read for de-duplication). */
export function dismiss(email: string, ids: string[]): void {
  const user = normEmail(email);
  const list = [...new Set(ids)].filter((id) => /^[0-9a-f-]{36}$/.test(id)).slice(0, 200);
  if (!list.length) return;
  const r = db()
    .prepare(`UPDATE notifications SET dismissed = 1, read = 1 WHERE user_email = ? AND dismissed = 0 AND id IN (${list.map(() => "?").join(",")})`)
    .run(user, ...list);
  if (Number(r.changes)) emit(user, { type: "removed", ids: list });
}

/** Empties the user's list. */
export function dismissAll(email: string): void {
  const user = normEmail(email);
  const r = db().prepare("UPDATE notifications SET dismissed = 1, read = 1 WHERE user_email = ? AND dismissed = 0").run(user);
  if (Number(r.changes)) emit(user, { type: "cleared" });
}

/** Marks a user's unread notifications about one thing (e.g. a conversation they just read) as read. */
export function markReadByRef(email: string, ref: string, categories: NotificationCategory[]): void {
  try {
    const user = normEmail(email);
    const rows = db()
      .prepare(
        `SELECT id FROM notifications WHERE user_email = ? AND ref = ? AND read = 0 AND category IN (${categories.map(() => "?").join(",")})`,
      )
      .all(user, ref, ...categories);
    if (rows.length) markRead(user, rows.map((r) => s(r.id)));
  } catch (e) {
    console.error("[notifications] markReadByRef failed:", e instanceof Error ? e.message : e);
  }
}
