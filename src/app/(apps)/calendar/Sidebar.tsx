"use client";

import { Check, ChevronLeft, ChevronRight, Plus, Settings2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import type { Calendar } from "@/lib/calendar";
import { Combobox, principalItem, usePrincipalMatches, usePrincipals } from "./people";
import { fmtDay, PEOPLE_COLORS, PEOPLE_MAX, type Person } from "./shared";
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

function CalendarRow({
  c,
  on,
  onToggle,
  onEdit,
}: {
  c: Calendar;
  on: boolean;
  onToggle: () => void;
  onEdit?: () => void;
}) {
  const t = useTranslations("calendar");
  return (
    <div className="group flex h-8 items-center rounded-md transition-colors hover:bg-hover">
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        onClick={onToggle}
        className="flex h-full min-w-0 flex-1 items-center gap-3 px-3 text-left text-[14px] text-ink-soft group-hover:text-ink"
      >
        <span
          className="grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border"
          style={{ background: on ? c.color : "transparent", borderColor: c.color }}
        >
          {on && <Check size={11} strokeWidth={3} color="#fff" aria-hidden />}
        </span>
        <span className="flex-1 truncate">{c.name}</span>
      </button>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={t("manage.settingsFor", { name: c.name })}
          title={t("manage.settings")}
          className="icon-btn !h-7 !w-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Settings2 size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

const SECTION = "mb-1 flex h-7 items-center justify-between pr-1 pl-3 text-[11px] font-medium tracking-wide text-ink-mute uppercase";

export function CalendarList({
  calendars,
  hidden,
  onToggle,
  onCreate,
  onEdit,
}: {
  calendars: Calendar[];
  hidden: Set<string>;
  onToggle: (c: Calendar) => void;
  onCreate: () => void;
  onEdit: (c: Calendar) => void;
}) {
  const t = useTranslations("calendar");
  const mine = calendars.filter((c) => c.owner === null);
  const others = useMemo(() => {
    const groups = new Map<string, Calendar[]>();
    for (const c of calendars) if (c.owner !== null) groups.set(c.owner, [...(groups.get(c.owner) ?? []), c]);
    return [...groups.entries()];
  }, [calendars]);

  return (
    <>
      <nav aria-label={t("calendars")} className="mb-4 flex flex-col gap-0.5">
        <h2 className={SECTION}>
          {t("calendars")}
          <button type="button" className="icon-btn !h-7 !w-7" aria-label={t("manage.newTitle")} title={t("manage.newTitle")} onClick={onCreate}>
            <Plus size={15} aria-hidden />
          </button>
        </h2>
        {mine.map((c) => (
          <CalendarRow key={c.key} c={c} on={!hidden.has(c.key)} onToggle={() => onToggle(c)} onEdit={() => onEdit(c)} />
        ))}
      </nav>
      {others.length > 0 && (
        <nav aria-label={t("otherCalendars")} className="mb-4 flex flex-col gap-0.5">
          <h2 className={SECTION}>{t("otherCalendars")}</h2>
          {others.map(([owner, list]) => (
            <div key={owner} className="flex flex-col gap-0.5">
              <p className="truncate px-3 pt-1 text-[12px] text-ink-mute" title={owner}>
                {owner}
              </p>
              {list.map((c) => (
                <CalendarRow key={c.key} c={c} on={!hidden.has(c.key)} onToggle={() => onToggle(c)} />
              ))}
            </div>
          ))}
        </nav>
      )}
    </>
  );
}

/** "Search for people": overlay colleagues' busy times on the week/day view. */
export function PeoplePanel({
  people,
  myEmail,
  onAdd,
  onRemove,
}: {
  people: Person[];
  myEmail: string;
  onAdd: (p: Person) => void;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations("calendar");
  const principals = usePrincipals();
  const [q, setQ] = useState("");
  const exclude = useMemo(() => {
    const me = principals?.filter((p) => p.email === myEmail.toLowerCase()).map((p) => p.id) ?? [];
    return new Set([...people.map((p) => p.id), ...me]);
  }, [people, principals, myEmail]);
  const found = usePrincipalMatches(principals, q, { exclude });
  const full = people.length >= PEOPLE_MAX;

  return (
    <section aria-label={t("people.title")} className="mb-4 flex flex-col gap-1.5 pr-1 pl-2">
      <h2 className={`${SECTION} !mb-0 !pl-1`}>{t("people.title")}</h2>
      <Combobox
        value={q}
        onChange={setQ}
        items={full ? [] : found.map(principalItem)}
        onPick={(it) => {
          const p = principals?.find((x) => x.id === it.key);
          if (p) onAdd({ id: p.id, name: p.name, email: p.email });
          setQ("");
        }}
        placeholder={principals && principals.length === 0 ? t("people.unavailable") : t("people.search")}
        label={t("people.search")}
        inputClass="h-8 text-[13px]"
      />
      {people.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 pt-1">
          {people.map((p, i) => {
            const color = PEOPLE_COLORS[i % PEOPLE_COLORS.length];
            return (
              <li
                key={p.id}
                className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border pr-0.5 pl-2.5 text-[12px] text-ink"
                style={{ borderColor: `color-mix(in oklab, ${color} 50%, transparent)`, background: `color-mix(in oklab, ${color} 10%, var(--color-sheet))` }}
                title={p.email}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                <span className="truncate">{p.name || p.email}</span>
                <button type="button" className="icon-btn !h-6 !w-6" aria-label={t("people.remove", { name: p.name || p.email })} onClick={() => onRemove(p.id)}>
                  <X size={12} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {people.length > 0 && <p className="text-[11px] text-ink-mute">{t("people.hint")}</p>}
    </section>
  );
}
