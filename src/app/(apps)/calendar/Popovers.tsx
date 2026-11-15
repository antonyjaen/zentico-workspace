"use client";

import { AlignLeft, Bell, CalendarDays, Clock, MapPin, Pencil, Repeat, Trash2, Users, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CalEvent, Calendar, ParticipationStatus } from "@/lib/calendar";
import { BTN, BTN_PRIMARY, eventTimeLabel, FIELD, fmt, fmtDay, type Anchor, type Slot } from "./shared";
import { addDays } from "./time";

/** A fixed-position card near `anchor`, clamped to the viewport; closes on outside press / Escape. */
function Floating({ anchor, onClose, width, label, children }: { anchor: Anchor; onClose: () => void; width: number; label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x + 12;
    if (left + width > vw - 8) left = anchor.x - width - 12;
    left = Math.min(Math.max(8, left), vw - width - 8);
    const top = Math.min(Math.max(8, anchor.y - 24), vh - h - 8);
    setPos({ left, top });
  }, [anchor, width]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className="pop fixed z-40 max-h-[80dvh] overflow-y-auto"
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? 0, transformOrigin: "top left" }}
    >
      {children}
    </div>
  );
}

export function QuickCreate({
  anchor,
  slot,
  calendars,
  tz,
  locale,
  onClose,
  onSave,
  onMore,
}: {
  anchor: Anchor;
  slot: Slot;
  calendars: Calendar[];
  tz: string;
  locale: string;
  onClose: () => void;
  onSave: (title: string, calendarId: string) => Promise<void>;
  onMore: (title: string, calendarId: string) => void;
}) {
  const t = useTranslations("calendar");
  const writable = calendars.filter((c) => c.mayWrite);
  const [title, setTitle] = useState("");
  const [calendarId, setCalendarId] = useState(writable[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  const when = slot.allDay
    ? addDays(slot.endDay, -1) === slot.startDay
      ? `${fmtDay(locale, slot.startDay, { weekday: "long", day: "numeric", month: "long" })} · ${t("allDay")}`
      : `${fmtDay(locale, slot.startDay, { day: "numeric", month: "short" })} – ${fmtDay(locale, addDays(slot.endDay, -1), { day: "numeric", month: "short" })}`
    : fmt(locale, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZone: tz }).formatRange(
        new Date(slot.start),
        new Date(slot.end),
      );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!calendarId || busy) return;
    setBusy(true);
    await onSave(title, calendarId);
    setBusy(false);
  }

  return (
    <Floating anchor={anchor} onClose={onClose} width={340} label={t("quick.label")}>
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("quick.titlePlaceholder")}
          maxLength={500}
          aria-label={t("editor.title")}
          className="h-10 w-full border-b border-line bg-transparent text-[17px] font-medium text-ink outline-none placeholder:text-ink-mute focus:border-ink-mute"
        />
        <p className="flex items-start gap-2 text-[13px] text-ink-soft">
          <Clock size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span className="first-letter:uppercase">{when}</span>
        </p>
        <label className="flex items-center gap-2">
          <CalendarDays size={14} aria-hidden className="shrink-0 text-ink-soft" />
          <select value={calendarId} onChange={(e) => setCalendarId(e.target.value)} className={`${FIELD} h-8`} aria-label={t("editor.calendar")}>
            {writable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" className={BTN} onClick={() => onMore(title, calendarId)}>
            {t("quick.moreOptions")}
          </button>
          <button type="submit" className={BTN_PRIMARY} disabled={busy || !calendarId}>
            {t("editor.save")}
          </button>
        </div>
      </form>
    </Floating>
  );
}

const STATUS_KEYS: ParticipationStatus[] = ["accepted", "tentative", "declined", "needs-action", "delegated"];

export function EventDetails({
  ev,
  anchor,
  calendar,
  tz,
  locale,
  canEdit,
  onClose,
  onEdit,
  onDelete,
  onRespond,
}: {
  ev: CalEvent;
  anchor: Anchor;
  calendar: Calendar | undefined;
  tz: string;
  locale: string;
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRespond: (status: "accepted" | "tentative" | "declined") => void;
}) {
  const t = useTranslations("calendar");
  const guests = ev.participants;
  const color = calendar?.color ?? "var(--color-app-calendar)";

  return (
    <Floating anchor={anchor} onClose={onClose} width={380} label={ev.title || t("untitled")}>
      <div className="flex items-center justify-end gap-0.5 px-2 pt-2">
        {canEdit && (
          <button type="button" className="icon-btn" aria-label={t("details.edit")} title={t("details.edit")} onClick={onEdit}>
            <Pencil size={16} aria-hidden />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label={t("details.delete")} title={t("details.delete")} onClick={onDelete}>
          <Trash2 size={16} aria-hidden />
        </button>
        <button type="button" className="icon-btn" aria-label={t("details.close")} title={t("details.close")} onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="flex flex-col gap-3 px-5 pb-5">
        <div className="flex items-start gap-3">
          <span className="mt-1.5 h-3 w-3 shrink-0 rounded-[4px]" style={{ background: color }} />
          <div className="min-w-0">
            <h2 className="text-[18px] leading-snug font-semibold tracking-tight break-words text-ink">{ev.title || t("untitled")}</h2>
            <p className="mt-0.5 text-[13px] text-ink-soft first-letter:uppercase">{eventTimeLabel(ev, locale, tz, t("allDay"))}</p>
            {ev.recurrence !== "none" && (
              <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ink-mute">
                <Repeat size={12} aria-hidden />
                {t(`repeat.${ev.recurrence}`)}
              </p>
            )}
          </div>
        </div>
        {ev.location && (
          <Row icon={<MapPin size={15} aria-hidden />}>
            <span className="break-words">{ev.location}</span>
          </Row>
        )}
        {guests.length > 0 && (
          <Row icon={<Users size={15} aria-hidden />}>
            <p className="text-ink">{t("details.guests", { count: guests.length })}</p>
            <ul className="mt-1 flex flex-col gap-1">
              {guests.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate text-ink-soft" title={p.email}>
                    {p.name ?? p.email}
                    {p.isOwner && <span className="ml-1.5 text-ink-mute">· {t("details.organizer")}</span>}
                    {p.isOptional && <span className="ml-1.5 text-ink-mute">· {t("editor.optional")}</span>}
                  </span>
                  <span className="shrink-0 text-[12px] text-ink-mute">
                    {t(`status.${STATUS_KEYS.includes(p.status) ? p.status : "needs-action"}`)}
                  </span>
                </li>
              ))}
            </ul>
          </Row>
        )}
        {ev.alerts.length > 0 && (
          <Row icon={<Bell size={15} aria-hidden />}>
            <span>{ev.alerts.map((m) => reminderLabel(t, m)).join(", ")}</span>
          </Row>
        )}
        {ev.description && (
          <Row icon={<AlignLeft size={15} aria-hidden />}>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{ev.description}</p>
          </Row>
        )}
        {calendar && (
          <Row icon={<CalendarDays size={15} aria-hidden />}>
            <span>{calendar.name}</span>
          </Row>
        )}
        {ev.myStatus !== null && (
          <div className="mt-1 flex items-center gap-2 border-t border-line pt-3">
            <span className="mr-auto text-[13px] font-medium text-ink">{t("rsvp.prompt")}</span>
            {(["accepted", "tentative", "declined"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={ev.myStatus === s}
                onClick={() => onRespond(s)}
                className={`${BTN} aria-pressed:border-ink aria-pressed:bg-primary-soft aria-pressed:text-ink`}
              >
                {t(`rsvp.${s}`)}
              </button>
            ))}
          </div>
        )}
      </div>
    </Floating>
  );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-[14px] text-ink-soft">
      <span className="mt-0.5 shrink-0 text-ink-mute">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

type T = ReturnType<typeof useTranslations<"calendar">>;
export function reminderLabel(t: T, min: number): string {
  if (min === 0) return t("reminders.atStart");
  if (min % 10080 === 0) return t("reminders.weeks", { count: min / 10080 });
  if (min % 1440 === 0) return t("reminders.days", { count: min / 1440 });
  if (min % 60 === 0) return t("reminders.hours", { count: min / 60 });
  return t("reminders.minutes", { count: min });
}
