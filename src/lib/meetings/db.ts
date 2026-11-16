// Meeting recordings storage: metadata in Node's built-in SQLite (DATA_DIR/meetings.sqlite, WAL)
// and audio under DATA_DIR/meetings/<id>/. Server-only. The app runs as a single instance, so one
// process owns the file; the connection is cached on globalThis so dev hot reloads reuse it.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Minimal local typings (independent of the Chat module's node:sqlite declarations).
type SQLValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SQLValue>;
type Statement = {
  run(...params: SQLValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SQLValue[]): Row | undefined;
  all(...params: SQLValue[]): Row[];
};
type Database = { exec(sql: string): void; prepare(sql: string): Statement };
type SqliteModule = {
  DatabaseSync: new (path: string, options?: { enableForeignKeyConstraints?: boolean; timeout?: number }) => Database;
};

// Loaded at runtime so neither webpack nor Turbopack tries to resolve/bundle the builtin.
const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule(
  "node:sqlite",
) as SqliteModule;

export const dataDir = () => resolve(process.env.DATA_DIR?.trim() || "./data");
export const meetingsDir = () => join(dataDir(), "meetings");

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    started_by TEXT NOT NULL,
    started_by_name TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_activity INTEGER NOT NULL,
    time_zone TEXT,
    participants TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (status IN ('recording', 'processing', 'ready', 'failed')),
    error TEXT,
    transcript TEXT,
    markdown TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    drive_file_id TEXT,
    drive_folder_id TEXT,
    -- The starter's session, sealed (AES-GCM), so the background job can write to their Drive.
    -- Cleared once the transcript is saved.
    starter_session TEXT,
    session_at INTEGER
  );
  CREATE INDEX meetings_room ON meetings(room, status);
  CREATE INDEX meetings_status ON meetings(status);

  -- Everyone who may read a recording: the starter plus every speaker seen in uploads.
  CREATE TABLE meeting_people (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    PRIMARY KEY (meeting_id, email)
  );
  CREATE INDEX meeting_people_email ON meeting_people(email, meeting_id);

  -- One continuous audio recording of one speaker's track (a new one whenever a track restarts).
  CREATE TABLE segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    identity TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    offset_ms INTEGER NOT NULL,
    mime TEXT NOT NULL,
    next_seq INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    UNIQUE (meeting_id, client_id)
  );
  CREATE INDEX segments_meeting ON segments(meeting_id, offset_ms);
  `,
  // Optional video (LiveKit room-composite egress → MP4 → starter's Drive). video_status:
  // NULL (audio only) | recording | processing (egress finishing) | uploading (MP4 on disk,
  // waiting for Drive) | ready | failed.
  `
  ALTER TABLE meetings ADD COLUMN egress_id TEXT;
  ALTER TABLE meetings ADD COLUMN video_status TEXT;
  ALTER TABLE meetings ADD COLUMN video_error TEXT;
  ALTER TABLE meetings ADD COLUMN video_bytes INTEGER;
  ALTER TABLE meetings ADD COLUMN video_file_id TEXT;
  ALTER TABLE meetings ADD COLUMN video_folder_id TEXT;
  ALTER TABLE meetings ADD COLUMN video_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE meetings ADD COLUMN video_next_at INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX meetings_video ON meetings(video_status);
  `,
];

function open(): Database {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "meetings.sqlite"), { enableForeignKeyConstraints: true, timeout: 5000 });
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

const g = globalThis as typeof globalThis & { __zwMeetingsDb?: Database };

function db(): Database {
  g.__zwMeetingsDb ??= open();
  return g.__zwMeetingsDb;
}

export const all = (sql: string, ...params: SQLValue[]) => db().prepare(sql).all(...params);
export const get = (sql: string, ...params: SQLValue[]) => db().prepare(sql).get(...params);
export const run = (sql: string, ...params: SQLValue[]) => db().prepare(sql).run(...params);

/** Runs fn in a transaction (node:sqlite is synchronous, so nothing interleaves). */
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

export const str = (v: SQLValue | undefined): string => (typeof v === "string" ? v : v == null ? "" : String(v));
export const strOrNull = (v: SQLValue | undefined): string | null => (typeof v === "string" ? v : null);
export const num = (v: SQLValue | undefined): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0);
export const numOrNull = (v: SQLValue | undefined): number | null => (v == null ? null : num(v));
