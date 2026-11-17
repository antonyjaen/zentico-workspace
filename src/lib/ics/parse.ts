// iCalendar (RFC 5545) reader for external calendar feeds and .ics imports. Pure (no I/O) and
// JSON-serializable output, so parsed feeds can be cached and expanded later (lib/ics/expand.ts).
//
// Times are kept as "wall clock" milliseconds (the local date-time read as if it were UTC) plus the
// zone they belong to; converting to real instants happens at expansion time, where recurring
// events keep their local time across DST changes.
import { parseDuration } from "../../app/(apps)/calendar/time";
import { ianaFor } from "./zones";

/**
 * A date or date-time. `zone`: "" floating (shown in the viewer's zone), "UTC", an IANA name, or
 * "#<TZID>" for a VTIMEZONE without an IANA equivalent (see IcsCalendar.zones).
 */
export type IcsTime = { wall: number; zone: string; date: boolean };

export type Freq = "daily" | "weekly" | "monthly" | "yearly";
/** n = ordinal (0 = every such weekday in the period); wd = 0 (Sunday) … 6. */
export type NDay = { n: number; wd: number };

export type RRule = {
  freq: Freq;
  interval: number;
  count?: number;
  until?: IcsTime;
  byDay?: NDay[];
  byMonthDay?: number[];
  byMonth?: number[];
  bySetPos?: number[];
  wkst: number;
};

export type IcsEvent = {
  uid: string;
  title: string;
  description: string;
  location: string;
  url: string;
  status: "confirmed" | "tentative" | "cancelled";
  /** TRANSP:TRANSPARENT: shown but doesn't make the owner busy. */
  transparent: boolean;
  start: IcsTime;
  end?: IcsTime;
  durationMs?: number;
  rrule?: RRule;
  rdates?: IcsTime[];
  exdates?: IcsTime[];
  /** Set on an instance that overrides (or cancels) one occurrence of the series with this uid. */
  recurrenceId?: IcsTime;
  sequence: number;
};

/** One STANDARD/DAYLIGHT block of a VTIMEZONE (offsets in ms east of UTC). */
export type ZoneObservance = { start: number; offsetFrom: number; offsetTo: number; rrule?: RRule; rdates?: number[] };
export type CustomZone = { observances: ZoneObservance[] };

export type IcsCalendar = {
  /** X-WR-CALNAME (Google, Outlook, Apple), or "". */
  name: string;
  /** VTIMEZONEs that don't map to an IANA zone, by TZID. */
  zones: Record<string, CustomZone>;
  events: IcsEvent[];
  /** True when the feed had more events than MAX_EVENTS (the rest were dropped). */
  truncated: boolean;
};

export class IcsError extends Error {}

export const MAX_EVENTS = 20_000;
const MAX_TEXT = { title: 500, location: 500, description: 8_000, url: 2_000, uid: 500 };
const DAY_MS = 86_400_000;

type Prop = { name: string; params: Record<string, string>; value: string };
type Comp = { name: string; props: Prop[]; children: Comp[] };

/** Splits "NAME;P1=a;P2=\"b:c\":value" honoring quoted parameter values. */
function parseLine(line: string): Prop | null {
  let i = 0;
  const n = line.length;
  while (i < n && line[i] !== ";" && line[i] !== ":") i++;
  const name = line.slice(0, i).toUpperCase();
  if (!name || i >= n) return null;
  const params: Record<string, string> = {};
  while (i < n && line[i] === ";") {
    i++;
    const eq = line.indexOf("=", i);
    if (eq < 0) return null;
    const key = line.slice(i, eq).toUpperCase();
    i = eq + 1;
    let value = "";
    // Multi-valued params (a,b) are kept as written; quotes are dropped.
    while (i < n && line[i] !== ";" && line[i] !== ":") {
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) return null;
        value += line.slice(i + 1, close);
        i = close + 1;
      } else value += line[i++];
    }
    params[key] = value;
  }
  if (line[i] !== ":") return null;
  return { name, params, value: line.slice(i + 1) };
}

/** Unfolds continuation lines and builds the component tree. */
function tree(text: string): Comp {
  const root: Comp = { name: "", props: [], children: [] };
  const stack: Comp[] = [root];
  const lines = text.replace(/^﻿/, "").replace(/\r?\n[ \t]/g, "").split(/\r\n|\n|\r/);
  for (const raw of lines) {
    if (!raw) continue;
    const p = parseLine(raw);
    if (!p) continue;
    const top = stack[stack.length - 1];
    if (p.name === "BEGIN") {
      const c: Comp = { name: p.value.trim().toUpperCase(), props: [], children: [] };
      top.children.push(c);
      stack.push(c);
      if (stack.length > 8) throw new IcsError("too deep");
    } else if (p.name === "END") {
      if (stack.length > 1 && top.name === p.value.trim().toUpperCase()) stack.pop();
    } else top.props.push(p);
  }
  return root;
}

export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

const first = (c: Comp, name: string) => c.props.find((p) => p.name === name);
const textOf = (c: Comp, name: string, max: number) => {
  const p = first(c, name);
  return p ? unescapeText(p.value).trim().slice(0, max) : "";
};

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATETIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i;

/** Wall-clock ms for a basic-format date or date-time (no zone), or null. */
export function parseWall(value: string): { wall: number; date: boolean; utc: boolean } | null {
  const v = value.trim();
  let m = DATE_RE.exec(v);
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (y < 1600 || y > 2500 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const wall = Date.UTC(y, mo - 1, d);
    if (new Date(wall).getUTCDate() !== d) return null;
    return { wall, date: true, utc: false };
  }
  m = DATETIME_RE.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)];
  if (y < 1600 || y > 2500 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || s > 60) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, Math.min(s, 59));
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;
  return { wall, date: false, utc: !!m[7] };
}

type ZoneMap = Map<string, string>;

function timeOf(p: Prop, value: string, zones: ZoneMap): IcsTime | null {
  const w = parseWall(value);
  if (!w) return null;
  const forceDate = (p.params.VALUE ?? "").toUpperCase() === "DATE";
  if (w.date || forceDate) return { wall: w.wall - (w.wall % DAY_MS), zone: "", date: true };
  if (w.utc) return { wall: w.wall, zone: "UTC", date: false };
  const tzid = p.params.TZID;
  if (!tzid) return { wall: w.wall, zone: "", date: false };
  return { wall: w.wall, zone: zones.get(tzid) ?? ianaFor(tzid) ?? "", date: false };
}

/** All values of a (possibly repeated, comma-separated) date property, e.g. EXDATE / RDATE. */
function timesOf(c: Comp, name: string, zones: ZoneMap): IcsTime[] {
  const out: IcsTime[] = [];
  for (const p of c.props) {
    if (p.name !== name || (p.params.VALUE ?? "").toUpperCase() === "PERIOD") continue;
    for (const v of p.value.split(",")) {
      const t = timeOf(p, v, zones);
      if (t) out.push(t);
      if (out.length >= 1000) return out;
    }
  }
  return out;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const FREQS: Record<string, Freq> = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" };

const intList = (v: string, min: number, max: number) =>
  v
    .split(",")
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x !== 0 && x >= min && x <= max)
    .slice(0, 50);

/**
 * RRULE value → rule, or null when it can't be expanded faithfully (sub-daily frequencies,
 * BYYEARDAY/BYWEEKNO/BYHOUR…): those events show their first occurrence only.
 */
export function parseRRule(value: string, zones: ZoneMap = new Map(), tzid?: string): RRule | null {
  const parts = new Map<string, string>();
  for (const kv of value.split(";")) {
    const eq = kv.indexOf("=");
    if (eq > 0) parts.set(kv.slice(0, eq).trim().toUpperCase(), kv.slice(eq + 1).trim().toUpperCase());
  }
  const freq = FREQS[parts.get("FREQ") ?? ""];
  if (!freq) return null;
  for (const k of ["BYYEARDAY", "BYWEEKNO", "BYHOUR", "BYMINUTE", "BYSECOND"]) if (parts.has(k)) return null;
  const rule: RRule = { freq, interval: 1, wkst: 1 };
  const interval = Number(parts.get("INTERVAL") ?? 1);
  if (Number.isInteger(interval) && interval >= 1 && interval <= 1000) rule.interval = interval;
  const count = parts.get("COUNT");
  if (count !== undefined) {
    const c = Number(count);
    if (!Number.isInteger(c) || c < 1) return null;
    rule.count = Math.min(c, 100_000);
  }
  const until = parts.get("UNTIL");
  if (until) {
    const w = parseWall(until);
    if (w) rule.until = { wall: w.wall, date: w.date, zone: w.utc ? "UTC" : w.date ? "" : ((tzid && (zones.get(tzid) ?? ianaFor(tzid))) || "") };
  }
  const byDay = parts.get("BYDAY");
  if (byDay) {
    const list: NDay[] = [];
    for (const d of byDay.split(",")) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d.trim());
      if (!m) return null;
      const n = m[1] ? Number(m[1]) : 0;
      if (Math.abs(n) > 53) return null;
      list.push({ n, wd: WEEKDAYS.indexOf(m[2]) });
    }
    if (list.length) rule.byDay = list;
  }
  const bmd = parts.get("BYMONTHDAY");
  if (bmd) rule.byMonthDay = intList(bmd, -31, 31);
  const bm = parts.get("BYMONTH");
  if (bm) rule.byMonth = intList(bm, 1, 12);
  const sp = parts.get("BYSETPOS");
  if (sp) rule.bySetPos = intList(sp, -366, 366);
  const wkst = WEEKDAYS.indexOf(parts.get("WKST") ?? "");
  if (wkst >= 0) rule.wkst = wkst;
  if ((rule.byMonthDay && !rule.byMonthDay.length) || (rule.byMonth && !rule.byMonth.length)) return null;
  return rule;
}

/** "+0100" / "-0530" / "+013045" → ms east of UTC. */
function offsetOf(v: string | undefined): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec((v ?? "").trim());
  if (!m) return null;
  const ms = (+m[2] * 3600 + +m[3] * 60 + +(m[4] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

function customZone(c: Comp): CustomZone | null {
  const observances: ZoneObservance[] = [];
  for (const o of c.children) {
    if (o.name !== "STANDARD" && o.name !== "DAYLIGHT") continue;
    const start = parseWall(first(o, "DTSTART")?.value ?? "");
    const offsetTo = offsetOf(first(o, "TZOFFSETTO")?.value);
    const offsetFrom = offsetOf(first(o, "TZOFFSETFROM")?.value) ?? offsetTo;
    if (!start || offsetTo === null || offsetFrom === null) continue;
    const rr = first(o, "RRULE");
    const rrule = rr ? parseRRule(rr.value) ?? undefined : undefined;
    const rdates = timesOf(o, "RDATE", new Map()).map((t) => t.wall);
    observances.push({ start: start.wall, offsetFrom, offsetTo, ...(rrule ? { rrule } : {}), ...(rdates.length ? { rdates } : {}) });
  }
  return observances.length ? { observances } : null;
}

/** Simple stable hash for events without a UID. */
function hashOf(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

/** Parses an iCalendar document. Throws IcsError when it isn't one. */
export function parseIcs(text: string): IcsCalendar {
  if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(text)) throw new IcsError("not a calendar");
  const root = tree(text);
  const cals = root.children.filter((c) => c.name === "VCALENDAR");
  if (!cals.length) throw new IcsError("not a calendar");

  const out: IcsCalendar = { name: "", zones: {}, events: [], truncated: false };
  for (const cal of cals) {
    if (!out.name) out.name = textOf(cal, "X-WR-CALNAME", 200) || textOf(cal, "NAME", 200);
    // Floating times of feeds that declare a calendar zone (Google's X-WR-TIMEZONE) belong to it.
    const calZone = ianaFor(first(cal, "X-WR-TIMEZONE")?.value) ?? "";

    const zones: ZoneMap = new Map();
    for (const tz of cal.children) {
      if (tz.name !== "VTIMEZONE") continue;
      const tzid = first(tz, "TZID")?.value.trim();
      if (!tzid || zones.has(tzid)) continue;
      const iana = ianaFor(first(tz, "X-LIC-LOCATION")?.value) ?? ianaFor(tzid);
      if (iana) zones.set(tzid, iana);
      else {
        const def = customZone(tz);
        if (def) {
          out.zones[tzid] = def;
          zones.set(tzid, `#${tzid}`);
        }
      }
    }

    for (const ev of cal.children) {
      if (ev.name !== "VEVENT") continue;
      if (out.events.length >= MAX_EVENTS) {
        out.truncated = true;
        break;
      }
      const dtstart = first(ev, "DTSTART");
      let start = dtstart ? timeOf(dtstart, dtstart.value, zones) : null;
      if (!start) continue;
      if (!start.zone && !start.date && calZone) start = { ...start, zone: calZone };
      const withCalZone = (t: IcsTime): IcsTime => (!t.zone && !t.date && calZone ? { ...t, zone: calZone } : t);

      const dtend = first(ev, "DTEND");
      const end = dtend ? timeOf(dtend, dtend.value, zones) : null;
      const durationMs = parseDuration(first(ev, "DURATION")?.value.trim());
      const rr = first(ev, "RRULE");
      const rrule = rr ? parseRRule(rr.value, zones, dtstart?.params.TZID) : null;
      const rid = first(ev, "RECURRENCE-ID");
      const recurrenceId = rid ? timeOf(rid, rid.value, zones) : null;
      const status = (first(ev, "STATUS")?.value.trim().toUpperCase() ?? "") as string;
      const exdates = timesOf(ev, "EXDATE", zones).map(withCalZone);
      const rdates = timesOf(ev, "RDATE", zones).map(withCalZone);
      const seq = Number(first(ev, "SEQUENCE")?.value);

      out.events.push({
        uid: textOf(ev, "UID", MAX_TEXT.uid) || `nouid-${hashOf(ev.props.map((p) => `${p.name}:${p.value}`).join("\n"))}`,
        title: textOf(ev, "SUMMARY", MAX_TEXT.title),
        description: textOf(ev, "DESCRIPTION", MAX_TEXT.description),
        location: textOf(ev, "LOCATION", MAX_TEXT.location),
        url: textOf(ev, "URL", MAX_TEXT.url),
        status: status === "CANCELLED" ? "cancelled" : status === "TENTATIVE" ? "tentative" : "confirmed",
        transparent: first(ev, "TRANSP")?.value.trim().toUpperCase() === "TRANSPARENT",
        start,
        ...(end && end.wall >= start.wall - DAY_MS ? { end: withCalZone(end) } : {}),
        ...(durationMs !== null && durationMs >= 0 ? { durationMs } : {}),
        ...(rrule ? { rrule } : {}),
        ...(rdates.length ? { rdates } : {}),
        ...(exdates.length ? { exdates } : {}),
        ...(recurrenceId ? { recurrenceId: withCalZone(recurrenceId) } : {}),
        sequence: Number.isInteger(seq) && seq >= 0 ? seq : 0,
      });
    }
  }
  return out;
}
