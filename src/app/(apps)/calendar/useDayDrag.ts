"use client";

import { useRef, useState } from "react";
import type { CalEvent } from "@/lib/calendar";
import type { Anchor } from "./shared";
import { diffDays } from "./time";

const dayAt = (x: number, y: number): string | null => {
  for (const el of document.elementsFromPoint(x, y)) {
    const day = (el as HTMLElement).dataset?.day;
    if (day) return day;
  }
  return null;
};

/**
 * Drag event chips between day cells (elements carrying `data-day`). A press without movement
 * opens the event instead.
 */
export function useDayDrag(
  canDrag: (ev: CalEvent) => boolean,
  onShiftDays: (ev: CalEvent, days: number) => void,
  onOpen: (ev: CalEvent, anchor: Anchor) => void,
) {
  const [drag, setDrag] = useState<{ id: string; over: string } | null>(null);
  const live = useRef(false);

  function onPointerDown(ev: CalEvent, e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0 || live.current) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget;
    const from = dayAt(e.clientX, e.clientY);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const draggable = canDrag(ev);
    let moved = false;
    let over = from;
    live.current = true;
    el.setPointerCapture(e.pointerId);

    const move = (pe: PointerEvent) => {
      if (!moved && Math.hypot(pe.clientX - x0, pe.clientY - y0) < 4) return;
      moved = true;
      if (!draggable) return;
      over = dayAt(pe.clientX, pe.clientY) ?? over;
      if (over) setDrag({ id: ev.id, over });
    };
    const end = (pe: PointerEvent, cancelled: boolean) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      live.current = false;
      setDrag(null);
      if (cancelled) return;
      if (!moved) onOpen(ev, { x: pe.clientX, y: pe.clientY });
      else if (draggable && from && over && over !== from) onShiftDays(ev, diffDays(from, over));
    };
    const up = (pe: PointerEvent) => end(pe, false);
    const cancel = (pe: PointerEvent) => end(pe, true);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
  }

  return { drag, onPointerDown };
}
