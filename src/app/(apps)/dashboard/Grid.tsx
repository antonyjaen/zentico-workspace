"use client";

// 12-column grid region of a Zentico UI layout. Desktop: absolutely positioned cells; in edit mode
// the card header drags an item and the corner handle resizes it, snapping to the grid (others are
// pushed down live). Keyboard (edit mode, item focused): arrows move, Shift+arrows resize. Phones:
// one column in (y, x) order.
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GRID_COLUMNS as GRID_COLS, normalizeBoxes, type Box as GridBox } from "@/lib/ui/schema";

const MAX_H = 40;
type Widget = GridBox;

const DESKTOP_MIN_PX = 720;

type Box = { id: string; x: number; y: number; w: number; h: number };
const normalizeLayout = (items: Widget[], pinned: string[]) => normalizeBoxes(items, pinned);
type Drag = { id: string; mode: "move" | "resize"; startX: number; startY: number; box: Box; pointerId: number };

const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export function Grid({
  widgets,
  editing,
  row,
  gap,
  onCommit,
  renderCard,
}: {
  widgets: Widget[];
  editing: boolean;
  row: number;
  gap: number;
  /** New positions of the widgets that changed (already resolved). */
  onCommit: (items: Box[], announce: string) => void;
  renderCard: (w: Widget, opts: { dragHandle: (e: React.PointerEvent) => void; resizeHandle: ReactNode; desktop: boolean }) => ReactNode;
}) {
  const t = useTranslations("dashboard.grid");
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [preview, setPreviewState] = useState<Widget[] | null>(null);
  const previewRef = useRef<Widget[] | null>(null);
  const setPreview = (p: Widget[] | null) => {
    previewRef.current = p;
    setPreviewState(p);
  };
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const desktop = width >= DESKTOP_MIN_PX;
  const col = (width - gap * (GRID_COLS - 1)) / GRID_COLS;
  const shown = preview ?? widgets;

  const resolve = useCallback(
    (box: Box) => normalizeLayout(widgets.map((w) => (w.id === box.id ? { ...w, ...box } : w)), [box.id]),
    [widgets],
  );

  const changed = (next: Widget[]) => {
    const before = new Map(widgets.map((w) => [w.id, w]));
    return next.filter((w) => !sameBox(w, before.get(w.id)!)).map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
  };

  const start = (e: React.PointerEvent, w: Widget, mode: Drag["mode"]) => {
    if (!editing || !desktop || e.button !== 0) return;
    // Buttons inside the header keep working.
    if (mode === "move" && (e.target as HTMLElement).closest("button,a,input,textarea,select")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: w.id, mode, startX: e.clientX, startY: e.clientY, box: { id: w.id, x: w.x, y: w.y, w: w.w, h: w.h }, pointerId: e.pointerId };
    setPreview(widgets);
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const dx = Math.round((e.clientX - d.startX) / (col + gap));
      const dy = Math.round((e.clientY - d.startY) / (row + gap));
      const spec = widgets.find((w) => w.id === d.id) ?? { minW: 1, minH: 1 };
      const box =
        d.mode === "move"
          ? { ...d.box, x: Math.min(GRID_COLS - d.box.w, Math.max(0, d.box.x + dx)), y: Math.max(0, d.box.y + dy) }
          : { ...d.box, w: Math.min(GRID_COLS - d.box.x, Math.max(spec.minW, d.box.w + dx)), h: Math.min(MAX_H, Math.max(spec.minH, d.box.h + dy)) };
      setPreview(resolve(box));
    };
    const up = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      drag.current = null;
      const p = previewRef.current;
      setPreview(null);
      if (p) {
        const items = changed(p);
        const me = p.find((w) => w.id === d.id)!;
        if (items.length) onCommit(items, t("moved", { x: me.x + 1, y: me.y + 1, w: me.w, h: me.h }));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  });

  const onKey = (e: React.KeyboardEvent, w: Widget) => {
    if (!editing || e.target !== e.currentTarget) return;
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const s = step[e.key];
    if (!s) return;
    e.preventDefault();
    const spec = w;
    const box: Box = e.shiftKey
      ? { id: w.id, x: w.x, y: w.y, w: Math.min(GRID_COLS - w.x, Math.max(spec.minW, w.w + s[0])), h: Math.min(MAX_H, Math.max(spec.minH, w.h + s[1])) }
      : { id: w.id, x: Math.min(GRID_COLS - w.w, Math.max(0, w.x + s[0])), y: Math.max(0, w.y + s[1]), w: w.w, h: w.h };
    const next = resolve(box);
    const items = changed(next);
    const me = next.find((x) => x.id === w.id)!;
    if (items.length) onCommit(items, e.shiftKey ? t("resized", { w: me.w, h: me.h }) : t("moved", { x: me.x + 1, y: me.y + 1, w: me.w, h: me.h }));
  };

  const rows = Math.max(1, ...shown.map((w) => w.y + w.h));
  const stacked = [...shown].sort((a, b) => a.y - b.y || a.x - b.x);
  const active = drag.current?.id;

  return (
    <div ref={ref} className="relative w-full" style={desktop ? { height: rows * row + (rows - 1) * gap } : undefined}>
      {editing && desktop && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-lg"
          style={{
            backgroundImage: `linear-gradient(to right, color-mix(in oklab, var(--color-line-strong) 70%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--color-line-strong) 70%, transparent) 1px, transparent 1px)`,
            backgroundSize: `${col + gap}px ${row + gap}px`,
            backgroundPosition: `-${gap / 2}px -${gap / 2}px`,
            opacity: 0.6,
          }}
        />
      )}
      {width > 0 &&
        (desktop ? shown : stacked).map((w) => {
          const style: React.CSSProperties = desktop
            ? {
                position: "absolute",
                left: w.x * (col + gap),
                top: w.y * (row + gap),
                width: w.w * col + (w.w - 1) * gap,
                height: w.h * row + (w.h - 1) * gap,
                transition: active === w.id ? "none" : "left 160ms, top 160ms, width 160ms, height 160ms",
                zIndex: active === w.id ? 10 : undefined,
              }
            : { height: Math.min(560, Math.max(160, w.h * row + (w.h - 1) * gap)), marginBottom: gap };
          return (
            <div
              key={w.id}
              style={style}
              tabIndex={editing ? 0 : undefined}
              role={editing ? "group" : undefined}
              aria-roledescription={editing ? t("roleDescription") : undefined}
              aria-label={editing ? t("position", { x: w.x + 1, y: w.y + 1, w: w.w, h: w.h }) : undefined}
              aria-keyshortcuts={editing ? "ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight" : undefined}
              onKeyDown={(e) => onKey(e, w)}
              className={`rounded-[var(--radius-sheet)] outline-offset-2 ${editing && active === w.id ? "opacity-90 shadow-[var(--shadow-pop)]" : ""}`}
            >
              {renderCard(w, {
                desktop,
                dragHandle: (e) => start(e, w, "move"),
                resizeHandle:
                  editing && desktop ? (
                    <span
                      aria-hidden
                      onPointerDown={(e) => start(e, w, "resize")}
                      className="absolute right-0.5 bottom-0.5 z-10 h-4 w-4 cursor-se-resize touch-none rounded-br-[10px] border-r-2 border-b-2 border-line-strong hover:border-ink-mute"
                    />
                  ) : null,
              })}
            </div>
          );
        })}
    </div>
  );
}
