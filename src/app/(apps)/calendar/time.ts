// Pure date/time helpers shared by the calendar server page, actions and client views.
// Day keys are "YYYY-MM-DD" wall-clock dates; local datetimes are "YYYY-MM-DDTHH:mm:ss".

export type View = "day" | "week" | "month" | "agenda";
export const VIEWS: View[] = ["day", "week", "month", "agenda"];

/** Cookie holding the browser's IANA time zone so the server renders in it. */
export const TZ_COOKIE = "zw_tz";

export const DAY_MS = 86_400_000;
export const AGENDA_DAYS = 30;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;

export function isDayKey(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DAY_KEY.exec(s);
  if (!m) return false;
  return utcToKey(Date.UTC(+m[1], +m[2] - 1, +m[3])) === s;
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const keyToUtc = (key: string) => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
export const utcToKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (key: string, n: number) => utcToKey(keyToUtc(key) + n * DAY_MS);
export const weekday = (key: string) => new Date(keyToUtc(key)).getUTCDay();
export const diffDays = (a: string, b: string) => Math.round((keyToUtc(b) - keyToUtc(a)) / DAY_MS);

export function addMonths(key: string, n: number): string {
  const y = +key.slice(0, 4);
  const m = +key.slice(5, 7) - 1 + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return utcToKey(Date.UTC(y, m, Math.min(+key.slice(8, 10), last)));
}

/** Sunday-first for English, Monday-first otherwise (deterministic on server and client). */
export const weekStartFor = (locale: string) => (locale.startsWith("en") ? 0 : 1);

export const startOfWeek = (key: string, weekStart: number) =>
  addDays(key, -((weekday(key) - weekStart + 7) % 7));

/** Visible day range [start, end) for a view anchored on `key`. */
export function viewRange(view: View, key: string, weekStart: number): { start: string; end: string } {
  switch (view) {
    case "day":
      return { start: key, end: addDays(key, 1) };
    case "week": {
      const start = startOfWeek(key, weekStart);
      return { start, end: addDays(start, 7) };
    }
    case "month": {
      const first = `${key.slice(0, 8)}01`;
      const start = startOfWeek(first, weekStart);
      const nextMonth = addMonths(first, 1);
      const weeks = Math.ceil(diffDays(start, nextMonth) / 7);
      return { start, end: addDays(start, weeks * 7) };
    }
    case "agenda":
      return { start: key, end: addDays(key, AGENDA_DAYS) };
  }
}

export function shiftDate(view: View, key: string, dir: 1 | -1): string {
  if (view === "day") return addDays(key, dir);
  if (view === "week") return addDays(key, 7 * dir);
  if (view === "month") return addMonths(key, dir);
  return addDays(key, AGENDA_DAYS * dir);
}

export function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let k = start; k < end; k = addDays(k, 1)) out.push(k);
  return out;
}

// ---- Time zones ----

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export type ZonedParts = { y: number; mo: number; d: number; h: number; mi: number; s: number; key: string; minutes: number };

export function zonedParts(ms: number, tz: string): ZonedParts {
  const p: Record<string, number> = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (type !== "literal") p[type] = Number(value);
  }
  const h = p.hour === 24 ? 0 : p.hour;
  const key = `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return { y: p.year, mo: p.month, d: p.day, h, mi: p.minute, s: p.second, key, minutes: h * 60 + p.minute };
}

function tzOffset(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Converts a wall-clock local datetime in `tz` to epoch milliseconds. */
export function zonedToUtc(local: string, tz: string): number {
  const m = LOCAL_DT.exec(local);
  if (!m) throw new Error(`Invalid local datetime: ${local}`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  const first = guess - tzOffset(guess, tz);
  const second = guess - tzOffset(first, tz);
  return second;
}

export function utcToLocal(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  const t = (n: number) => String(n).padStart(2, "0");
  return `${p.key}T${t(p.h)}:${t(p.mi)}:${t(p.s)}`;
}

export const minutesToHHMM = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// ---- ISO 8601 durations (JSCalendar Duration / SignedDuration) ----

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

export function parseDuration(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = DURATION.exec(s);
  if (!m || s === "P" || s.endsWith("T")) return null;
  const ms =
    (+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * DAY_MS +
    +(m[4] ?? 0) * 3_600_000 +
    +(m[5] ?? 0) * 60_000 +
    Math.round(+(m[6] ?? 0) * 1000);
  return m[1] === "-" ? -ms : ms;
}

export function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  let rest = Math.abs(Math.round(ms / 60_000));
  const d = Math.floor(rest / 1440);
  rest -= d * 1440;
  const h = Math.floor(rest / 60);
  const mi = rest % 60;
  let out = `${sign}P${d ? `${d}D` : ""}`;
  if (h || mi) out += `T${h ? `${h}H` : ""}${mi ? `${mi}M` : ""}`;
  if (out === `${sign}P`) out += "T0S";
  return out;
}
