"use client";

import { AlignLeft, Bell, CalendarDays, CalendarSearch, Clock, Globe, MapPin, Plus, Repeat, Trash2, Users, Video, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import type { Calendar, Participant } from "@/lib/calendar";
import type { EventInput } from "./actions";
import { Combobox, useAvailability, usePrincipals, type ComboItem } from "./people";
import { reminderLabel } from "./Popovers";
import { generateRoomCode } from "../meet/shared";
import { BTN, BTN_PRIMARY, busyStyle, FIELD, fmt, matches, meetCodeOf, PEOPLE_COLORS } from "./shared";
import { addDays, diffDays, isTimeZone, keyToUtc, minutesToHHMM, utcToKey, zonedParts, zonedToUtc } from "./time";

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
  tz,
  locale,
  myEmail,
  onClose,
  onSave,
  onDelete,
}: {
  state: EditorState;
  calendars: Calendar[];
  tz: string;
  locale: string;
  myEmail: string;
  onClose: () => void;
  onSave: (id: string | null, input: EventInput) => Promise<string | null>;
  onDelete: (id: string) => void;
}) {
  const t = useTranslations("calendar");
  const [v, setV] = useState<EventInput>(state.input);
  const [guest, setGuest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [findTime, setFindTime] = useState(false);
  const principals = usePrincipals();
  const contacts = useContactSuggestions(guest);
  // Existing events can't change account; new ones may go to any calendar I can write to.
  const currentKey = calendars.find((c) => c.id === v.calendarId && (!v.accountId || c.accountId === v.accountId))?.key ?? "";
  const writable = calendars.filter(
    (c) => (c.mayWrite || c.key === currentKey) && (!state.id || !state.input.accountId || c.accountId === state.input.accountId),
  );

  const guestItems = useMemo((): ComboItem[] => {
    const q = guest.split(/[,;]/).pop()?.trim() ?? "";
    if (!q) return [];
    const taken = new Set([...v.guests.map((g) => g.email), myEmail.toLowerCase()]);
    const out: ComboItem[] = [];
    for (const p of principals ?? []) {
      if (out.length >= 6) break;
      if (!p.email || taken.has(p.email) || (p.type !== "individual" && p.type !== "group") || !matches(q, p.name, p.email)) continue;
      taken.add(p.email);
      out.push({ key: p.email, label: p.name || p.email, sub: p.email, group: p.type === "group" });
    }
    for (const c of contacts) {
      if (out.length >= 8) break;
      if (taken.has(c.email)) continue;
      taken.add(c.email);
      out.push({ key: c.email, label: c.name || c.email, sub: c.email });
    }
    return out;
  }, [guest, principals, contacts, v.guests, myEmail]);
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
              <Combobox
                value={guest}
                onChange={setGuest}
                items={guestItems}
                onPick={(it) => {
                  if (!v.guests.some((g) => g.email === it.key)) set("guests", [...v.guests, { email: it.key, optional: false }]);
                  setGuest("");
                  setError(null);
                }}
                onEnter={addGuest}
                icon={false}
                placeholder={t("editor.guestPlaceholder")}
                label={t("editor.guests")}
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
            {v.guests.length > 0 && !v.allDay && (
              <button type="button" className={`${BTN} mt-2`} aria-expanded={findTime} onClick={() => setFindTime((f) => !f)}>
                <CalendarSearch size={14} aria-hidden />
                {t("findTime.toggle")}
              </button>
            )}
            {findTime && !v.allDay && v.guests.length > 0 && (
              <FindTime
                input={v}
                tz={isTimeZone(v.timeZone) ? v.timeZone : tz}
                locale={locale}
                myEmail={myEmail}
                onPick={(time) => setStart(v.startDate, time)}
              />
            )}
          </Field>

          <Field icon={<MapPin size={16} aria-hidden />}>
            <div className="flex gap-2">
              <input value={v.location} onChange={(e) => set("location", e.target.value)} placeholder={t("editor.location")} aria-label={t("editor.location")} maxLength={500} className={FIELD} />
              {meetCodeOf(v.location) ? (
                <span className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-sheet-muted pr-1 pl-3 text-[13px] text-ink-soft">
                  <Video size={14} aria-hidden style={{ color: "var(--color-app-meet)" }} />
                  {t("editor.videoAdded")}
                  <button
                    type="button"
                    className="icon-btn !h-7 !w-7"
                    aria-label={t("editor.removeVideo")}
                    onClick={() => set("location", v.location.replace(/\S*\/meet\/[a-z0-9-]{3,64}\S*/, "").trim())}
                  >
                    <X size={14} aria-hidden />
                  </button>
                </span>
              ) : (
                <button type="button" className={`${BTN} h-9 shrink-0`} onClick={() => set("location", `${window.location.origin}/meet/${generateRoomCode()}`)}>
                  <Video size={14} aria-hidden />
                  {t("editor.addVideo")}
                </button>
              )}
            </div>
          </Field>

          <Field icon={<CalendarDays size={16} aria-hidden />}>
            <select
              value={currentKey}
              onChange={(e) => {
                const c = calendars.find((x) => x.key === e.target.value);
                if (c) setV((p) => ({ ...p, calendarId: c.id, accountId: c.accountId }));
              }}
              className={FIELD}
              aria-label={t("editor.calendar")}
            >
              {writable.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.owner ? `${c.name} (${c.owner})` : c.name}
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

/** Contacts matching the last typed guest token, from the mail autocomplete endpoint (debounced). */
function useContactSuggestions(text: string): { name: string; email: string }[] {
  const [list, setList] = useState<{ name: string; email: string }[]>([]);
  const q = text.split(/[,;]/).pop()?.trim() ?? "";
  useEffect(() => {
    if (q.length < 2 || q.length > 100) {
      setList([]);
      return;
    }
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      fetch(`/api/contacts/suggest?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : []))
        .then((data: unknown) => {
          if (!Array.isArray(data)) return;
          setList(
            data
              .filter((c): c is { name: string; email: string } => !!c && typeof c.email === "string")
              .map((c) => ({ name: typeof c.name === "string" ? c.name : "", email: c.email.toLowerCase() })),
          );
        })
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [q]);
  return list;
}

const FT_FROM = 7 * 60;
const FT_TO = 21 * 60;
const FT_SPAN = FT_TO - FT_FROM;

/** Guests' (and my) busy times on the event's day, with the proposed slot; click to move it. */
function FindTime({
  input,
  tz,
  locale,
  myEmail,
  onPick,
}: {
  input: EventInput;
  tz: string;
  locale: string;
  myEmail: string;
  onPick: (time: string) => void;
}) {
  const t = useTranslations("calendar");
  const principals = usePrincipals();
  const me = myEmail.toLowerCase();
  const rows = useMemo(() => {
    const byEmail = new Map((principals ?? []).filter((p) => p.email).map((p) => [p.email, p]));
    return [me, ...input.guests.map((g) => g.email).filter((e) => e !== me)].map((email) => ({
      email,
      label: email === me ? t("findTime.you") : byEmail.get(email)?.name || email,
      principal: byEmail.get(email) ?? null,
    }));
  }, [principals, input.guests, me, t]);

  const dayStart = zonedToUtc(`${input.startDate}T00:00:00`, tz);
  const dayEnd = zonedToUtc(`${addDays(input.startDate, 1)}T00:00:00`, tz);
  const ids = rows.flatMap((r) => (r.principal ? [r.principal.id] : []));
  const availability = useAvailability(ids, dayStart, dayEnd);

  const slotStart = toMin(input.startDate, input.startTime) - keyToUtc(input.startDate) / 60_000;
  const slotEnd = toMin(input.endDate, input.endTime) - keyToUtc(input.startDate) / 60_000;
  const pct = (m: number) => `${((Math.min(Math.max(m, FT_FROM), FT_TO) - FT_FROM) / FT_SPAN) * 100}%`;
  const minOf = (ms: number) => (ms <= dayStart ? 0 : ms >= dayEnd ? 1440 : zonedParts(ms, tz).minutes);
  const hourFmt = fmt(locale, { hour: "numeric", timeZone: "UTC" });

  function pick(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const m = FT_FROM + ((e.clientX - r.left) / r.width) * FT_SPAN;
    const snapped = Math.min(FT_TO - 15, Math.max(FT_FROM, Math.round(m / 15) * 15));
    onPick(minutesToHHMM(snapped));
  }

  return (
    <div className="mt-2 rounded-md border border-line p-3">
      <div className="mb-1 flex text-[10px] text-ink-mute tabular-nums" style={{ paddingLeft: 112 }}>
        <div className="relative h-3 flex-1">
          {Array.from({ length: FT_SPAN / 120 + 1 }, (_, i) => FT_FROM + i * 120).map((m) => (
            <span key={m} className="absolute -translate-x-1/2" style={{ left: pct(m) }}>
              {hourFmt.format(new Date(Date.UTC(2020, 0, 1, m / 60)))}
            </span>
          ))}
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((row, i) => {
          const blocks = row.principal ? (availability[row.principal.id] ?? []) : [];
          const color = PEOPLE_COLORS[i % PEOPLE_COLORS.length];
          return (
            <li key={row.email} className="flex items-center gap-2">
              <span className="w-[104px] shrink-0 truncate text-[12px] text-ink-soft" title={row.email}>
                {row.label}
              </span>
              <div
                className="relative h-6 flex-1 cursor-pointer overflow-hidden rounded-[4px] bg-sheet-muted"
                onClick={pick}
                title={t("findTime.pickHint")}
              >
                {!row.principal && (
                  <span className="absolute inset-0 grid place-items-center text-[11px] text-ink-mute">{t("findTime.noInfo")}</span>
                )}
                {blocks.map((b, j) => {
                  const s = minOf(b.start);
                  const e = minOf(b.end);
                  if (e <= FT_FROM || s >= FT_TO) return null;
                  return (
                    <span
                      key={j}
                      className="pointer-events-none absolute inset-y-0 border"
                      style={{ ...busyStyle(color), left: pct(s), right: `calc(100% - ${pct(e)})` }}
                    />
                  );
                })}
                <span
                  className="pointer-events-none absolute inset-y-0 border-2"
                  style={{ left: pct(slotStart), right: `calc(100% - ${pct(slotEnd)})`, borderColor: "var(--color-app-calendar)" }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] text-ink-mute">{t("findTime.pickHint")}</p>
    </div>
  );
}
