"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import type { CalEvent } from "@/lib/calendar";
import { chipStyle, eventDays, fmtDay, fmtTime, isBand, type Anchor, type Slot } from "./shared";
import { addDays } from "./time";
import { useDayDrag } from "./useDayDrag";

type Props = {
  days: string[];
  month: string;
  events: CalEvent[];
  tz: string;
  locale: string;
  todayKey: string;
  colorOf: (ev: CalEvent) => string;
  canDrag: (ev: CalEvent) => boolean;
  onCreate: (slot: Slot, anchor: Anchor) => void;
  onOpen: (ev: CalEvent, anchor: Anchor) => void;
  onShiftDays: (ev: CalEvent, days: number) => void;
  onPickDay: (key: string) => void;
};

const MAX_CHIPS = 3;

export function MonthGrid({ days, month, events, tz, locale, todayKey, colorOf, canDrag, onCreate, onOpen, onShiftDays, onPickDay }: Props) {
  const t = useTranslations("calendar");
  const { drag, onPointerDown } = useDayDrag(canDrag, onShiftDays, onOpen);
  const weeks = days.length / 7;

  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>(days.map((d) => [d, []]));
    for (const ev of events) {
      const r = eventDays(ev, tz);
      for (let k = r.start < days[0] ? days[0] : r.start; k < r.end && map.has(k); k = addDays(k, 1)) map.get(k)!.push(ev);
    }
    for (const list of map.values()) list.sort((a, b) => Number(isBand(b)) - Number(isBand(a)) || a.utcStart - b.utcStart);
    return map;
  }, [days, events, tz]);

  return (
    <div className="flex min-h-0 flex-1 flex-col select-none">
      <div className="grid grid-cols-7 border-b border-line">
        {days.slice(0, 7).map((d) => (
          <div key={d} className="py-2 text-center text-[11px] font-medium tracking-wide text-ink-mute uppercase">
            {fmtDay(locale, d, { weekday: "short" })}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7" style={{ gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` }}>
        {days.map((d, i) => {
          const list = byDay.get(d) ?? [];
          const extra = list.length - MAX_CHIPS;
          const outside = d.slice(0, 7) !== month.slice(0, 7);
          const today = d === todayKey;
          return (
            <div
              key={d}
              data-day={d}
              onClick={(e) => onCreate({ allDay: true, startDay: d, endDay: addDays(d, 1) }, { x: e.clientX, y: e.clientY })}
              className={`flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-line p-1 ${i % 7 ? "border-l" : ""} ${i >= 7 ? "border-t" : ""} ${outside ? "bg-sheet-muted/60" : ""} ${drag?.over === d ? "bg-primary-soft" : ""}`}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPickDay(d);
                }}
                className={`mx-auto grid h-6 min-w-6 place-items-center rounded-full px-1 text-[12px] font-medium tabular-nums transition-colors ${today ? "text-white" : outside ? "text-ink-mute hover:bg-hover" : "text-ink hover:bg-hover"}`}
                style={today ? { background: "var(--color-app-calendar)" } : undefined}
              >
                {fmtDay(locale, d, d.endsWith("-01") ? { day: "numeric", month: "short" } : { day: "numeric" })}
              </button>
              {list.slice(0, extra > 0 ? MAX_CHIPS - 1 : MAX_CHIPS).map((ev) => {
                const band = isBand(ev);
                const color = colorOf(ev);
                return (
                  <button
                    key={ev.id}
                    type="button"
                    onPointerDown={(pe) => onPointerDown(ev, pe)}
                    onClick={(ce) => ce.stopPropagation()}
                    className={`flex h-5 shrink-0 items-center gap-1.5 truncate rounded-[5px] px-1.5 text-left text-[12px] ${band ? "border font-medium" : "hover:bg-hover"} ${drag?.id === ev.id ? "opacity-50" : ""} ${ev.myStatus === "declined" ? "line-through opacity-60" : ""}`}
                    style={band ? chipStyle(color) : undefined}
                  >
                    {!band && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
                    {!band && <span className="shrink-0 text-ink-mute tabular-nums">{fmtTime(locale, tz, ev.utcStart)}</span>}
                    <span className="truncate text-ink">{ev.title || t("untitled")}</span>
                  </button>
                );
              })}
              {extra > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPickDay(d);
                  }}
                  className="h-5 shrink-0 rounded-[5px] px-1.5 text-left text-[12px] font-medium text-ink-soft hover:bg-hover"
                >
                  {t("more", { count: extra + 1 })}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
