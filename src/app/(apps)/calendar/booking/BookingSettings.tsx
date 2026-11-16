"use client";

import { Check, Copy, ExternalLink, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  bookingPath,
  defaultSettings,
  DURATION_CHOICES,
  LOCATION_KINDS,
  QUESTION_TYPES,
  slugify,
  type BookingType,
  type BookingTypeSettings,
  type TimeRange,
} from "@/lib/booking/types";
import {
  deleteTypeAction,
  disableBookingAction,
  enableBookingAction,
  saveProfileAction,
  saveTypeAction,
  setTypeActiveAction,
} from "./actions";

export type CalendarOption = { key: string; name: string; color: string; own: boolean; mayWrite: boolean; isDefault: boolean };
export type UpcomingView = { id: string; start: number; end: number; guest: string; title: string };

const CARD = "rounded-xl border border-line p-5";
const H2 = "text-[15px] font-medium text-ink";
const INPUT =
  "h-9 w-full rounded-lg border border-line bg-sheet px-2.5 text-[13.5px] text-ink outline-none transition-colors hover:border-line-strong focus:border-ink-mute";
const BTN = "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13.5px] font-medium transition-colors disabled:opacity-50";
const PRIMARY = `${BTN} bg-primary text-primary-ink hover:bg-primary-hover`;
const SECONDARY = `${BTN} border border-line text-ink-soft hover:bg-hover hover:text-ink`;
const LABEL = "flex flex-col gap-1 text-[12.5px] font-medium text-ink-soft";
const SETUP_URL = "/api/auth/login?mcp=1&returnTo=%2Fcalendar%2Fbooking";

export function BookingSettings({
  appUrl,
  enabled,
  needsReauth,
  host,
  types,
  calendars,
  upcoming,
  defaultZone,
  authReturn,
}: {
  appUrl: string;
  enabled: boolean;
  needsReauth: boolean;
  host: { handle: string; showEmail: boolean } | null;
  types: BookingType[];
  calendars: CalendarOption[];
  upcoming: UpcomingView[];
  defaultZone: string;
  authReturn: "ok" | "error" | null;
}) {
  const t = useTranslations("booking.settings");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(authReturn === "error" ? "failed" : null);
  const [editing, setEditing] = useState<BookingType | "new" | null>(null);
  const tried = useRef(false);

  const enable = (fromSetup: boolean) =>
    start(async () => {
      setError(null);
      const r = await enableBookingAction();
      if (r.ok) return router.replace("/calendar/booking");
      // The session can't create API keys: one-off authorization, then back here (?mcp=ok).
      if (r.error === "authorize" && !fromSetup) return window.location.assign(SETUP_URL);
      setError(r.error === "authorize" ? "not_allowed" : r.error);
    });

  useEffect(() => {
    if (authReturn === "ok" && !enabled && !tried.current) {
      tried.current = true;
      enable(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReturn, enabled]);

  if (!enabled || !host) {
    return (
      <section className={CARD}>
        <h2 className={H2}>{needsReauth ? t("reconnectTitle") : t("introTitle")}</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">{needsReauth ? t("reconnectBody") : t("introBody")}</p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-mute">{t("keyNote")}</p>
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            {t(`errors.${error}` as "errors.failed")}
          </p>
        )}
        <button type="button" className={`${PRIMARY} mt-4`} disabled={pending} onClick={() => enable(false)}>
          {pending && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {needsReauth ? t("reconnect") : t("enable")}
        </button>
      </section>
    );
  }

  if (editing) {
    const own = calendars.filter((c) => c.own && c.mayWrite);
    const firstCal = (own.find((c) => c.isDefault) ?? own[0])?.key ?? "";
    return (
      <TypeEditor
        initial={editing === "new" ? { ...defaultSettings(defaultZone, firstCal) } : editing}
        id={editing === "new" ? null : editing.id}
        calendars={calendars}
        onDone={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Profile appUrl={appUrl} host={host} />

      <section className={CARD}>
        <div className="flex items-center justify-between gap-3">
          <h2 className={H2}>{t("pages")}</h2>
          <button type="button" className={PRIMARY} onClick={() => setEditing("new")}>
            <Plus size={15} aria-hidden /> {t("newPage")}
          </button>
        </div>
        {types.length === 0 ? (
          <p className="mt-3 text-[13.5px] text-ink-mute">{t("noPages")}</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {types.map((x) => (
              <TypeRow key={x.id} type={x} url={`${appUrl}${bookingPath(host.handle, x.slug)}`} onEdit={() => setEditing(x)} />
            ))}
          </ul>
        )}
      </section>

      <Upcoming list={upcoming} />

      <section className={CARD}>
        <h2 className={H2}>{t("disableTitle")}</h2>
        <p className="mt-1 text-[13px] text-ink-soft">{t("disableBody")}</p>
        <button
          type="button"
          className={`${SECONDARY} mt-3 !text-danger`}
          disabled={pending}
          onClick={() => {
            if (!confirm(t("disableConfirm"))) return;
            start(async () => {
              await disableBookingAction();
              router.refresh();
            });
          }}
        >
          {t("disable")}
        </button>
      </section>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const t = useTranslations("booking.settings");
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn h-8 w-8"
      aria-label={t("copyLink")}
      title={t("copyLink")}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
    </button>
  );
}

function Profile({ appUrl, host }: { appUrl: string; host: { handle: string; showEmail: boolean } }) {
  const t = useTranslations("booking.settings");
  const router = useRouter();
  const [handle, setHandle] = useState(host.handle);
  const [showEmail, setShowEmail] = useState(host.showEmail);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = handle !== host.handle || showEmail !== host.showEmail;
  const url = `${appUrl}${bookingPath(host.handle)}`;
  return (
    <section className={CARD}>
      <h2 className={H2}>{t("profile")}</h2>
      <div className="mt-3 flex items-center gap-1 text-[13px] text-ink-soft">
        <span className="truncate">{url}</span>
        <CopyButton text={url} />
        <a href={bookingPath(host.handle)} target="_blank" rel="noopener" className="icon-btn h-8 w-8" aria-label={t("preview")} title={t("preview")}>
          <ExternalLink size={15} aria-hidden />
        </a>
      </div>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await saveProfileAction({ handle, showEmail });
            setError(r.ok ? null : r.error);
            if (r.ok) router.refresh();
          });
        }}
      >
        <label className={`${LABEL} w-56`}>
          {t("handle")}
          <input value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} maxLength={32} pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]" className={INPUT} />
        </label>
        <label className="flex h-9 items-center gap-2 text-[13px] text-ink-soft">
          <input type="checkbox" checked={showEmail} onChange={(e) => setShowEmail(e.target.checked)} />
          {t("showEmail")}
        </label>
        <button type="submit" className={PRIMARY} disabled={!dirty || pending}>
          {t("save")}
        </button>
      </form>
      <p className="mt-2 text-[12px] text-ink-mute">{t("handleHint")}</p>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {t(`errors.${error}` as "errors.failed")}
        </p>
      )}
    </section>
  );
}

function TypeRow({ type, url, onEdit }: { type: BookingType; url: string; onEdit: () => void }) {
  const t = useTranslations("booking.settings");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className={`truncate text-[14px] font-medium ${type.active ? "text-ink" : "text-ink-mute"}`}>{type.title}</p>
        <p className="truncate text-[12.5px] text-ink-mute">
          {type.durations.map((d) => t("minutes", { n: d })).join(" · ")} · {t(`location.${type.location.kind}`)} · /{type.slug}
        </p>
      </div>
      <label className="flex items-center gap-1.5 text-[12.5px] text-ink-soft">
        <input
          type="checkbox"
          checked={type.active}
          disabled={pending}
          onChange={(e) => {
            const v = e.target.checked;
            start(async () => {
              await setTypeActiveAction(type.id, v);
              router.refresh();
            });
          }}
        />
        {t("active")}
      </label>
      <CopyButton text={url} />
      <a href={url} target="_blank" rel="noopener" className="icon-btn h-8 w-8" aria-label={t("preview")} title={t("preview")}>
        <ExternalLink size={15} aria-hidden />
      </a>
      <button type="button" className="icon-btn h-8 w-8" aria-label={t("edit")} title={t("edit")} onClick={onEdit}>
        <Pencil size={15} aria-hidden />
      </button>
      <button
        type="button"
        className="icon-btn h-8 w-8"
        aria-label={t("delete")}
        title={t("delete")}
        disabled={pending}
        onClick={() => {
          if (!confirm(t("deleteConfirm", { title: type.title }))) return;
          start(async () => {
            await deleteTypeAction(type.id);
            router.refresh();
          });
        }}
      >
        <Trash2 size={15} aria-hidden />
      </button>
    </li>
  );
}

function Upcoming({ list }: { list: UpcomingView[] }) {
  const t = useTranslations("booking.settings");
  const locale = useLocale();
  const fmt = new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-ES", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <section className={CARD}>
      <h2 className={H2}>{t("upcoming")}</h2>
      {list.length === 0 ? (
        <p className="mt-2 text-[13.5px] text-ink-mute">{t("noUpcoming")}</p>
      ) : (
        <ul className="mt-2 divide-y divide-line text-[13.5px]">
          {list.map((b) => (
            <li key={b.id} className="flex flex-wrap gap-x-3 py-2">
              <span className="w-44 shrink-0 tabular-nums text-ink">{fmt.format(b.start)}</span>
              <span className="min-w-0 flex-1 truncate text-ink-soft">
                {b.title} · {b.guest}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ editor */

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function zones(current: string): string[] {
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf("timeZone");
  } catch {
    list = [];
  }
  return list.includes(current) ? list : [current, ...list];
}

function Ranges({ value, onChange, label }: { value: TimeRange[]; onChange: (v: TimeRange[]) => void; label: string }) {
  const t = useTranslations("booking.settings");
  return (
    <div className="flex flex-col gap-1.5">
      {value.length === 0 && <span className="text-[13px] text-ink-mute">{t("unavailable")}</span>}
      {value.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input type="time" aria-label={`${label} ${t("from")}`} value={r.start} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} className={`${INPUT} !w-28`} />
          <span className="text-ink-mute">–</span>
          <input type="time" aria-label={`${label} ${t("to")}`} value={r.end === "24:00" ? "23:59" : r.end} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, end: e.target.value === "23:59" ? "24:00" : e.target.value } : x)))} className={`${INPUT} !w-28`} />
          <button type="button" className="icon-btn h-8 w-8" aria-label={t("removeRange")} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
      {value.length < 6 && (
        <button
          type="button"
          className="w-fit text-[12.5px] font-medium text-ink-soft hover:text-ink"
          onClick={() => {
            const last = value[value.length - 1];
            onChange([...value, last && last.end < "23:00" ? { start: last.end, end: `${String(Math.min(23, +last.end.slice(0, 2) + 1)).padStart(2, "0")}:${last.end.slice(3)}` } : { start: "09:00", end: "17:00" }]);
          }}
        >
          + {t("addRange")}
        </button>
      )}
    </div>
  );
}

function TypeEditor({ initial, id, calendars, onDone }: { initial: BookingTypeSettings; id: string | null; calendars: CalendarOption[]; onDone: () => void }) {
  const t = useTranslations("booking.settings");
  const locale = useLocale();
  const [s, setS] = useState<BookingTypeSettings>(initial);
  const [slugTouched, setSlugTouched] = useState(!!id);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [overrideDay, setOverrideDay] = useState("");
  const set = <K extends keyof BookingTypeSettings>(k: K, v: BookingTypeSettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const writable = calendars.filter((c) => c.own && c.mayWrite);
  const dayName = (d: number) => new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-ES", { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2024, 0, 7 + d));

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveTypeAction(id, s);
          if (r.ok) onDone();
          else setError(r.error);
        });
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[17px] font-semibold">{id ? t("editPage") : t("newPage")}</h2>
        <button type="button" className={SECONDARY} onClick={onDone}>
          {t("cancel")}
        </button>
      </div>

      <section className={`${CARD} grid gap-4 sm:grid-cols-2`}>
        <label className={LABEL}>
          {t("fTitle")}
          <input
            required
            maxLength={120}
            value={s.title}
            onChange={(e) => {
              const title = e.target.value;
              setS((p) => ({ ...p, title, slug: slugTouched ? p.slug : slugify(title) }));
            }}
            className={INPUT}
          />
        </label>
        <label className={LABEL}>
          {t("fSlug")}
          <input
            required
            maxLength={48}
            pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
            value={s.slug}
            onChange={(e) => {
              setSlugTouched(true);
              set("slug", e.target.value.toLowerCase());
            }}
            className={INPUT}
          />
        </label>
        <label className={`${LABEL} sm:col-span-2`}>
          {t("fDescription")}
          <textarea maxLength={2000} rows={3} value={s.description} onChange={(e) => set("description", e.target.value)} className={`${INPUT} !h-auto py-2`} />
        </label>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-[12.5px] font-medium text-ink-soft">{t("fDurations")}</legend>
          <div className="flex flex-wrap gap-1.5">
            {DURATION_CHOICES.map((d) => {
              const on = s.durations.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set("durations", on ? s.durations.filter((x) => x !== d) : [...s.durations, d].sort((a, b) => a - b))}
                  className={`h-8 rounded-lg border px-2.5 text-[13px] ${on ? "border-ink bg-primary text-primary-ink" : "border-line text-ink-soft hover:bg-hover"}`}
                >
                  {t("minutes", { n: d })}
                </button>
              );
            })}
          </div>
        </fieldset>
        <label className={LABEL}>
          {t("fLocation")}
          <select value={s.location.kind} onChange={(e) => set("location", { kind: e.target.value as BookingTypeSettings["location"]["kind"], value: s.location.value })} className={INPUT}>
            {LOCATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`location.${k}`)}
              </option>
            ))}
          </select>
        </label>
        {s.location.kind !== "meet" && (
          <label className={LABEL}>
            {t(`locationValue.${s.location.kind}`)}
            <input
              maxLength={300}
              required={s.location.kind !== "phone"}
              value={s.location.value}
              onChange={(e) => set("location", { ...s.location, value: e.target.value })}
              className={INPUT}
            />
          </label>
        )}
      </section>

      <section className={CARD}>
        <h3 className={H2}>{t("availability")}</h3>
        <label className={`${LABEL} mt-3 max-w-xs`}>
          {t("fTimeZone")}
          <select value={s.timeZone} onChange={(e) => set("timeZone", e.target.value)} className={INPUT}>
            {zones(s.timeZone).map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-4 flex flex-col divide-y divide-line">
          {WEEKDAY_ORDER.map((d) => (
            <div key={d} className="flex flex-wrap items-start gap-3 py-2.5">
              <label className="flex w-32 items-center gap-2 pt-1.5 text-[13.5px] capitalize text-ink">
                <input
                  type="checkbox"
                  checked={s.weekly[d].length > 0}
                  onChange={(e) => set("weekly", s.weekly.map((r, i) => (i === d ? (e.target.checked ? [{ start: "09:00", end: "17:00" }] : []) : r)))}
                />
                {dayName(d)}
              </label>
              <Ranges label={dayName(d)} value={s.weekly[d]} onChange={(v) => set("weekly", s.weekly.map((r, i) => (i === d ? v : r)))} />
            </div>
          ))}
        </div>
        <h4 className="mt-5 text-[13.5px] font-medium">{t("overrides")}</h4>
        <p className="text-[12.5px] text-ink-mute">{t("overridesHint")}</p>
        <div className="mt-2 flex flex-col divide-y divide-line">
          {Object.entries(s.overrides).map(([day, ranges]) => (
            <div key={day} className="flex flex-wrap items-start gap-3 py-2.5">
              <div className="flex w-32 items-center gap-1 pt-1.5 text-[13.5px] tabular-nums">
                {day}
                <button
                  type="button"
                  className="icon-btn h-7 w-7"
                  aria-label={t("removeOverride")}
                  onClick={() => {
                    const next = { ...s.overrides };
                    delete next[day];
                    set("overrides", next);
                  }}
                >
                  <X size={13} aria-hidden />
                </button>
              </div>
              <Ranges label={day} value={ranges} onChange={(v) => set("overrides", { ...s.overrides, [day]: v })} />
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input type="date" value={overrideDay} onChange={(e) => setOverrideDay(e.target.value)} className={`${INPUT} !w-44`} aria-label={t("overrideDate")} />
          <button
            type="button"
            className={SECONDARY}
            disabled={!overrideDay || overrideDay in s.overrides}
            onClick={() => {
              set("overrides", { ...s.overrides, [overrideDay]: [] });
              setOverrideDay("");
            }}
          >
            {t("addOverride")}
          </button>
        </div>
      </section>

      <section className={`${CARD} grid gap-4 sm:grid-cols-3`}>
        <h3 className={`${H2} sm:col-span-3`}>{t("limits")}</h3>
        <NumberField label={t("bufferBefore")} value={s.bufferBefore} min={0} max={240} onChange={(v) => set("bufferBefore", v)} />
        <NumberField label={t("bufferAfter")} value={s.bufferAfter} min={0} max={240} onChange={(v) => set("bufferAfter", v)} />
        <NumberField label={t("minNotice")} value={Math.round(s.minNotice / 60)} min={0} max={720} onChange={(v) => set("minNotice", v * 60)} />
        <NumberField label={t("windowDays")} value={s.windowDays} min={1} max={365} onChange={(v) => set("windowDays", v)} />
        <NumberField label={t("maxPerDay")} value={s.maxPerDay} min={0} max={50} onChange={(v) => set("maxPerDay", v)} />
        <label className={LABEL}>
          {t("interval")}
          <select value={s.interval} onChange={(e) => set("interval", Number(e.target.value))} className={INPUT}>
            {[0, 10, 15, 20, 30, 45, 60, 90, 120].map((v) => (
              <option key={v} value={v}>
                {v === 0 ? t("intervalAuto") : t("minutes", { n: v })}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className={CARD}>
        <h3 className={H2}>{t("questions")}</h3>
        <p className="text-[12.5px] text-ink-mute">{t("questionsHint")}</p>
        <div className="mt-3 flex flex-col gap-2">
          {s.questions.map((q, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                required
                maxLength={200}
                value={q.label}
                aria-label={t("questionLabel")}
                placeholder={t("questionLabel")}
                onChange={(e) => set("questions", s.questions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                className={`${INPUT} !w-auto min-w-0 flex-1`}
              />
              <select
                value={q.type}
                aria-label={t("questionType")}
                onChange={(e) => set("questions", s.questions.map((x, j) => (j === i ? { ...x, type: e.target.value as typeof q.type } : x)))}
                className={`${INPUT} !w-36`}
              >
                {QUESTION_TYPES.map((k) => (
                  <option key={k} value={k}>
                    {t(`qType.${k}`)}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-[12.5px] text-ink-soft">
                <input type="checkbox" checked={q.required} onChange={(e) => set("questions", s.questions.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
                {t("required")}
              </label>
              <button type="button" className="icon-btn h-8 w-8" aria-label={t("removeQuestion")} onClick={() => set("questions", s.questions.filter((_, j) => j !== i))}>
                <X size={14} aria-hidden />
              </button>
            </div>
          ))}
          {s.questions.length < 8 && (
            <button
              type="button"
              className="w-fit text-[12.5px] font-medium text-ink-soft hover:text-ink"
              onClick={() => set("questions", [...s.questions, { id: `q${Date.now().toString(36).slice(-6)}`, label: "", type: "text", required: false }])}
            >
              + {t("addQuestion")}
            </button>
          )}
        </div>
      </section>

      <section className={`${CARD} grid gap-4 sm:grid-cols-2`}>
        <h3 className={`${H2} sm:col-span-2`}>{t("calendars")}</h3>
        <label className={LABEL}>
          {t("writeInto")}
          <select value={s.calendar} onChange={(e) => set("calendar", e.target.value)} className={INPUT} required>
            {writable.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="mb-1 text-[12.5px] font-medium text-ink-soft">{t("busyFrom")}</legend>
          <div className="flex flex-col gap-1">
            {calendars.map((c) => (
              <label key={c.key} className="flex items-center gap-2 text-[13px] text-ink-soft">
                <input
                  type="checkbox"
                  checked={s.busyCalendars.includes(c.key)}
                  onChange={(e) => set("busyCalendars", e.target.checked ? [...s.busyCalendars, c.key] : s.busyCalendars.filter((k) => k !== c.key))}
                />
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
                <span className="truncate">{c.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-[13.5px] text-ink sm:col-span-2">
          <input type="checkbox" checked={s.active} onChange={(e) => set("active", e.target.checked)} />
          {t("activeLong")}
        </label>
      </section>

      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {t.has(`errors.${error}`) ? t(`errors.${error}` as "errors.failed") : t("errors.failed")}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={PRIMARY} disabled={pending || s.durations.length === 0}>
          {pending && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t("save")}
        </button>
        <button type="button" className={SECONDARY} onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className={LABEL}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          onChange(Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min);
        }}
        className={INPUT}
      />
    </label>
  );
}
