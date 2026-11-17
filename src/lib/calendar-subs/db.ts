// External calendar subscriptions on Node's built-in SQLite: ${DATA_DIR:-./data}/calendar-subs.sqlite.
// Server-only. Feed URLs are secrets (Google's "secret address", published Outlook links), so they
// are stored sealed (lib/crypto seal, AES-256-GCM); the parsed feed is cached per subscription so
// page loads never wait for a remote fetch.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

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
  CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    url_sealed TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    visible INTEGER NOT NULL DEFAULT 1,
    busy INTEGER NOT NULL DEFAULT 1,
    refresh_min INTEGER NOT NULL DEFAULT 15,
    etag TEXT NOT NULL DEFAULT '',
    last_modified TEXT NOT NULL DEFAULT '',
    last_attempt INTEGER NOT NULL DEFAULT 0,
    last_success INTEGER NOT NULL DEFAULT 0,
    next_fetch INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    event_count INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
  );
  CREATE INDEX subscriptions_owner ON subscriptions(owner, created);
  CREATE INDEX subscriptions_due ON subscriptions(next_fetch);

  CREATE TABLE feed_cache (
    sub_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched INTEGER NOT NULL
  );
  `,
];

function open(): Database {
  const dir = resolve(process.env.DATA_DIR?.trim() || "./data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "calendar-subs.sqlite"), { timeout: 5000 });
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

const g = globalThis as typeof globalThis & { __zwCalSubsDb?: Database };
const db = () => (g.__zwCalSubsDb ??= open());

const s = (v: SQLValue | undefined) => (v == null ? "" : String(v));
const n = (v: SQLValue | undefined) => Number(v ?? 0);

export type SubscriptionRow = {
  id: string;
  owner: string;
  name: string;
  urlSealed: string;
  host: string;
  color: string;
  visible: boolean;
  busy: boolean;
  refreshMin: number;
  etag: string;
  lastModified: string;
  lastAttempt: number;
  lastSuccess: number;
  nextFetch: number;
  failures: number;
  lastError: string;
  eventCount: number;
  created: number;
};

const toRow = (r: Row): SubscriptionRow => ({
  id: s(r.id),
  owner: s(r.owner),
  name: s(r.name),
  urlSealed: s(r.url_sealed),
  host: s(r.host),
  color: s(r.color),
  visible: n(r.visible) === 1,
  busy: n(r.busy) === 1,
  refreshMin: n(r.refresh_min),
  etag: s(r.etag),
  lastModified: s(r.last_modified),
  lastAttempt: n(r.last_attempt),
  lastSuccess: n(r.last_success),
  nextFetch: n(r.next_fetch),
  failures: n(r.failures),
  lastError: s(r.last_error),
  eventCount: n(r.event_count),
  created: n(r.created),
});

export const listByOwner = (owner: string): SubscriptionRow[] =>
  db().prepare("SELECT * FROM subscriptions WHERE owner = ? ORDER BY created, id").all(owner).map(toRow);

export const countByOwner = (owner: string): number =>
  n(db().prepare("SELECT COUNT(*) AS c FROM subscriptions WHERE owner = ?").get(owner)?.c);

export function getSubscription(id: string): SubscriptionRow | null {
  const r = db().prepare("SELECT * FROM subscriptions WHERE id = ?").get(id);
  return r ? toRow(r) : null;
}

/** Subscriptions whose refresh is due, oldest first. */
export const dueSubscriptions = (now: number, limit: number): SubscriptionRow[] =>
  db().prepare("SELECT * FROM subscriptions WHERE next_fetch <= ? ORDER BY next_fetch LIMIT ?").all(now, limit).map(toRow);

export function insertSubscription(row: Pick<SubscriptionRow, "id" | "owner" | "name" | "urlSealed" | "host" | "color" | "busy" | "refreshMin">): void {
  db()
    .prepare(
      `INSERT INTO subscriptions (id, owner, name, url_sealed, host, color, visible, busy, refresh_min, created)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(row.id, row.owner, row.name, row.urlSealed, row.host, row.color, row.busy ? 1 : 0, row.refreshMin, Date.now());
}

export function updateSettings(
  id: string,
  owner: string,
  patch: Partial<Pick<SubscriptionRow, "name" | "color" | "visible" | "busy" | "refreshMin">>,
): boolean {
  const sets: string[] = [];
  const values: SQLValue[] = [];
  if (patch.name !== undefined) sets.push("name = ?"), values.push(patch.name);
  if (patch.color !== undefined) sets.push("color = ?"), values.push(patch.color);
  if (patch.visible !== undefined) sets.push("visible = ?"), values.push(patch.visible ? 1 : 0);
  if (patch.busy !== undefined) sets.push("busy = ?"), values.push(patch.busy ? 1 : 0);
  if (patch.refreshMin !== undefined) sets.push("refresh_min = ?"), values.push(patch.refreshMin);
  if (!sets.length) return true;
  const r = db().prepare(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ? AND owner = ?`).run(...values, id, owner);
  return Number(r.changes) > 0;
}

export function deleteSubscription(id: string, owner: string): boolean {
  const r = db().prepare("DELETE FROM subscriptions WHERE id = ? AND owner = ?").run(id, owner);
  db().prepare("DELETE FROM feed_cache WHERE sub_id = ?").run(id);
  return Number(r.changes) > 0;
}

/** Records a successful fetch (new data, or 304 when `data` is null). */
export function recordSuccess(
  id: string,
  at: number,
  nextFetch: number,
  validators: { etag: string; lastModified: string },
  data: { json: string; eventCount: number } | null,
): void {
  const d = db();
  d.exec("BEGIN");
  try {
    const r = d
      .prepare(
        `UPDATE subscriptions SET etag = ?, last_modified = ?, last_attempt = ?, last_success = ?, next_fetch = ?,
         failures = 0, last_error = '' WHERE id = ?`,
      )
      .run(validators.etag, validators.lastModified, at, at, nextFetch, id);
    // Removed while the fetch was running: don't leave a cache row behind.
    if (data && Number(r.changes) > 0) {
      d.prepare(
        `INSERT INTO feed_cache (sub_id, data, fetched) VALUES (?, ?, ?)
         ON CONFLICT(sub_id) DO UPDATE SET data = excluded.data, fetched = excluded.fetched`,
      ).run(id, data.json, at);
      d.prepare("UPDATE subscriptions SET event_count = ? WHERE id = ?").run(data.eventCount, id);
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function recordFailure(id: string, at: number, nextFetch: number, error: string): void {
  db()
    .prepare("UPDATE subscriptions SET last_attempt = ?, next_fetch = ?, failures = failures + 1, last_error = ? WHERE id = ?")
    .run(at, nextFetch, error.slice(0, 60), id);
}

/** Pushes the next refresh to `at` (used to claim a subscription before fetching it). */
export const setNextFetch = (id: string, at: number) => db().prepare("UPDATE subscriptions SET next_fetch = ? WHERE id = ?").run(at, id);

export function readCache(id: string): { data: string; fetched: number } | null {
  const r = db().prepare("SELECT data, fetched FROM feed_cache WHERE sub_id = ?").get(id);
  return r ? { data: s(r.data), fetched: n(r.fetched) } : null;
}
