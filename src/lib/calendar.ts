// JMAP for Calendars (draft-ietf-jmap-calendars) on Stalwart: calendars and JSCalendar events.
import { addDays, DAY_MS, parseDuration, zonedToUtc } from "@/app/(apps)/calendar/time";
import { unstable_rethrow } from "next/navigation";
import { CAP, jmap, primaryAccount } from "./jmap";

export const CAL_USING = [CAP.core, CAP.calendars];

export type Calendar = {
  id: string;
  name: string;
  color: string;
  isVisible: boolean;
  isDefault: boolean;
  timeZone: string | null;
  sortOrder: number;
  mayWrite: boolean;
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
  /** Event id (a synthetic instance id when recurrences are expanded). */
  id: string;
  /** Id of the stored event to update (the series for expanded instances). */
  baseId: string;
  calendarId: string;
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

export async function getCalendars(): Promise<Calendar[]> {
  const accountId = await calendarAccount();
  const r = await jmap([["Calendar/get", { accountId }, "c"]], CAL_USING);
  const list = (r.c.list as Raw[]) ?? [];
  return list
    .map((c, i): Calendar => {
      const rights = obj(c.myRights);
      return {
        id: str(c.id),
        name: str(c.name) || "Calendar",
        color: str(c.color) || FALLBACK_COLORS[i % FALLBACK_COLORS.length],
        isVisible: c.isVisible !== false,
        isDefault: c.isDefault === true,
        timeZone: typeof c.timeZone === "string" ? c.timeZone : null,
        sortOrder: typeof c.sortOrder === "number" ? c.sortOrder : 0,
        mayWrite: rights.mayWriteAll !== false || rights.mayWriteOwn === true,
      };
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
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

/** Turns a JSCalendar event from the server into the shape the UI works with. */
export function normalizeEvent(raw: Raw, displayTz: string, myEmail: string): CalEvent {
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
  return {
    id,
    baseId,
    calendarId: Object.keys(obj(raw.calendarIds))[0] ?? "",
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

/**
 * Events overlapping [afterMs, beforeMs). Asks the server to expand recurrences; servers that
 * reject `expandRecurrences` get a plain query (base occurrences only).
 */
export async function getEvents(
  afterMs: number,
  beforeMs: number,
  displayTz: string,
  myEmail: string,
): Promise<{ events: CalEvent[]; expanded: boolean }> {
  const accountId = await calendarAccount();
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
  const events = ((r.g.list as Raw[]) ?? [])
    .map((raw) => normalizeEvent(raw, displayTz, myEmail))
    .filter((e) => e.utcEnd > afterMs - DAY_MS && e.utcStart < beforeMs + DAY_MS)
    .sort((a, b) => a.utcStart - b.utcStart || b.utcEnd - a.utcEnd);
  return { events, expanded };
}

/** One stored event, raw (as JSCalendar). */
export async function getRawEvent(id: string): Promise<Raw | null> {
  const accountId = await calendarAccount();
  const r = await jmap([["CalendarEvent/get", { accountId, ids: [id] }, "g"]], CAL_USING);
  return ((r.g.list as Raw[]) ?? [])[0] ?? null;
}
