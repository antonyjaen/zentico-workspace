"use client";

import { MapPin, Repeat } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { CalEvent } from "@/lib/calendar";
import { meetHref } from "../meet/shared";
import { BTN_MEET, eventDays, fmtDay, fmtTime, isBand, meetCodeOf, type Anchor } from "./shared";
import { addDays } from "./time";

type Props = {
  days: string[];
  events: CalEvent[];
  tz: string;
  locale: string;
  todayKey: string;
  colorOf: (ev: CalEvent) => string;
  onOpen: (ev: CalEvent, anchor: Anchor) => void;
  onPickDay: (key: string) => void;
};

export function Agenda({ days, events, tz, locale, todayKey, colorOf, onOpen, onPickDay }: Props) {
  const t = useTranslations("calendar");
  const groups = days
    .map((d) => ({
      day: d,
      list: events.filter((ev) => {
        const r = eventDays(ev, tz);
        return r.start <= d && d < r.end && (r.start === d || d === days[0] || isBand(ev));
      }),
    }))
    .filter((g) => g.list.length > 0);

  if (groups.length === 0) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center text-[14px] text-ink-mute">{t("noEvents")}</div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ol className="divide-y divide-line">
        {groups.map(({ day, list }) => (
          <li key={day} className="flex gap-4 px-4 py-3 sm:px-6">
            <button
              type="button"
              onClick={() => onPickDay(day)}
              className="flex w-16 shrink-0 flex-col items-start pt-1 text-left"
            >
              <span
                className={`text-[22px] leading-none font-semibold tabular-nums ${day === todayKey ? "" : "text-ink"}`}
                style={day === todayKey ? { color: "var(--color-app-calendar)" } : undefined}
              >
                {fmtDay(locale, day, { day: "numeric" })}
              </span>
              <span className="mt-1 text-[11px] font-medium tracking-wide text-ink-mute uppercase">
                {fmtDay(locale, day, { month: "short", weekday: "short" })}
              </span>
            </button>
            <ul className="flex min-w-0 flex-1 flex-col gap-0.5">
              {list.map((ev) => {
                const band = isBand(ev);
                const r = eventDays(ev, tz);
                const last = addDays(r.end, -1);
                const meetCode = meetCodeOf(ev.location, ev.description);
                return (
                  <li key={ev.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        onOpen(ev, { x: Math.min(rect.left + 360, rect.right), y: rect.top });
                      }}
                      className={`flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 text-left text-[14px] transition-colors hover:bg-hover ${ev.myStatus === "declined" ? "line-through opacity-60" : ""}`}
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorOf(ev) }} />
                      <span className="w-36 shrink-0 text-[13px] text-ink-soft tabular-nums">
                        {band
                          ? r.start === last
                            ? t("allDay")
                            : `${fmtDay(locale, r.start, { day: "numeric", month: "short" })} – ${fmtDay(locale, last, { day: "numeric", month: "short" })}`
                          : `${fmtTime(locale, tz, ev.utcStart)} – ${fmtTime(locale, tz, ev.utcEnd)}`}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium text-ink">
                        {ev.recurrence !== "none" && <Repeat size={12} aria-hidden className="mr-1.5 inline text-ink-mute" />}
                        {ev.title || t("untitled")}
                      </span>
                      {ev.location && (
                        <span className="hidden max-w-[40%] items-center gap-1 truncate text-[13px] text-ink-mute md:flex">
                          <MapPin size={12} aria-hidden className="shrink-0" />
                          <span className="truncate">{ev.location}</span>
                        </span>
                      )}
                    </button>
                    {meetCode && (
                      <Link href={meetHref(meetCode)} className={BTN_MEET} style={{ background: "var(--color-app-meet)" }}>
                        {t("details.joinMeeting")}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
