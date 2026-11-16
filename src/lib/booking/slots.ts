// Slot computation for booking pages. Pure (no I/O) so it runs anywhere and is easy to test.
//
// Availability is wall-clock time in the owner's zone; each candidate start is converted to UTC
// on its own day, so DST changes shift nothing: a 09:00–17:00 day stays 09:00–17:00 local, a
// time skipped by the spring-forward gap is never offered, and the window end is checked in real
// elapsed time (a 01:00–03:00 window on that night holds one hour, not two).
import { addDays, DAY_MS, minutesToHHMM, utcToLocal, weekday, zonedParts, zonedToUtc } from "@/app/(apps)/calendar/time";
import { toMinutes, type BookingTypeSettings, type TimeRange } from "./types";

export type Interval = { start: number; end: number };
export type SlotRules = Pick<
  BookingTypeSettings,
  "timeZone" | "weekly" | "overrides" | "bufferBefore" | "bufferAfter" | "minNotice" | "windowDays" | "maxPerDay" | "interval"
>;

export type SlotContext = {
  now: number;
  /** Busy periods (any order, may overlap). */
  busy: Interval[];
  /** Confirmed bookings of this type per owner-zone day ("YYYY-MM-DD"), for maxPerDay. */
  perDay?: Map<string, number>;
};

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export const rangesFor = (rules: Pick<SlotRules, "weekly" | "overrides">, day: string): TimeRange[] =>
  rules.overrides[day] ?? rules.weekly[weekday(day)] ?? [];

/** The bookable days [first, last] in the owner's zone: today … today + windowDays - 1. */
export function bookingDays(rules: Pick<SlotRules, "timeZone" | "windowDays">, now: number): { first: string; last: string } {
  const first = zonedParts(now, rules.timeZone).key;
  return { first, last: addDays(first, rules.windowDays - 1) };
}

/** First index in sorted, merged `busy` whose end is after `t` (binary search). */
function firstEndingAfter(busy: Interval[], t: number): number {
  let lo = 0;
  let hi = busy.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (busy[mid].end <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Bookable slot starts (UTC ms, ascending) for a meeting of `duration` minutes whose start falls in
 * [from, to). Applies weekly hours / date overrides, minimum notice, the booking window, the daily
 * limit, and busy times widened by the buffers.
 */
export function computeSlots(rules: SlotRules, duration: number, from: number, to: number, ctx: SlotContext): number[] {
  const tz = rules.timeZone;
  const durMs = duration * 60_000;
  const step = (rules.interval || duration) * 60_000;
  const before = rules.bufferBefore * 60_000;
  const after = rules.bufferAfter * 60_000;
  const earliest = Math.max(from, ctx.now + rules.minNotice * 60_000);
  const { first, last } = bookingDays(rules, ctx.now);
  const busy = mergeIntervals(ctx.busy);
  const out = new Set<number>();

  // Owner-zone days that can hold a start in [earliest, to); one day of slack covers zone offsets.
  let day = zonedParts(earliest, tz).key;
  if (day < first) day = first;
  const lastDay = zonedParts(to, tz).key < last ? zonedParts(to, tz).key : last;

  for (; day <= lastDay; day = addDays(day, 1)) {
    if (rules.maxPerDay > 0 && (ctx.perDay?.get(day) ?? 0) >= rules.maxPerDay) continue;
    for (const r of rangesFor(rules, day)) {
      const startMin = toMinutes(r.start);
      const endMin = toMinutes(r.end);
      const windowEnd = endMin === 1440 ? zonedToUtc(`${addDays(day, 1)}T00:00:00`, tz) : zonedToUtc(`${day}T${r.end}:00`, tz);
      for (let m = startMin; m + duration <= endMin; m += step / 60_000) {
        const local = `${day}T${minutesToHHMM(m)}:00`;
        const start = zonedToUtc(local, tz);
        // Wall-clock times that don't exist (spring-forward gap) come back shifted: skip them.
        if (utcToLocal(start, tz) !== local) continue;
        const end = start + durMs;
        if (end > windowEnd || start < earliest || start >= to) continue;
        const i = firstEndingAfter(busy, start - before);
        if (i < busy.length && busy[i].start < end + after) continue;
        out.add(start);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Whether `start` is one of the bookable slots right now (the server's re-check before booking). */
export function isBookable(rules: SlotRules, duration: number, start: number, ctx: SlotContext): boolean {
  if (!Number.isFinite(start)) return false;
  return computeSlots(rules, duration, start, start + 1, ctx).includes(start);
}

/** [start, end) of the owner-zone day holding `ms` (23 or 25 hours long on DST days). */
export function ownerDayBounds(ms: number, tz: string): { day: string; start: number; end: number } {
  const day = zonedParts(ms, tz).key;
  return { day, start: zonedToUtc(`${day}T00:00:00`, tz), end: zonedToUtc(`${addDays(day, 1)}T00:00:00`, tz) };
}

/** Clamp a requested [from, to) to at most `maxDays` days and to the booking window. */
export function clampRange(rules: Pick<SlotRules, "timeZone" | "windowDays">, now: number, from: number, to: number, maxDays = 45) {
  const { last } = bookingDays(rules, now);
  const windowEnd = zonedToUtc(`${addDays(last, 1)}T00:00:00`, rules.timeZone);
  const start = Math.max(from, now);
  return { from: start, to: Math.min(to, start + maxDays * DAY_MS, windowEnd) };
}
