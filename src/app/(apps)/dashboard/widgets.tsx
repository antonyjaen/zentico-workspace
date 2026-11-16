"use client";

// Built-in widget renderers. Live data comes from /api/dashboard/query (read-only queries run with
// the viewer's session); each widget loads, refreshes and fails on its own.
import { AlertCircle, CalendarDays, FileText, Folder, Loader2, Mail, MessageSquare, RotateCw, Video } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { renderMarkdown } from "@/app/(apps)/docs/md/[fileId]/markdown";
import { widgetQuery, type DataQuery, type Widget } from "./model";

/* -------------------------------------------------------------------- data */

const REFRESH_MS = 60_000;

export const viewerTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
};

export async function fetchQuery(name: DataQuery, args: unknown): Promise<unknown> {
  const res = await fetch("/api/dashboard/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: name, args, timeZone: viewerTimeZone() }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { data?: unknown; error?: string };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.data;
}

type DataState<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

/** Loads a query, refreshes it every minute while the tab is visible, and when it becomes visible. */
export function useQuery<T>(name: DataQuery | null, args: unknown, refreshKey = 0): DataState<T> {
  const key = name ? `${name}:${JSON.stringify(args)}` : "";
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!name });
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!name) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    fetchQuery(name, args).then(
      (data) => mine === seq.current && setState({ data: data as T, error: null, loading: false }),
      (e: unknown) => mine === seq.current && setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e), loading: false })),
    );
    // `key` covers name + args.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    load();
    const timer = setInterval(() => document.visibilityState === "visible" && load(), REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, refreshKey]);

  return { ...state, reload: load };
}

/* ------------------------------------------------------------------ helpers */

export function useWhen() {
  const locale = useLocale();
  return useMemo(() => {
    const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
    const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
    return (value: string | number | null | undefined) => {
      if (value == null || value === "") return "";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "";
      return d.toDateString() === new Date().toDateString() ? time.format(d) : day.format(d);
    };
  }, [locale]);
}

export function State({ loading, error, empty, onRetry, children }: { loading: boolean; error: string | null; empty: boolean; onRetry: () => void; children: ReactNode }) {
  const t = useTranslations("dashboard.widget");
  if (error && empty) {
    return (
      <div className="grid h-full place-items-center p-4 text-center">
        <div className="flex flex-col items-center gap-2 text-[13px] text-ink-mute">
          <AlertCircle size={18} aria-hidden className="text-danger" />
          <span>{t("error")}</span>
          <span className="max-w-[260px] truncate text-[12px]" title={error}>
            {error}
          </span>
          <button type="button" onClick={onRetry} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12.5px] font-medium text-ink-soft hover:bg-hover hover:text-ink">
            <RotateCw size={12} aria-hidden />
            {t("retry")}
          </button>
        </div>
      </div>
    );
  }
  if (loading && empty) {
    return (
      <div className="grid h-full place-items-center" role="status" aria-label={t("loading")}>
        <Loader2 size={16} aria-hidden className="animate-spin text-ink-mute" />
      </div>
    );
  }
  return <>{children}</>;
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="grid h-full place-items-center p-4 text-center text-[13px] text-ink-mute">{children}</p>;

export const ROW = "flex min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-hover";

/* ------------------------------------------------------------------ agenda */

type Ev = { id: string; title: string; start: string; end: string; allDay: boolean; location: string | null; declined: boolean; href: string; meetHref: string | null };

function EventRows({ events }: { events: Ev[] }) {
  const t = useTranslations("dashboard.widget");
  const locale = useLocale();
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" });
  const now = Date.now();
  const groups = new Map<string, Ev[]>();
  for (const e of events) {
    const k = e.start.slice(0, 10);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return (
    <div className="flex flex-col gap-2">
      {[...groups].map(([day, list]) => (
        <section key={day}>
          <h4 className="px-2 pb-0.5 text-[11px] font-medium tracking-wide text-ink-mute uppercase">
            {day === todayKey ? t("today") : dayFmt.format(new Date(`${day}T12:00:00`))}
          </h4>
          <ul>
            {list.map((e) => {
              const past = !e.allDay && Date.parse(e.end) < now;
              return (
                <li key={`${e.id}-${e.start}`}>
                  <Link href={e.href} className={`${ROW} ${past || e.declined ? "opacity-55" : ""}`}>
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--dash-accent)" }} aria-hidden />
                    <span className="w-[86px] shrink-0 text-[12.5px] text-ink-soft tabular-nums">
                      {e.allDay ? t("allDay") : `${time.format(new Date(e.start))}–${time.format(new Date(e.end))}`}
                    </span>
                    <span className={`min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink ${e.declined ? "line-through" : ""}`}>{e.title || t("untitled")}</span>
                    {e.meetHref && (
                      <span className="shrink-0 text-ink-mute" title={t("join")}>
                        <Video size={13} aria-hidden />
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AgendaWidget({ widget, refreshKey }: { widget: Widget; refreshKey: number }) {
  const t = useTranslations("dashboard.widget");
  const q = widgetQuery(widget)!;
  const { data, error, loading, reload } = useQuery<{ events: Ev[] }>(q.name, q.args, refreshKey);
  const events = data?.events ?? [];
  return (
    <State loading={loading} error={error} empty={!data} onRetry={reload}>
      {events.length ? <EventRows events={events} /> : <Empty>{t("noEvents")}</Empty>}
    </State>
  );
}

/* -------------------------------------------------------------------- mail */

type MailItem = { threadId: string; from: string; subject: string; preview: string; receivedAt: string; unread: boolean; messages: number; href: string };

function MailWidget({ widget, refreshKey, onOpen, activeId }: { widget: Widget; refreshKey: number; onOpen?: (m: MailItem) => void; activeId?: string | null }) {
  const t = useTranslations("dashboard.widget");
  const when = useWhen();
  const q = widgetQuery(widget)!;
  const { data, error, loading, reload } = useQuery<{ total: number; items: MailItem[] }>(q.name, q.args, refreshKey);
  const items = data?.items ?? [];
  return (
    <State loading={loading} error={error} empty={!data} onRetry={reload}>
      {items.length ? (
        <ul>
          {items.map((m) => {
            const body = (
              <>
                <Mail size={14} aria-hidden className={`mt-0.5 shrink-0 ${m.unread ? "text-[var(--dash-accent)]" : "text-ink-mute"}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`min-w-0 flex-1 truncate text-[13px] ${m.unread ? "font-semibold text-ink" : "text-ink-soft"}`}>
                      {m.from || t("unknownSender")}
                      {m.messages > 1 && <span className="ml-1 font-normal text-ink-mute">{m.messages}</span>}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-ink-mute tabular-nums">{when(m.receivedAt)}</span>
                  </span>
                  <span className={`block truncate text-[13px] ${m.unread ? "font-medium text-ink" : "text-ink-soft"}`}>{m.subject || t("noSubject")}</span>
                  <span className="block truncate text-[12px] text-ink-mute">{m.preview}</span>
                </span>
              </>
            );
            return (
              <li key={m.threadId}>
                {onOpen ? (
                  <button type="button" onClick={() => onOpen(m)} aria-current={activeId === m.threadId || undefined} className={`${ROW} w-full text-left aria-[current=true]:bg-primary-soft`}>
                    {body}
                  </button>
                ) : (
                  <Link href={m.href} className={ROW}>
                    {body}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty>{widget.config.mode === "search" ? t("noResults") : t("inboxZero")}</Empty>
      )}
    </State>
  );
}

/* -------------------------------------------------------------------- chat */

type Conv = { id: string; name: string; team: string | null; unread: number; lastMessage: { author: string; preview: string; at: string } | null; href: string };
type Msg = { id: number; author: string | null; at: string; body: string; kind: string };

function ChatWidget({ widget, refreshKey }: { widget: Widget; refreshKey: number }) {
  const t = useTranslations("dashboard.widget");
  const when = useWhen();
  const q = widgetQuery(widget)!;
  const conv = widget.config.mode === "conversation";
  const { data, error, loading, reload } = useQuery<{ items: (Conv | Msg)[]; href?: string }>(q.name, q.args, refreshKey);
  const items = data?.items ?? [];
  if (conv) {
    const msgs = items as Msg[];
    return (
      <State loading={loading} error={error} empty={!data} onRetry={reload}>
        {msgs.length ? (
          <div className="flex flex-col gap-2 px-2">
            {msgs.map((m) => (
              <div key={m.id} className="min-w-0">
                <div className="flex items-baseline gap-2 text-[12px]">
                  <span className="truncate font-medium text-ink">{m.author ?? t("system")}</span>
                  <span className="shrink-0 text-ink-mute tabular-nums">{when(m.at)}</span>
                </div>
                <p className="line-clamp-3 text-[13px] whitespace-pre-wrap text-ink-soft">{m.kind === "text" ? m.body : `· ${m.body || m.kind}`}</p>
              </div>
            ))}
            {data?.href && (
              <Link href={data.href} className="self-start text-[12.5px] font-medium text-[var(--dash-accent)] hover:underline">
                {t("openChat")}
              </Link>
            )}
          </div>
        ) : (
          <Empty>{t("noMessages")}</Empty>
        )}
      </State>
    );
  }
  const convs = items as Conv[];
  return (
    <State loading={loading} error={error} empty={!data} onRetry={reload}>
      {convs.length ? (
        <ul>
          {convs.map((c) => (
            <li key={c.id}>
              <Link href={c.href} className={ROW}>
                <MessageSquare size={14} aria-hidden className="mt-0.5 shrink-0 text-ink-mute" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                      {c.team ? `${c.team} › ` : ""}
                      {c.name}
                    </span>
                    {c.unread > 0 && (
                      <span className="shrink-0 rounded-full px-1.5 text-[11px] font-semibold text-white tabular-nums" style={{ background: "var(--dash-accent)" }}>
                        {c.unread}
                      </span>
                    )}
                  </span>
                  {c.lastMessage && (
                    <span className="block truncate text-[12px] text-ink-mute">
                      {c.lastMessage.author}: {c.lastMessage.preview} · {when(c.lastMessage.at)}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{t("chatZero")}</Empty>
      )}
    </State>
  );
}

/* ------------------------------------------------------------------- drive */

type DriveItem = { id: string; name: string; folder: boolean; modified: string | null; href: string };

function DriveWidget({ widget, refreshKey }: { widget: Widget; refreshKey: number }) {
  const t = useTranslations("dashboard.widget");
  const when = useWhen();
  const q = widgetQuery(widget)!;
  const { data, error, loading, reload } = useQuery<{ items: DriveItem[]; href?: string }>(q.name, q.args, refreshKey);
  const items = data?.items ?? [];
  return (
    <State loading={loading} error={error} empty={!data} onRetry={reload}>
      {items.length ? (
        <ul className={widget.w >= 6 ? "grid grid-cols-2 gap-x-2" : ""}>
          {items.map((f) => (
            <li key={f.id} className="min-w-0">
              <a href={f.href} target={f.href.startsWith("/api/") ? "_blank" : undefined} rel="noreferrer" className={`${ROW} items-center`}>
                {f.folder ? <Folder size={14} aria-hidden className="shrink-0 text-ink-mute" /> : <FileText size={14} aria-hidden className="shrink-0 text-ink-mute" />}
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{f.name}</span>
                <span className="shrink-0 text-[11.5px] text-ink-mute tabular-nums">{when(f.modified)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{t("noFiles")}</Empty>
      )}
    </State>
  );
}

/* ---------------------------------------------------------------- meetings */

type Rec = { id: string; title: string; startedAt: string | number; durationMinutes: number | null; status: string; href: string };

function MeetingsWidget({ widget, refreshKey }: { widget: Widget; refreshKey: number }) {
  const t = useTranslations("dashboard.widget");
  const when = useWhen();
  const c = widget.config;
  const up = useQuery<{ events: Ev[] }>(c.upcoming ? "meetings.upcoming" : null, { days: c.days, limit: c.limit }, refreshKey);
  const rec = useQuery<{ items: Rec[] }>(c.recordings ? "meetings.recordings" : null, { limit: c.limit }, refreshKey);
  return (
    <div className="flex flex-col gap-3">
      {!!c.upcoming && (
        <section>
          <h4 className="px-2 pb-0.5 text-[11px] font-medium tracking-wide text-ink-mute uppercase">{t("upcoming")}</h4>
          <State loading={up.loading} error={up.error} empty={!up.data} onRetry={up.reload}>
            {up.data?.events.length ? (
              <ul>
                {up.data.events.map((e) => (
                  <li key={`${e.id}-${e.start}`} className="flex items-center gap-1">
                    <Link href={e.href} className={`${ROW} min-w-0 flex-1 items-center`}>
                      <CalendarDays size={14} aria-hidden className="shrink-0 text-ink-mute" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{e.title || t("untitled")}</span>
                      <span className="shrink-0 text-[11.5px] text-ink-mute tabular-nums">{when(e.start)}</span>
                    </Link>
                    {e.meetHref && (
                      <Link
                        href={e.meetHref}
                        className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-white"
                        style={{ background: "var(--color-app-meet)" }}
                      >
                        {t("join")}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 py-1 text-[12.5px] text-ink-mute">{t("noMeetings")}</p>
            )}
          </State>
        </section>
      )}
      {!!c.recordings && (
        <section>
          <h4 className="px-2 pb-0.5 text-[11px] font-medium tracking-wide text-ink-mute uppercase">{t("recordings")}</h4>
          <State loading={rec.loading} error={rec.error} empty={!rec.data} onRetry={rec.reload}>
            {rec.data?.items.length ? (
              <ul>
                {rec.data.items.map((m) => (
                  <li key={m.id}>
                    <Link href={m.href} className={`${ROW} items-center`}>
                      <Video size={14} aria-hidden className="shrink-0 text-ink-mute" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{m.title || t("untitled")}</span>
                      <span className="shrink-0 text-[11.5px] text-ink-mute tabular-nums">
                        {m.durationMinutes != null ? `${m.durationMinutes} min · ` : ""}
                        {when(m.startedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 py-1 text-[12.5px] text-ink-mute">{t("noRecordings")}</p>
            )}
          </State>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- notes */

function NotesWidget({ widget, onSave }: { widget: Widget; onSave: (text: string) => void }) {
  const t = useTranslations("dashboard.widget");
  const text = String(widget.config.text ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);
  if (editing) {
    return (
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft !== text) onSave(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(text);
            setEditing(false);
          }
        }}
        maxLength={20_000}
        aria-label={t("notesEdit")}
        className="h-full w-full resize-none rounded-md border border-line bg-sheet p-2 font-mono text-[12.5px] text-ink outline-none focus:border-line-strong"
      />
    );
  }
  return (
    <div
      className="h-full cursor-text px-2 text-[13.5px] leading-relaxed text-ink-soft"
      onDoubleClick={() => setEditing(true)}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setEditing(true)}
      tabIndex={0}
      role="button"
      aria-label={t("notesEdit")}
      title={t("notesHint")}
    >
      {text.trim() ? renderMarkdown(text) : <span className="text-ink-mute">{t("notesEmpty")}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------- links */

function LinksWidget({ widget }: { widget: Widget }) {
  const t = useTranslations("dashboard.widget");
  const items = (widget.config.items as { label: string; url: string }[]) ?? [];
  if (!items.length) return <Empty>{t("noLinks")}</Empty>;
  return (
    <ul>
      {items.map((l, i) => {
        const internal = l.url.startsWith("/");
        let host = l.url;
        try {
          host = internal ? l.url : new URL(l.url).host || l.url;
        } catch {}
        return (
          <li key={i}>
            <a href={l.url} target={internal ? undefined : "_blank"} rel="noopener noreferrer" className={`${ROW} items-baseline`}>
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-[var(--dash-accent)]">{l.label || host}</span>
              {l.label && <span className="max-w-[45%] shrink-0 truncate text-[11.5px] text-ink-mute">{host}</span>}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------- clock */

function ClockWidget({ widget }: { widget: Widget }) {
  const locale = useLocale();
  const c = widget.config;
  const seconds = !!c.seconds;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), seconds ? 1000 : 15_000);
    return () => clearInterval(id);
  }, [seconds]);
  const zones = ((c.zones as { timeZone: string; label: string }[]) ?? []).length ? (c.zones as { timeZone: string; label: string }[]) : [{ timeZone: "", label: "" }];
  const single = zones.length === 1;
  return (
    <div className={`flex h-full flex-col justify-center ${single ? "items-center" : ""} gap-1.5 px-2`}>
      {zones.map((z, i) => {
        const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: !!c.hour12, ...(seconds ? { second: "2-digit" } : {}), ...(z.timeZone ? { timeZone: z.timeZone } : {}) };
        const dayOpts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", ...(z.timeZone ? { timeZone: z.timeZone } : {}) };
        const label = z.label || (z.timeZone ? z.timeZone.split("/").pop()!.replace(/_/g, " ") : "");
        return single ? (
          <div key={i} className="text-center">
            <div className="text-[clamp(28px,5vw,44px)] leading-none font-semibold tracking-tight text-ink tabular-nums">{new Intl.DateTimeFormat(locale, opts).format(now)}</div>
            <div className="mt-1.5 text-[12.5px] text-ink-mute first-letter:uppercase">
              {label ? `${label} · ` : ""}
              {new Intl.DateTimeFormat(locale, dayOpts).format(now)}
            </div>
          </div>
        ) : (
          <div key={i} className="flex items-baseline gap-3 border-b border-line pb-1.5 last:border-0">
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft">{label}</span>
            <span className="text-[11.5px] text-ink-mute">{new Intl.DateTimeFormat(locale, { weekday: "short", ...(z.timeZone ? { timeZone: z.timeZone } : {}) }).format(now)}</span>
            <span className="text-[18px] font-semibold text-ink tabular-nums">{new Intl.DateTimeFormat(locale, opts).format(now)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------- chart */

const SERIES_OPACITY = [1, 0.6, 0.38, 0.24, 0.14];

function ChartWidget({ widget }: { widget: Widget }) {
  const locale = useLocale();
  const c = widget.config;
  const unit = String(c.unit ?? "");
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  if (c.kind === "number") {
    const value = Number(c.value ?? 0);
    const delta = c.delta == null ? null : Number(c.delta);
    return (
      <div className="flex h-full flex-col justify-center px-2">
        <div className="text-[clamp(28px,4vw,40px)] leading-none font-semibold tracking-tight text-ink tabular-nums">
          {fmt.format(value)}
          {unit && <span className="ml-1 text-[0.5em] font-medium text-ink-mute">{unit}</span>}
        </div>
        {delta != null && (
          <div className={`mt-2 text-[13px] font-medium tabular-nums ${delta >= 0 ? "text-signal" : "text-danger"}`}>
            {delta >= 0 ? "+" : ""}
            {fmt.format(delta)}
            {unit}
          </div>
        )}
        {!!c.caption && <p className="mt-2 text-[12.5px] text-ink-mute">{String(c.caption)}</p>}
      </div>
    );
  }
  const series = (c.series as { name: string; values: number[] }[]) ?? [];
  const labels = (c.labels as string[]) ?? [];
  const n = Math.max(1, ...series.map((s) => s.values.length));
  const all = series.flatMap((s) => s.values);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const W = 300;
  const H = 150;
  const yOf = (v: number) => H - ((v - min) / span) * H;
  const label = (i: number) => labels[i] ?? String(i + 1);
  const step = Math.ceil(n / 8);
  return (
    <div className="flex h-full flex-col gap-1.5 px-1">
      <div className="flex items-baseline justify-between text-[11px] text-ink-mute tabular-nums">
        <span>
          {fmt.format(max)}
          {unit}
        </span>
        {series.length > 1 && (
          <span className="flex min-w-0 flex-wrap justify-end gap-x-2.5">
            {series.map((s, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm" style={{ background: "var(--dash-accent)", opacity: SERIES_OPACITY[i] }} aria-hidden />
                {s.name}
              </span>
            ))}
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="min-h-0 w-full flex-1 overflow-visible" role="img" aria-label={String(c.caption || widget.title || "chart")}>
        <line x1={0} x2={W} y1={yOf(0)} y2={yOf(0)} stroke="var(--color-line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {c.kind === "line"
          ? series.map((s, si) => (
              <polyline
                key={si}
                fill="none"
                stroke="var(--dash-accent)"
                strokeOpacity={SERIES_OPACITY[si]}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                points={s.values.map((v, i) => `${n === 1 ? W / 2 : (i / (n - 1)) * W},${yOf(v)}`).join(" ")}
              >
                <title>{s.name}</title>
              </polyline>
            ))
          : Array.from({ length: n }, (_, i) => {
              const slot = W / n;
              const bw = (slot * 0.72) / Math.max(1, series.length);
              return series.map((s, si) => {
                const v = s.values[i];
                if (v == null) return null;
                const y = yOf(Math.max(0, v));
                const h = Math.abs(yOf(v) - yOf(0));
                return (
                  <rect key={`${i}-${si}`} x={i * slot + slot * 0.14 + si * bw} y={y} width={Math.max(1, bw - 1)} height={Math.max(0.5, h)} rx={1.5} fill="var(--dash-accent)" fillOpacity={SERIES_OPACITY[si]}>
                    <title>{`${s.name ? `${s.name} · ` : ""}${label(i)}: ${fmt.format(v)}${unit}`}</title>
                  </rect>
                );
              });
            })}
      </svg>
      <div className="flex justify-between gap-1 text-[10.5px] text-ink-mute">
        {Array.from({ length: n }, (_, i) => (i % step === 0 ? <span key={i} className="min-w-0 truncate">{label(i)}</span> : null))}
      </div>
      {!!c.caption && <p className="text-[12px] text-ink-mute">{String(c.caption)}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ switch */

export function WidgetBody({
  widget,
  refreshKey,
  onNotesSave,
  custom,
  onOpenMail,
  activeMail,
}: {
  widget: Widget;
  refreshKey: number;
  onNotesSave: (text: string) => void;
  custom: (w: Widget) => ReactNode;
  onOpenMail?: (m: { threadId: string; subject: string; href: string }) => void;
  activeMail?: string | null;
}) {
  switch (widget.type) {
    case "agenda":
      return <AgendaWidget widget={widget} refreshKey={refreshKey} />;
    case "mail":
      return <MailWidget widget={widget} refreshKey={refreshKey} onOpen={onOpenMail} activeId={activeMail} />;
    case "chat":
      return <ChatWidget widget={widget} refreshKey={refreshKey} />;
    case "drive":
      return <DriveWidget widget={widget} refreshKey={refreshKey} />;
    case "meetings":
      return <MeetingsWidget widget={widget} refreshKey={refreshKey} />;
    case "notes":
      return <NotesWidget widget={widget} onSave={onNotesSave} />;
    case "links":
      return <LinksWidget widget={widget} />;
    case "clock":
      return <ClockWidget widget={widget} />;
    case "chart":
      return <ChartWidget widget={widget} />;
    case "custom":
      return <>{custom(widget)}</>;
  }
}
