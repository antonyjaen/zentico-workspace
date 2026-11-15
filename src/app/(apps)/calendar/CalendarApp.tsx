"use client";

import { ChevronLeft, ChevronRight, Loader2, Plus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { CalEvent, Calendar } from "@/lib/calendar";
import { deleteEvent, loadEvent, moveEvent, respond, saveEvent, setCalendarVisible, shiftEventDays, type EventInput } from "./actions";
import { Agenda } from "./Agenda";
import { CalendarDialog } from "./CalendarDialog";
import { EventEditor, type EditorState } from "./EventEditor";
import { MonthGrid } from "./MonthGrid";
import { EventDetails, QuickCreate } from "./Popovers";
import { useAvailability } from "./people";
import { BTN, defaultSlot, eventToInput, fmt, fmtDay, PEOPLE_COLORS, PEOPLE_MAX, savePeople, slotToInput, type Anchor, type Person, type Slot } from "./shared";
import { CalendarList, MiniMonth, PeoplePanel } from "./Sidebar";
import { TimeGrid, type BusyOverlay } from "./TimeGrid";
import { addDays, DAY_MS, daysBetween, keyToUtc, shiftDate, TZ_COOKIE, VIEWS, viewRange, zonedParts, zonedToUtc, type View } from "./time";

type Props = {
  calendars: Calendar[];
  events: CalEvent[];
  expanded: boolean;
  view: View;
  date: string;
  tz: string;
  tzFromCookie: boolean;
  weekStart: number;
  people: Person[];
  myEmail: string;
};

type Override = Pick<CalEvent, "utcStart" | "utcEnd" | "startDay" | "endDay">;

export function CalendarApp({ calendars, events, expanded, view, date, tz, tzFromCookie, weekStart, people: initialPeople, myEmail }: Props) {
  const t = useTranslations("calendar");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Hidden (not visible) calendar keys: calendars created later show up by default.
  const [hidden, setHidden] = useState(() => new Set(calendars.filter((c) => !c.isVisible).map((c) => c.key)));
  const [manage, setManage] = useState<{ calendar: Calendar | null } | null>(null);
  const [people, setPeople] = useState<Person[]>(initialPeople);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [quick, setQuick] = useState<{ slot: Slot; anchor: Anchor } | null>(null);
  const [details, setDetails] = useState<{ ev: CalEvent; anchor: Anchor } | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);

  // Fresh server data replaces optimistic moves.
  useEffect(() => setOverrides({}), [events]);

  useEffect(() => {
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(i);
  }, []);

  // Render in the browser's time zone: remember it in a cookie the server reads.
  useEffect(() => {
    let browser = "";
    try {
      browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {}
    if (!browser) return;
    if (!tzFromCookie || browser !== tz) {
      document.cookie = `${TZ_COOKIE}=${encodeURIComponent(browser)}; path=/; max-age=31536000; samesite=lax`;
      if (browser !== tz) router.refresh();
    }
  }, [tz, tzFromCookie, router]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const todayKey = zonedParts(now ?? Date.now(), tz).key;
  const range = viewRange(view, date, weekStart);
  const days = useMemo(() => daysBetween(range.start, range.end), [range.start, range.end]);
  const byKey = useMemo(() => new Map(calendars.map((c) => [c.key, c])), [calendars]);
  const mine = calendars.filter((c) => c.owner === null);
  const defaultCalendar = mine.find((c) => c.mayWrite && c.isDefault) ?? mine.find((c) => c.mayWrite) ?? calendars.find((c) => c.mayWrite);

  const shown = useMemo(
    () =>
      events
        .filter((e) => !hidden.has(e.calKey))
        .map((e) => (overrides[e.id] ? { ...e, ...overrides[e.id] } : e)),
    [events, hidden, overrides],
  );

  const colorOf = useCallback((ev: CalEvent) => byKey.get(ev.calKey)?.color ?? "var(--color-app-calendar)", [byKey]);
  const canEdit = useCallback((ev: CalEvent) => ev.isOrganizer && byKey.get(ev.calKey)?.mayWrite === true, [byKey]);

  // Colleagues' busy blocks over the week/day view.
  const rangeStartMs = zonedToUtc(`${range.start}T00:00:00`, tz);
  const rangeEndMs = zonedToUtc(`${range.end}T00:00:00`, tz);
  const timeView = view === "day" || view === "week";
  const availability = useAvailability(timeView ? people.map((p) => p.id) : [], rangeStartMs, rangeEndMs);
  const busy = useMemo<BusyOverlay[]>(
    () =>
      people.flatMap((p, i) =>
        (availability[p.id] ?? []).map((b, j) => ({
          key: `${p.id}:${j}`,
          start: b.start,
          end: b.end,
          color: PEOPLE_COLORS[i % PEOPLE_COLORS.length],
          name: p.name || p.email,
          tentative: b.status === "tentative",
        })),
      ),
    [people, availability],
  );

  function updatePeople(next: Person[]) {
    setPeople(next);
    savePeople(next);
  }
  const canDrag = useCallback((ev: CalEvent) => canEdit(ev) && ev.recurrence === "none" && !ev.isInstance, [canEdit]);

  const go = useCallback(
    (v: View, d: string) => startTransition(() => router.push(`/calendar?view=${v}&date=${d}`)),
    [router],
  );

  const fail = useCallback((key: string) => setToast(t(`errors.${key}`)), [t]);

  // ---- Mutations ----

  async function onMove(ev: CalEvent, start: number, end: number) {
    setOverrides((o) => ({ ...o, [ev.id]: { utcStart: start, utcEnd: end, startDay: ev.startDay, endDay: ev.endDay } }));
    const r = await moveEvent(ev.baseId, start, end, tz, ev.accountId);
    if (!r.ok) {
      setOverrides(({ [ev.id]: _, ...rest }) => rest);
      fail("move");
    }
  }

  async function onShiftDays(ev: CalEvent, n: number) {
    setOverrides((o) => ({
      ...o,
      [ev.id]: {
        utcStart: ev.utcStart + n * DAY_MS,
        utcEnd: ev.utcEnd + n * DAY_MS,
        startDay: addDays(ev.startDay, n),
        endDay: addDays(ev.endDay, n),
      },
    }));
    const r = await shiftEventDays(ev.baseId, n, ev.accountId);
    if (!r.ok) {
      setOverrides(({ [ev.id]: _, ...rest }) => rest);
      fail("move");
    }
  }

  async function onSave(id: string | null, input: EventInput): Promise<string | null> {
    const r = await saveEvent(id, input);
    if (!r.ok) return t("errors.save");
    setEditor(null);
    setQuick(null);
    return null;
  }

  async function onDelete(ev: { baseId: string; accountId?: string; recurrence: string; isInstance: boolean }) {
    const series = ev.recurrence !== "none" || ev.isInstance;
    if (!window.confirm(series ? t("confirmDeleteSeries") : t("confirmDelete"))) return;
    setDetails(null);
    setEditor(null);
    const r = await deleteEvent(ev.baseId, ev.accountId);
    if (!r.ok) fail("delete");
  }

  async function onRespond(ev: CalEvent, status: "accepted" | "tentative" | "declined") {
    setDetails((d) => (d ? { ...d, ev: { ...d.ev, myStatus: status } } : d));
    const r = await respond(ev.baseId, status, ev.accountId);
    if (!r.ok) fail("rsvp");
  }

  async function onToggleCalendar(c: Calendar) {
    const on = hidden.has(c.key);
    setHidden((s) => {
      const n = new Set(s);
      if (on) n.delete(c.key);
      else n.add(c.key);
      return n;
    });
    // Persisting is best-effort; the local toggle already applies.
    await setCalendarVisible(c.id, on, c.accountId);
  }

  async function openEditor(ev: CalEvent) {
    setDetails(null);
    let source = ev;
    if (ev.baseId !== ev.id) {
      const r = await loadEvent(ev.baseId, tz, ev.accountId);
      if (!r.ok || !r.data) return fail("generic");
      source = r.data;
    }
    setEditor({
      id: source.baseId,
      input: eventToInput(source, tz),
      participants: source.participants,
      isSeries: source.recurrence !== "none",
    });
  }

  function openCreate(slot: Slot, title = "", calendar = defaultCalendar) {
    setQuick(null);
    setEditor({ id: null, input: { ...slotToInput(slot, tz, calendar), title }, participants: [], isSeries: false });
  }

  const onCreateSlot = useCallback(
    (slot: Slot, anchor: Anchor) => {
      if (!defaultCalendar) return;
      setDetails(null);
      setQuick({ slot, anchor });
    },
    [defaultCalendar],
  );
  const onOpen = useCallback((ev: CalEvent, anchor: Anchor) => {
    setQuick(null);
    setDetails({ ev, anchor });
  }, []);
  const onPickDay = useCallback((d: string) => go("day", d), [go]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || editor || quick) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true]")) return;
      const map: Record<string, () => void> = {
        t: () => go(view, todayKey),
        d: () => go("day", date),
        w: () => go("week", date),
        m: () => go("month", date),
        a: () => go("agenda", date),
        j: () => go(view, shiftDate(view, date, 1)),
        n: () => go(view, shiftDate(view, date, 1)),
        k: () => go(view, shiftDate(view, date, -1)),
        p: () => go(view, shiftDate(view, date, -1)),
        c: () => defaultCalendar && openCreate(defaultSlot(tz)),
      };
      const fn = map[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // ---- Title ----
  const title = (() => {
    if (view === "day") return fmtDay(locale, date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    if (view === "month") return fmtDay(locale, date, { month: "long", year: "numeric" });
    const last = addDays(range.end, -1);
    const opts: Intl.DateTimeFormatOptions =
      view === "week" ? { month: "long", year: "numeric", timeZone: "UTC" } : { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
    return fmt(locale, opts).formatRange(new Date(keyToUtc(range.start)), new Date(keyToUtc(last)));
  })();

  const ghost = quick?.slot ?? null;

  return (
    <>
      <aside className="hidden w-[248px] shrink-0 flex-col pl-2 lg:flex">
        <button
          type="button"
          disabled={!defaultCalendar}
          onClick={() => openCreate(defaultSlot(tz))}
          className="mb-4 ml-1 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors duration-150 hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus size={16} aria-hidden />
          {t("create")}
        </button>
        <MiniMonth
          key={date}
          date={date}
          range={range}
          todayKey={todayKey}
          locale={locale}
          weekStart={weekStart}
          onPick={(d) => go(view === "agenda" ? "agenda" : view, d)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <CalendarList
            calendars={calendars}
            hidden={hidden}
            onToggle={onToggleCalendar}
            onCreate={() => setManage({ calendar: null })}
            onEdit={(c) => setManage({ calendar: c })}
          />
          <PeoplePanel
            people={people}
            myEmail={myEmail}
            onAdd={(p) => updatePeople([...people.filter((x) => x.id !== p.id), p].slice(-PEOPLE_MAX))}
            onRemove={(id) => updatePeople(people.filter((p) => p.id !== id))}
          />
        </div>
      </aside>

      <main className="sheet relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-line px-3">
          <button
            type="button"
            className="icon-btn lg:hidden"
            aria-label={t("create")}
            disabled={!defaultCalendar}
            onClick={() => openCreate(defaultSlot(tz))}
          >
            <Plus size={18} aria-hidden />
          </button>
          <button type="button" className={BTN} onClick={() => go(view, todayKey)} title="T">
            {t("today")}
          </button>
          <button type="button" className="icon-btn" aria-label={t("prev")} title="K" onClick={() => go(view, shiftDate(view, date, -1))}>
            <ChevronLeft size={18} aria-hidden />
          </button>
          <button type="button" className="icon-btn" aria-label={t("next")} title="J" onClick={() => go(view, shiftDate(view, date, 1))}>
            <ChevronRight size={18} aria-hidden />
          </button>
          <h1 className="ml-1 min-w-0 truncate text-[17px] font-semibold tracking-tight text-ink first-letter:uppercase">{title}</h1>
          {pending && <Loader2 size={15} aria-hidden className="shrink-0 animate-spin text-ink-mute" />}
          {!expanded && (
            <span className="hidden shrink-0 text-[12px] text-ink-mute xl:inline" title={t("notExpandedHint")}>
              {t("notExpanded")}
            </span>
          )}
          <div role="group" aria-label={t("viewLabel")} className="ml-auto inline-flex shrink-0 rounded-lg border border-line p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => go(v, date)}
                title={v[0].toUpperCase()}
                className="h-7 rounded-md px-2.5 text-[13px] font-medium text-ink-soft transition-colors hover:text-ink aria-pressed:bg-primary-soft aria-pressed:text-ink sm:px-3"
              >
                {t(`views.${v}`)}
              </button>
            ))}
          </div>
        </header>

        {view === "month" ? (
          <MonthGrid
            days={days}
            month={date}
            events={shown}
            tz={tz}
            locale={locale}
            todayKey={todayKey}
            colorOf={colorOf}
            canDrag={canDrag}
            onCreate={onCreateSlot}
            onOpen={onOpen}
            onShiftDays={onShiftDays}
            onPickDay={onPickDay}
          />
        ) : view === "agenda" ? (
          <Agenda days={days} events={shown} tz={tz} locale={locale} todayKey={todayKey} colorOf={colorOf} onOpen={onOpen} onPickDay={onPickDay} />
        ) : (
          <TimeGrid
            days={days}
            events={shown}
            tz={tz}
            locale={locale}
            todayKey={todayKey}
            now={now}
            ghost={ghost}
            busy={busy}
            colorOf={colorOf}
            canDrag={canDrag}
            onCreate={onCreateSlot}
            onOpen={onOpen}
            onMove={onMove}
            onShiftDays={onShiftDays}
            onPickDay={onPickDay}
          />
        )}

        {toast && (
          <div role="status" className="pop absolute bottom-4 left-1/2 z-30 -translate-x-1/2 px-4 py-2.5 text-[13px] text-ink">
            {toast}
          </div>
        )}
      </main>

      {quick && (
        <QuickCreate
          anchor={quick.anchor}
          slot={quick.slot}
          calendars={calendars}
          tz={tz}
          locale={locale}
          onClose={() => setQuick(null)}
          onSave={async (title, key) => {
            const err = await onSave(null, { ...slotToInput(quick.slot, tz, byKey.get(key)), title });
            if (err) setToast(err);
          }}
          onMore={(title, key) => openCreate(quick.slot, title, byKey.get(key))}
        />
      )}

      {details && (
        <EventDetails
          ev={details.ev}
          anchor={details.anchor}
          calendar={byKey.get(details.ev.calKey)}
          tz={tz}
          locale={locale}
          canEdit={canEdit(details.ev)}
          canDelete={byKey.get(details.ev.calKey)?.mayWrite === true}
          onClose={() => setDetails(null)}
          onEdit={() => openEditor(details.ev)}
          onDelete={() => onDelete(details.ev)}
          onRespond={(s) => onRespond(details.ev, s)}
        />
      )}

      {editor && (
        <EventEditor
          state={editor}
          calendars={calendars}
          tz={tz}
          locale={locale}
          myEmail={myEmail}
          onClose={() => setEditor(null)}
          onSave={onSave}
          onDelete={() =>
            onDelete({
              baseId: editor.id!,
              accountId: editor.input.accountId,
              recurrence: editor.isSeries ? "series" : "none",
              isInstance: false,
            })
          }
        />
      )}

      {manage && <CalendarDialog calendar={manage.calendar} myEmail={myEmail} onClose={() => setManage(null)} />}
    </>
  );
}
