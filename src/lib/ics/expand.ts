// Expands parsed iCalendar events (lib/ics/parse.ts) into concrete occurrences in a time range:
// RRULE (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY incl. ordinals,
// BYMONTHDAY, BYMONTH, BYSETPOS, WKST), RDATE, EXDATE, RECURRENCE-ID overrides and cancellations.
// Pure. Occurrences are generated in wall-clock time and converted per instance, so a weekly
// 09:00 meeting stays at 09:00 local time across DST changes.
import { addDays, utcToKey, zonedParts, zonedToUtc } from "../../app/(apps)/calendar/time";
import type { CustomZone, IcsCalendar, IcsEvent, IcsTime, RRule } from "./parse";

const DAY = 86_400_000;
/** Safety caps: periods walked per rule, occurrences per event and per expansion. */
const MAX_PERIODS = 50_000;
export const MAX_PER_EVENT = 1_000;
export const MAX_OCCURRENCES = 5_000;

export type IcsOccurrence = {
  uid: string;
  /** Original start of this occurrence (UTC ms): identifies it within the series. */
  recurrenceKey: number;
  title: string;
  description: string;
  location: string;
  url: string;
  allDay: boolean;
  utcStart: number;
  utcEnd: number;
  /** All-day: first day and exclusive end day; timed: days in the display zone. */
  startDay: string;
  endDay: string;
  transparent: boolean;
  tentative: boolean;
  recurring: boolean;
  /** How the series repeats, in the calendar UI's terms. */
  repeat: "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";
};

function repeatOf(ev: IcsEvent): IcsOccurrence["repeat"] {
  const r = ev.rrule;
  if (!r) return ev.rdates?.length ? "custom" : "none";
  const simple = r.interval === 1 && !r.byMonth && !r.byMonthDay && !r.bySetPos && (!r.byDay || (r.freq === "weekly" && r.byDay.length === 1));
  return simple ? r.freq : "custom";
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);
const mod = (a: number, b: number) => ((a % b) + b) % b;
const weekdayOf = (dayNum: number) => mod(dayNum + 4, 7); // 1970-01-01 was a Thursday
const wallLocal = (wall: number) => new Date(wall).toISOString().slice(0, 19);

// ---- Zones ----

/** Offset (ms east of UTC) of a VTIMEZONE at instant `utc`: the latest observance onset before it. */
function customOffset(zone: CustomZone, utc: number): number {
  let best: { at: number; offset: number } | null = null;
  let earliest: { at: number; offset: number } | null = null;
  for (const o of zone.observances) {
    const onsetUtc = (wall: number) => wall - o.offsetFrom;
    const consider = (wall: number) => {
      const at = onsetUtc(wall);
      if (!earliest || at < earliest.at) earliest = { at, offset: o.offsetFrom };
      if (at <= utc && (!best || at > best.at)) best = { at, offset: o.offsetTo };
    };
    consider(o.start);
    for (const r of o.rdates ?? []) consider(r);
    if (o.rrule) {
      const afterUntil = untilCheck(o.rrule, (w) => w - o.offsetFrom);
      const near = expandRule(o.start, o.rrule, utc - 400 * DAY, utc + DAY, afterUntil, 10);
      const walls = near.length ? near : expandRule(o.start, o.rrule, o.start, utc + DAY, afterUntil, 1_000);
      for (const w of walls) consider(w);
    }
  }
  return (best as { offset: number } | null)?.offset ?? (earliest as { offset: number } | null)?.offset ?? 0;
}

/** Real instant of a time. Dates and floating times are read in the viewer's zone. */
export function toUtc(t: IcsTime, zones: Record<string, CustomZone>, displayTz: string): number {
  if (t.date || !t.zone) return zonedToUtc(wallLocal(t.wall), displayTz);
  if (t.zone === "UTC") return t.wall;
  if (t.zone.startsWith("#")) {
    const def = zones[t.zone.slice(1)];
    if (!def) return zonedToUtc(wallLocal(t.wall), displayTz);
    const first = t.wall - customOffset(def, t.wall);
    return t.wall - customOffset(def, first);
  }
  try {
    return zonedToUtc(wallLocal(t.wall), t.zone);
  } catch {
    return zonedToUtc(wallLocal(t.wall), displayTz);
  }
}

// ---- RRULE ----

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const dayNumOf = (y: number, m: number, d: number) => Date.UTC(y, m, d) / DAY;

/** Day numbers in month (y, m) selected by BYMONTHDAY / BYDAY, or the default day of month. */
function monthDays(rule: RRule, y: number, m: number, defaultDom: number): number[] {
  const n = daysInMonth(y, m);
  const first = dayNumOf(y, m, 1);
  let a: number[] | null = null;
  if (rule.byMonthDay) a = rule.byMonthDay.map((v) => (v > 0 ? v : n + v + 1)).filter((v) => v >= 1 && v <= n);
  let b: number[] | null = null;
  if (rule.byDay) {
    b = [];
    for (const { n: ord, wd } of rule.byDay) {
      const firstMatch = 1 + mod(wd - weekdayOf(first), 7);
      const matches: number[] = [];
      for (let d = firstMatch; d <= n; d += 7) matches.push(d);
      if (ord === 0) b.push(...matches);
      else {
        const pick = ord > 0 ? matches[ord - 1] : matches[matches.length + ord];
        if (pick !== undefined) b.push(pick);
      }
    }
  }
  const days = a && b ? a.filter((d) => b.includes(d)) : (a ?? b ?? (defaultDom <= n ? [defaultDom] : []));
  return [...new Set(days)].sort((x, y2) => x - y2).map((d) => first + d - 1);
}

/** Day numbers in year y matching BYDAY with ordinals relative to the year (YEARLY without BYMONTH). */
function yearDays(rule: RRule, y: number): number[] {
  const first = dayNumOf(y, 0, 1);
  const total = dayNumOf(y + 1, 0, 1) - first;
  const out: number[] = [];
  for (const { n: ord, wd } of rule.byDay ?? []) {
    const matches: number[] = [];
    for (let d = first + mod(wd - weekdayOf(first), 7); d < first + total; d += 7) matches.push(d);
    if (ord === 0) out.push(...matches);
    else {
      const pick = ord > 0 ? matches[ord - 1] : matches[matches.length + ord];
      if (pick !== undefined) out.push(pick);
    }
  }
  return out;
}

function setPos(list: number[], pos: number[] | undefined): number[] {
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  if (!pos) return sorted;
  const out = new Set<number>();
  for (const p of pos) {
    const v = p > 0 ? sorted[p - 1] : sorted[sorted.length + p];
    if (v !== undefined) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Candidate days of period `i` (and the first day of that period). */
function period(rule: RRule, d0: number, i: number): { startDay: number; days: number[] } {
  const date0 = new Date(d0 * DAY);
  const y0 = date0.getUTCFullYear();
  const m0 = date0.getUTCMonth();
  const dom0 = date0.getUTCDate();
  const inMonth = (d: number) => !rule.byMonth || rule.byMonth.includes(new Date(d * DAY).getUTCMonth() + 1);

  switch (rule.freq) {
    case "daily": {
      const d = d0 + i * rule.interval;
      const date = new Date(d * DAY);
      const dom = date.getUTCDate();
      const n = daysInMonth(date.getUTCFullYear(), date.getUTCMonth());
      const okDom = !rule.byMonthDay || rule.byMonthDay.some((v) => (v > 0 ? v : n + v + 1) === dom);
      const okDay = !rule.byDay || rule.byDay.some((b) => b.wd === weekdayOf(d));
      return { startDay: d, days: inMonth(d) && okDom && okDay ? [d] : [] };
    }
    case "weekly": {
      const ws = d0 - mod(weekdayOf(d0) - rule.wkst, 7) + 7 * i * rule.interval;
      const days = rule.byDay
        ? [0, 1, 2, 3, 4, 5, 6].map((k) => ws + k).filter((d) => rule.byDay!.some((b) => b.wd === weekdayOf(d)))
        : [ws + mod(weekdayOf(d0) - rule.wkst, 7)];
      return { startDay: ws, days: days.filter(inMonth) };
    }
    case "monthly": {
      const total = y0 * 12 + m0 + i * rule.interval;
      const y = floorDiv(total, 12);
      const m = mod(total, 12);
      const startDay = dayNumOf(y, m, 1);
      if (rule.byMonth && !rule.byMonth.includes(m + 1)) return { startDay, days: [] };
      return { startDay, days: monthDays(rule, y, m, dom0) };
    }
    case "yearly": {
      const y = y0 + i * rule.interval;
      const startDay = dayNumOf(y, 0, 1);
      let days: number[];
      if (rule.byMonth) days = rule.byMonth.flatMap((m) => monthDays(rule, y, m - 1, dom0));
      else if (rule.byDay && !rule.byMonthDay) days = yearDays(rule, y);
      else if (rule.byMonthDay) days = Array.from({ length: 12 }, (_, m) => monthDays(rule, y, m, dom0)).flat();
      else days = monthDays(rule, y, m0, dom0);
      return { startDay, days };
    }
  }
}

/** First period index worth walking for a window starting at `fromDay` (rules without COUNT). */
function skipTo(rule: RRule, d0: number, fromDay: number): number {
  if (fromDay <= d0) return 0;
  const a = new Date(d0 * DAY);
  const b = new Date(fromDay * DAY);
  let span: number;
  if (rule.freq === "daily") span = fromDay - d0;
  else if (rule.freq === "weekly") span = floorDiv(fromDay - d0, 7);
  else if (rule.freq === "monthly") span = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  else span = b.getUTCFullYear() - a.getUTCFullYear();
  return Math.max(0, floorDiv(span, rule.interval) - 1);
}

/** Builds "is this wall time past UNTIL?" for a rule, given how to turn wall times into instants. */
export function untilCheck(rule: RRule, wallToUtc: (wall: number) => number): (wall: number) => boolean {
  const u = rule.until;
  if (!u) return () => false;
  if (u.date) {
    const lastDay = floorDiv(u.wall, DAY);
    return (w) => floorDiv(w, DAY) > lastDay;
  }
  if (u.zone === "UTC") return (w) => wallToUtc(w) > u.wall;
  return (w) => w > u.wall;
}

/**
 * Wall-clock starts of a rule's occurrences inside [fromWall, toWall), DTSTART included (it always
 * counts as the first occurrence, RFC 5545 §3.8.5.3). COUNT is honored from the series start.
 */
export function expandRule(
  start: number,
  rule: RRule,
  fromWall: number,
  toWall: number,
  afterUntil: (wall: number) => boolean,
  max = MAX_PER_EVENT,
): number[] {
  const out: number[] = [];
  const t0 = mod(start, DAY);
  const d0 = floorDiv(start, DAY);
  const limit = rule.count ?? Infinity;
  let count = 1;
  if (start >= fromWall && start < toWall) out.push(start);
  if (count >= limit || afterUntil(start)) return out;

  let i = rule.count === undefined ? skipTo(rule, d0, floorDiv(fromWall, DAY)) : 0;
  for (let walked = 0; walked < MAX_PERIODS; walked++, i++) {
    const { startDay, days } = period(rule, d0, i);
    if (startDay * DAY >= toWall) break;
    for (const d of setPos(days, rule.bySetPos)) {
      const w = d * DAY + t0;
      if (w <= start) continue;
      if (afterUntil(w)) return out;
      count++;
      if (w >= fromWall && w < toWall) {
        out.push(w);
        if (out.length >= max) return out;
      }
      if (count >= limit) return out;
    }
  }
  return out;
}

// ---- Events ----

/** Duration of an event (ms; all-day events: whole days). */
export function durationOf(ev: IcsEvent, zones: Record<string, CustomZone>, displayTz: string): number {
  if (ev.start.date) {
    let days = 1;
    if (ev.end?.date) days = Math.round((ev.end.wall - ev.start.wall) / DAY);
    else if (ev.durationMs !== undefined) days = Math.round(ev.durationMs / DAY);
    return Math.max(1, days) * DAY;
  }
  if (ev.durationMs !== undefined) return ev.durationMs;
  if (ev.end) return Math.max(0, toUtc(ev.end, zones, displayTz) - toUtc(ev.start, zones, displayTz));
  return 0;
}

const dayKeyOfWall = (wall: number) => utcToKey(wall);

type Overrides = Map<string, Set<string>>;

/** Keys a RECURRENCE-ID / EXDATE matches: its instant and (for dates) its day. */
function idKeys(t: IcsTime, zones: Record<string, CustomZone>, displayTz: string): string[] {
  return t.date ? [`d:${dayKeyOfWall(t.wall)}`] : [`t:${toUtc(t, zones, displayTz)}`];
}

/**
 * Occurrences overlapping [from, to) (UTC ms) of every event in the calendar, sorted by start.
 * Cancelled events and cancelled instances are left out.
 */
export function expandCalendar(cal: IcsCalendar, from: number, to: number, displayTz: string, max = MAX_OCCURRENCES): IcsOccurrence[] {
  const zones = cal.zones;
  // uid → original starts replaced (or cancelled) by a RECURRENCE-ID instance.
  const overridden: Overrides = new Map();
  for (const ev of cal.events) {
    if (!ev.recurrenceId) continue;
    const set = overridden.get(ev.uid) ?? new Set<string>();
    for (const k of idKeys(ev.recurrenceId, zones, displayTz)) set.add(k);
    overridden.set(ev.uid, set);
  }

  const out: IcsOccurrence[] = [];
  for (const ev of cal.events) {
    if (out.length >= max) break;
    if (ev.status === "cancelled") continue;
    try {
      out.push(...expandEvent(ev, zones, from, to, displayTz, ev.recurrenceId ? undefined : overridden.get(ev.uid)));
    } catch {
      // A malformed event never breaks the whole feed.
    }
  }
  return out.slice(0, max).sort((a, b) => a.utcStart - b.utcStart || b.utcEnd - a.utcEnd);
}

function expandEvent(
  ev: IcsEvent,
  zones: Record<string, CustomZone>,
  from: number,
  to: number,
  displayTz: string,
  overridden: Set<string> | undefined,
): IcsOccurrence[] {
  const allDay = ev.start.date;
  const duration = durationOf(ev, zones, displayTz);
  const recurring = !!ev.rrule || !!ev.rdates?.length;
  const wallToUtc = (wall: number) => toUtc({ ...ev.start, wall }, zones, displayTz);

  // Original starts as wall times (in the event's own zone).
  let walls: number[];
  if (ev.rrule && !ev.recurrenceId) {
    const margin = 2 * DAY;
    walls = expandRule(ev.start.wall, ev.rrule, from - duration - margin, to + margin, untilCheck(ev.rrule, wallToUtc));
  } else walls = [ev.start.wall];

  const starts: { utc: number; day: string }[] = walls.map((w) => ({ utc: wallToUtc(w), day: dayKeyOfWall(w) }));
  if (!ev.recurrenceId) {
    for (const r of ev.rdates ?? []) {
      const utc = toUtc(r, zones, displayTz);
      starts.push({ utc, day: r.date ? dayKeyOfWall(r.wall) : zonedParts(utc, displayTz).key });
    }
  }

  const excluded = new Set<string>();
  for (const x of ev.exdates ?? []) for (const k of idKeys(x, zones, displayTz)) excluded.add(k);

  const out: IcsOccurrence[] = [];
  const seen = new Set<number>();
  for (const s of starts) {
    if (seen.has(s.utc)) continue;
    seen.add(s.utc);
    const keys = [`t:${s.utc}`, `d:${s.day}`];
    if (keys.some((k) => excluded.has(k) || overridden?.has(k))) continue;

    let utcStart: number, utcEnd: number, startDay: string, endDay: string;
    if (allDay) {
      startDay = s.day;
      endDay = addDays(startDay, Math.max(1, Math.round(duration / DAY)));
      utcStart = zonedToUtc(`${startDay}T00:00:00`, displayTz);
      utcEnd = zonedToUtc(`${endDay}T00:00:00`, displayTz);
    } else {
      utcStart = s.utc;
      utcEnd = s.utc + duration;
      startDay = zonedParts(utcStart, displayTz).key;
      endDay = addDays(zonedParts(Math.max(utcStart, utcEnd - 1), displayTz).key, 1);
    }
    if (!(utcEnd > from && utcStart < to) && !(utcStart === utcEnd && utcStart >= from && utcStart < to)) continue;
    out.push({
      uid: ev.uid,
      recurrenceKey: ev.recurrenceId ? toUtc(ev.recurrenceId, zones, displayTz) : s.utc,
      title: ev.title,
      description: ev.description,
      location: ev.location,
      url: ev.url,
      allDay,
      utcStart,
      utcEnd,
      startDay,
      endDay,
      transparent: ev.transparent,
      tentative: ev.status === "tentative",
      recurring: recurring || !!ev.recurrenceId,
      repeat: ev.recurrenceId ? "none" : repeatOf(ev),
    });
    if (out.length >= MAX_PER_EVENT) break;
  }
  return out;
}
