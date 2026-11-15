"use client";

import { Repeat } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CalEvent } from "@/lib/calendar";
import { chipStyle, eventDays, fmt, fmtDay, fmtTime, HOUR_PX, isBand, SNAP_MIN, type Anchor, type Slot } from "./shared";
import { addDays, minutesToHHMM, zonedParts, zonedToUtc } from "./time";
import { useDayDrag } from "./useDayDrag";

type Props = {
  days: string[];
  events: CalEvent[];
  tz: string;
  locale: string;
  todayKey: string;
  now: number | null;
  ghost: Slot | null;
  colorOf: (ev: CalEvent) => string;
  canDrag: (ev: CalEvent) => boolean;
  onCreate: (slot: Slot, anchor: Anchor) => void;
  onOpen: (ev: CalEvent, anchor: Anchor) => void;
  onMove: (ev: CalEvent, start: number, end: number) => void;
  onShiftDays: (ev: CalEvent, days: number) => void;
  onPickDay: (key: string) => void;
};

type Seg = { ev: CalEvent; startMin: number; endMin: number; col: number; cols: number };

type Drag =
  | { kind: "create"; day: number; anchor: number; cur: number; moved: boolean }
  | { kind: "move" | "resize"; ev: CalEvent; day0: number; min0: number; delta: number; moved: boolean };

const snap = (m: number) => Math.round(m / SNAP_MIN) * SNAP_MIN;
const GUTTER = 56;

/** Assigns side-by-side columns to overlapping segments of one day. */
function layoutDay(segs: Omit<Seg, "col" | "cols">[]): Seg[] {
  const sorted = [...segs].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: Seg[] = [];
  let cluster: Seg[] = [];
  let colsEnd: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const s of cluster) s.cols = colsEnd.length;
    cluster = [];
    colsEnd = [];
  };
  for (const s of sorted) {
    const visualEnd = Math.max(s.endMin, s.startMin + 20);
    if (s.startMin >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    let col = colsEnd.findIndex((e) => e <= s.startMin);
    if (col === -1) {
      col = colsEnd.length;
      colsEnd.push(visualEnd);
    } else colsEnd[col] = visualEnd;
    clusterEnd = Math.max(clusterEnd, visualEnd);
    const seg: Seg = { ...s, col, cols: 1 };
    cluster.push(seg);
    out.push(seg);
  }
  flush();
  return out;
}

export function TimeGrid(props: Props) {
  const { days, events, tz, locale, todayKey, now, ghost, colorOf, canDrag, onCreate, onOpen, onMove, onPickDay } = props;
  const t = useTranslations("calendar");
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ d: Drag; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dayDrag = useDayDrag(canDrag, props.onShiftDays, onOpen);

  const bounds = useMemo(
    () => days.map((d) => [zonedToUtc(`${d}T00:00:00`, tz), zonedToUtc(`${addDays(d, 1)}T00:00:00`, tz)] as const),
    [days, tz],
  );

  // Scroll to the working day (or just before now) on first render.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nowMin = days.includes(todayKey) ? zonedParts(Date.now(), tz).minutes : 7 * 60;
    el.scrollTop = Math.max(0, ((Math.min(nowMin, 18 * 60) - 60) / 60) * HOUR_PX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply the in-progress move/resize as a preview.
  const shown = useMemo(() => {
    if (!drag || drag.kind === "create" || !drag.moved || !canDrag(drag.ev)) return events;
    const ms = drag.delta * 60_000;
    return events.map((ev) => {
      if (ev.id !== drag.ev.id) return ev;
      if (drag.kind === "move") return { ...ev, utcStart: ev.utcStart + ms, utcEnd: ev.utcEnd + ms };
      return { ...ev, utcEnd: Math.max(ev.utcStart + SNAP_MIN * 60_000, ev.utcEnd + ms) };
    });
  }, [events, drag, canDrag]);

  const band = shown.filter(isBand);
  const timed = shown.filter((e) => !isBand(e));

  const perDay = useMemo(
    () =>
      bounds.map(([ds, de]) =>
        layoutDay(
          timed
            .filter((ev) => ev.utcStart < de && Math.max(ev.utcEnd, ev.utcStart + 1) > ds)
            .map((ev) => {
              const startMin = ev.utcStart <= ds ? 0 : zonedParts(ev.utcStart, tz).minutes;
              let endMin = ev.utcEnd >= de ? 1440 : zonedParts(ev.utcEnd, tz).minutes;
              if (endMin <= startMin) endMin = Math.min(1440, startMin + SNAP_MIN);
              return { ev, startMin, endMin };
            }),
        ),
      ),
    [bounds, timed, tz],
  );

  // All-day band: lanes of day spans.
  const spans = useMemo(() => {
    const first = days[0];
    const last = days[days.length - 1];
    const items = band
      .map((ev) => {
        const r = eventDays(ev, tz);
        if (r.end <= first || r.start > last) return null;
        const s = Math.max(0, days.indexOf(r.start < first ? first : r.start));
        const e = r.end > last ? days.length : days.indexOf(r.end);
        return { ev, s, e: e === -1 ? days.length : e, lane: 0 };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => a.s - b.s || b.e - b.s - (a.e - a.s));
    const lanes: number[] = [];
    for (const it of items) {
      let lane = lanes.findIndex((end) => end <= it.s);
      if (lane === -1) lane = lanes.push(0) - 1;
      lanes[lane] = it.e;
      it.lane = lane;
    }
    return { items, lanes: lanes.length };
  }, [band, days, tz]);

  function pointAt(x: number, y: number) {
    const r = cols.current!.getBoundingClientRect();
    const day = Math.min(days.length - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * days.length)));
    const min = Math.min(1440, Math.max(0, ((y - r.top) / HOUR_PX) * 60));
    return { day, min };
  }

  function msAt(day: number, min: number): number {
    if (min >= 1440) return bounds[day][1];
    return zonedToUtc(`${days[day]}T${minutesToHHMM(min)}:00`, tz);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || dragRef.current) return;
    const target = e.target as HTMLElement;
    const evEl = target.closest<HTMLElement>("[data-event-id]");
    const p = pointAt(e.clientX, e.clientY);
    let d: Drag;
    if (evEl) {
      const ev = events.find((x) => x.id === evEl.dataset.eventId);
      if (!ev) return;
      d = { kind: target.closest("[data-resize]") ? "resize" : "move", ev, day0: p.day, min0: p.min, delta: 0, moved: false };
    } else {
      const m = Math.min(1440 - SNAP_MIN, Math.floor(p.min / SNAP_MIN) * SNAP_MIN);
      d = { kind: "create", day: p.day, anchor: m, cur: m, moved: false };
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { d, x: e.clientX, y: e.clientY };
    setDrag(d);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const cur = dragRef.current;
    if (!cur) return;
    if (!cur.d.moved && Math.hypot(e.clientX - cur.x, e.clientY - cur.y) < 4) return;
    const p = pointAt(e.clientX, e.clientY);
    let d: Drag;
    if (cur.d.kind === "create") d = { ...cur.d, cur: snap(p.min), moved: true };
    else d = { ...cur.d, delta: snap((p.day - cur.d.day0) * 1440 + p.min - cur.d.min0), moved: true };
    cur.d = d;
    setDrag(d);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const cur = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!cur) return;
    const d = cur.d;
    const anchor = { x: e.clientX, y: e.clientY };
    if (d.kind === "create") {
      let lo = d.anchor;
      let hi = d.anchor + 60;
      if (d.moved) {
        lo = Math.min(d.anchor, d.cur);
        hi = Math.max(d.anchor + SNAP_MIN, d.cur);
        if (d.cur < d.anchor) hi = d.anchor + SNAP_MIN;
      }
      hi = Math.min(1440, hi);
      onCreate({ allDay: false, start: msAt(d.day, lo), end: msAt(d.day, hi) }, anchor);
      return;
    }
    if (!d.moved || !canDrag(d.ev)) {
      if (!d.moved) onOpen(d.ev, anchor);
      return;
    }
    if (d.delta === 0) return;
    const ms = d.delta * 60_000;
    if (d.kind === "move") onMove(d.ev, d.ev.utcStart + ms, d.ev.utcEnd + ms);
    else onMove(d.ev, d.ev.utcStart, Math.max(d.ev.utcStart + SNAP_MIN * 60_000, d.ev.utcEnd + ms));
  }

  const ghostSeg = (() => {
    if (drag?.kind === "create") {
      const lo = drag.moved ? Math.min(drag.anchor, drag.cur) : drag.anchor;
      const hi = drag.moved ? Math.max(drag.anchor + SNAP_MIN, drag.cur) : drag.anchor + 60;
      return { day: drag.day, startMin: lo, endMin: Math.min(1440, drag.cur < drag.anchor && drag.moved ? drag.anchor + SNAP_MIN : hi) };
    }
    if (ghost && !ghost.allDay) {
      const day = bounds.findIndex(([ds, de]) => ghost.start >= ds && ghost.start < de);
      if (day === -1) return null;
      const startMin = zonedParts(ghost.start, tz).minutes;
      const endMin = ghost.end >= bounds[day][1] ? 1440 : zonedParts(ghost.end, tz).minutes;
      return { day, startMin, endMin: Math.max(endMin, startMin + SNAP_MIN) };
    }
    return null;
  })();

  const todayIdx = days.indexOf(todayKey);
  const nowMin = now !== null && todayIdx >= 0 ? zonedParts(now, tz).minutes : null;
  const hourFmt = fmt(locale, { hour: "numeric", timeZone: "UTC" });
  const gridCols = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };

  return (
    <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain select-none">
      {/* Sticky header: day names + all-day band */}
      <div className="sticky top-0 z-20 border-b border-line bg-sheet">
        <div className="flex" style={{ paddingLeft: GUTTER }}>
          <div className="grid flex-1" style={gridCols}>
            {days.map((d) => {
              const today = d === todayKey;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => onPickDay(d)}
                  className="group flex flex-col items-center gap-0.5 py-2 text-ink-mute transition-colors hover:text-ink"
                >
                  <span className="text-[11px] font-medium tracking-wide uppercase">
                    {fmtDay(locale, d, { weekday: "short" })}
                  </span>
                  <span
                    className={`grid h-8 min-w-8 place-items-center rounded-full px-1 text-[18px] font-semibold tabular-nums ${today ? "text-white" : "text-ink group-hover:bg-hover"}`}
                    style={today ? { background: "var(--color-app-calendar)" } : undefined}
                  >
                    {fmtDay(locale, d, { day: "numeric" })}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex border-t border-line">
          <div
            className="shrink-0 pt-1.5 pr-2 text-right text-[10px] font-medium text-ink-mute uppercase"
            style={{ width: GUTTER }}
          >
            {t("allDay")}
          </div>
          <div className="relative flex-1" style={{ minHeight: Math.max(1, spans.lanes) * 24 + 6 }}>
            <div className="absolute inset-0 grid" style={gridCols}>
              {days.map((d) => (
                <div
                  key={d}
                  data-day={d}
                  onClick={(e) => onCreate({ allDay: true, startDay: d, endDay: addDays(d, 1) }, { x: e.clientX, y: e.clientY })}
                  className={`border-l border-line ${dayDrag.drag?.over === d ? "bg-primary-soft" : ""}`}
                />
              ))}
            </div>
            <div className="pointer-events-none relative grid gap-y-0.5 py-0.5" style={{ ...gridCols, gridAutoRows: 22 }}>
              {spans.items.map(({ ev, s, e, lane }) => (
                <button
                  key={ev.id}
                  type="button"
                  onPointerDown={(pe) => dayDrag.onPointerDown(ev, pe)}
                  onClick={(ce) => ce.stopPropagation()}
                  className={`pointer-events-auto mx-0.5 truncate rounded-[5px] border px-1.5 text-left text-[12px] leading-[20px] font-medium ${dayDrag.drag?.id === ev.id ? "opacity-50" : ""}`}
                  style={{ ...chipStyle(colorOf(ev)), gridColumn: `${s + 1} / ${e + 1}`, gridRow: lane + 1 }}
                >
                  {ev.title || t("untitled")}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Time body */}
      <div className="flex" style={{ height: 24 * HOUR_PX }}>
        <div className="relative shrink-0" style={{ width: GUTTER }}>
          {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
            <span
              key={h}
              className="absolute right-2 -translate-y-1/2 font-mono text-[10px] text-ink-mute tabular-nums"
              style={{ top: h * HOUR_PX }}
            >
              {hourFmt.format(new Date(Date.UTC(2020, 0, 1, h)))}
            </span>
          ))}
        </div>
        <div
          ref={cols}
          className="relative grid flex-1 touch-pan-y"
          style={{
            ...gridCols,
            backgroundImage: "linear-gradient(to bottom, var(--color-line) 1px, transparent 1px)",
            backgroundSize: `100% ${HOUR_PX}px`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            dragRef.current = null;
            setDrag(null);
          }}
        >
          {days.map((d, i) => (
            <div key={d} className="relative border-l border-line">
              {perDay[i].map((s) => {
                const ev = s.ev;
                const top = (s.startMin / 60) * HOUR_PX;
                const height = Math.max(((s.endMin - s.startMin) / 60) * HOUR_PX - 2, 18);
                const short = height < 36;
                const dragging = drag && drag.kind !== "create" && drag.ev.id === ev.id && drag.moved;
                const draggable = canDrag(ev);
                return (
                  <div
                    key={ev.id}
                    data-event-id={ev.id}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(k) => {
                      if (k.key === "Enter" || k.key === " ") {
                        const r = k.currentTarget.getBoundingClientRect();
                        onOpen(ev, { x: r.right, y: r.top });
                      }
                    }}
                    className={`absolute overflow-hidden rounded-[5px] border px-1.5 text-[12px] leading-tight ${draggable ? "cursor-grab" : "cursor-pointer"} ${dragging ? "z-10 shadow-[var(--shadow-pop)]" : ""} ${ev.myStatus === "declined" ? "line-through opacity-60" : ""} ${ev.myStatus === "needs-action" ? "border-dashed" : ""}`}
                    style={{
                      ...chipStyle(colorOf(ev)),
                      top: top + 1,
                      height,
                      left: `calc(${(s.col / s.cols) * 100}% + 2px)`,
                      width: `calc(${100 / s.cols}% - 4px)`,
                    }}
                  >
                    <div className={`flex gap-1 ${short ? "items-center" : "flex-col pt-0.5"}`}>
                      <span className="truncate font-medium">
                        {ev.recurrence !== "none" && <Repeat size={10} aria-hidden className="mr-1 inline" />}
                        {ev.title || t("untitled")}
                      </span>
                      <span className="truncate text-[11px] text-ink-soft tabular-nums">
                        {fmtTime(locale, tz, ev.utcStart)}
                        {!short && ` – ${fmtTime(locale, tz, ev.utcEnd)}`}
                        {!short && ev.location && ` · ${ev.location}`}
                      </span>
                    </div>
                    {draggable && (
                      <div data-resize className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize" aria-hidden />
                    )}
                  </div>
                );
              })}
              {ghostSeg && ghostSeg.day === i && (
                <div
                  className="pointer-events-none absolute inset-x-0.5 rounded-[5px] border px-1.5 pt-0.5 text-[12px] font-medium"
                  style={{
                    ...chipStyle("var(--color-app-calendar)"),
                    top: (ghostSeg.startMin / 60) * HOUR_PX + 1,
                    height: Math.max(((ghostSeg.endMin - ghostSeg.startMin) / 60) * HOUR_PX - 2, 18),
                  }}
                >
                  {minutesToHHMM(ghostSeg.startMin)} – {minutesToHHMM(ghostSeg.endMin)}
                </div>
              )}
              {i === todayIdx && nowMin !== null && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-10 h-0.5"
                  style={{ top: (nowMin / 60) * HOUR_PX - 1, background: "var(--color-app-calendar)" }}
                >
                  <span
                    className="absolute -top-[5px] -left-[6px] h-3 w-3 rounded-full"
                    style={{ background: "var(--color-app-calendar)" }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
