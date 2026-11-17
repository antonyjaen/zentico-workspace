// Calendar tools: events (list, read, create, update, delete, RSVP), calendars and free time.
// Times default to the user's time zone (the `timeZone` argument, else their calendars' zone)
// and are returned as local times with a UTC offset ("2026-11-16T10:00:00+01:00").
import { deleteEvent, respond, saveEvent, type EventInput } from "@/app/(apps)/calendar/actions";
import { addDays, DAY_MS, isTimeZone, utcToLocal, weekday, zonedParts, zonedToUtc } from "@/app/(apps)/calendar/time";
import { generateRoomCode } from "@/app/(apps)/meet/shared";
import { requireSession } from "../auth";
import {
  calendarAccount,
  createMeetingEvent,
  getAvailability,
  getCalendars,
  getEvents,
  getPrincipals,
  getRawEvent,
  normalizeEvent,
  resolveCalendarAccount,
  type CalEvent,
} from "../calendar";
import { subscriptionEvents } from "../calendar-subs/service";
import { bool, emailList, int, oneOf, str, ToolError, truncate, type Args } from "./args";
import { A, appUrl, B, I, S, type JsonSchema, type Tool } from "./kit";

/* ----------------------------------------------------------------- time */

const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EVENT_ID = /^[A-Za-z0-9_.:@-]{1,255}$/;

/** "YYYY-MM-DD" (midnight in tz), local "YYYY-MM-DDTHH:MM[:SS]" (in tz) or ISO with Z/offset. */
export function parseWhen(value: string, tz: string, key: string): number {
  try {
    if (DATE.test(value)) return zonedToUtc(`${value}T00:00:00`, tz);
    if (LOCAL_DT.test(value)) return zonedToUtc(value, tz);
  } catch {
    throw new ToolError(`"${key}" is not a valid date/time`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new ToolError(`"${key}" must be an ISO 8601 date or date-time`);
  return ms;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local wall-clock time in `tz` with its UTC offset, e.g. "2026-11-16T10:00:00+01:00". */
export function localIso(ms: number, tz: string): string {
  const local = utcToLocal(ms, tz);
  const offset = Math.round((Date.parse(`${local}Z`) - Math.floor(ms / 1000) * 1000) / 60_000);
  const a = Math.abs(offset);
  return `${local}${offset < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// The user's zone rarely changes: remember it per user for a while.
const TZ_TTL_MS = 10 * 60_000;
const g = globalThis as typeof globalThis & { __zwMcpTz?: Map<string, { at: number; tz: string }> };
const tzCache = (g.__zwMcpTz ??= new Map());

/**
 * The user's time zone: their default (or any own) calendar's zone, else the zone most of their
 * recent timed events were created in, else UTC.
 */
export async function userTimeZone(): Promise<string> {
  const { email } = await requireSession();
  const hit = tzCache.get(email);
  if (hit && Date.now() - hit.at < TZ_TTL_MS) return hit.tz;
  let tz = "UTC";
  try {
    const own = (await getCalendars()).filter((c) => !c.owner && c.timeZone && isTimeZone(c.timeZone));
    const fromCalendar = (own.find((c) => c.isDefault) ?? own[0])?.timeZone;
    if (fromCalendar) tz = fromCalendar;
    else {
      const now = Date.now();
      const { events } = await getEvents(now - 60 * DAY_MS, now + 30 * DAY_MS, "UTC", email);
      const counts = new Map<string, number>();
      for (const e of events) if (!e.allDay && e.isOrganizer && e.timeZone && isTimeZone(e.timeZone)) counts.set(e.timeZone, (counts.get(e.timeZone) ?? 0) + 1);
      const best = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (best) tz = best[0];
    }
  } catch (e) {
    console.error("[mcp] user time zone:", e instanceof Error ? e.message : e);
  }
  if (tzCache.size > 1000) tzCache.clear();
  tzCache.set(email, { at: Date.now(), tz });
  return tz;
}

/** The `timeZone` argument (validated), else the user's own time zone. */
async function timeZoneArg(args: Args): Promise<string> {
  const tz = str(args, "timeZone", { max: 64 });
  if (tz == null) return userTimeZone();
  if (!isTimeZone(tz)) throw new ToolError(`Unknown time zone "${tz}" (use an IANA name like "Europe/Madrid")`);
  return tz;
}

const TZ_PROP = S('IANA time zone for inputs and outputs, e.g. "Europe/Madrid". Default: your calendar time zone.');

/* ---------------------------------------------------------------- events */

function eventId(args: Args): string {
  const v = str(args, "eventId", { required: true, max: 255 });
  if (!EVENT_ID.test(v)) throw new ToolError('"eventId" is not valid');
  return v;
}

function optAccount(args: Args): string | undefined {
  const v = str(args, "accountId", { max: 255 });
  if (v !== undefined && !/^[A-Za-z0-9_-]{1,255}$/.test(v)) throw new ToolError('"accountId" is not valid');
  return v;
}

const MEET_LINK = /https?:\/\/[^\s"'<>]+\/meet\/[a-z0-9-]{3,64}/i;

function compactEvent(e: CalEvent, tz: string, primary?: string) {
  return {
    id: e.baseId,
    accountId: primary && e.accountId !== primary ? e.accountId : undefined,
    title: e.title,
    start: e.allDay ? e.startDay : localIso(e.utcStart, tz),
    end: e.allDay ? e.endDay : localIso(e.utcEnd, tz),
    allDay: e.allDay || undefined,
    location: e.location || undefined,
    description: e.description ? truncate(e.description, 500) : undefined,
    recurring: e.recurrence !== "none" || undefined,
    organizer: e.isOrganizer || undefined,
    readOnly: e.external ? true : undefined,
    calendar: e.external ? `${e.external.name} (subscription)` : undefined,
    myStatus: e.myStatus ?? undefined,
    attendees: e.participants.length
      ? e.participants.map((p) => `${p.name ? `${p.name} <${p.email}>` : p.email}${p.status !== "needs-action" ? ` (${p.status})` : ""}`)
      : undefined,
  };
}

/** Cached events of the user's external calendar subscriptions (best effort, never fetches). */
function externalEvents(owner: string, start: number, end: number, tz: string): CalEvent[] {
  try {
    return subscriptionEvents(owner, start, end, tz, (s) => s.visible);
  } catch {
    return [];
  }
}

/** Loads one stored event (the series for recurring events) as the signed-in user sees it. */
async function loadEvent(args: Args, tz: string) {
  const id = eventId(args);
  const { email } = await requireSession();
  const accountId = await resolveCalendarAccount(optAccount(args));
  const primary = await calendarAccount();
  const raw = await getRawEvent(id, accountId);
  if (!raw) throw new ToolError("Event not found (pass accountId for events in shared calendars)");
  return { id, accountId, primary, ev: normalizeEvent(raw, tz, email, accountId, accountId === primary) };
}

type Interval = { start: number; end: number };

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

const EVENT_REF: Record<string, JsonSchema> = {
  eventId: S("Event id (from calendar_list_events)."),
  accountId: S("Account of a shared calendar (as returned with the event; omit for your own)."),
};

export const CALENDAR_TOOLS: Tool[] = [
  {
    name: "calendar_list_events",
    description:
      "Lists calendar events (own and shared calendars, plus read-only events from subscribed external calendars marked readOnly; recurrences expanded) overlapping a time range. Times are local times with UTC offset in `timeZone` (default: your time zone).",
    inputSchema: {
      type: "object",
      properties: {
        start: S('Range start: "YYYY-MM-DD", local "YYYY-MM-DDTHH:MM" (in timeZone) or ISO with offset. Default: now.'),
        end: S("Range end (exclusive). Default: start + 7 days. Max range 92 days."),
        timeZone: TZ_PROP,
        query: S("Only events whose title, description or location contains this text."),
        limit: I("Max events.", 1, 500, 100),
        position: I("Offset for pagination.", 0, 10_000, 0),
      },
    },
    async run(args, ctx) {
      const tz = await timeZoneArg(args);
      const startArg = str(args, "start", { max: 40 });
      const endArg = str(args, "end", { max: 40 });
      const start = startArg ? parseWhen(startArg, tz, "start") : Date.now();
      const end = endArg ? parseWhen(endArg, tz, "end") : start + 7 * DAY_MS;
      if (end <= start) throw new ToolError('"end" must be after "start"');
      if (end - start > 92 * DAY_MS) throw new ToolError("The range can be at most 92 days");
      const q = str(args, "query", { max: 200 })?.toLowerCase();
      const limit = int(args, "limit", { min: 1, max: 500, def: 100 });
      const position = int(args, "position", { min: 0, max: 10_000, def: 0 });
      const [{ events: own }, primary] = await Promise.all([getEvents(start, end, tz, ctx.session.email), calendarAccount()]);
      const events = [...own, ...externalEvents(ctx.session.sub, start, end, tz)].sort((a, b) => a.utcStart - b.utcStart);
      const inRange = events.filter(
        (e) => e.utcEnd > start && e.utcStart < end && (!q || `${e.title}\n${e.description}\n${e.location}`.toLowerCase().includes(q)),
      );
      const page = inRange.slice(position, position + limit);
      return {
        timeZone: tz,
        total: inRange.length,
        nextPosition: position + page.length < inRange.length ? position + page.length : null,
        events: page.map((e) => compactEvent(e, tz, primary)),
      };
    },
  },
  {
    name: "calendar_create_event",
    description:
      "Creates an event in the user's default calendar and emails invitations to attendees. Optionally adds a Zentico Meet video link.",
    inputSchema: {
      type: "object",
      properties: {
        title: S("Event title."),
        start: S('Start: local "YYYY-MM-DDTHH:MM" in timeZone, or ISO with offset (e.g. "2026-11-16T10:00:00+01:00").'),
        end: S("End (same formats). Use either end or durationMinutes."),
        durationMinutes: I("Duration in minutes (default 30).", 5, 24 * 60),
        timeZone: TZ_PROP,
        attendees: A("Attendee email addresses to invite."),
        location: S("Location (room, address or link)."),
        description: S("Description / agenda."),
        add_video_meeting: B("Create a Zentico Meet link for the event."),
      },
      required: ["title", "start"],
    },
    write: true,
    openWorld: true,
    async run(args) {
      const tz = await timeZoneArg(args);
      const title = str(args, "title", { required: true, max: 300 }).trim();
      if (!title) throw new ToolError('"title" is required');
      const start = parseWhen(str(args, "start", { required: true, max: 40 }), tz, "start");
      const endArg = str(args, "end", { max: 40 });
      const durationMs = endArg
        ? parseWhen(endArg, tz, "end") - start
        : int(args, "durationMinutes", { min: 5, max: 24 * 60, def: 30 }) * 60_000;
      if (durationMs <= 0) throw new ToolError('"end" must be after "start"');
      if (durationMs > 7 * DAY_MS) throw new ToolError("Events can last at most 7 days");
      const attendees = emailList(args, "attendees", 100).map((email) => ({ email }));
      let location = str(args, "location", { max: 500 }) ?? "";
      let description = str(args, "description", { max: 20_000 }) ?? "";
      let meetUrl: string | null = null;
      if (bool(args, "add_video_meeting")) {
        meetUrl = `${appUrl()}/meet/${generateRoomCode()}`;
        if (!location) location = meetUrl;
        else description = `${description ? `${description}\n\n` : ""}Video meeting: ${meetUrl}`;
      }
      const created = await createMeetingEvent({
        title,
        description,
        start: utcToLocal(start, tz),
        timeZone: tz,
        durationMs,
        location,
        attendees,
      });
      return {
        id: created.id,
        title,
        start: localIso(start, tz),
        end: localIso(start + durationMs, tz),
        timeZone: tz,
        invited: attendees.map((a) => a.email),
        meetUrl: meetUrl ?? undefined,
      };
    },
  },
  {
    name: "calendar_find_free_time",
    description:
      "Finds time windows when the user and the given colleagues are all free (uses the user's calendar plus colleagues' free/busy). Returns free windows within working hours.",
    inputSchema: {
      type: "object",
      properties: {
        attendees: A("Colleague email addresses (the user is always included)."),
        start: S("Range start (date or date-time). Default: now."),
        end: S("Range end. Default: start + 7 days. Max 31 days."),
        durationMinutes: I("Required meeting length in minutes.", 5, 8 * 60, 30),
        timeZone: TZ_PROP,
        workdayStart: S('Working hours start "HH:MM" (default "09:00").'),
        workdayEnd: S('Working hours end "HH:MM" (default "18:00").'),
        includeWeekends: B("Also search Saturdays and Sundays."),
        limit: I("Max windows returned.", 1, 100, 20),
      },
    },
    async run(args, ctx) {
      const tz = await timeZoneArg(args);
      const startArg = str(args, "start", { max: 40 });
      const endArg = str(args, "end", { max: 40 });
      const from = Math.max(startArg ? parseWhen(startArg, tz, "start") : Date.now(), Date.now());
      const to = endArg ? parseWhen(endArg, tz, "end") : from + 7 * DAY_MS;
      if (to <= from) throw new ToolError('"end" must be in the future and after "start"');
      if (to - from > 31 * DAY_MS) throw new ToolError("The range can be at most 31 days");
      const duration = int(args, "durationMinutes", { min: 5, max: 480, def: 30 }) * 60_000;
      const ws = str(args, "workdayStart", { max: 5 }) ?? "09:00";
      const we = str(args, "workdayEnd", { max: 5 }) ?? "18:00";
      if (!HHMM.test(ws) || !HHMM.test(we) || we <= ws) throw new ToolError("Working hours must be HH:MM with start before end");
      const weekends = bool(args, "includeWeekends");
      const limit = int(args, "limit", { min: 1, max: 100, def: 20 });

      const me = ctx.session.email.toLowerCase();
      const emails = [...new Set(emailList(args, "attendees", 50).map((e) => e.toLowerCase()))].filter((e) => e !== me);
      const [{ events }, principals] = await Promise.all([
        getEvents(from, to, tz, ctx.session.email),
        emails.length ? getPrincipals().catch(() => []) : Promise.resolve([]),
      ]);
      const busy: Interval[] = events
        .filter((e) => !e.allDay && e.myStatus !== "declined")
        .map((e) => ({ start: e.utcStart, end: e.utcEnd }));
      const checked: string[] = [];
      const unknown: string[] = [];
      await Promise.all(
        emails.map(async (email) => {
          const p = principals.find((x) => x.email === email && x.type === "individual") ?? principals.find((x) => x.email === email);
          if (!p) return void unknown.push(email);
          try {
            const blocks = await getAvailability(p.id, from, to);
            busy.push(...blocks.filter((b) => b.status !== "free").map((b) => ({ start: b.start, end: b.end })));
            checked.push(email);
          } catch {
            unknown.push(email);
          }
        }),
      );
      const merged = mergeIntervals(busy);

      const windows: { start: string; end: string; minutes: number }[] = [];
      const lastDay = zonedParts(to, tz).key;
      for (let day = zonedParts(from, tz).key; day <= lastDay && windows.length < limit; day = addDays(day, 1)) {
        const wd = weekday(day);
        if (!weekends && (wd === 0 || wd === 6)) continue;
        let cursor = Math.max(zonedToUtc(`${day}T${ws}:00`, tz), from);
        const dayEnd = Math.min(zonedToUtc(`${day}T${we}:00`, tz), to);
        // Start on a 5-minute boundary.
        cursor = Math.ceil(cursor / 300_000) * 300_000;
        for (const b of merged) {
          if (b.end <= cursor) continue;
          if (b.start >= dayEnd) break;
          if (b.start - cursor >= duration) windows.push({ start: localIso(cursor, tz), end: localIso(b.start, tz), minutes: Math.round((b.start - cursor) / 60_000) });
          cursor = Math.max(cursor, b.end);
          if (windows.length >= limit) break;
        }
        if (windows.length < limit && dayEnd - cursor >= duration) {
          windows.push({ start: localIso(cursor, tz), end: localIso(dayEnd, tz), minutes: Math.round((dayEnd - cursor) / 60_000) });
        }
      }
      return {
        timeZone: tz,
        durationMinutes: duration / 60_000,
        checked: [ctx.session.email, ...checked],
        unknownAvailability: unknown.length ? unknown : undefined,
        freeWindows: windows,
      };
    },
  },
  {
    name: "calendar_list_calendars",
    description: "Lists your calendars and calendars shared with you (id, owner, default, time zone, whether you can add events).",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const [calendars, tz] = await Promise.all([getCalendars(), userTimeZone()]);
      return {
        yourTimeZone: tz,
        calendars: calendars.map((c) => ({
          id: c.id,
          accountId: c.owner ? c.accountId : undefined,
          name: c.name,
          owner: c.owner ?? undefined,
          default: c.isDefault || undefined,
          timeZone: c.timeZone ?? undefined,
          canWrite: c.mayWrite,
          hidden: c.isVisible ? undefined : true,
          sharedWith: Object.keys(c.shareWith).length || undefined,
        })),
      };
    },
  },
  {
    name: "calendar_get_event",
    description:
      "Reads one event in full: description, attendees with their responses, recurrence, reminders, calendar and video link. For recurring events this is the series.",
    inputSchema: { type: "object", properties: { ...EVENT_REF, timeZone: TZ_PROP }, required: ["eventId"] },
    async run(args) {
      const tz = await timeZoneArg(args);
      const { accountId, primary, ev } = await loadEvent(args, tz);
      const calendar = (await getCalendars().catch(() => [])).find((c) => c.accountId === accountId && c.id === ev.calendarId);
      return {
        id: ev.baseId,
        accountId: accountId !== primary ? accountId : undefined,
        calendar: calendar?.name,
        title: ev.title,
        start: ev.allDay ? ev.startDay : localIso(ev.utcStart, tz),
        end: ev.allDay ? ev.endDay : localIso(ev.utcEnd, tz),
        timeZone: tz,
        eventTimeZone: ev.timeZone && ev.timeZone !== tz ? ev.timeZone : undefined,
        allDay: ev.allDay || undefined,
        location: ev.location || undefined,
        description: ev.description ? truncate(ev.description, 20_000) : undefined,
        videoLink: MEET_LINK.exec(`${ev.location}\n${ev.description}`)?.[0],
        recurrence: ev.recurrence !== "none" ? ev.recurrence : undefined,
        remindersMinutesBefore: ev.alerts.length ? ev.alerts : undefined,
        youAreOrganizer: ev.isOrganizer,
        myStatus: ev.myStatus ?? undefined,
        attendees: ev.participants.length
          ? ev.participants.map((p) => ({
              name: p.name ?? undefined,
              email: p.email,
              status: p.status,
              organizer: p.isOwner || undefined,
              optional: p.isOptional || undefined,
            }))
          : undefined,
      };
    },
  },
  {
    name: "calendar_update_event",
    description:
      "Changes an event you organize: title, time, location, description or attendees (attendees are notified). Times keep the event's duration when only `start` changes. For recurring events this changes the whole series. Use calendar_rsvp to answer invitations instead.",
    inputSchema: {
      type: "object",
      properties: {
        ...EVENT_REF,
        title: S("New title."),
        start: S('New start: local "YYYY-MM-DDTHH:MM" in timeZone or ISO with offset; "YYYY-MM-DD" for all-day events.'),
        end: S("New end (same formats; for all-day events the last day, inclusive)."),
        durationMinutes: I("New duration in minutes (instead of end).", 5, 7 * 24 * 60),
        allDay: { type: "boolean", description: "Make it an all-day event (true) or a timed one (false, needs start)." },
        location: S('New location ("" clears it).'),
        description: S('New description ("" clears it).'),
        attendees: A("Replace the attendee list with these email addresses."),
        addAttendees: A("Invite these email addresses."),
        removeAttendees: A("Remove these email addresses."),
        timeZone: TZ_PROP,
      },
      required: ["eventId"],
    },
    write: true,
    openWorld: true,
    async run(args, ctx) {
      const tz = await timeZoneArg(args);
      const { id, accountId, primary, ev } = await loadEvent(args, tz);
      if (!ev.isOrganizer) throw new ToolError("Only the organizer can change this event; use calendar_rsvp to respond to it");
      const me = ctx.session.email.toLowerCase();

      const allDay = typeof args.allDay === "boolean" ? args.allDay : ev.allDay;
      const startArg = str(args, "start", { max: 40 });
      const endArg = str(args, "end", { max: 40 });
      const hasDuration = args.durationMinutes != null && args.durationMinutes !== "";

      let startDate: string, startTime: string, endDate: string, endTime: string;
      // Timed events are written in the event's own zone unless the caller chose one explicitly.
      const writeTz = str(args, "timeZone") || !ev.timeZone || !isTimeZone(ev.timeZone) ? tz : ev.timeZone;
      if (allDay) {
        startDate = startArg ? startArg.slice(0, 10) : ev.allDay ? ev.startDay : utcToLocal(ev.utcStart, tz).slice(0, 10);
        const days = ev.allDay ? Math.max(1, Math.round((Date.parse(ev.endDay) - Date.parse(ev.startDay)) / DAY_MS)) : 1;
        endDate = endArg ? endArg.slice(0, 10) : addDays(startDate, days - 1);
        if (!DATE.test(startDate) || !DATE.test(endDate)) throw new ToolError('All-day events take dates like "2026-11-16"');
        if (endDate < startDate) throw new ToolError('"end" must not be before "start"');
        startTime = "00:00";
        endTime = "00:00";
      } else {
        if (ev.allDay && !startArg) throw new ToolError('Pass "start" (with a time) to turn an all-day event into a timed one');
        const oldDuration = ev.allDay ? 60 * 60_000 : ev.utcEnd - ev.utcStart;
        const start = startArg ? parseWhen(startArg, tz, "start") : ev.utcStart;
        const end = endArg
          ? parseWhen(endArg, tz, "end")
          : hasDuration
            ? start + int(args, "durationMinutes", { min: 5, max: 7 * 24 * 60, def: 30 }) * 60_000
            : start + oldDuration;
        if (end <= start) throw new ToolError('"end" must be after "start"');
        const s = utcToLocal(start, writeTz);
        const e = utcToLocal(end, writeTz);
        [startDate, startTime, endDate, endTime] = [s.slice(0, 10), s.slice(11, 16), e.slice(0, 10), e.slice(11, 16)];
      }

      const guests = new Map(ev.participants.filter((p) => p.email !== me).map((p) => [p.email, p.isOptional]));
      if (args.attendees != null) {
        guests.clear();
        for (const e of emailList(args, "attendees", 100)) guests.set(e.toLowerCase(), false);
      }
      for (const e of emailList(args, "addAttendees", 100)) if (!guests.has(e.toLowerCase())) guests.set(e.toLowerCase(), false);
      for (const e of emailList(args, "removeAttendees", 100)) guests.delete(e.toLowerCase());

      const input: EventInput = {
        accountId: accountId !== primary ? accountId : undefined,
        calendarId: ev.calendarId,
        title: str(args, "title", { max: 500 }) ?? ev.title,
        description: str(args, "description", { max: 20_000 }) ?? (args.description === "" ? "" : ev.description),
        location: str(args, "location", { max: 500 }) ?? (args.location === "" ? "" : ev.location),
        allDay,
        startDate,
        startTime,
        endDate,
        endTime,
        timeZone: writeTz,
        guests: [...guests].map(([email, optional]) => ({ email, optional })),
        alerts: ev.alerts,
        recurrence: "keep",
      };
      const r = await saveEvent(id, input);
      if (!r.ok) throw new ToolError(`Could not update the event (${r.error})`);
      const { ev: next } = await loadEvent(args, tz);
      return { updated: true, timeZone: tz, event: compactEvent(next, tz, primary) };
    },
  },
  {
    name: "calendar_delete_event",
    description:
      "Deletes an event from your calendar. If you organize it, attendees get a cancellation. For recurring events this deletes the whole series.",
    inputSchema: { type: "object", properties: EVENT_REF, required: ["eventId"] },
    write: true,
    destructive: true,
    openWorld: true,
    async run(args) {
      const tz = await userTimeZone();
      const { id, accountId, primary, ev } = await loadEvent(args, tz);
      const r = await deleteEvent(id, accountId !== primary ? accountId : undefined);
      if (!r.ok) throw new ToolError(`Could not delete the event (${r.error})`);
      const notified = ev.isOrganizer ? ev.participants.filter((p) => !p.isMe).map((p) => p.email) : [];
      return { deleted: true, title: ev.title, series: ev.recurrence !== "none" || undefined, cancellationSentTo: notified.length ? notified : undefined };
    },
  },
  {
    name: "calendar_rsvp",
    description: "Answers an invitation (accepted, tentative or declined); the organizer is notified.",
    inputSchema: {
      type: "object",
      properties: {
        ...EVENT_REF,
        status: S('"accepted", "tentative" or "declined".', { enum: ["accepted", "tentative", "declined"] }),
      },
      required: ["eventId", "status"],
    },
    write: true,
    openWorld: true,
    async run(args) {
      const status = oneOf(args, "status", ["accepted", "tentative", "declined"] as const, "accepted");
      if (args.status == null) throw new ToolError('"status" is required');
      const tz = await userTimeZone();
      const { id, accountId, primary, ev } = await loadEvent(args, tz);
      if (!ev.participants.some((p) => p.isMe)) throw new ToolError("You are not an attendee of this event");
      if (ev.isOrganizer) throw new ToolError("You organize this event; there is no invitation to answer");
      const r = await respond(id, status, accountId !== primary ? accountId : undefined);
      if (!r.ok) throw new ToolError(`Could not answer the invitation (${r.error})`);
      return { title: ev.title, start: ev.allDay ? ev.startDay : localIso(ev.utcStart, tz), status };
    },
  },
];
