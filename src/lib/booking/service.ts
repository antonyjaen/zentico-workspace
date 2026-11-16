// Booking pages: what the public pages and the owner's tools do. Server-only.
//
// Free/busy comes from the owner's calendars through their booking key (asHost); only start/end
// of busy events ever leave this module, never titles or details. A booking is guarded twice:
// the slot is recomputed from fresh calendar data, then reserved in one SQLite write transaction
// that rejects overlaps with the owner's other bookings (db.ts reserve), so two guests racing for
// the same slot can't both get it.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { DAY_MS, formatDuration, utcToLocal, zonedParts } from "@/app/(apps)/calendar/time";
import { generateRoomCode } from "@/app/(apps)/meet/shared";
import { CAL_USING, getCalendars, getEvents } from "../calendar";
import { env } from "../env";
import { jmap } from "../jmap";
import { notify } from "../notifications/store";
import {
  bookingById,
  bookingByJoinToken,
  bookingByManageToken,
  cancelBookingRow,
  confirmedBookings,
  countsPerDay,
  getType,
  hostByHandle,
  hostBySub,
  reserve,
  reserveMove,
  restoreBookingTimes,
  setBookingEvent,
  typeBySlug,
  type Booking,
  type Host,
} from "./db";
import { tr, type CopyKey } from "./copy";
import { asHost } from "./host";
import { buildIcs, buildMime, renderHtml, renderText, sendRaw, type MailBlock } from "./mail";
import { clampRange, computeSlots, isBookable, ownerDayBounds, type Interval } from "./slots";
import { cleanText, isEmail, LIMITS, type BookingType } from "./types";

export type Problem = "not_found" | "unavailable" | "invalid" | "slot_taken" | "limit" | "failed" | "too_late";
export class BookingProblem extends Error {
  constructor(readonly code: Problem) {
    super(code);
  }
}

/* ------------------------------------------------------------- lookups */

/** A host whose public pages can work (booking key present). */
export function activeHost(handle: string): Host | null {
  const host = hostByHandle(handle);
  return host && host.credentialSealed && !host.needsReauth ? host : null;
}

export function activePage(handle: string, slug: string): { host: Host; type: BookingType } | null {
  const host = activeHost(handle);
  const type = host ? typeBySlug(host.sub, slug) : null;
  return host && type?.active ? { host, type } : null;
}

/* ------------------------------------------------------------- free/busy */

/**
 * Busy intervals for `type` in [from, to): the owner's events in the calendars that count as busy
 * (declined and all-day events don't block) plus their confirmed bookings. Also notices bookings
 * whose calendar event the owner deleted and releases them.
 */
async function busyFor(host: Host, type: BookingType, from: number, to: number, exclude?: Booking): Promise<Interval[]> {
  const span = { from: from - DAY_MS, to: to + DAY_MS };
  const { events } = await asHost(host, () => getEvents(span.from, span.to, "UTC", host.email));
  const keys = new Set(type.busyCalendars);
  const busy: Interval[] = events
    .filter((e) => keys.has(e.calKey) && !e.allDay && e.myStatus !== "declined" && (!exclude || e.baseId !== exclude.eventId))
    .map((e) => ({ start: e.utcStart, end: e.utcEnd }));

  const ids = new Set(events.map((e) => e.baseId));
  const settled = Date.now() - 5 * 60_000;
  for (const b of confirmedBookings(host.sub, span.from, span.to)) {
    if (exclude && b.id === exclude.id) continue;
    // The owner removed the event from their calendar (Stalwart told the guest): free the slot.
    if (b.eventId && b.created < settled && b.start >= span.from && b.end <= span.to && !ids.has(b.eventId)) {
      cancelBookingRow(b.id);
      continue;
    }
    busy.push({ start: b.start, end: b.end });
  }
  return busy;
}

const perDayFor = (type: BookingType, from: number, to: number, exceptId = "") =>
  countsPerDay(type.id, from - DAY_MS, to + DAY_MS, (ms) => zonedParts(ms, type.timeZone).key, exceptId);

/** Bookable slot starts (UTC ms) in [from, to) for a meeting of `duration` minutes. */
export async function getSlots(host: Host, type: BookingType, duration: number, from: number, to: number, exclude?: Booking): Promise<number[]> {
  if (!type.durations.includes(duration)) throw new BookingProblem("invalid");
  const now = Date.now();
  const range = clampRange(type, now, from, to);
  if (range.to <= range.from) return [];
  const busy = await busyFor(host, type, range.from, range.to, exclude);
  return computeSlots(type, duration, range.from, range.to, { now, busy, perDay: perDayFor(type, range.from, range.to, exclude?.id) });
}

/* --------------------------------------------------------------- tokens */

const token = () => randomBytes(32).toString("base64url");
/** The guest's join link token, derived from the manage token so only hashes need storing. */
const joinTokenOf = (manageToken: string) => createHmac("sha256", env.sessionSecret).update(`booking-join:${manageToken}`).digest("base64url");
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const manageUrl = (t: string) => `${env.appUrl}/book/manage/${t}`;
export const joinUrl = (manageToken: string) => `${env.appUrl}/book/join/${joinTokenOf(manageToken)}`;

/* -------------------------------------------------------------- copy */

type Locale = "es" | "en";

export function formatWhen(ms: number, end: number, tz: string, locale: Locale): string {
  const tag = locale === "es" ? "es-ES" : "en-US";
  const day = new Intl.DateTimeFormat(tag, { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(ms);
  const time = new Intl.DateTimeFormat(tag, { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time.format(ms)} – ${time.format(end)} (${tz})`;
}

/* ---------------------------------------------------------- calendar */

type Raw = Record<string, unknown>;

/** The type's target calendar if it is one of the owner's writable calendars, else their default. */
async function targetCalendar(type: BookingType): Promise<{ accountId: string; id: string }> {
  const own = (await getCalendars()).filter((c) => c.owner === null && c.mayWrite);
  const cal = own.find((c) => c.key === type.calendar) ?? own.find((c) => c.isDefault) ?? own[0];
  if (!cal) throw new BookingProblem("failed");
  return { accountId: cal.accountId, id: cal.id };
}

function locationText(type: BookingType, b: Pick<Booking, "answers">, manageToken: string, locale: Locale): string {
  switch (type.location.kind) {
    case "meet":
      return joinUrl(manageToken);
    case "phone": {
      const phone = b.answers.find((a) => a.label === PHONE_LABEL)?.value ?? "";
      return type.location.value || tr(locale, "phoneLocation", { phone });
    }
    default:
      return type.location.value;
  }
}

const PHONE_LABEL = "phone";

async function createEvent(host: Host, type: BookingType, b: Booking, manageToken: string): Promise<string> {
  const { accountId, id: calendarId } = await asHost(host, () => targetCalendar(type));
  const key = () => randomUUID().replace(/-/g, "").slice(0, 12);
  const owner = host.email.toLowerCase();
  const lines = [
    tr(host.locale, "eventBookedVia", { title: type.title }),
    `${tr(host.locale, "guest")}: ${b.guestName} <${b.guestEmail}>`,
    ...b.answers.map((a) => `${a.label === PHONE_LABEL ? tr(host.locale, "phone") : a.label}: ${a.value}`),
    `${tr(host.locale, "guestTimeZone")}: ${b.guestTz}`,
  ];
  if (b.room) lines.push("", `Zentico Meet: ${env.appUrl}/meet/${b.room}`, `${tr(host.locale, "guestLink")}: ${joinUrl(manageToken)}`);
  const location = locationText(type, b, manageToken, host.locale);
  const event: Raw = {
    "@type": "Event",
    uid: b.eventUid,
    calendarIds: { [calendarId]: true },
    title: `${type.title} · ${b.guestName}`.slice(0, 300),
    description: lines.join("\n"),
    start: utcToLocal(b.start, type.timeZone),
    timeZone: type.timeZone,
    duration: formatDuration(b.end - b.start),
    showWithoutTime: false,
    freeBusyStatus: "busy",
    participants: {
      [key()]: { "@type": "Participant", name: host.name, email: owner, sendTo: { imip: `mailto:${owner}` }, roles: { owner: true, attendee: true }, participationStatus: "accepted" },
      [key()]: { "@type": "Participant", name: b.guestName, email: b.guestEmail, sendTo: { imip: `mailto:${b.guestEmail}` }, roles: { attendee: true }, participationStatus: "needs-action", expectReply: true },
    },
    replyTo: { imip: `mailto:${owner}` },
  };
  if (location) event.locations = { [key()]: { "@type": "Location", name: location } };
  // Our own e-mail carries the invitation (with the manage links), so Stalwart doesn't send one.
  const r = await asHost(host, () =>
    jmap([["CalendarEvent/set", { accountId, create: { b: event }, sendSchedulingMessages: false }, "s"]], CAL_USING),
  );
  const id = (r.s.created as Record<string, Raw> | undefined)?.b?.id;
  if (!id) throw new Error(`CalendarEvent/set: ${JSON.stringify(r.s.notCreated ?? {}).slice(0, 200)}`);
  return String(id);
}

async function eventAccount(host: Host, type: BookingType | null): Promise<string> {
  if (type) return (await asHost(host, () => targetCalendar(type))).accountId;
  const own = await asHost(host, () => getCalendars());
  return own.find((c) => c.owner === null)?.accountId ?? "";
}

/* -------------------------------------------------------------- mail */

function guestMail(host: Host, type: BookingType | null, b: Booking, manageToken: string, kind: "confirmed" | "rescheduled" | "cancelled", reason = "") {
  const L = b.locale;
  const title = type?.title ?? tr(L, "meeting");
  const ownerName = host.name || host.email;
  const location = type ? locationText(type, b, manageToken, L) : "";
  const rows: [string, string][] = [
    [tr(L, "what"), title],
    [tr(L, "when"), formatWhen(b.start, b.end, b.guestTz, L)],
    [tr(L, "with"), host.showEmail ? `${ownerName} <${host.email}>` : ownerName],
  ];
  if (location && kind !== "cancelled") rows.push([tr(L, "where"), type?.location.kind === "meet" ? tr(L, "meetLocation") : location]);
  if (reason) rows.push([tr(L, "reason"), reason]);
  const blocks: MailBlock[] = [{ kind: "p", text: tr(L, `${kind}Intro`, { owner: ownerName }) }, { kind: "rows", rows }];
  if (kind !== "cancelled") {
    if (type?.location.kind === "meet") blocks.push({ kind: "link", label: tr(L, "join"), url: joinUrl(manageToken) });
    blocks.push({ kind: "link", label: tr(L, "manage"), url: manageUrl(manageToken) });
  } else if (type) {
    blocks.push({ kind: "link", label: tr(L, "bookAgain"), url: `${env.appUrl}/book/${host.handle}/${type.slug}` });
  }
  const heading = tr(L, `${kind}Heading`);
  const description = [type?.description ?? "", kind !== "cancelled" ? `${tr(L, "manage")}: ${manageUrl(manageToken)}` : ""].filter(Boolean).join("\n\n");
  const ics = buildIcs({
    method: kind === "cancelled" ? "CANCEL" : "REQUEST",
    uid: b.eventUid,
    sequence: b.sequence,
    start: b.start,
    end: b.end,
    title: `${title} · ${ownerName}`,
    description,
    location,
    url: kind === "cancelled" ? undefined : manageUrl(manageToken),
    organizer: { name: ownerName, email: host.email },
    attendee: { name: b.guestName, email: b.guestEmail },
  });
  return buildMime({
    from: { name: ownerName, email: host.email },
    to: { name: b.guestName, email: b.guestEmail },
    subject: tr(L, `${kind}Subject`, { title, owner: ownerName }),
    text: renderText(heading, blocks),
    html: renderHtml(heading, blocks),
    ics: { method: kind === "cancelled" ? "CANCEL" : "REQUEST", content: ics },
  });
}

function ownerMail(host: Host, type: BookingType | null, b: Booking, kind: "confirmed" | "rescheduled" | "cancelled", extra = "") {
  const L = host.locale;
  const title = type?.title ?? tr(L, "meeting");
  const rows: [string, string][] = [
    [tr(L, "what"), title],
    [tr(L, "when"), formatWhen(b.start, b.end, type?.timeZone ?? b.guestTz, L)],
    [tr(L, "guest"), `${b.guestName} <${b.guestEmail}>`],
    ...b.answers.map((a): [string, string] => [a.label === PHONE_LABEL ? tr(L, "phone") : a.label, a.value]),
  ];
  if (extra) rows.push([tr(L, kind === "cancelled" ? "reason" : "previously"), extra]);
  const heading = tr(L, `owner${kind[0].toUpperCase()}${kind.slice(1)}Heading` as CopyKey, { guest: b.guestName });
  const blocks: MailBlock[] = [{ kind: "rows", rows }, { kind: "link", label: tr(L, "openCalendar"), url: `${env.appUrl}${calendarHref(b, type)}` }];
  return buildMime({
    from: { name: "Zentico", email: host.email },
    to: { name: host.name, email: host.email },
    subject: tr(L, `owner${kind[0].toUpperCase()}${kind.slice(1)}Subject` as CopyKey, { guest: b.guestName, title }),
    text: renderText(heading, blocks),
    html: renderHtml(heading, blocks),
  });
}

const calendarHref = (b: Booking, type: BookingType | null) => `/calendar?date=${zonedParts(b.start, type?.timeZone ?? "UTC").key}`;

/** E-mails the guest and tells the owner (notification center + e-mail). Never throws. */
async function announce(host: Host, type: BookingType | null, b: Booking, manageToken: string | null, kind: "confirmed" | "rescheduled" | "cancelled", extra = "") {
  const jobs: Promise<unknown>[] = [];
  if (manageToken || kind === "cancelled") {
    jobs.push(asHost(host, () => sendRaw(guestMail(host, type, b, manageToken ?? "", kind, kind === "cancelled" ? extra : ""), [b.guestEmail], { keep: true })));
  }
  jobs.push(asHost(host, () => sendRaw(ownerMail(host, type, b, kind, extra), [host.email], { keep: false })));
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === "rejected") console.error(`[booking] ${kind} mail failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
  }
  const L = host.locale;
  notify(host.email, {
    category: "calendar",
    kind: "invite",
    title: tr(L, `owner${kind[0].toUpperCase()}${kind.slice(1)}Subject` as CopyKey, { guest: b.guestName, title: type?.title ?? tr(L, "meeting") }),
    body: formatWhen(b.start, b.end, type?.timeZone ?? b.guestTz, L),
    href: calendarHref(b, type),
    priority: kind === "confirmed" ? "high" : "normal",
    ref: `booking:${b.id}`,
  });
}

/* ------------------------------------------------------------- booking */

export type BookInput = {
  start: number;
  duration: number;
  name: string;
  email: string;
  phone: string;
  answers: Record<string, unknown>;
  timeZone: string;
  locale: Locale;
};

function guardFor(type: BookingType, start: number, end: number) {
  const day = ownerDayBounds(start, type.timeZone);
  return {
    blockStart: start - type.bufferBefore * 60_000,
    blockEnd: end + type.bufferAfter * 60_000,
    maxPerDay: type.maxPerDay,
    dayStart: day.start,
    dayEnd: day.end,
  };
}

/** Validates the guest's form against the type's questions. */
export function cleanAnswers(type: BookingType, input: Pick<BookInput, "phone" | "answers">): Booking["answers"] {
  const out: Booking["answers"] = [];
  if (type.location.kind === "phone" && !type.location.value) {
    const phone = cleanText(input.phone, 40);
    if (!/^[+()\d][\d\s().-]{4,38}$/.test(phone)) throw new BookingProblem("invalid");
    out.push({ label: PHONE_LABEL, value: phone });
  }
  for (const q of type.questions) {
    const value = cleanText(input.answers[q.id], LIMITS.answer, q.type === "textarea");
    if (!value && q.required) throw new BookingProblem("invalid");
    if (value) out.push({ label: q.label, value });
  }
  return out;
}

export async function book(host: Host, type: BookingType, input: BookInput): Promise<{ manageToken: string; booking: Booking }> {
  const name = cleanText(input.name, LIMITS.name);
  const email = cleanText(input.email, LIMITS.email).toLowerCase();
  if (!name || !isEmail(email) || !type.durations.includes(input.duration)) throw new BookingProblem("invalid");
  if (email === host.email.toLowerCase()) throw new BookingProblem("invalid");
  const answers = cleanAnswers(type, input);
  const start = input.start;
  const end = start + input.duration * 60_000;

  // 1) Fresh free/busy: is the slot still offered?
  const now = Date.now();
  const busy = await busyFor(host, type, start - DAY_MS, end + DAY_MS);
  if (!isBookable(type, input.duration, start, { now, busy, perDay: perDayFor(type, start, end) })) throw new BookingProblem("slot_taken");

  // 2) Reserve atomically against concurrent bookings.
  const manageToken = token();
  const b: Booking = {
    id: randomUUID(),
    typeId: type.id,
    sub: host.sub,
    start,
    end,
    status: "confirmed",
    guestName: name,
    guestEmail: email,
    guestTz: input.timeZone,
    locale: input.locale,
    answers,
    eventId: "",
    eventUid: `${randomUUID()}@zentico-booking`,
    sequence: 0,
    room: type.location.kind === "meet" ? generateRoomCode() : "",
    created: now,
  };
  const reserved = reserve({ ...b, manageToken, joinToken: joinTokenOf(manageToken) }, guardFor(type, start, end));
  if (reserved === "conflict") throw new BookingProblem("slot_taken");
  if (reserved === "limit") throw new BookingProblem("limit");

  // 3) Write the owner's calendar; release the slot if that fails.
  try {
    b.eventId = await createEvent(host, type, b, manageToken);
    setBookingEvent(b.id, b.eventId);
  } catch (e) {
    cancelBookingRow(b.id);
    console.error("[booking] creating the event failed:", e instanceof Error ? e.message : e);
    throw new BookingProblem("failed");
  }

  await announce(host, type, b, manageToken, "confirmed");
  return { manageToken, booking: b };
}

/** A booking for its manage link: the booking, its type (may be deleted) and its host. */
export function manageContext(manageToken: string) {
  if (!TOKEN_PATTERN.test(manageToken)) return null;
  const booking = bookingByManageToken(manageToken);
  const host = booking ? hostBySub(booking.sub) : null;
  if (!booking || !host) return null;
  return { booking, host, type: getType(host.sub, booking.typeId) };
}

export async function cancel(manageToken: string, reasonRaw: unknown): Promise<void> {
  const ctx = manageContext(manageToken);
  if (!ctx) throw new BookingProblem("not_found");
  const { booking, host, type } = ctx;
  if (booking.status !== "confirmed") throw new BookingProblem("not_found");
  if (booking.start <= Date.now()) throw new BookingProblem("too_late");
  const reason = cleanText(reasonRaw, 500, true);
  if (!cancelBookingRow(booking.id)) throw new BookingProblem("not_found");
  if (booking.eventId) {
    try {
      const accountId = await eventAccount(host, type);
      await asHost(host, () => jmap([["CalendarEvent/set", { accountId, destroy: [booking.eventId], sendSchedulingMessages: false }, "d"]], CAL_USING));
    } catch (e) {
      console.error("[booking] removing the event failed:", e instanceof Error ? e.message : e);
    }
  }
  await announce(host, type, { ...booking, status: "cancelled", sequence: booking.sequence + 1 }, null, "cancelled", reason);
}

export async function reschedule(manageToken: string, start: number): Promise<Booking> {
  const ctx = manageContext(manageToken);
  if (!ctx || !ctx.type || !ctx.type.active) throw new BookingProblem("not_found");
  const { booking, host, type } = ctx;
  if (booking.status !== "confirmed") throw new BookingProblem("not_found");
  if (booking.start <= Date.now()) throw new BookingProblem("too_late");
  const duration = Math.round((booking.end - booking.start) / 60_000);
  const end = start + duration * 60_000;
  const now = Date.now();
  const busy = await busyFor(host, type, start - DAY_MS, end + DAY_MS, booking);
  if (!isBookable(type, duration, start, { now, busy, perDay: perDayFor(type, start, end, booking.id) })) throw new BookingProblem("slot_taken");
  const moved = reserveMove(booking.id, host.sub, type.id, start, end, guardFor(type, start, end));
  if (moved === "conflict") throw new BookingProblem("slot_taken");
  if (moved === "limit") throw new BookingProblem("limit");

  const next: Booking = { ...booking, start, end, sequence: booking.sequence + 1 };
  try {
    const accountId = await eventAccount(host, type);
    const r = await asHost(host, () =>
      jmap(
        [
          [
            "CalendarEvent/set",
            { accountId, update: { [booking.eventId]: { start: utcToLocal(start, type.timeZone), timeZone: type.timeZone, duration: formatDuration(end - start), sequence: next.sequence } }, sendSchedulingMessages: false },
            "u",
          ],
        ],
        CAL_USING,
      ),
    );
    if (!booking.eventId || (r.u.notUpdated as Raw | undefined)?.[booking.eventId]) throw new Error(JSON.stringify(r.u.notUpdated ?? {}).slice(0, 200));
  } catch (e) {
    restoreBookingTimes(booking.id, booking.start, booking.end, booking.sequence);
    console.error("[booking] moving the event failed:", e instanceof Error ? e.message : e);
    throw new BookingProblem("failed");
  }
  await announce(host, type, next, manageToken, "rescheduled", formatWhen(booking.start, booking.end, type.timeZone, host.locale));
  return next;
}

/* ---------------------------------------------------------------- join */

/** A booking whose guest may join its Meet room now (30 min before start until 2 h after the end). */
export function joinContext(joinToken: string): { booking: Booking; host: Host; open: "early" | "open" | "over" } | null {
  if (!TOKEN_PATTERN.test(joinToken)) return null;
  const booking = bookingByJoinToken(joinToken);
  const host = booking ? hostBySub(booking.sub) : null;
  if (!booking || !host || booking.status !== "confirmed" || !booking.room) return null;
  const now = Date.now();
  const open = now < booking.start - 30 * 60_000 ? "early" : now > booking.end + 2 * 60 * 60_000 ? "over" : "open";
  return { booking, host, open };
}

export const bookingStillThere = (id: string) => bookingById(id)?.status === "confirmed";
