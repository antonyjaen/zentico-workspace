// Booking pages (Calendly-style scheduling): client-safe types, defaults and validation of the
// owner's settings. No server imports here.
import { isDayKey, isTimeZone } from "@/app/(apps)/calendar/time";

export type LocationKind = "meet" | "phone" | "inPerson" | "custom";
export const LOCATION_KINDS: readonly LocationKind[] = ["meet", "phone", "inPerson", "custom"];

/** A wall-clock window "HH:MM"–"HH:MM" in the owner's time zone ("24:00" = end of day). */
export type TimeRange = { start: string; end: string };

export type QuestionType = "text" | "textarea" | "phone";
export const QUESTION_TYPES: readonly QuestionType[] = ["text", "textarea", "phone"];
/** Extra fields on the booking form (name and email are always asked). */
export type Question = { id: string; label: string; type: QuestionType; required: boolean };

export type BookingTypeSettings = {
  title: string;
  slug: string;
  description: string;
  /** Minutes; the visitor picks one when there are several. */
  durations: number[];
  location: { kind: LocationKind; value: string };
  /** IANA zone the availability below is expressed in. */
  timeZone: string;
  /** Index 0 = Sunday … 6 = Saturday. */
  weekly: TimeRange[][];
  /** "YYYY-MM-DD" → that day's windows instead of the weekly ones ([] = unavailable). */
  overrides: Record<string, TimeRange[]>;
  bufferBefore: number;
  bufferAfter: number;
  /** Minutes between now and the earliest bookable start. */
  minNotice: number;
  /** Bookable days ahead, counting today. */
  windowDays: number;
  /** 0 = no limit. */
  maxPerDay: number;
  /** Minutes between slot starts; 0 = the chosen duration. */
  interval: number;
  questions: Question[];
  /** Calendar key ("<accountId>/<calendarId>") the bookings are written into. */
  calendar: string;
  /** Calendar keys whose events block slots. */
  busyCalendars: string[];
  active: boolean;
};

export type BookingType = BookingTypeSettings & { id: string; created: number; updated: number };

/** What the public page may know about a booking type (no calendars, nothing private). */
export type PublicBookingType = Pick<
  BookingTypeSettings,
  "title" | "slug" | "description" | "durations" | "questions" | "timeZone"
> & { location: LocationKind; locationText: string };

export const DURATION_CHOICES = [15, 20, 30, 45, 60, 90, 120] as const;
export const LIMITS = {
  title: 120,
  description: 2000,
  locationValue: 300,
  rangesPerDay: 6,
  overrides: 120,
  questions: 8,
  questionLabel: 200,
  answer: 1000,
  name: 120,
  email: 254,
  calendars: 30,
  calendarKey: 300,
} as const;

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
/** Path segments under /book that a handle can't take. */
export const RESERVED_HANDLES = new Set(["manage", "join", "api", "admin", "book", "new", "settings", "help", "www"]);
const HHMM = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

export const toMinutes = (hhmm: string) => (hhmm === "24:00" ? 1440 : Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));

const WEEKDAYS_9_TO_5: TimeRange[][] = [0, 1, 2, 3, 4, 5, 6].map((d) => (d === 0 || d === 6 ? [] : [{ start: "09:00", end: "17:00" }]));

export function defaultSettings(timeZone: string, calendar: string): BookingTypeSettings {
  return {
    title: "",
    slug: "",
    description: "",
    durations: [30],
    location: { kind: "meet", value: "" },
    timeZone,
    weekly: WEEKDAYS_9_TO_5.map((d) => d.map((r) => ({ ...r }))),
    overrides: {},
    bufferBefore: 0,
    bufferAfter: 0,
    minNotice: 240,
    windowDays: 60,
    maxPerDay: 0,
    interval: 0,
    questions: [],
    calendar,
    busyCalendars: calendar ? [calendar] : [],
    active: true,
  };
}

/** "Product demo!" → "product-demo". */
export function slugify(text: string, max = 48): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** Strips control characters (keeps newlines when `multiline`) and trims. */
export function cleanText(v: unknown, max: number, multiline = false): string {
  if (typeof v !== "string") return "";
  const re = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return v.replace(re, multiline ? "" : " ").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isEmail = (s: string) => s.length <= LIMITS.email && EMAIL.test(s);

export class SettingsError extends Error {
  /** Field that failed (for the editor), e.g. "slug", "weekly". */
  constructor(readonly field: string) {
    super(`invalid_${field}`);
  }
}

const int = (v: unknown, min: number, max: number, field: string): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new SettingsError(field);
  return n;
};

/** Validates one day's windows: well-formed, start < end, sorted and non-overlapping. */
export function parseRanges(v: unknown, field: string): TimeRange[] {
  if (!Array.isArray(v) || v.length > LIMITS.rangesPerDay) throw new SettingsError(field);
  const out = v.map((r) => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const start = typeof o.start === "string" ? o.start : "";
    const end = typeof o.end === "string" ? o.end : "";
    if (!HHMM.test(start) || !HHMM.test(end) || start === "24:00" || toMinutes(end) <= toMinutes(start)) throw new SettingsError(field);
    return { start, end };
  });
  out.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (let i = 1; i < out.length; i++) if (toMinutes(out[i].start) < toMinutes(out[i - 1].end)) throw new SettingsError(field);
  return out;
}

const calendarKey = (v: unknown): string => {
  if (typeof v !== "string" || !v || v.length > LIMITS.calendarKey || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.:@-]+$/.test(v)) {
    throw new SettingsError("calendar");
  }
  return v;
};

/** Validates untrusted settings (from the editor or an MCP tool) into a complete object. */
export function parseSettings(raw: unknown): BookingTypeSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const title = cleanText(r.title, LIMITS.title);
  if (!title) throw new SettingsError("title");
  const slug = typeof r.slug === "string" && r.slug ? r.slug.toLowerCase() : slugify(title);
  if (!SLUG.test(slug)) throw new SettingsError("slug");

  if (!Array.isArray(r.durations) || r.durations.length === 0 || r.durations.length > 6) throw new SettingsError("durations");
  const durations = [...new Set(r.durations.map((d) => int(d, 5, 480, "durations")))].sort((a, b) => a - b);

  const loc = (r.location && typeof r.location === "object" ? r.location : {}) as Record<string, unknown>;
  const kind = LOCATION_KINDS.find((k) => k === loc.kind);
  if (!kind) throw new SettingsError("location");
  const value = cleanText(loc.value, LIMITS.locationValue);
  if ((kind === "inPerson" || kind === "custom") && !value) throw new SettingsError("location");

  if (!isTimeZone(r.timeZone)) throw new SettingsError("timeZone");
  if (!Array.isArray(r.weekly) || r.weekly.length !== 7) throw new SettingsError("weekly");
  const weekly = r.weekly.map((d) => parseRanges(d, "weekly"));

  const overrides: Record<string, TimeRange[]> = {};
  const rawOverrides = (r.overrides && typeof r.overrides === "object" ? r.overrides : {}) as Record<string, unknown>;
  const keys = Object.keys(rawOverrides);
  if (keys.length > LIMITS.overrides) throw new SettingsError("overrides");
  for (const k of keys.sort()) {
    if (!isDayKey(k)) throw new SettingsError("overrides");
    overrides[k] = parseRanges(rawOverrides[k], "overrides");
  }

  if (!Array.isArray(r.questions ?? []) || ((r.questions as unknown[]) ?? []).length > LIMITS.questions) throw new SettingsError("questions");
  const seen = new Set<string>();
  const questions = ((r.questions as unknown[]) ?? []).map((q, i) => {
    const o = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
    const label = cleanText(o.label, LIMITS.questionLabel);
    if (!label) throw new SettingsError("questions");
    let id = typeof o.id === "string" && /^[a-z0-9]{1,16}$/.test(o.id) ? o.id : `q${i + 1}`;
    while (seen.has(id)) id = `${id}x`.slice(-16);
    seen.add(id);
    return { id, label, type: QUESTION_TYPES.find((t) => t === o.type) ?? "text", required: o.required === true };
  });

  const calendar = calendarKey(r.calendar);
  if (!Array.isArray(r.busyCalendars) || r.busyCalendars.length > LIMITS.calendars) throw new SettingsError("busyCalendars");
  const busyCalendars = [...new Set(r.busyCalendars.map(calendarKey))];

  return {
    title,
    slug,
    description: cleanText(r.description, LIMITS.description, true),
    durations,
    location: { kind, value: kind === "meet" ? "" : value },
    timeZone: r.timeZone,
    weekly,
    overrides,
    bufferBefore: int(r.bufferBefore ?? 0, 0, 240, "buffer"),
    bufferAfter: int(r.bufferAfter ?? 0, 0, 240, "buffer"),
    minNotice: int(r.minNotice ?? 0, 0, 60 * 24 * 30, "minNotice"),
    windowDays: int(r.windowDays ?? 60, 1, 365, "windowDays"),
    maxPerDay: int(r.maxPerDay ?? 0, 0, 50, "maxPerDay"),
    interval: int(r.interval ?? 0, 0, 480, "interval") === 0 ? 0 : int(r.interval, 5, 480, "interval"),
    questions,
    calendar,
    busyCalendars,
    active: r.active !== false,
  };
}

export function publicView(t: BookingTypeSettings): PublicBookingType {
  return {
    title: t.title,
    slug: t.slug,
    description: t.description,
    durations: t.durations,
    questions: t.questions,
    timeZone: t.timeZone,
    location: t.location.kind,
    // Phone: the owner calls the number the guest gives; the owner's own number isn't published.
    locationText: t.location.kind === "inPerson" || t.location.kind === "custom" ? t.location.value : "",
  };
}

/** Public booking URL path. */
export const bookingPath = (handle: string, slug?: string) => (slug ? `/book/${handle}/${slug}` : `/book/${handle}`);
