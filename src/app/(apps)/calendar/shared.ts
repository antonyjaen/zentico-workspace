// Client-safe helpers shared by the calendar views (no server imports).
import type { CSSProperties } from "react";
import type { CalEvent } from "@/lib/calendar";
import type { EventInput } from "./actions";
import { addDays, DAY_MS, keyToUtc, utcToLocal, zonedParts } from "./time";

export type Anchor = { x: number; y: number };

/** A time slot picked on the grid: timed (UTC ms) or all-day (day keys, end exclusive). */
export type Slot =
  | { allDay: false; start: number; end: number }
  | { allDay: true; startDay: string; endDay: string };

export const SNAP_MIN = 15;
export const HOUR_PX = 48;

export const FIELD =
  "h-9 w-full rounded-md border border-line bg-sheet px-2.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-mute hover:border-line-strong focus:border-ink-mute";

export const BTN =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-3 text-[13px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:opacity-50";

export const BTN_PRIMARY =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors hover:bg-primary-hover disabled:opacity-50";

const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function fmt(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = locale + JSON.stringify(opts);
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    fmtCache.set(k, f);
  }
  return f;
}

/** Formats a day key ("YYYY-MM-DD") without time zone drift. */
export const fmtDay = (locale: string, key: string, opts: Intl.DateTimeFormatOptions) =>
  fmt(locale, { ...opts, timeZone: "UTC" }).format(new Date(keyToUtc(key)));

export const fmtTime = (locale: string, tz: string, ms: number) =>
  fmt(locale, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(ms));

/** Is the event shown in the all-day band (all-day or 24h+)? */
export const isBand = (ev: CalEvent) => ev.allDay || ev.utcEnd - ev.utcStart >= DAY_MS;

/** First visible day and exclusive end day for an event in the display zone. */
export function eventDays(ev: CalEvent, tz: string): { start: string; end: string } {
  if (ev.allDay) return { start: ev.startDay, end: ev.endDay };
  const start = zonedParts(ev.utcStart, tz).key;
  const last = zonedParts(Math.max(ev.utcStart, ev.utcEnd - 1), tz).key;
  return { start, end: addDays(last, 1) };
}

export function eventTimeLabel(ev: CalEvent, locale: string, tz: string, allDayLabel: string): string {
  if (ev.allDay) {
    const last = addDays(ev.endDay, -1);
    const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
    return last === ev.startDay
      ? `${fmtDay(locale, ev.startDay, opts)} · ${allDayLabel}`
      : `${fmtDay(locale, ev.startDay, opts)} – ${fmtDay(locale, last, opts)}`;
  }
  const f = fmt(locale, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: tz });
  return f.formatRange(new Date(ev.utcStart), new Date(Math.max(ev.utcEnd, ev.utcStart)));
}

export function chipStyle(color: string, solid = false): CSSProperties {
  return solid
    ? { background: color, color: "#fff" }
    : {
        background: `color-mix(in oklab, ${color} 16%, var(--color-sheet))`,
        borderColor: `color-mix(in oklab, ${color} 45%, transparent)`,
        color: "var(--color-ink)",
      };
}

const split = (local: string) => ({ date: local.slice(0, 10), time: local.slice(11, 16) });

export function slotToInput(slot: Slot, tz: string, calendarId: string): EventInput {
  const base = {
    calendarId,
    title: "",
    description: "",
    location: "",
    timeZone: tz,
    guests: [],
    alerts: [10],
    recurrence: "none" as const,
  };
  if (slot.allDay) {
    return { ...base, allDay: true, startDate: slot.startDay, endDate: addDays(slot.endDay, -1), startTime: "09:00", endTime: "10:00", alerts: [] };
  }
  const s = split(utcToLocal(slot.start, tz));
  const e = split(utcToLocal(slot.end, tz));
  return { ...base, allDay: false, startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
}

export function eventToInput(ev: CalEvent, displayTz: string): EventInput {
  const tz = ev.timeZone ?? displayTz;
  const common = {
    calendarId: ev.calendarId,
    title: ev.title,
    description: ev.description,
    location: ev.location,
    timeZone: tz,
    guests: ev.participants.filter((p) => !p.isMe).map((p) => ({ email: p.email, optional: p.isOptional })),
    alerts: ev.alerts,
    recurrence: ev.recurrence === "custom" ? ("keep" as const) : ev.recurrence,
  };
  if (ev.allDay) {
    return { ...common, allDay: true, startDate: ev.startDay, endDate: addDays(ev.endDay, -1), startTime: "09:00", endTime: "10:00" };
  }
  const s = split(utcToLocal(ev.utcStart, tz));
  const e = split(utcToLocal(ev.utcEnd, tz));
  return { ...common, allDay: false, startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
}

/** Next round hour today as a 1-hour slot. */
export function defaultSlot(tz: string, now = Date.now()): Slot {
  const start = Math.ceil(now / 3_600_000) * 3_600_000;
  return { allDay: false, start, end: start + 3_600_000 };
}
