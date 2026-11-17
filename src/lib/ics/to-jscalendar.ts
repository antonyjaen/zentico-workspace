// Parsed iCalendar events (lib/ics/parse.ts) → JSCalendar objects for JMAP CalendarEvent/set, used
// by the .ics import. Pure. One JSCalendar event per UID: the series (RRULE/RDATE) with EXDATEs as
// excluded overrides and RECURRENCE-ID instances as patches. Attendees are deliberately not
// imported (no invitations are sent and nobody's RSVP is impersonated).
import { formatDuration, utcToKey, utcToLocal } from "../../app/(apps)/calendar/time";
import { durationOf, toUtc } from "./expand";
import type { IcsCalendar, IcsEvent, IcsTime, RRule } from "./parse";

type Raw = Record<string, unknown>;
export type ImportItem = { uid: string; event: Raw };

const DAY = 86_400_000;
const WD = ["su", "mo", "tu", "we", "th", "fr", "sa"];
const wallLocal = (wall: number) => new Date(wall).toISOString().slice(0, 19);

/** The zone the JSCalendar event is written in: null = floating / all-day. */
function eventZone(start: IcsTime): string | null {
  if (start.date || !start.zone) return null;
  if (start.zone === "UTC" || start.zone.startsWith("#")) return "Etc/UTC";
  return start.zone;
}

/** A time as a JSCalendar LocalDateTime in the event's zone. */
function localIn(t: IcsTime, cal: IcsCalendar, zone: string | null, allDay: boolean, masterWall: number): string {
  if (allDay) return `${utcToKey(t.wall)}T00:00:00`;
  // A DATE-valued EXDATE / RECURRENCE-ID on a timed series: that day at the series' time of day.
  if (t.date) return `${utcToKey(t.wall)}T${wallLocal(masterWall).slice(11)}`;
  if (!zone) return wallLocal(t.wall);
  return utcToLocal(toUtc(t, cal.zones, "UTC"), zone === "Etc/UTC" ? "UTC" : zone);
}

function ruleOf(r: RRule, cal: IcsCalendar, zone: string | null, allDay: boolean, masterWall: number): Raw {
  const rule: Raw = { "@type": "RecurrenceRule", frequency: r.freq };
  if (r.interval > 1) rule.interval = r.interval;
  if (r.count !== undefined) rule.count = r.count;
  if (r.until) rule.until = r.until.date ? `${utcToKey(r.until.wall)}T23:59:59` : localIn(r.until, cal, zone, allDay, masterWall);
  if (r.byDay) rule.byDay = r.byDay.map((d) => ({ "@type": "NDay", day: WD[d.wd], ...(d.n ? { nthOfPeriod: d.n } : {}) }));
  if (r.byMonthDay) rule.byMonthDay = r.byMonthDay;
  if (r.byMonth) rule.byMonth = r.byMonth.map(String);
  if (r.bySetPos) rule.bySetPosition = r.bySetPos;
  if (r.wkst !== 1) rule.firstDayOfWeek = WD[r.wkst];
  return rule;
}

function durationText(ev: IcsEvent, cal: IcsCalendar): string {
  const ms = durationOf(ev, cal.zones, "UTC");
  return ev.start.date ? `P${Math.max(1, Math.round(ms / DAY))}D` : formatDuration(ms);
}

function describe(ev: IcsEvent): string {
  return ev.url && !ev.description.includes(ev.url) ? `${ev.description}\n\n${ev.url}`.trim() : ev.description;
}

/** Converts every UID of the calendar; cancelled series are left out. */
export function toJsCalendar(cal: IcsCalendar): { items: ImportItem[]; cancelled: number } {
  const groups = new Map<string, { master: IcsEvent | null; overrides: IcsEvent[] }>();
  for (const ev of cal.events) {
    const g = groups.get(ev.uid) ?? { master: null, overrides: [] };
    if (ev.recurrenceId) g.overrides.push(ev);
    else if (!g.master || ev.sequence >= g.master.sequence) g.master = ev;
    groups.set(ev.uid, g);
  }

  const items: ImportItem[] = [];
  let cancelled = 0;
  for (const [uid, { master, overrides }] of groups) {
    // Orphan instances (no series in the file) become plain events; extra ones get a derived UID.
    if (!master) {
      overrides
        .filter((o) => o.status !== "cancelled")
        .forEach((o, i) => items.push({ uid: i ? `${uid}-${i}` : uid, event: single(o, cal, i ? `${uid}-${i}` : uid) }));
      continue;
    }
    if (master.status === "cancelled") {
      cancelled++;
      continue;
    }
    const event = single(master, cal, uid);
    const zone = eventZone(master.start);
    const allDay = master.start.date;
    if (master.rrule) event.recurrenceRules = [ruleOf(master.rrule, cal, zone, allDay, master.start.wall)];

    const patches: Record<string, Raw> = {};
    if (master.rrule || master.rdates?.length) {
      for (const r of master.rdates ?? []) patches[localIn(r, cal, zone, allDay, master.start.wall)] = {};
      for (const x of master.exdates ?? []) patches[localIn(x, cal, zone, allDay, master.start.wall)] = { excluded: true };
      for (const o of overrides) {
        const id = localIn(o.recurrenceId!, cal, zone, allDay, master.start.wall);
        if (o.status === "cancelled") {
          patches[id] = { excluded: true };
          continue;
        }
        const patch: Raw = {
          start: localIn(o.start, cal, zone, allDay, master.start.wall),
          duration: durationText(o, cal),
        };
        if (o.title !== master.title) patch.title = o.title;
        if (o.description !== master.description) patch.description = describe(o);
        if (o.location && o.location !== master.location) patch.locations = { l1: { "@type": "Location", name: o.location } };
        patches[id] = patch;
      }
    }
    if (Object.keys(patches).length) event.recurrenceOverrides = patches;
    items.push({ uid, event });
  }
  return { items, cancelled };
}

/** One event without recurrence (the series fields are added by the caller). */
function single(ev: IcsEvent, cal: IcsCalendar, uid: string): Raw {
  const zone = eventZone(ev.start);
  const allDay = ev.start.date;
  // Stalwart rejects explicit nulls on create, so optional properties are only set when present.
  const out: Raw = {
    "@type": "Event",
    uid,
    title: ev.title,
    start: allDay ? `${utcToKey(ev.start.wall)}T00:00:00` : zone ? localIn(ev.start, cal, zone, false, ev.start.wall) : wallLocal(ev.start.wall),
    duration: durationText(ev, cal),
    showWithoutTime: allDay,
  };
  if (zone) out.timeZone = zone;
  const description = describe(ev);
  if (description) out.description = description;
  if (ev.location) out.locations = { l1: { "@type": "Location", name: ev.location } };
  if (ev.transparent) out.freeBusyStatus = "free";
  if (ev.status === "tentative") out.status = "tentative";
  return out;
}

