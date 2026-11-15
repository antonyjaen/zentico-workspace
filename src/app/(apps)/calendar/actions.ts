"use server";

// Calendar mutations (CalendarEvent/set, Calendar/set). Every input is validated here.
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireSession } from "@/lib/auth";
import {
  CAL_USING,
  calendarAccount,
  getAvailability,
  getPrincipals,
  getRawEvent,
  normalizeEvent,
  participantEmail,
  resolveCalendarAccount,
  rightsFor,
  SHARE_ROLES,
  type BusyBlock,
  type CalEvent,
  type Principal,
  type ShareRole,
} from "@/lib/calendar";
import { jmap } from "@/lib/jmap";
import { addDays, diffDays, formatDuration, isDayKey, isTimeZone, utcToLocal, zonedToUtc } from "./time";

export type ActionResult<T = void> = { ok: true; data?: T } | { ok: false; error: string };

export type EventInput = {
  /** Account of the calendar (omitted for my own account). */
  accountId?: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timeZone: string;
  guests: { email: string; optional: boolean }[];
  alerts: number[];
  recurrence: "none" | "daily" | "weekly" | "monthly" | "yearly" | "keep";
};

type Raw = Record<string, unknown>;
const ID = /^[A-Za-z0-9_.:@-]{1,255}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const RECURRENCE = ["none", "daily", "weekly", "monthly", "yearly", "keep"] as const;
const ALERT_MAX = 60 * 24 * 28;

class InputError extends Error {}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !ID.test(id)) throw new InputError("Invalid id");
}
function text(v: unknown, max: number): string {
  if (typeof v !== "string") throw new InputError("Invalid text");
  return v.trim().slice(0, max);
}

async function wrap<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    revalidatePath("/calendar");
    return { ok: true, data };
  } catch (e) {
    unstable_rethrow(e);
    console.error("calendar action failed", e instanceof Error ? e.message : e);
    return { ok: false, error: e instanceof InputError ? e.message : "failed" };
  }
}

function setErrors(r: Record<string, unknown>, key: string) {
  for (const k of ["notCreated", "notUpdated", "notDestroyed"]) {
    const errs = r[k] as Record<string, { type?: string; description?: string }> | undefined;
    const err = errs?.[key];
    if (err) throw new Error(`${k}: ${err.type ?? "error"} ${err.description ?? ""}`.trim());
  }
}

function validate(input: EventInput) {
  if (!input || typeof input !== "object") throw new InputError("Invalid input");
  assertId(input.calendarId);
  const allDay = input.allDay === true;
  if (!isDayKey(input.startDate) || !isDayKey(input.endDate)) throw new InputError("Invalid date");
  if (!allDay && (!TIME.test(input.startTime) || !TIME.test(input.endTime))) throw new InputError("Invalid time");
  if (!allDay && !isTimeZone(input.timeZone)) throw new InputError("Invalid time zone");
  if (!Array.isArray(input.guests) || input.guests.length > 100) throw new InputError("Invalid guests");
  const guests = new Map<string, boolean>();
  for (const g of input.guests) {
    const email = typeof g?.email === "string" ? g.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email)) throw new InputError("Invalid guest email");
    guests.set(email, g.optional === true);
  }
  if (!Array.isArray(input.alerts) || input.alerts.length > 10) throw new InputError("Invalid reminders");
  const alerts = [...new Set(input.alerts)];
  for (const a of alerts) if (!Number.isInteger(a) || a < 0 || a > ALERT_MAX) throw new InputError("Invalid reminder");
  if (!RECURRENCE.includes(input.recurrence)) throw new InputError("Invalid recurrence");

  let start: string, timeZone: string | null, duration: string;
  if (allDay) {
    const days = diffDays(input.startDate, input.endDate) + 1;
    if (days < 1 || days > 366) throw new InputError("End before start");
    start = `${input.startDate}T00:00:00`;
    timeZone = null;
    duration = `P${days}D`;
  } else {
    start = `${input.startDate}T${input.startTime}:00`;
    const ms = zonedToUtc(start, input.timeZone);
    const endMs = zonedToUtc(`${input.endDate}T${input.endTime}:00`, input.timeZone);
    if (endMs <= ms || endMs - ms > 366 * 86_400_000) throw new InputError("End before start");
    timeZone = input.timeZone;
    duration = formatDuration(endMs - ms);
  }

  return {
    calendarId: input.calendarId,
    title: text(input.title, 500),
    description: text(input.description, 20_000),
    location: text(input.location, 500),
    allDay,
    start,
    timeZone,
    duration,
    guests,
    alerts,
    recurrence: input.recurrence,
  };
}

const newKey = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

function buildAlerts(alerts: number[]) {
  if (alerts.length === 0) return null;
  return Object.fromEntries(
    alerts.map((min) => [
      newKey(),
      {
        "@type": "Alert",
        action: "display",
        trigger: { "@type": "OffsetTrigger", relativeTo: "start", offset: min === 0 ? "PT0S" : `-${formatDuration(min * 60_000)}` },
      },
    ]),
  );
}

/** Builds JSCalendar participants, keeping existing entries (and their RSVP state) where possible. */
function buildParticipants(
  guests: Map<string, boolean>,
  me: { email: string; name: string },
  existing: Record<string, Raw>,
): Record<string, Raw> | null {
  if (guests.size === 0) return null;
  const byEmail = new Map(Object.entries(existing).map(([id, p]) => [participantEmail(p), { id, p }]));
  const out: Record<string, Raw> = {};
  const mine = byEmail.get(me.email);
  out[mine?.id ?? newKey()] = {
    ...(mine?.p ?? {}),
    "@type": "Participant",
    name: (mine?.p.name as string | undefined) ?? me.name,
    email: me.email,
    sendTo: { imip: `mailto:${me.email}` },
    roles: { owner: true, attendee: true },
    participationStatus: "accepted",
  };
  for (const [email, optional] of guests) {
    if (email === me.email) continue;
    const prev = byEmail.get(email);
    out[prev?.id ?? newKey()] = {
      "@type": "Participant",
      participationStatus: "needs-action",
      expectReply: true,
      ...(prev?.p ?? {}),
      email,
      sendTo: { imip: `mailto:${email}` },
      roles: optional ? { attendee: true, optional: true } : { attendee: true },
    };
  }
  return out;
}

/** Validates an optional account id from the client against the session's calendar accounts. */
async function account(accountId?: string | null): Promise<string> {
  if (accountId != null) assertId(accountId);
  return resolveCalendarAccount(accountId);
}

async function loadOwned(id: string, myEmail: string, accountId: string) {
  const raw = await getRawEvent(id, accountId);
  if (!raw) throw new InputError("Event not found");
  const ev = normalizeEvent(raw, "UTC", myEmail, accountId);
  return { raw, ev };
}

/** Creates (id = null) or updates an event. */
export async function saveEvent(id: string | null, input: EventInput): Promise<ActionResult<string>> {
  return wrap(async () => {
    const session = await requireSession();
    const me = { email: session.email.toLowerCase(), name: session.name };
    if (id !== null) assertId(id);
    const v = validate(input);
    const accountId = await account(input.accountId);

    let existingParticipants: Record<string, Raw> = {};
    let hadGuests = false;
    if (id) {
      const { raw, ev } = await loadOwned(id, me.email, accountId);
      if (!ev.isOrganizer) throw new InputError("Only the organizer can edit this event");
      existingParticipants = (raw.participants as Record<string, Raw> | null) ?? {};
      hadGuests = ev.participants.some((p) => !p.isMe);
    }
    const participants = buildParticipants(v.guests, me, existingParticipants);

    const event: Raw = {
      calendarIds: { [v.calendarId]: true },
      title: v.title,
      description: v.description,
      start: v.start,
      timeZone: v.timeZone,
      duration: v.duration,
      showWithoutTime: v.allDay,
      locations: v.location ? { [newKey()]: { "@type": "Location", name: v.location } } : null,
      participants,
      replyTo: participants ? { imip: `mailto:${me.email}` } : null,
      alerts: buildAlerts(v.alerts),
    };
    if (v.recurrence !== "keep") {
      event.recurrenceRules = v.recurrence === "none" ? null : [{ "@type": "RecurrenceRule", frequency: v.recurrence }];
    }
    const sendSchedulingMessages = !!participants || hadGuests;

    if (id) {
      const r = await jmap(
        [["CalendarEvent/set", { accountId, update: { [id]: event }, sendSchedulingMessages }, "s"]],
        CAL_USING,
      );
      setErrors(r.s, id);
      return id;
    }
    const create = { "@type": "Event", ...event };
    for (const k of Object.keys(create)) if ((create as Raw)[k] === null) delete (create as Raw)[k];
    const r = await jmap(
      [["CalendarEvent/set", { accountId, create: { new: create }, sendSchedulingMessages }, "s"]],
      CAL_USING,
    );
    setErrors(r.s, "new");
    return String(((r.s.created as Record<string, Raw>)?.new?.id as string | undefined) ?? "");
  });
}

/** Moves/resizes a timed event to absolute UTC instants (from drag in the time grid). */
export async function moveEvent(
  id: string,
  startMs: number,
  endMs: number,
  displayTz: string,
  accountId?: string,
): Promise<ActionResult> {
  return wrap(async () => {
    assertId(id);
    const acc = await account(accountId);
    if (!isTimeZone(displayTz)) throw new InputError("Invalid time zone");
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > 366 * 86_400_000)
      throw new InputError("Invalid range");
    const session = await requireSession();
    const { raw, ev } = await loadOwned(id, session.email, acc);
    if (!ev.isOrganizer) throw new InputError("Only the organizer can move this event");
    if (ev.allDay || ev.recurrence !== "none") throw new InputError("Event cannot be moved here");
    // Floating events (no timeZone) keep floating: write the wall-clock time the user saw.
    const tz = typeof raw.timeZone === "string" && isTimeZone(raw.timeZone) ? raw.timeZone : displayTz;
    await patch(id, { start: utcToLocal(startMs, tz), duration: formatDuration(endMs - startMs) }, ev, acc);
  });
}

/** Shifts an event by whole days, keeping its time of day (month view / all-day row). */
export async function shiftEventDays(id: string, days: number, accountId?: string): Promise<ActionResult> {
  return wrap(async () => {
    assertId(id);
    const acc = await account(accountId);
    if (!Number.isInteger(days) || Math.abs(days) > 3660) throw new InputError("Invalid shift");
    if (days === 0) return;
    const session = await requireSession();
    const { raw, ev } = await loadOwned(id, session.email, acc);
    if (!ev.isOrganizer) throw new InputError("Only the organizer can move this event");
    if (ev.recurrence !== "none") throw new InputError("Event cannot be moved here");
    const start = String(raw.start);
    await patch(id, { start: `${addDays(start.slice(0, 10), days)}${start.slice(10)}` }, ev, acc);
  });
}

async function patch(id: string, update: Raw, ev: CalEvent, accountId: string) {
  const sendSchedulingMessages = ev.participants.some((p) => !p.isMe);
  const r = await jmap(
    [["CalendarEvent/set", { accountId, update: { [id]: update }, sendSchedulingMessages }, "s"]],
    CAL_USING,
  );
  setErrors(r.s, id);
}

export async function deleteEvent(id: string, accountIdIn?: string): Promise<ActionResult> {
  return wrap(async () => {
    assertId(id);
    const accountId = await account(accountIdIn);
    const session = await requireSession();
    const { ev } = await loadOwned(id, session.email, accountId);
    const sendSchedulingMessages = ev.isOrganizer && ev.participants.some((p) => !p.isMe);
    const r = await jmap(
      [["CalendarEvent/set", { accountId, destroy: [id], sendSchedulingMessages }, "s"]],
      CAL_USING,
    );
    setErrors(r.s, id);
  });
}

/** Updates the signed-in user's own participationStatus and notifies the organizer. */
export async function respond(
  id: string,
  status: "accepted" | "tentative" | "declined",
  accountIdIn?: string,
): Promise<ActionResult> {
  return wrap(async () => {
    assertId(id);
    if (!["accepted", "tentative", "declined"].includes(status)) throw new InputError("Invalid status");
    const accountId = await account(accountIdIn);
    const session = await requireSession();
    const { ev } = await loadOwned(id, session.email, accountId);
    const mine = ev.participants.find((p) => p.isMe);
    if (!mine) throw new InputError("You are not invited to this event");
    const r = await jmap(
      [
        [
          "CalendarEvent/set",
          { accountId, update: { [id]: { [`participants/${mine.id}/participationStatus`]: status } }, sendSchedulingMessages: true },
          "s",
        ],
      ],
      CAL_USING,
    );
    setErrors(r.s, id);
  });
}

export async function setCalendarVisible(calendarId: string, visible: boolean, accountIdIn?: string): Promise<ActionResult> {
  return wrap(async () => {
    assertId(calendarId);
    const accountId = await account(accountIdIn);
    const r = await jmap(
      [["Calendar/set", { accountId, update: { [calendarId]: { isVisible: visible === true } } }, "s"]],
      CAL_USING,
    );
    setErrors(r.s, calendarId);
  });
}

/** Loads a stored event (e.g. the series behind an expanded instance) for the editor. */
export async function loadEvent(id: string, displayTz: string, accountIdIn?: string): Promise<ActionResult<CalEvent>> {
  try {
    assertId(id);
    if (!isTimeZone(displayTz)) throw new InputError("Invalid time zone");
    const accountId = await account(accountIdIn);
    const primary = accountId === (await calendarAccount());
    const session = await requireSession();
    const raw = await getRawEvent(id, accountId);
    if (!raw) throw new InputError("Event not found");
    return { ok: true, data: normalizeEvent(raw, displayTz, session.email, accountId, primary) };
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, error: e instanceof InputError ? e.message : "failed" };
  }
}

// ---- Managing my calendars ----

const COLOR = /^#[0-9a-fA-F]{6}$/;

function calendarName(v: unknown): string {
  const name = text(v, 255).replace(/[\u0000-\u001F\u007F]/g, "");
  if (!name) throw new InputError("Name required");
  return name;
}
function calendarColor(v: unknown): string {
  if (typeof v !== "string" || !COLOR.test(v)) throw new InputError("Invalid color");
  return v.toLowerCase();
}

/** Creates a calendar in my account. Retries with "@type" when the server insists on it. */
export async function createCalendar(name: string, color: string): Promise<ActionResult<string>> {
  return wrap(async () => {
    const calendar: Raw = { name: calendarName(name), color: calendarColor(color), isVisible: true };
    const accountId = await calendarAccount();
    const create = async (body: Raw) => {
      const r = await jmap([["Calendar/set", { accountId, create: { new: body } }, "s"]], CAL_USING);
      const err = (r.s.notCreated as Record<string, { type?: string; description?: string }> | undefined)?.new;
      return { r, err };
    };
    let { r, err } = await create(calendar);
    if (err && /@type/i.test(`${err.description ?? ""}`)) ({ r, err } = await create({ "@type": "Calendar", ...calendar }));
    if (err) {
      console.error("[calendar] Calendar/set create failed", err.type, err.description);
      throw new Error(`notCreated: ${err.type ?? "error"}`);
    }
    return String(((r.s.created as Record<string, Raw>)?.new?.id as string | undefined) ?? "");
  });
}

/** Renames / recolors one of my calendars. */
export async function updateCalendar(calendarId: string, patch: { name?: string; color?: string }): Promise<ActionResult> {
  return wrap(async () => {
    assertId(calendarId);
    const update: Raw = {};
    if (patch?.name !== undefined) update.name = calendarName(patch.name);
    if (patch?.color !== undefined) update.color = calendarColor(patch.color);
    if (!Object.keys(update).length) return;
    const accountId = await calendarAccount();
    const r = await jmap([["Calendar/set", { accountId, update: { [calendarId]: update } }, "s"]], CAL_USING);
    logSetError("Calendar/set update", r.s, calendarId);
    setErrors(r.s, calendarId);
  });
}

/** Deletes one of my calendars with its events (never the default one). */
export async function deleteCalendar(calendarId: string): Promise<ActionResult> {
  return wrap(async () => {
    assertId(calendarId);
    const accountId = await calendarAccount();
    const g = await jmap([["Calendar/get", { accountId, ids: [calendarId], properties: ["id", "isDefault"] }, "g"]], CAL_USING);
    const cal = ((g.g.list as Raw[]) ?? [])[0];
    if (!cal) throw new InputError("Calendar not found");
    if (cal.isDefault === true) throw new InputError("The default calendar can't be deleted");
    const r = await jmap(
      [["Calendar/set", { accountId, destroy: [calendarId], onDestroyRemoveEvents: true }, "s"]],
      CAL_USING,
    );
    logSetError("Calendar/set destroy", r.s, calendarId);
    setErrors(r.s, calendarId);
  });
}

/** Makes one of my calendars the default for new events. */
export async function setDefaultCalendar(calendarId: string): Promise<ActionResult> {
  return wrap(async () => {
    assertId(calendarId);
    const accountId = await calendarAccount();
    try {
      const r = await jmap([["Calendar/set", { accountId, onSuccessSetIsDefault: calendarId }, "s"]], CAL_USING);
      setErrors(r.s, calendarId);
    } catch (e) {
      unstable_rethrow(e);
      // Servers without onSuccessSetIsDefault may accept a direct isDefault update instead.
      console.error("[calendar] onSuccessSetIsDefault failed, trying isDefault update", e instanceof Error ? e.message : e);
      const r = await jmap([["Calendar/set", { accountId, update: { [calendarId]: { isDefault: true } } }, "s"]], CAL_USING);
      logSetError("Calendar/set isDefault", r.s, calendarId);
      setErrors(r.s, calendarId);
    }
  });
}

/** Replaces who one of my calendars is shared with (principal id → role). */
export async function shareCalendar(calendarId: string, shares: Record<string, ShareRole>): Promise<ActionResult> {
  return wrap(async () => {
    assertId(calendarId);
    if (!shares || typeof shares !== "object" || Object.keys(shares).length > 200) throw new InputError("Invalid sharing");
    const shareWith: Record<string, Record<string, boolean>> = {};
    for (const [principalId, role] of Object.entries(shares)) {
      assertId(principalId);
      if (!SHARE_ROLES.includes(role)) throw new InputError("Invalid role");
      shareWith[principalId] = rightsFor(role);
    }
    const accountId = await calendarAccount();
    const update = { shareWith };
    const r = await jmap([["Calendar/set", { accountId, update: { [calendarId]: update } }, "s"]], CAL_USING);
    logSetError("Calendar/set shareWith", r.s, calendarId);
    setErrors(r.s, calendarId);
  });
}

function logSetError(what: string, r: Record<string, unknown>, key: string) {
  for (const k of ["notCreated", "notUpdated", "notDestroyed"]) {
    const err = (r[k] as Record<string, { type?: string; description?: string }> | undefined)?.[key];
    if (err) console.error(`[calendar] ${what} ${k}`, err.type, err.description ?? "");
  }
}

// ---- People: principals and their availability (read-only; no revalidation) ----

async function read<T>(what: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    unstable_rethrow(e);
    if (!(e instanceof InputError)) console.error(`[calendar] ${what} failed`, e instanceof Error ? e.message : e);
    return { ok: false, error: e instanceof InputError ? e.message : "failed" };
  }
}

/** People and groups on this server (the client searches them locally). */
export async function listPrincipals(): Promise<ActionResult<Principal[]>> {
  return read("Principal/query", () => getPrincipals());
}

/** Busy blocks per principal id in [startMs, endMs) (max 20 people, 62 days). */
export async function principalsAvailability(
  ids: string[],
  startMs: number,
  endMs: number,
): Promise<ActionResult<Record<string, BusyBlock[]>>> {
  return read("Principal/getAvailability", async () => {
    if (!Array.isArray(ids) || ids.length > 20) throw new InputError("Invalid people");
    ids.forEach((id) => assertId(id));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > 62 * 86_400_000)
      throw new InputError("Invalid range");
    const out: Record<string, BusyBlock[]> = {};
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        try {
          out[id] = await getAvailability(id, startMs, endMs);
        } catch (e) {
          unstable_rethrow(e);
          // One person's availability failing (e.g. forbidden) shouldn't hide everyone else's.
          console.error("[calendar] Principal/getAvailability failed", id, e instanceof Error ? e.message : e);
        }
      }),
    );
    return out;
  });
}
