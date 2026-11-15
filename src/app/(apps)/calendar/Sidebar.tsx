"use client";

import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Calendar } from "@/lib/calendar";
import { fmtDay } from "./shared";
import { addMonths, daysBetween, viewRange } from "./time";

export function MiniMonth({
  date,
  range,
  todayKey,
  locale,
  weekStart,
  onPick,
}: {
  date: string;
  range: { start: string; end: string };
  todayKey: string;
  locale: string;
  weekStart: number;
  onPick: (key: string) => void;
}) {
  const t = useTranslations("calendar");
  const [month, setMonth] = useState(`${date.slice(0, 8)}01`);
  const grid = viewRange("month", month, weekStart);
  const days = daysBetween(grid.start, grid.end);

  return (
    <div className="mb-5 px-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="pl-1 text-[13px] font-medium text-ink capitalize">
          {fmtDay(locale, month, { month: "long", year: "numeric" })}
        </span>
        <div className="flex">
          <button type="button" className="icon-btn !h-7 !w-7" aria-label={t("prev")} onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft size={15} aria-hidden />
          </button>
          <button type="button" className="icon-btn !h-7 !w-7" aria-label={t("next")} onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight size={15} aria-hidden />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center">
        {days.slice(0, 7).map((d) => (
          <span key={d} className="py-1 text-[10px] font-medium text-ink-mute uppercase">
            {fmtDay(locale, d, { weekday: "narrow" })}
          </span>
        ))}
        {days.map((d) => {
          const inRange = d >= range.start && d < range.end;
          const today = d === todayKey;
          const outside = d.slice(0, 7) !== month.slice(0, 7);
          return (
            <button
              key={d}
              type="button"
              onClick={() => onPick(d)}
              aria-current={d === date ? "date" : undefined}
              className={`mx-auto grid h-7 w-7 place-items-center rounded-full text-[12px] tabular-nums transition-colors ${today ? "font-semibold text-white" : inRange ? "bg-primary-soft text-ink" : outside ? "text-ink-mute hover:bg-hover" : "text-ink-soft hover:bg-hover"}`}
              style={today ? { background: "var(--color-app-calendar)" } : undefined}
            >
              {fmtDay(locale, d, { day: "numeric" })}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CalendarList({
  calendars,
  visible,
  onToggle,
}: {
  calendars: Calendar[];
  visible: Set<string>;
  onToggle: (id: string) => void;
}) {
  const t = useTranslations("calendar");
  return (
    <nav aria-label={t("calendars")} className="flex flex-col gap-0.5 overflow-y-auto pr-2">
      <h2 className="mb-1 px-3 text-[11px] font-medium tracking-wide text-ink-mute uppercase">{t("calendars")}</h2>
      {calendars.map((c) => {
        const on = visible.has(c.id);
        return (
          <button
            key={c.id}
            type="button"
            role="checkbox"
            aria-checked={on}
            onClick={() => onToggle(c.id)}
            className="flex h-8 items-center gap-3 rounded-md px-3 text-left text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
          >
            <span
              className="grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border"
              style={{ background: on ? c.color : "transparent", borderColor: c.color }}
            >
              {on && <Check size={11} strokeWidth={3} color="#fff" aria-hidden />}
            </span>
            <span className="flex-1 truncate">{c.name}</span>
          </button>
        );
      })}
    </nav>
  );
}
