// Booking pages storage on Node's built-in SQLite: ${DATA_DIR:-./data}/booking.sqlite. Server-only.
// hosts = owners who enabled booking pages (handle + sealed Stalwart API key), types = their
// booking pages, bookings = what guests booked (tokens stored as SHA-256 hashes only).
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BookingType, BookingTypeSettings } from "./types";

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
  CREATE TABLE hosts (
    user_sub TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    user_name TEXT NOT NULL DEFAULT '',
    handle TEXT NOT NULL UNIQUE,
    show_email INTEGER NOT NULL DEFAULT 0,
    locale TEXT NOT NULL DEFAULT 'es',
    -- Stalwart API key (lib/mcp/credential.ts) sealed with lib/crypto seal(); '' when disabled.
    credential_sealed TEXT NOT NULL DEFAULT '',
    needs_reauth INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
  );

  CREATE TABLE types (
    id TEXT PRIMARY KEY,
    user_sub TEXT NOT NULL,
    slug TEXT NOT NULL,
    data TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    UNIQUE (user_sub, slug)
  );

  CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    type_id TEXT NOT NULL,
    user_sub TEXT NOT NULL,
    starts INTEGER NOT NULL,
    ends INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
    guest_name TEXT NOT NULL,
    guest_email TEXT NOT NULL,
    guest_tz TEXT NOT NULL,
    locale TEXT NOT NULL,
    answers TEXT NOT NULL DEFAULT '[]',
    event_id TEXT NOT NULL DEFAULT '',
    event_uid TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    room TEXT NOT NULL DEFAULT '',
    manage_hash TEXT NOT NULL UNIQUE,
    join_hash TEXT NOT NULL UNIQUE,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE INDEX bookings_user ON bookings(user_sub, status, starts);
  CREATE INDEX bookings_type ON bookings(type_id, status, starts);
  `,
];

function open(): Database {
  const dir = resolve(process.env.DATA_DIR?.trim() || "./data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "booking.sqlite"), { timeout: 5000 });
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

const g = globalThis as typeof globalThis & { __zwBookingDb?: Database };
const db = () => (g.__zwBookingDb ??= open());

const s = (v: SQLValue | undefined) => (v == null ? "" : String(v));
const n = (v: SQLValue | undefined) => Number(v ?? 0);

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/* ------------------------------------------------------------------ hosts */

export type Host = {
  sub: string;
  email: string;
  name: string;
  handle: string;
  showEmail: boolean;
  locale: "es" | "en";
  credentialSealed: string;
  needsReauth: boolean;
};

const toHost = (r: Row): Host => ({
  sub: s(r.user_sub),
  email: s(r.user_email),
  name: s(r.user_name),
  handle: s(r.handle),
  showEmail: n(r.show_email) === 1,
  locale: s(r.locale) === "en" ? "en" : "es",
  credentialSealed: s(r.credential_sealed),
  needsReauth: n(r.needs_reauth) === 1,
});

export function hostBySub(sub: string): Host | null {
  const r = db().prepare("SELECT * FROM hosts WHERE user_sub = ?").get(sub);
  return r ? toHost(r) : null;
}

export function hostByHandle(handle: string): Host | null {
  const r = db().prepare("SELECT * FROM hosts WHERE handle = ?").get(handle);
  return r ? toHost(r) : null;
}

export const handleTaken = (handle: string, exceptSub: string) =>
  !!db().prepare("SELECT 1 AS x FROM hosts WHERE handle = ? AND user_sub != ?").get(handle, exceptSub);

/** Creates or updates the host row; `credentialSealed` undefined keeps the current one. */
export function upsertHost(h: Omit<Host, "credentialSealed" | "needsReauth"> & { credentialSealed?: string }): void {
  const d = db();
  const existing = hostBySub(h.sub);
  if (!existing) {
    d.prepare(
      "INSERT INTO hosts (user_sub, user_email, user_name, handle, show_email, locale, credential_sealed, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(h.sub, h.email, h.name, h.handle, h.showEmail ? 1 : 0, h.locale, h.credentialSealed ?? "", Date.now());
    return;
  }
  d.prepare("UPDATE hosts SET user_email = ?, user_name = ?, handle = ?, show_email = ?, locale = ? WHERE user_sub = ?").run(
    h.email,
    h.name,
    h.handle,
    h.showEmail ? 1 : 0,
    h.locale,
    h.sub,
  );
  if (h.credentialSealed !== undefined) {
    d.prepare("UPDATE hosts SET credential_sealed = ?, needs_reauth = 0 WHERE user_sub = ?").run(h.credentialSealed, h.sub);
  }
}

export function setHostCredential(sub: string, sealed: string): void {
  db().prepare("UPDATE hosts SET credential_sealed = ?, needs_reauth = 0 WHERE user_sub = ?").run(sealed, sub);
}

export function markHostNeedsReauth(sub: string): void {
  db().prepare("UPDATE hosts SET needs_reauth = 1 WHERE user_sub = ?").run(sub);
}

/* ------------------------------------------------------------------ types */

function toType(r: Row): BookingType {
  const data = JSON.parse(s(r.data)) as BookingTypeSettings;
  return { ...data, slug: s(r.slug), active: n(r.active) === 1, id: s(r.id), created: n(r.created), updated: n(r.updated) };
}

export function listTypes(sub: string): BookingType[] {
  return db().prepare("SELECT * FROM types WHERE user_sub = ? ORDER BY created").all(sub).map(toType);
}

export function getType(sub: string, id: string): BookingType | null {
  const r = db().prepare("SELECT * FROM types WHERE user_sub = ? AND id = ?").get(sub, id);
  return r ? toType(r) : null;
}

export function typeBySlug(sub: string, slug: string): BookingType | null {
  const r = db().prepare("SELECT * FROM types WHERE user_sub = ? AND slug = ?").get(sub, slug);
  return r ? toType(r) : null;
}

export const countTypes = (sub: string) => n(db().prepare("SELECT COUNT(*) AS c FROM types WHERE user_sub = ?").get(sub)?.c);

/** Inserts (no id) or updates a type. Returns null when the slug is used by another of the user's types. */
export function saveType(sub: string, id: string | null, settings: BookingTypeSettings, newId: () => string): BookingType | null {
  const d = db();
  const clash = d.prepare("SELECT id FROM types WHERE user_sub = ? AND slug = ?").get(sub, settings.slug);
  if (clash && s(clash.id) !== id) return null;
  const now = Date.now();
  const data = JSON.stringify(settings);
  if (id) {
    const res = d
      .prepare("UPDATE types SET slug = ?, data = ?, active = ?, updated = ? WHERE user_sub = ? AND id = ?")
      .run(settings.slug, data, settings.active ? 1 : 0, now, sub, id);
    if (Number(res.changes) === 0) return null;
    return getType(sub, id);
  }
  const created = newId();
  d.prepare("INSERT INTO types (id, user_sub, slug, data, active, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    created,
    sub,
    settings.slug,
    data,
    settings.active ? 1 : 0,
    now,
    now,
  );
  return getType(sub, created);
}

export function setTypeActive(sub: string, id: string, active: boolean): boolean {
  const t = getType(sub, id);
  if (!t) return false;
  const { id: _id, created: _c, updated: _u, ...settings } = t;
  db()
    .prepare("UPDATE types SET active = ?, data = ?, updated = ? WHERE user_sub = ? AND id = ?")
    .run(active ? 1 : 0, JSON.stringify({ ...settings, active }), Date.now(), sub, id);
  return true;
}

export function deleteType(sub: string, id: string): boolean {
  return Number(db().prepare("DELETE FROM types WHERE user_sub = ? AND id = ?").run(sub, id).changes) > 0;
}

/* --------------------------------------------------------------- bookings */

export type Booking = {
  id: string;
  typeId: string;
  sub: string;
  start: number;
  end: number;
  status: "confirmed" | "cancelled";
  guestName: string;
  guestEmail: string;
  guestTz: string;
  locale: "es" | "en";
  answers: { label: string; value: string }[];
  eventId: string;
  eventUid: string;
  sequence: number;
  room: string;
  created: number;
};

function toBooking(r: Row): Booking {
  let answers: Booking["answers"] = [];
  try {
    answers = JSON.parse(s(r.answers)) as Booking["answers"];
  } catch {
    answers = [];
  }
  return {
    id: s(r.id),
    typeId: s(r.type_id),
    sub: s(r.user_sub),
    start: n(r.starts),
    end: n(r.ends),
    status: s(r.status) === "cancelled" ? "cancelled" : "confirmed",
    guestName: s(r.guest_name),
    guestEmail: s(r.guest_email),
    guestTz: s(r.guest_tz),
    locale: s(r.locale) === "en" ? "en" : "es",
    answers,
    eventId: s(r.event_id),
    eventUid: s(r.event_uid),
    sequence: n(r.sequence),
    room: s(r.room),
    created: n(r.created),
  };
}

export function bookingByManageToken(token: string): Booking | null {
  const r = db().prepare("SELECT * FROM bookings WHERE manage_hash = ?").get(hashToken(token));
  return r ? toBooking(r) : null;
}

export function bookingByJoinToken(token: string): Booking | null {
  const r = db().prepare("SELECT * FROM bookings WHERE join_hash = ?").get(hashToken(token));
  return r ? toBooking(r) : null;
}

/** Confirmed bookings of a host overlapping [from, to). */
export function confirmedBookings(sub: string, from: number, to: number): Booking[] {
  return db()
    .prepare("SELECT * FROM bookings WHERE user_sub = ? AND status = 'confirmed' AND starts < ? AND ends > ? ORDER BY starts")
    .all(sub, to, from)
    .map(toBooking);
}

export function upcomingBookings(sub: string, now: number, limit = 20): Booking[] {
  return db()
    .prepare("SELECT * FROM bookings WHERE user_sub = ? AND status = 'confirmed' AND ends > ? ORDER BY starts LIMIT ?")
    .all(sub, now, limit)
    .map(toBooking);
}

export type Guard = {
  /** The new slot widened by the type's buffers: no other confirmed booking of the host may overlap it. */
  blockStart: number;
  blockEnd: number;
  /** maxPerDay over [dayStart, dayEnd) for this type (0 = none). */
  maxPerDay: number;
  dayStart: number;
  dayEnd: number;
};

export type NewBooking = Omit<Booking, "status" | "eventId" | "sequence" | "created"> & { manageToken: string; joinToken: string };

/**
 * The double-booking guard: checks overlap with the host's other confirmed bookings and the daily
 * limit, and inserts, in one write transaction. node:sqlite is synchronous, so nothing else in this
 * process runs in between; BEGIN IMMEDIATE also serializes against other processes.
 */
export function reserve(b: NewBooking, guard: Guard): "ok" | "conflict" | "limit" {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const result = check(d, b.sub, b.typeId, b.id, guard);
    if (result === "ok") {
      const now = Date.now();
      d.prepare(
        `INSERT INTO bookings (id, type_id, user_sub, starts, ends, status, guest_name, guest_email, guest_tz, locale, answers,
           event_uid, room, manage_hash, join_hash, created, updated)
         VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        b.id,
        b.typeId,
        b.sub,
        b.start,
        b.end,
        b.guestName,
        b.guestEmail,
        b.guestTz,
        b.locale,
        JSON.stringify(b.answers),
        b.eventUid,
        b.room,
        hashToken(b.manageToken),
        hashToken(b.joinToken),
        now,
        now,
      );
    }
    d.exec("COMMIT");
    return result;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** Moves a confirmed booking to a new time under the same guard (itself excluded). */
export function reserveMove(id: string, sub: string, typeId: string, start: number, end: number, guard: Guard): "ok" | "conflict" | "limit" {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const result = check(d, sub, typeId, id, guard);
    if (result === "ok") {
      d.prepare("UPDATE bookings SET starts = ?, ends = ?, sequence = sequence + 1, updated = ? WHERE id = ? AND status = 'confirmed'").run(
        start,
        end,
        Date.now(),
        id,
      );
    }
    d.exec("COMMIT");
    return result;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

function check(d: Database, sub: string, typeId: string, selfId: string, g: Guard): "ok" | "conflict" | "limit" {
  const overlap = d
    .prepare("SELECT 1 AS x FROM bookings WHERE user_sub = ? AND status = 'confirmed' AND id != ? AND starts < ? AND ends > ? LIMIT 1")
    .get(sub, selfId, g.blockEnd, g.blockStart);
  if (overlap) return "conflict";
  if (g.maxPerDay > 0) {
    const c = n(
      d
        .prepare("SELECT COUNT(*) AS c FROM bookings WHERE type_id = ? AND status = 'confirmed' AND id != ? AND starts >= ? AND starts < ?")
        .get(typeId, selfId, g.dayStart, g.dayEnd)?.c,
    );
    if (c >= g.maxPerDay) return "limit";
  }
  return "ok";
}

export function setBookingEvent(id: string, eventId: string): void {
  db().prepare("UPDATE bookings SET event_id = ?, updated = ? WHERE id = ?").run(eventId, Date.now(), id);
}

export function cancelBookingRow(id: string): boolean {
  return Number(db().prepare("UPDATE bookings SET status = 'cancelled', updated = ? WHERE id = ? AND status = 'confirmed'").run(Date.now(), id).changes) > 0;
}

export function bookingById(id: string): Booking | null {
  const r = db().prepare("SELECT * FROM bookings WHERE id = ?").get(id);
  return r ? toBooking(r) : null;
}

/** Per owner-zone day counts of a type's confirmed bookings in [from, to), keyed by `dayOf(start)`. */
export function countsPerDay(typeId: string, from: number, to: number, dayOf: (ms: number) => string, exceptId = ""): Map<string, number> {
  const out = new Map<string, number>();
  const rows = db()
    .prepare("SELECT starts FROM bookings WHERE type_id = ? AND status = 'confirmed' AND id != ? AND starts >= ? AND starts < ?")
    .all(typeId, exceptId, from, to);
  for (const r of rows) {
    const day = dayOf(n(r.starts));
    out.set(day, (out.get(day) ?? 0) + 1);
  }
  return out;
}

/** Puts a booking back at a previous time (a reschedule whose calendar update failed). */
export function restoreBookingTimes(id: string, start: number, end: number, sequence: number): void {
  db().prepare("UPDATE bookings SET starts = ?, ends = ?, sequence = ?, updated = ? WHERE id = ?").run(start, end, sequence, Date.now(), id);
}
