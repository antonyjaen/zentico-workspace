"use client";

import { AlignLeft, Bell, CalendarDays, Clock, Globe, MapPin, Plus, Repeat, Trash2, Users, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import type { Calendar, Participant } from "@/lib/calendar";
import type { EventInput } from "./actions";
import { reminderLabel } from "./Popovers";
import { BTN, BTN_PRIMARY, FIELD } from "./shared";
import { addDays, diffDays, keyToUtc, minutesToHHMM, utcToKey } from "./time";

export type EditorState = {
  /** Stored event id when editing, null when creating. */
  id: string | null;
  input: EventInput;
  participants: Participant[];
  isSeries: boolean;
};

const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const REMINDER_PRESETS = [0, 5, 10, 15, 30, 60, 120, 1440, 10080];
const REPEATS = ["none", "daily", "weekly", "monthly", "yearly"] as const;

const toMin = (date: string, time: string) => keyToUtc(date) / 60_000 + +time.slice(0, 2) * 60 + +time.slice(3, 5);
const fromMin = (m: number) => ({ date: utcToKey(Math.floor(m / 1440) * 86_400_000), time: minutesToHHMM(((m % 1440) + 1440) % 1440) });

export function EventEditor({
  state,
  calendars,
  onClose,
  onSave,
  onDelete,
}: {
  state: EditorState;
  calendars: Calendar[];
  onClose: () => void;
  onSave: (id: string | null, input: EventInput) => Promise<string | null>;
  onDelete: (id: string) => void;
}) {
  const t = useTranslations("calendar");
  const [v, setV] = useState<EventInput>(state.input);
  const [guest, setGuest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writable = calendars.filter((c) => c.mayWrite || c.id === v.calendarId);
  const statusByEmail = useMemo(() => new Map(state.participants.map((p) => [p.email, p.status])), [state.participants]);

  const zones = useMemo(() => {
    let list: string[] = [];
    try {
      list = Intl.supportedValuesOf("timeZone");
    } catch {}
    if (!list.includes(v.timeZone)) list = [v.timeZone, ...list];
    if (!list.includes("UTC")) list = [...list, "UTC"];
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = <K extends keyof EventInput>(k: K, value: EventInput[K]) => setV((p) => ({ ...p, [k]: value }));

  // Moving the start keeps the duration.
  function setStart(date: string, time: string) {
    setV((p) => {
      if (!date) return p;
      if (p.allDay) {
        const len = Math.max(0, diffDays(p.startDate, p.endDate));
        return { ...p, startDate: date, endDate: addDays(date, len) };
      }
      const dur = toMin(p.endDate, p.endTime) - toMin(p.startDate, p.startTime);
      const end = fromMin(toMin(date, time) + Math.max(dur, 15));
      return { ...p, startDate: date, startTime: time, endDate: end.date, endTime: end.time };
    });
  }

  /** Merges the typed guest text into the list; returns the new input or null when invalid. */
  function mergeGuests(p: EventInput): EventInput | null {
    const emails = guest
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const bad = emails.find((e) => !EMAIL.test(e));
    if (bad) {
      setError(t("editor.invalidEmail", { email: bad }));
      return null;
    }
    setError(null);
    setGuest("");
    const fresh = emails.filter((e, i) => emails.indexOf(e) === i && !p.guests.some((g) => g.email === e));
    return { ...p, guests: [...p.guests, ...fresh.map((email) => ({ email, optional: false }))] };
  }

  function addGuest() {
    const next = mergeGuests(v);
    if (next) setV(next);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const input = guest.trim() ? mergeGuests(v) : v;
    if (!input) return;
    if (input !== v) setV(input);
    const endOk = input.allDay
      ? input.endDate >= input.startDate
      : toMin(input.endDate, input.endTime) > toMin(input.startDate, input.startTime);
    if (!endOk) {
      setError(t("editor.endBeforeStart"));
      return;
    }
    setBusy(true);
    setError(null);
    const err = await onSave(state.id, input);
    setBusy(false);
    if (err) setError(err);
  }

  const reminderOptions = [...new Set([...REMINDER_PRESETS, ...v.alerts])].sort((a, b) => a - b);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label={state.id ? t("editor.editTitle") : t("editor.newTitle")}
        className="pop flex max-h-[92dvh] w-full max-w-[640px] flex-col overflow-hidden"
        style={{ transformOrigin: "center" }}
      >
        <header className="flex items-center gap-2 border-b border-line px-5 py-3">
          <h2 className="flex-1 text-[15px] font-semibold text-ink">{state.id ? t("editor.editTitle") : t("editor.newTitle")}</h2>
          <button type="button" className="icon-btn" aria-label={t("details.close")} onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <input
            autoFocus
            value={v.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder={t("quick.titlePlaceholder")}
            aria-label={t("editor.title")}
            maxLength={500}
            className="h-11 w-full border-b border-line bg-transparent text-[20px] font-semibold tracking-tight text-ink outline-none placeholder:text-ink-mute focus:border-ink-mute"
          />

          {state.isSeries && <p className="rounded-md bg-sheet-muted px-3 py-2 text-[13px] text-ink-soft">{t("editor.seriesNote")}</p>}

          <Field icon={<Clock size={16} aria-hidden />}>
            <div className="flex flex-wrap items-center gap-2">
              <input type="date" required value={v.startDate} onChange={(e) => setStart(e.target.value, v.startTime)} className={`${FIELD} w-auto`} aria-label={t("editor.start")} />
              {!v.allDay && (
                <input type="time" required step={300} value={v.startTime} onChange={(e) => setStart(v.startDate, e.target.value)} className={`${FIELD} w-auto`} aria-label={t("editor.startTime")} />
              )}
              <span className="text-ink-mute">–</span>
              {!v.allDay && (
                <input type="time" required step={300} value={v.endTime} onChange={(e) => set("endTime", e.target.value)} className={`${FIELD} w-auto`} aria-label={t("editor.endTime")} />
              )}
              <input type="date" required value={v.endDate} onChange={(e) => set("endDate", e.target.value)} className={`${FIELD} w-auto`} aria-label={t("editor.end")} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex items-center gap-2 text-[14px] text-ink-soft">
                <input type="checkbox" checked={v.allDay} onChange={(e) => set("allDay", e.target.checked)} className="h-4 w-4 accent-[var(--color-app-calendar)]" />
                {t("allDay")}
              </label>
              <label className="flex items-center gap-2 text-[14px] text-ink-soft">
                <Repeat size={14} aria-hidden />
                <select value={v.recurrence} onChange={(e) => set("recurrence", e.target.value as EventInput["recurrence"])} className={`${FIELD} h-8 w-auto`} aria-label={t("editor.repeat")}>
                  {state.input.recurrence === "keep" && <option value="keep">{t("repeat.custom")}</option>}
                  {REPEATS.map((r) => (
                    <option key={r} value={r}>
                      {t(`repeat.${r}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Field>

          {!v.allDay && (
            <Field icon={<Globe size={16} aria-hidden />}>
              <select value={v.timeZone} onChange={(e) => set("timeZone", e.target.value)} className={FIELD} aria-label={t("editor.timeZone")}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field icon={<Users size={16} aria-hidden />}>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="email"
                autoComplete="off"
                value={guest}
                onChange={(e) => setGuest(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addGuest();
                  }
                }}
                placeholder={t("editor.guestPlaceholder")}
                aria-label={t("editor.guests")}
                className={FIELD}
              />
              <button type="button" className={`${BTN} h-9 shrink-0`} onClick={addGuest}>
                <Plus size={14} aria-hidden />
                {t("editor.addGuest")}
              </button>
            </div>
            {v.guests.length > 0 && (
              <ul className="mt-2 flex flex-col divide-y divide-line rounded-md border border-line">
                {v.guests.map((g) => {
                  const status = statusByEmail.get(g.email);
                  return (
                    <li key={g.email} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                      <span className="min-w-0 flex-1 truncate text-ink">{g.email}</span>
                      {status && <span className="shrink-0 text-[12px] text-ink-mute">{t(`status.${status}`)}</span>}
                      <select
                        value={g.optional ? "optional" : "required"}
                        onChange={(e) =>
                          set(
                            "guests",
                            v.guests.map((x) => (x.email === g.email ? { ...x, optional: e.target.value === "optional" } : x)),
                          )
                        }
                        className="h-7 rounded-md border border-line bg-sheet px-1.5 text-[12px] text-ink-soft"
                        aria-label={t("editor.role")}
                      >
                        <option value="required">{t("editor.required")}</option>
                        <option value="optional">{t("editor.optional")}</option>
                      </select>
                      <button
                        type="button"
                        className="icon-btn !h-7 !w-7"
                        aria-label={t("editor.removeGuest", { email: g.email })}
                        onClick={() => set("guests", v.guests.filter((x) => x.email !== g.email))}
                      >
                        <X size={14} aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {v.guests.length > 0 && <p className="mt-1.5 text-[12px] text-ink-mute">{t("editor.invitesNote")}</p>}
          </Field>

          <Field icon={<MapPin size={16} aria-hidden />}>
            <input value={v.location} onChange={(e) => set("location", e.target.value)} placeholder={t("editor.location")} aria-label={t("editor.location")} maxLength={500} className={FIELD} />
          </Field>

          <Field icon={<CalendarDays size={16} aria-hidden />}>
            <select value={v.calendarId} onChange={(e) => set("calendarId", e.target.value)} className={FIELD} aria-label={t("editor.calendar")}>
              {writable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>

          <Field icon={<Bell size={16} aria-hidden />}>
            <div className="flex flex-col gap-2">
              {v.alerts.map((a, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={a}
                    onChange={(e) => set("alerts", v.alerts.map((x, j) => (j === i ? Number(e.target.value) : x)))}
                    className={FIELD}
                    aria-label={t("editor.reminders")}
                  >
                    {reminderOptions.map((m) => (
                      <option key={m} value={m}>
                        {reminderLabel(t, m)}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="icon-btn shrink-0" aria-label={t("editor.removeReminder")} onClick={() => set("alerts", v.alerts.filter((_, j) => j !== i))}>
                    <X size={14} aria-hidden />
                  </button>
                </div>
              ))}
              {v.alerts.length < 5 && (
                <button type="button" className={`${BTN} self-start`} onClick={() => set("alerts", [...v.alerts, v.allDay ? 1440 : 10])}>
                  <Plus size={14} aria-hidden />
                  {t("editor.addReminder")}
                </button>
              )}
            </div>
          </Field>

          <Field icon={<AlignLeft size={16} aria-hidden />}>
            <textarea
              value={v.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder={t("editor.description")}
              aria-label={t("editor.description")}
              rows={4}
              maxLength={20000}
              className={`${FIELD} h-auto resize-y py-2`}
            />
          </Field>
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
          {state.id && (
            <button type="button" className={`${BTN} hover:text-danger`} onClick={() => onDelete(state.id!)}>
              <Trash2 size={14} aria-hidden />
              {t("details.delete")}
            </button>
          )}
          {error && (
            <p role="alert" className="min-w-0 flex-1 truncate text-[13px] text-danger">
              {error}
            </p>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" className={BTN} onClick={onClose}>
              {t("editor.cancel")}
            </button>
            <button type="submit" className={BTN_PRIMARY} disabled={busy || !v.calendarId}>
              {busy ? t("editor.saving") : t("editor.save")}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function Field({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-2.5 shrink-0 text-ink-mute">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
