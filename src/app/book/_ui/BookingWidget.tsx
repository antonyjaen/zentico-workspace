"use client";

import { ArrowLeft, CalendarCheck, ChevronLeft, ChevronRight, Clock, Globe, Loader2, MapPin, Phone, Video } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { addMonths, daysBetween, isTimeZone, viewRange, weekStartFor, zonedParts, zonedToUtc } from "@/app/(apps)/calendar/time";
import type { PublicBookingType } from "@/lib/booking/types";
import { formatRange } from "./format";
import { BTN_PRIMARY, BTN_SECONDARY, INPUT } from "./Shell";

type Mode = { kind: "book"; handle: string; slug: string } | { kind: "reschedule"; token: string; duration: number };

function detectZone(fallback: string): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(tz) ? tz : fallback;
  } catch {
    return fallback;
  }
}

function zoneList(current: string): string[] {
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf("timeZone");
  } catch {
    list = [];
  }
  return list.includes(current) ? list : [current, ...list];
}

/** Date + time picker and booking form of a public booking page (also used to reschedule). */
export function BookingWidget({
  type,
  mode,
  initialZone,
  onRescheduled,
}: {
  type: PublicBookingType;
  mode: Mode;
  /** Zone to start in (the guest's, when rescheduling); default: the browser's. */
  initialZone?: string;
  onRescheduled?: () => void;
}) {
  const t = useTranslations("booking.public");
  const locale = useLocale();
  const tag = locale === "en" ? "en-US" : "es-ES";
  const [tz, setTz] = useState(initialZone ?? type.timeZone);
  useEffect(() => {
    if (!initialZone) setTz(detectZone(type.timeZone));
  }, [initialZone, type.timeZone]);

  const [duration, setDuration] = useState(mode.kind === "reschedule" ? mode.duration : type.durations[0]);
  const today = zonedParts(Date.now(), tz).key;
  const [month, setMonth] = useState(`${today.slice(0, 8)}01`);
  const [slots, setSlots] = useState<number[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    setSlots(null);
    const from = zonedToUtc(`${month}T00:00:00`, tz);
    const to = zonedToUtc(`${addMonths(month, 1)}T00:00:00`, tz);
    const q = new URLSearchParams({ from: String(Math.floor(from / 60_000) * 60_000), to: String(Math.ceil(to / 60_000) * 60_000) });
    if (mode.kind === "book") {
      q.set("handle", mode.handle);
      q.set("slug", mode.slug);
      q.set("duration", String(duration));
    } else q.set("token", mode.token);
    try {
      const res = await fetch(`/api/book/slots?${q}`, { cache: "no-store" });
      if (!res.ok) {
        setError(res.status === 429 ? "rate" : "unavailable");
        setSlots([]);
        return;
      }
      const body = (await res.json()) as { slots: number[] };
      setSlots(body.slots);
    } catch {
      setError("network");
      setSlots([]);
    }
  }, [month, tz, duration, mode]);
  useEffect(() => {
    void load();
  }, [load, reload]);

  const byDay = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const s of slots ?? []) {
      const k = zonedParts(s, tz).key;
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [slots, tz]);

  // Keep a valid day selected: the first one with times when the current one has none.
  useEffect(() => {
    if (!slots) return;
    if (!day || !byDay.has(day)) setDay([...byDay.keys()][0] ?? null);
  }, [slots, byDay, day]);

  const weekStart = weekStartFor(locale);
  const grid = viewRange("month", month, weekStart);
  const days = daysBetween(grid.start, grid.end);
  const fmtTime = new Intl.DateTimeFormat(tag, { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const fmtDayLong = (k: string) =>
    new Intl.DateTimeFormat(tag, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)));

  if (start != null) {
    return (
      <Details
        type={type}
        mode={mode}
        start={start}
        duration={duration}
        tz={tz}
        onBack={(taken) => {
          setStart(null);
          if (taken) {
            setError("slot_taken");
            setReload((n) => n + 1);
          }
        }}
        onRescheduled={onRescheduled}
      />
    );
  }

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_220px]">
      <div>
        {mode.kind === "book" && type.durations.length > 1 && (
          <fieldset className="mb-5">
            <legend className="mb-2 text-[13px] font-medium text-ink-soft">{t("duration")}</legend>
            <div className="flex flex-wrap gap-2">
              {type.durations.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={d === duration}
                  onClick={() => setDuration(d)}
                  className={`h-9 rounded-lg border px-3 text-[13.5px] transition-colors ${d === duration ? "border-ink bg-primary text-primary-ink" : "border-line text-ink-soft hover:bg-hover"}`}
                >
                  {t("minutes", { n: d })}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[15px] font-medium capitalize">
            {new Intl.DateTimeFormat(tag, { timeZone: "UTC", month: "long", year: "numeric" }).format(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1, 1))}
          </h2>
          <div className="flex gap-1">
            <button
              type="button"
              className="icon-btn h-9 w-9"
              aria-label={t("prevMonth")}
              disabled={month <= `${today.slice(0, 8)}01`}
              onClick={() => setMonth(addMonths(month, -1))}
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
            <button type="button" className="icon-btn h-9 w-9" aria-label={t("nextMonth")} onClick={() => setMonth(addMonths(month, 1))}>
              <ChevronRight size={16} aria-hidden />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center" role="grid" aria-label={t("selectDate")}>
          {days.slice(0, 7).map((d) => (
            <span key={d} className="py-1 text-[11px] font-medium text-ink-mute uppercase">
              {new Intl.DateTimeFormat(tag, { timeZone: "UTC", weekday: "short" }).format(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)))}
            </span>
          ))}
          {days.map((d) => {
            const has = byDay.has(d);
            const inMonth = d.slice(0, 7) === month.slice(0, 7);
            const selected = d === day;
            return (
              <button
                key={d}
                type="button"
                disabled={!has}
                onClick={() => setDay(d)}
                aria-pressed={selected}
                aria-label={fmtDayLong(d)}
                className={`mx-auto grid aspect-square w-full max-w-11 place-items-center rounded-full text-[14px] tabular-nums transition-colors ${
                  selected
                    ? "bg-primary font-semibold text-primary-ink"
                    : has
                      ? "bg-primary-soft font-medium text-ink hover:bg-hover"
                      : inMonth
                        ? "text-ink-mute"
                        : "text-ink-mute/50"
                }`}
              >
                {+d.slice(8, 10)}
              </button>
            );
          })}
        </div>
        {slots && byDay.size === 0 && (
          <p className="mt-4 text-[13.5px] text-ink-soft">
            {t("noSlotsMonth")}{" "}
            <button type="button" className="font-medium text-ink underline underline-offset-2" onClick={() => setMonth(addMonths(month, 1))}>
              {t("nextMonth")}
            </button>
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            {t(`errors.${error}` as "errors.failed")}
          </p>
        )}
        <label className="mt-5 flex items-center gap-2 text-[13px] text-ink-soft">
          <Globe size={14} aria-hidden className="shrink-0" />
          <span className="sr-only">{t("timeZone")}</span>
          <select value={tz} onChange={(e) => isTimeZone(e.target.value) && setTz(e.target.value)} className={`${INPUT} !h-9 max-w-xs text-[13px]`}>
            {zoneList(tz).map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <h3 className="mb-2 text-[14px] font-medium first-letter:uppercase">{day ? fmtDayLong(day) : t("selectTime")}</h3>
        {!slots ? (
          <p className="flex items-center gap-2 text-[13px] text-ink-mute">
            <Loader2 size={14} className="animate-spin" aria-hidden /> {t("loading")}
          </p>
        ) : (
          <ul className="flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1">
            {(day ? (byDay.get(day) ?? []) : []).map((s) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setStart(s);
                  }}
                  className="h-10 w-full rounded-lg border border-line text-[14px] font-medium tabular-nums text-ink transition-colors hover:border-ink"
                >
                  {fmtTime.format(s)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Details({
  type,
  mode,
  start,
  duration,
  tz,
  onBack,
  onRescheduled,
}: {
  type: PublicBookingType;
  mode: Mode;
  start: number;
  duration: number;
  tz: string;
  onBack: (taken: boolean) => void;
  onRescheduled?: () => void;
}) {
  const t = useTranslations("booking.public");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ manage: string; email: string } | null>(null);
  const when = formatRange(start, start + duration * 60_000, tz, locale);
  const needsPhone = type.location === "phone" && !type.locationText;

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const answers: Record<string, string> = {};
    for (const q of type.questions) answers[q.id] = String(data.get(`q_${q.id}`) ?? "");
    setBusy(true);
    setError(null);
    try {
      const body =
        mode.kind === "book"
          ? {
              handle: mode.handle,
              slug: mode.slug,
              start,
              duration,
              name: data.get("name"),
              email: data.get("email"),
              phone: data.get("phone") ?? "",
              answers,
              timeZone: tz,
              locale,
              website: data.get("website") ?? "",
            }
          : { token: mode.token, start };
      const res = await fetch(`/api/book/${mode.kind === "book" ? "book" : "reschedule"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string; manage?: string };
      if (!res.ok) {
        if (out.error === "slot_taken") return onBack(true);
        setError(["invalid", "limit", "rate", "unavailable", "not_found", "too_late"].includes(out.error ?? "") ? out.error! : "failed");
        return;
      }
      if (mode.kind === "reschedule") return onRescheduled?.();
      setDone({ manage: out.manage ?? "", email: String(data.get("email") ?? "") });
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col items-start gap-3" role="status">
        <CalendarCheck size={28} className="text-signal" aria-hidden />
        <h2 className="text-[20px] font-semibold tracking-tight">{t("booked")}</h2>
        <p className="text-[14px] text-ink-soft">{when}</p>
        <p className="text-[14px] text-ink-soft">{t("bookedBody", { email: done.email })}</p>
        {done.manage.startsWith("/book/manage/") && (
          <Link href={done.manage} className={BTN_SECONDARY}>
            {t("manageBooking")}
          </Link>
        )}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget);
      }}
    >
      <button type="button" onClick={() => onBack(false)} className="inline-flex w-fit items-center gap-1.5 text-[13px] text-ink-soft hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> {t("back")}
      </button>
      <p className="flex items-center gap-2 rounded-lg bg-sheet-muted px-3 py-2.5 text-[14px] font-medium">
        <Clock size={15} aria-hidden className="shrink-0 text-ink-soft" /> {when}
      </p>
      {mode.kind === "book" && (
        <>
          <h2 className="text-[15px] font-medium">{t("yourDetails")}</h2>
          <Field label={t("name")}>
            <input name="name" required maxLength={120} autoComplete="name" className={INPUT} />
          </Field>
          <Field label={t("email")}>
            <input name="email" type="email" required maxLength={254} autoComplete="email" className={INPUT} />
          </Field>
          {needsPhone && (
            <Field label={t("phone")}>
              <input name="phone" type="tel" required maxLength={40} autoComplete="tel" pattern="[+()0-9][0-9 ().\-]{4,38}" className={INPUT} />
            </Field>
          )}
          {type.questions.map((q) => (
            <Field key={q.id} label={q.required ? q.label : `${q.label} (${t("optional")})`}>
              {q.type === "textarea" ? (
                <textarea name={`q_${q.id}`} required={q.required} maxLength={1000} rows={3} className={`${INPUT} !h-auto py-2`} />
              ) : (
                <input name={`q_${q.id}`} type={q.type === "phone" ? "tel" : "text"} required={q.required} maxLength={1000} className={INPUT} />
              )}
            </Field>
          ))}
          {/* Honeypot: hidden from people and assistive tech; bots fill it. */}
          <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
            <label>
              Website
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {t(`errors.${error}` as "errors.failed")}
        </p>
      )}
      <button type="submit" disabled={busy} className={`${BTN_PRIMARY} w-full sm:w-fit`}>
        {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}
        {busy ? t("confirming") : mode.kind === "book" ? t("confirm") : t("confirmReschedule")}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink-soft">
      {label}
      {children}
    </label>
  );
}


/** Icon for each kind of location. */
export const LOCATION_ICON = { meet: Video, phone: Phone, inPerson: MapPin, custom: MapPin } as const;
