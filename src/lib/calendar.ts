// JMAP for Calendars (draft-ietf-jmap-calendars) on Stalwart: calendars and JSCalendar events,
// calendars shared with me (extra session accounts) and principals (people/groups + availability).
import { addDays, DAY_MS, formatDuration, parseDuration, zonedToUtc } from "@/app/(apps)/calendar/time";
import { unstable_rethrow } from "next/navigation";
import { cache } from "react";
import { actingAccountId, requireSession } from "./auth";
import { actAs } from "./delegation";
import { env } from "./env";
import { CAP, jmap, JmapError, primaryAccount, selfIdentity } from "./jmap";

export const CAP_PRINCIPALS = "urn:ietf:params:jmap:principals";
export const CAP_AVAILABILITY = "urn:ietf:params:jmap:principals:availability";
export const CAL_USING = [CAP.core, CAP.calendars];
export const PRINCIPAL_USING = [CAP.core, CAP_PRINCIPALS];
const AVAILABILITY_USING = [CAP.core, CAP.calendars, CAP_PRINCIPALS, CAP_AVAILABILITY];

/** How a calendar is shared with someone (maps to a fixed set of JMAP calendar rights). */
export type ShareRole = "freebusy" | "read" | "write" | "manage";
export const SHARE_ROLES: ShareRole[] = ["freebusy", "read", "write", "manage"];

export type Calendar = {
  id: string;
  /** JMAP account holding the calendar (the signed-in user's or a sharer's). */
  accountId: string;
  /** Unique across accounts: `${accountId}/${id}`. */
  key: string;
  /** Sharer's account name for calendars shared with me; null for my own. */
  owner: string | null;
  name: string;
  color: string;
  isVisible: boolean;
  isDefault: boolean;
  timeZone: string | null;
  sortOrder: number;
  mayWrite: boolean;
  mayDelete: boolean;
  mayShare: boolean;
  /** Who the calendar is shared with (principal id → role); only for my own calendars. */
  shareWith: Record<string, ShareRole>;
};

export type ParticipationStatus = "needs-action" | "accepted" | "declined" | "tentative" | "delegated";

export type Participant = {
  id: string;
  name: string | null;
  email: string;
  isOwner: boolean;
  isOptional: boolean;
  status: ParticipationStatus;
  isMe: boolean;
};

export type Recurrence = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";

export type CalEvent = {
  /** Event id (a synthetic instance id when recurrences are expanded; prefixed for shared accounts). */
  id: string;
  /** Id of the stored event to update (the series for expanded instances). */
  baseId: string;
  accountId: string;
  calendarId: string;
  /** Key of the calendar it belongs to (see Calendar.key). */
  calKey: string;
  title: string;
  description: string;
  location: string;
  /** JSCalendar local start, as stored. */
  start: string;
  timeZone: string | null;
  allDay: boolean;
  utcStart: number;
  utcEnd: number;
  /** All-day events: first day and exclusive end day. */
  startDay: string;
  endDay: string;
  recurrence: Recurrence;
  isInstance: boolean;
  /** Minutes before start for each offset alert. */
  alerts: number[];
  participants: Participant[];
  /** True when the signed-in user organizes the event (or it has no guests). */
  isOrganizer: boolean;
  myStatus: ParticipationStatus | null;
};

const FALLBACK_COLORS = ["#0f9f8f", "#3b6cf6", "#d97706", "#e5484d", "#8b5cf6", "#16a34a", "#db2777", "#64748b"];

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function calendarAccount(): Promise<string> {
  return primaryAccount(CAP.calendars);
}

type RawSession = {
  capabilities?: Record<string, unknown>;
  primaryAccounts?: Record<string, string>;
  accounts?: Record<string, { name?: string; isPersonal?: boolean; accountCapabilities?: Record<string, unknown> }>;
};

export type CalAccount = { id: string; name: string; primary: boolean };

/** Calendar accounts in the JMAP session: mine first, then accounts other users shared with me. */
export const getCalendarSession = async () => calendarSessionFor(await actingAccountId());

const calendarSessionFor = cache(
  async (acting: string | null): Promise<{ accounts: CalAccount[]; principalsAccount: string | null; availability: boolean }> => {
    const { accessToken } = await requireSession();
    const res = await fetch(`${env.issuer}/jmap/session`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) throw new JmapError(`JMAP session failed: ${res.status}`);
    const s = actAs((await res.json()) as RawSession, acting);
    const primary = s.primaryAccounts?.[CAP.calendars];
    if (!primary) throw new JmapError(`No account for ${CAP.calendars}`);
    const shared = Object.entries(s.accounts ?? {})
      .filter(([id, a]) => id !== primary && a.accountCapabilities?.[CAP.calendars] !== undefined)
      .map(([id, a]): CalAccount => ({ id, name: a.name || id, primary: false }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 25);
    return {
      accounts: [{ id: primary, name: s.accounts?.[primary]?.name ?? "", primary: true }, ...shared],
      principalsAccount: s.capabilities?.[CAP_PRINCIPALS] ? (s.primaryAccounts?.[CAP_PRINCIPALS] ?? primary) : null,
      availability: !!s.capabilities?.[CAP_AVAILABILITY],
    };
  },
);

/** Returns the account id when it is one of the user's calendar accounts (default: primary). */
export async function resolveCalendarAccount(accountId?: string | null): Promise<string> {
  const { accounts } = await getCalendarSession();
  if (!accountId) return accounts[0].id;
  if (!accounts.some((a) => a.id === accountId)) throw new JmapError("Unknown calendar account");
  return accountId;
}

export function roleOf(rights: Raw): ShareRole {
  if (rights.mayShare === true || rights.mayAdmin === true) return "manage";
  if (rights.mayWriteAll === true) return "write";
  if (rights.mayReadItems === true) return "read";
  return "freebusy";
}

/** JMAP calendar rights granted for each sharing role. */
export function rightsFor(role: ShareRole): Record<string, boolean> {
  const read = role !== "freebusy";
  const write = role === "write" || role === "manage";
  return {
    mayReadFreeBusy: true,
    mayReadItems: read,
    mayWriteAll: write,
    mayWriteOwn: write,
    mayUpdatePrivate: write,
    mayRSVP: write,
    mayDelete: write,
    mayShare: role === "manage",
  };
}

function normalizeCalendar(c: Raw, i: number, account: CalAccount): Calendar {
  const rights = obj(c.myRights);
  const id = str(c.id);
  const mine = account.primary;
  const shareWith: Record<string, ShareRole> = {};
  if (mine) for (const [pid, r] of Object.entries(obj(c.shareWith))) shareWith[pid] = roleOf(obj(r));
  return {
    id,
    accountId: account.id,
    key: `${account.id}/${id}`,
    owner: mine ? null : account.name,
    name: str(c.name) || "Calendar",
    color: str(c.color) || FALLBACK_COLORS[i % FALLBACK_COLORS.length],
    isVisible: c.isVisible !== false,
    isDefault: mine && c.isDefault === true,
    timeZone: typeof c.timeZone === "string" ? c.timeZone : null,
    sortOrder: typeof c.sortOrder === "number" ? c.sortOrder : 0,
    // My own calendars are writable unless rights say otherwise; shared ones need an explicit grant.
    mayWrite: mine
      ? rights.mayWriteAll !== false || rights.mayWriteOwn === true
      : rights.mayWriteAll === true || rights.mayWriteOwn === true,
    mayDelete: mine ? rights.mayDelete !== false : rights.mayDelete === true,
    mayShare: mine ? rights.mayShare !== false && rights.mayAdmin !== false : false,
    shareWith,
  };
}

/** My calendars followed by calendars other accounts share with me. */
export async function getCalendars(): Promise<Calendar[]> {
  const { accounts } = await getCalendarSession();
  const lists = await Promise.all(
    accounts.map(async (account) => {
      try {
        const r = await jmap([["Calendar/get", { accountId: account.id }, "c"]], CAL_USING);
        return ((r.c.list as Raw[]) ?? []).map((c, i) => normalizeCalendar(c, i, account));
      } catch (e) {
        unstable_rethrow(e);
        // My own account must work; a broken share just doesn't show.
        if (account.primary) throw e;
        console.error("[calendar] Calendar/get failed for shared account", account.id, e instanceof Error ? e.message : e);
        return [];
      }
    }),
  );
  const sort = (a: Calendar, b: Calendar) =>
    Number(b.isDefault) - Number(a.isDefault) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  return lists.flatMap((l) => l.sort(sort));
}

export function participantEmail(p: Raw): string {
  const address = str(p.email) || str(obj(p.sendTo).imip) || str(p.calendarAddress);
  return address.replace(/^mailto:/i, "").trim().toLowerCase();
}

const recurrenceOf = (rules: unknown): Recurrence => {
  if (!Array.isArray(rules) || rules.length === 0) return "none";
  if (rules.length > 1) return "custom";
  const rule = obj(rules[0]);
  const extra = Object.keys(rule).filter((k) => !["@type", "frequency", "interval", "rscale", "skip", "firstDayOfWeek"].includes(k));
  const freq = str(rule.frequency);
  const simple = ["daily", "weekly", "monthly", "yearly"].includes(freq);
  if (!simple || extra.length || (rule.interval !== undefined && rule.interval !== 1)) return "custom";
  return freq as Recurrence;
};

/**
 * Turns a JSCalendar event from the server into the shape the UI works with. Events from shared
 * accounts get an account-prefixed `id` (ids are only unique per account); `baseId` stays raw.
 */
export function normalizeEvent(raw: Raw, displayTz: string, myEmail: string, accountId = "", primary = true): CalEvent {
  const me = myEmail.toLowerCase();
  const allDay = raw.showWithoutTime === true;
  const start = str(raw.start) || "1970-01-01T00:00:00";
  const timeZone = typeof raw.timeZone === "string" && raw.timeZone ? raw.timeZone : null;
  let duration = parseDuration(raw.duration) ?? 0;
  if (allDay && duration < DAY_MS) duration = DAY_MS;

  let utcStart: number;
  try {
    utcStart = zonedToUtc(start, allDay || !timeZone ? displayTz : timeZone);
  } catch {
    utcStart = 0;
  }
  const startDay = start.slice(0, 10);

  const participants: Participant[] = Object.entries(obj(raw.participants)).map(([id, value]) => {
    const p = obj(value);
    const roles = obj(p.roles);
    const email = participantEmail(p);
    return {
      id,
      name: typeof p.name === "string" && p.name ? p.name : null,
      email,
      isOwner: roles.owner === true,
      isOptional: roles.optional === true,
      status: (str(p.participationStatus) || "needs-action") as ParticipationStatus,
      isMe: email === me,
    };
  });
  const replyTo = str(obj(raw.replyTo).imip).replace(/^mailto:/i, "").toLowerCase();
  const mine = participants.find((p) => p.isMe) ?? null;
  const hasOrganizer = participants.some((p) => p.isOwner) || !!replyTo;
  const isOrganizer =
    participants.length === 0 || replyTo === me || !!mine?.isOwner || (!hasOrganizer && !!mine);

  const alerts: number[] = [];
  for (const value of Object.values(obj(raw.alerts))) {
    const trigger = obj(obj(value).trigger);
    if (trigger["@type"] !== "OffsetTrigger" || (trigger.relativeTo && trigger.relativeTo !== "start")) continue;
    const offset = parseDuration(trigger.offset);
    if (offset !== null && offset <= 0) alerts.push(Math.round(-offset / 60_000));
  }

  const location = Object.values(obj(raw.locations))
    .map((l) => str(obj(l).name))
    .filter(Boolean)
    .join(", ");

  const id = str(raw.id);
  const baseId = str(raw.baseEventId) || id;
  const calendarId = Object.keys(obj(raw.calendarIds))[0] ?? "";
  return {
    id: primary ? id : `${accountId}:${id}`,
    baseId,
    accountId,
    calendarId,
    calKey: `${accountId}/${calendarId}`,
    title: str(raw.title),
    description: str(raw.description),
    location,
    start,
    timeZone,
    allDay,
    utcStart,
    utcEnd: utcStart + Math.max(duration, 0),
    startDay,
    endDay: addDays(startDay, Math.max(1, Math.round(duration / DAY_MS))),
    recurrence: recurrenceOf(raw.recurrenceRules),
    isInstance: baseId !== id || !!raw.recurrenceId,
    alerts: alerts.sort((a, b) => a - b),
    participants,
    isOrganizer,
    myStatus: mine && !isOrganizer ? mine.status : null,
  };
}

const utcDate = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Events of one account overlapping [afterMs, beforeMs); see getEvents. */
async function getAccountEvents(
  account: CalAccount,
  afterMs: number,
  beforeMs: number,
  displayTz: string,
  myEmail: string,
): Promise<{ events: CalEvent[]; expanded: boolean }> {
  const accountId = account.id;
  const run = (expand: boolean) =>
    jmap(
      [
        [
          "CalendarEvent/query",
          {
            accountId,
            filter: { after: utcDate(afterMs), before: utcDate(beforeMs) },
            ...(expand ? { expandRecurrences: true, timeZone: displayTz } : {}),
          },
          "q",
        ],
        [
          "CalendarEvent/get",
          { accountId, "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" } },
          "g",
        ],
      ],
      CAL_USING,
    );

  let expanded = true;
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = await run(true);
  } catch (e) {
    unstable_rethrow(e);
    expanded = false;
    r = await run(false);
  }
  const events = ((r.g.list as Raw[]) ?? []).map((raw) => normalizeEvent(raw, displayTz, myEmail, accountId, account.primary));
  return { events, expanded };
}

/**
 * Events overlapping [afterMs, beforeMs) from my account and every account sharing calendars with
 * me. Asks the server to expand recurrences; servers that reject `expandRecurrences` get a plain
 * query (base occurrences only).
 */
export async function getEvents(
  afterMs: number,
  beforeMs: number,
  displayTz: string,
  myEmail: string,
): Promise<{ events: CalEvent[]; expanded: boolean }> {
  const { accounts } = await getCalendarSession();
  const results = await Promise.all(
    accounts.map(async (account) => {
      try {
        return await getAccountEvents(account, afterMs, beforeMs, displayTz, myEmail);
      } catch (e) {
        unstable_rethrow(e);
        if (account.primary) throw e;
        console.error("[calendar] CalendarEvent/query failed for shared account", account.id, e instanceof Error ? e.message : e);
        return { events: [], expanded: true };
      }
    }),
  );
  const events = results
    .flatMap((r) => r.events)
    .filter((e) => e.utcEnd > afterMs - DAY_MS && e.utcStart < beforeMs + DAY_MS)
    .sort((a, b) => a.utcStart - b.utcStart || b.utcEnd - a.utcEnd);
  return { events, expanded: results[0].expanded };
}

/** One stored event, raw (as JSCalendar). */
export async function getRawEvent(id: string, accountId?: string | null): Promise<Raw | null> {
  const account = await resolveCalendarAccount(accountId);
  const r = await jmap([["CalendarEvent/get", { accountId: account, ids: [id] }, "g"]], CAL_USING);
  return ((r.g.list as Raw[]) ?? [])[0] ?? null;
}

// ---- Principals (people and groups on this server) ----

export type Principal = {
  id: string;
  type: "individual" | "group" | "resource" | "location" | "other";
  name: string;
  email: string;
};

const PRINCIPAL_TYPES = ["individual", "group", "resource", "location"];

/** Every principal the server lets me see (people and groups of my domain), capped at 1000. */
export async function getPrincipals(): Promise<Principal[]> {
  const { principalsAccount } = await getCalendarSession();
  if (!principalsAccount) return [];
  const r = await jmap(
    [
      ["Principal/query", { accountId: principalsAccount, limit: 1000 }, "q"],
      [
        "Principal/get",
        {
          accountId: principalsAccount,
          "#ids": { resultOf: "q", name: "Principal/query", path: "/ids" },
          properties: ["id", "type", "name", "email"],
        },
        "g",
      ],
    ],
    PRINCIPAL_USING,
  );
  return ((r.g.list as Raw[]) ?? [])
    .map((p): Principal => {
      const type = str(p.type);
      return {
        id: str(p.id),
        type: (PRINCIPAL_TYPES.includes(type) ? type : "other") as Principal["type"],
        name: str(p.name),
        email: str(p.email).toLowerCase(),
      };
    })
    .filter((p) => p.id)
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}

export type BusyBlock = { start: number; end: number; status: string };

/** Busy periods of one principal in [afterMs, beforeMs) (Principal/getAvailability). */
export async function getAvailability(principalId: string, afterMs: number, beforeMs: number): Promise<BusyBlock[]> {
  const { principalsAccount, availability } = await getCalendarSession();
  if (!principalsAccount || !availability) return [];
  const r = await jmap(
    [
      [
        "Principal/getAvailability",
        { accountId: principalsAccount, id: principalId, utcStart: utcDate(afterMs), utcEnd: utcDate(beforeMs) },
        "a",
      ],
    ],
    AVAILABILITY_USING,
  );
  return ((r.a.list as Raw[]) ?? [])
    .map((b) => ({ start: Date.parse(str(b.utcStart)), end: Date.parse(str(b.utcEnd)), status: str(b.busyStatus) || "confirmed" }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
}

// ---- Meetings scheduled from other apps (Chat) ----

export type MeetingEventInput = {
  title: string;
  description: string;
  /** Local start "YYYY-MM-DDTHH:MM:SS" in `timeZone`. */
  start: string;
  timeZone: string;
  durationMs: number;
  /** Usually the meeting link (`${APP_URL}/meet/<code>`). */
  location: string;
  attendees: { email: string; name?: string }[];
};

/**
 * Creates a timed event in the signed-in user's default calendar with the user as organizer and
 * the attendees invited (iTIP/iMIP via sendSchedulingMessages). Returns the new event id.
 * Inputs must already be validated by the caller.
 */
export async function createMeetingEvent(input: MeetingEventInput): Promise<{ id: string; calendarId: string }> {
  const session = await selfIdentity();
  const me = { email: session.email.toLowerCase(), name: session.name };
  const accountId = await calendarAccount();
  const own = (await getCalendars()).filter((c) => c.accountId === accountId && c.mayWrite);
  const calendar = own.find((c) => c.isDefault) ?? own[0];
  if (!calendar) throw new JmapError("No writable calendar");

  const key = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const guests = input.attendees.filter((a) => a.email.toLowerCase() !== me.email);
  const participants: Record<string, Raw> = {};
  if (guests.length) {
    participants[key()] = {
      "@type": "Participant",
      name: me.name,
      email: me.email,
      sendTo: { imip: `mailto:${me.email}` },
      roles: { owner: true, attendee: true },
      participationStatus: "accepted",
    };
    for (const g of guests) {
      const email = g.email.toLowerCase();
      participants[key()] = {
        "@type": "Participant",
        ...(g.name ? { name: g.name } : {}),
        email,
        sendTo: { imip: `mailto:${email}` },
        roles: { attendee: true },
        participationStatus: "needs-action",
        expectReply: true,
      };
    }
  }

  // Stalwart rejects explicit nulls on create, so optional properties are only set when present.
  const event: Raw = {
    "@type": "Event",
    calendarIds: { [calendar.id]: true },
    title: input.title,
    start: input.start,
    timeZone: input.timeZone,
    duration: formatDuration(input.durationMs),
    showWithoutTime: false,
  };
  if (input.description) event.description = input.description;
  if (input.location) event.locations = { [key()]: { "@type": "Location", name: input.location } };
  if (guests.length) {
    event.participants = participants;
    event.replyTo = { imip: `mailto:${me.email}` };
  }

  const r = await jmap(
    [["CalendarEvent/set", { accountId, create: { new: event }, sendSchedulingMessages: guests.length > 0 }, "s"]],
    CAL_USING,
  );
  const err = (r.s.notCreated as Record<string, { type?: string; description?: string }> | undefined)?.new;
  if (err) throw new JmapError(`notCreated: ${err.type ?? "error"} ${err.description ?? ""}`.trim());
  const id = String(((r.s.created as Record<string, Raw> | undefined)?.new?.id as string | undefined) ?? "");
  return { id, calendarId: calendar.id };
}
