"use client";

// Built-in Zentico UI components beyond the classic widgets: embedded app views (mail thread
// reader, chat conversation with composer, calendar week, Drive folder, Markdown doc, next
// meeting, Claude panel) and the leaf renderer that maps a layout node to its component. Data
// comes from /api/dashboard/query with the viewer's session; user-initiated writes (send a chat
// message, archive a thread) go to /api/ui/action as the user, without a mod.
import { Archive, ArrowUp, CalendarDays, ExternalLink, FileText, Folder, Loader2, MailOpen, Star, Video } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { renderMarkdown } from "@/app/(apps)/docs/md/[fileId]/markdown";
import type { UiNode } from "@/lib/ui/schema";
import { ChatPanel } from "./ChatPanel";
import { CustomWidget } from "./CustomWidget";
import type { TurnView, Widget, WidgetType } from "./model";
import { ModFrame } from "./ModFrame";
import { useStudio } from "./studio-context";
import { Empty, ROW, State, useQuery, useWhen, viewerTimeZone, WidgetBody } from "./widgets";

type Raw = Record<string, unknown>;
type Leaf = Extract<UiNode, { type: "component" }>;

async function act(name: string, args: Raw): Promise<string | null> {
  const res = await fetch("/api/ui/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, args, timeZone: viewerTimeZone() }) }).catch(() => null);
  if (!res) return "network";
  if (res.ok) return null;
  const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return b.message || b.error || `HTTP ${res.status}`;
}

/** Saves props of a component node into ui.json. */
function useSaveProps(node: Leaf) {
  const studio = useStudio();
  return (patch: Raw) => studio.patch([{ op: "set", pointer: `${node.ptr}/props`, value: { ...node.props, ...patch } }]);
}

function Picker({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
      <p className="px-1 text-[12.5px] text-ink-mute">{hint}</p>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------- mail thread */

type ThreadMsg = { emailId: string; from: string[]; to: string[]; date: string; unread: boolean; flagged: boolean; body: string };

function MailThread({ node, refreshKey }: { node: Leaf; refreshKey: number }) {
  const t = useTranslations("dashboard.blocks");
  const studio = useStudio();
  const when = useWhen();
  const fixed = typeof node.props.threadId === "string" && node.props.threadId ? node.props.threadId : null;
  const threadId = fixed ?? (studio.selection?.kind === "mail.thread" ? studio.selection.id : null);
  const [bump, setBump] = useState(0);
  const { data, error, loading, reload } = useQuery<{ subject: string; href: string; messages: ThreadMsg[] }>(threadId ? "mail.thread" : null, { threadId }, refreshKey + bump);
  const [busy, setBusy] = useState(false);
  if (!threadId) return <Empty>{t("pickThread")}</Empty>;
  const run = async (name: string, args: Raw, after?: () => void) => {
    setBusy(true);
    const err = await act(name, args);
    setBusy(false);
    if (err) studio.toast(err);
    else {
      after?.();
      setBump((b) => b + 1);
    }
  };
  const msgs = data?.messages ?? [];
  const flagged = msgs.some((m) => m.flagged);
  const btn = "inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] font-medium text-ink-soft hover:bg-hover hover:text-ink disabled:opacity-50";
  return (
    <State loading={loading} error={error} empty={!data} onRetry={reload}>
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
          <h4 className="w-full min-w-0 truncate text-[14px] font-semibold text-ink">{data?.subject || t("noSubject")}</h4>
          <button type="button" className={btn} disabled={busy} onClick={() => run("mail.markRead", { threadId, read: true })}>
            <MailOpen size={13} aria-hidden />
            {t("markRead")}
          </button>
          <button type="button" className={btn} disabled={busy} onClick={() => run("mail.flag", { threadId, flagged: !flagged })}>
            <Star size={13} aria-hidden className={flagged ? "fill-current text-amber" : ""} />
            {flagged ? t("unstar") : t("star")}
          </button>
          <button type="button" className={btn} disabled={busy} onClick={() => run("mail.archive", { threadId }, () => !fixed && studio.select(null))}>
            <Archive size={13} aria-hidden />
            {t("archive")}
          </button>
          {data?.href && (
            <Link href={data.href} className={btn}>
              <ExternalLink size={13} aria-hidden />
              {t("openMail")}
            </Link>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2">
          {msgs.map((m) => (
            <article key={m.emailId} className="rounded-lg border border-line bg-[var(--ui-card,var(--color-sheet))] p-2.5">
              <header className="flex items-baseline gap-2 text-[12.5px]">
                <span className={`min-w-0 flex-1 truncate ${m.unread ? "font-semibold text-ink" : "text-ink-soft"}`}>{m.from[0] ?? ""}</span>
                <span className="shrink-0 text-ink-mute tabular-nums">{when(m.date)}</span>
              </header>
              <p className="mt-1.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-ink">{m.body}</p>
            </article>
          ))}
        </div>
      </div>
    </State>
  );
}

/* ------------------------------------------------------- chat conversation */

type Conv = { id: string; name: string; team: string | null; unread: number };
type Msg = { id: number; author: string | null; at: string; body: string; kind: string };

function ChatConversation({ node, refreshKey }: { node: Leaf; refreshKey: number }) {
  const t = useTranslations("dashboard.blocks");
  const studio = useStudio();
  const when = useWhen();
  const save = useSaveProps(node);
  const conversationId = typeof node.props.conversationId === "string" && node.props.conversationId ? node.props.conversationId : null;
  const limit = Math.min(50, Number(node.props.limit ?? 30));
  const [bump, setBump] = useState(0);
  const convs = useQuery<{ items: Conv[] }>(conversationId ? null : "chat.conversations", { limit: 30 }, refreshKey);
  const { data, error, loading, reload } = useQuery<{ items: Msg[]; href: string }>(conversationId ? "chat.messages" : null, { conversationId, limit }, refreshKey + bump);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => studio.subscribeLive((e) => e.category === "chat" && (!e.ref || e.ref === conversationId) && setBump((b) => b + 1)), [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setInterval(() => document.visibilityState === "visible" && setBump((b) => b + 1), 20_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [data?.items.length]);

  if (!conversationId) {
    return (
      <Picker hint={t("pickConversation")}>
        <State loading={convs.loading} error={convs.error} empty={!convs.data} onRetry={convs.reload}>
          <ul>
            {(convs.data?.items ?? []).map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => void save({ conversationId: c.id }).then((e) => e && studio.toast(e))} className={`${ROW} w-full text-left text-[13px] text-ink`}>
                  {c.team ? `${c.team} › ` : ""}
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        </State>
      </Picker>
    );
  }
  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    const err = await act("chat.send", { conversationId, body });
    setSending(false);
    if (err) studio.toast(err);
    else {
      setDraft("");
      setBump((b) => b + 1);
    }
  };
  return (
    <div className="flex h-full flex-col">
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto">
        <State loading={loading} error={error} empty={!data} onRetry={reload}>
          {data?.items.length ? (
            <div className="flex flex-col gap-2 px-2">
              {data.items.map((m) => (
                <div key={m.id} className="min-w-0">
                  <div className="flex items-baseline gap-2 text-[12px]">
                    <span className="truncate font-medium text-ink">{m.author ?? t("system")}</span>
                    <span className="shrink-0 text-ink-mute tabular-nums">{when(m.at)}</span>
                  </div>
                  <p className="text-[13px] break-words whitespace-pre-wrap text-ink-soft">{m.kind === "text" ? m.body : `· ${m.body || m.kind}`}</p>
                </div>
              ))}
            </div>
          ) : (
            <Empty>{t("noMessages")}</Empty>
          )}
        </State>
      </div>
      {node.props.composer !== false && (
        <form
          className="shrink-0 px-1.5 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="flex items-end gap-2 rounded-lg border border-line bg-[var(--ui-card,var(--color-sheet))] px-2.5 py-1.5 focus-within:border-line-strong">
            <textarea
              rows={1}
              value={draft}
              maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={t("message")}
              aria-label={t("message")}
              className="max-h-28 min-h-[20px] flex-1 resize-none bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-mute"
            />
            <button type="submit" className="icon-btn !h-6 !w-6 shrink-0" disabled={!draft.trim() || sending} aria-label={t("send")}>
              {sending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <ArrowUp size={14} aria-hidden />}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ calendar week */

type Ev = { id: string; title: string; start: string; end: string; allDay: boolean; href: string; declined: boolean };

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function CalendarWeek({ node, refreshKey }: { node: Leaf; refreshKey: number }) {
  const locale = useLocale();
  const t = useTranslations("dashboard.blocks");
  const days = Number(node.props.days ?? 7);
  const fromHour = Number(node.props.fromHour ?? 8);
  const toHour = Number(node.props.toHour ?? 19);
  const first = useMemo(() => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    if (node.props.start !== "today") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  }, [node.props.start]);
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    return d;
  });
  const end = new Date(first);
  end.setDate(end.getDate() + days);
  const { data, error, loading, reload } = useQuery<{ events: Ev[] }>("calendar.range", { start: ymd(first), end: ymd(end), limit: 200 }, refreshKey);
  const fmtDay = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric" });
  const fmtTime = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const span = (toHour - fromHour) * 60;
  const today = ymd(new Date());
  const hours = Array.from({ length: toHour - fromHour }, (_, i) => fromHour + i);
  return (
    <State loading={loading} error={error} empty={!data} onRetry={reload}>
      <div className="flex h-full min-h-[240px] flex-col px-1">
        <div className="grid shrink-0 gap-px pl-9" style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}>
          {dates.map((d) => (
            <div key={ymd(d)} className={`truncate pb-1 text-center text-[11.5px] font-medium first-letter:uppercase ${ymd(d) === today ? "text-[var(--dash-accent)]" : "text-ink-mute"}`}>
              {fmtDay.format(d)}
            </div>
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1 pb-1 pl-9">
          {(data?.events ?? [])
            .filter((e) => e.allDay)
            .slice(0, 6)
            .map((e) => (
              <Link key={`${e.id}-${e.start}`} href={e.href} className="truncate rounded px-1.5 py-0.5 text-[11px] text-white" style={{ background: "var(--dash-accent)", maxWidth: 160 }}>
                {e.title || t("untitled")}
              </Link>
            ))}
        </div>
        <div className="relative min-h-0 flex-1">
          <div className="absolute inset-0 flex flex-col pl-9">
            {hours.map((h) => (
              <div key={h} className="relative flex-1 border-t border-line">
                <span className="absolute -top-2 -left-9 w-8 text-right text-[10px] text-ink-mute tabular-nums">{String(h).padStart(2, "0")}</span>
              </div>
            ))}
          </div>
          <div className="absolute inset-0 grid gap-px pl-9" style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}>
            {dates.map((d) => {
              const key = ymd(d);
              const evs = (data?.events ?? []).filter((e) => !e.allDay && e.start.slice(0, 10) === key);
              return (
                <div key={key} className={`relative ${key === today ? "bg-primary-soft/40" : ""}`}>
                  {evs.map((e) => {
                    const s = new Date(e.start);
                    const en = new Date(e.end);
                    const top = Math.max(0, ((s.getHours() - fromHour) * 60 + s.getMinutes()) / span);
                    const bottom = Math.min(1, ((en.getHours() - fromHour) * 60 + en.getMinutes()) / span);
                    if (bottom <= 0 || top >= 1) return null;
                    return (
                      <Link
                        key={`${e.id}-${e.start}`}
                        href={e.href}
                        title={`${fmtTime.format(s)} ${e.title}`}
                        className={`absolute inset-x-0.5 overflow-hidden rounded-md border-l-2 px-1 py-0.5 text-[11px] leading-tight text-ink hover:brightness-95 ${e.declined ? "opacity-50" : ""}`}
                        style={{
                          top: `${top * 100}%`,
                          height: `max(18px, ${(bottom - top) * 100}%)`,
                          borderColor: "var(--dash-accent)",
                          background: "color-mix(in oklab, var(--dash-accent) 16%, var(--ui-card, var(--color-sheet)))",
                        }}
                      >
                        <span className="font-medium">{e.title || t("untitled")}</span>
                        <span className="block text-ink-mute tabular-nums">{fmtTime.format(s)}</span>
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </State>
  );
}

/* ------------------------------------------------------- drive path helpers */

function useResolved(path: string | null, kind: "folder" | "file", refreshKey: number) {
  return useQuery<{ id: string; name: string; href: string }>(path ? "drive.resolve" : null, { path, kind }, refreshKey);
}

type DriveItem = { id: string; name: string; folder: boolean; modified: string | null; href: string };

function DriveFolder({ node, refreshKey }: { node: Leaf; refreshKey: number }) {
  const t = useTranslations("dashboard.blocks");
  const when = useWhen();
  const studio = useStudio();
  const save = useSaveProps(node);
  const path = typeof node.props.path === "string" && node.props.path ? node.props.path : null;
  const direct = typeof node.props.folderId === "string" && node.props.folderId ? node.props.folderId : null;
  const resolved = useResolved(direct ? null : path, "folder", refreshKey);
  const folderId = direct ?? resolved.data?.id ?? null;
  const { data, error, loading, reload } = useQuery<{ items: DriveItem[]; href: string }>(folderId ? "drive.folder" : null, { folderId, limit: Number(node.props.limit ?? 20) }, refreshKey);
  const [q, setQ] = useState("");
  const search = useQuery<{ items: DriveItem[] }>(!direct && !path && q.trim().length > 1 ? "drive.search" : null, { query: q.trim(), limit: 20 }, 0);
  if (!direct && !path) {
    return (
      <Picker hint={t("pickFolder")}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchDrive")} className="h-8 rounded-lg border border-line bg-[var(--ui-card,var(--color-sheet))] px-2.5 text-[13px] text-ink outline-none focus:border-line-strong" />
        <ul>
          {(search.data?.items ?? [])
            .filter((f) => f.folder)
            .map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => void save({ folderId: f.id }).then((e) => e && studio.toast(e))} className={`${ROW} w-full items-center text-left text-[13px] text-ink`}>
                  <Folder size={14} aria-hidden className="text-ink-mute" />
                  {f.name}
                </button>
              </li>
            ))}
        </ul>
      </Picker>
    );
  }
  if (resolved.error) return <Empty>{resolved.error}</Empty>;
  return (
    <State loading={loading || resolved.loading} error={error} empty={!data} onRetry={reload}>
      {data?.items.length ? (
        <ul>
          {data.items.map((f) => (
            <li key={f.id}>
              <a href={f.href} target={f.href.startsWith("/api/") ? "_blank" : undefined} rel="noreferrer" className={`${ROW} items-center`}>
                {f.folder ? <Folder size={14} aria-hidden className="shrink-0 text-ink-mute" /> : <FileText size={14} aria-hidden className="shrink-0 text-ink-mute" />}
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{f.name}</span>
                <span className="shrink-0 text-[11.5px] text-ink-mute tabular-nums">{when(f.modified)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{t("emptyFolder")}</Empty>
      )}
    </State>
  );
}

function DocMarkdown({ node, refreshKey }: { node: Leaf; refreshKey: number }) {
  const t = useTranslations("dashboard.blocks");
  const studio = useStudio();
  const save = useSaveProps(node);
  const path = typeof node.props.path === "string" && node.props.path ? node.props.path : null;
  const direct = typeof node.props.fileId === "string" && node.props.fileId ? node.props.fileId : null;
  const resolved = useResolved(direct ? null : path, "file", refreshKey);
  const fileId = direct ?? resolved.data?.id ?? null;
  const { data, error, loading, reload } = useQuery<{ name: string; text: string; href: string | null }>(fileId ? "drive.read" : null, { fileId }, refreshKey);
  const [q, setQ] = useState(".md");
  const search = useQuery<{ items: DriveItem[] }>(!direct && !path && q.trim().length > 1 ? "drive.search" : null, { query: q.trim(), limit: 20 }, 0);
  if (!direct && !path) {
    return (
      <Picker hint={t("pickDoc")}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchDrive")} className="h-8 rounded-lg border border-line bg-[var(--ui-card,var(--color-sheet))] px-2.5 text-[13px] text-ink outline-none focus:border-line-strong" />
        <ul>
          {(search.data?.items ?? [])
            .filter((f) => !f.folder && /\.(md|markdown|txt)$/i.test(f.name))
            .map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => void save({ fileId: f.id }).then((e) => e && studio.toast(e))} className={`${ROW} w-full items-center text-left text-[13px] text-ink`}>
                  <FileText size={14} aria-hidden className="text-ink-mute" />
                  {f.name}
                </button>
              </li>
            ))}
        </ul>
      </Picker>
    );
  }
  if (resolved.error) return <Empty>{resolved.error}</Empty>;
  return (
    <State loading={loading || resolved.loading} error={error} empty={!data} onRetry={reload}>
      <div className="px-2 text-[13.5px] leading-relaxed text-ink-soft">
        {data?.text.trim() ? renderMarkdown(data.text) : <span className="text-ink-mute">{t("emptyDoc")}</span>}
        {data?.href && (
          <a href={data.href} className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-[var(--dash-accent)] hover:underline">
            <ExternalLink size={12} aria-hidden />
            {t("openDoc")}
          </a>
        )}
      </div>
    </State>
  );
}

/* ------------------------------------------------------------ next meeting */

type Up = { id: string; title: string; start: string; end: string; href: string; meetHref: string | null; attendees: number };

function MeetingsNext({ node, refreshKey }: { node: Leaf; refreshKey: number }) {
  const t = useTranslations("dashboard.blocks");
  const locale = useLocale();
  const { data, error, loading, reload } = useQuery<{ events: Up[] }>("meetings.upcoming", { days: Number(node.props.days ?? 7), limit: 1 }, refreshKey);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const e = data?.events[0];
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const rel = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return (
    <State loading={loading} error={error} empty={!data} onRetry={reload}>
      {e ? (
        <div className="flex h-full flex-col justify-center gap-2 px-2">
          <div className="flex items-center gap-2 text-[12px] font-medium tracking-wide text-ink-mute uppercase">
            <CalendarDays size={13} aria-hidden />
            {Date.parse(e.start) <= now ? t("now") : rel.format(Math.round((Date.parse(e.start) - now) / 60_000), "minute")}
          </div>
          <Link href={e.href} className="line-clamp-2 text-[18px] leading-snug font-semibold text-ink hover:underline">
            {e.title || t("untitled")}
          </Link>
          <div className="text-[12.5px] text-ink-mute">
            {fmt.format(new Date(e.start))} · {t("people", { n: e.attendees })}
          </div>
          {e.meetHref && (
            <Link href={e.meetHref} className="inline-flex h-8 w-fit items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-white" style={{ background: "var(--color-app-meet)" }}>
              <Video size={14} aria-hidden />
              {t("join")}
            </Link>
          )}
        </div>
      ) : (
        <Empty>{t("noMeetings")}</Empty>
      )}
    </State>
  );
}

/* ------------------------------------------------------------------ claude */

function ClaudeBlock() {
  const studio = useStudio();
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  return <ChatPanel chat={studio.chat} draft={draft} setDraft={setDraft} inputRef={input} onAdded={(_t: TurnView) => undefined} />;
}

/* -------------------------------------------------------------------- leaf */

const LEGACY = new Set<string>(["agenda", "mail", "chat", "drive", "meetings", "notes", "links", "clock", "chart", "custom"]);

export function LeafBody({ node, refreshKey, title }: { node: UiNode; refreshKey: number; title: string }) {
  const studio = useStudio();
  const t = useTranslations("dashboard.blocks");
  if (node.type === "mod") {
    const mod = studio.view.ui?.mods[node.mod];
    if (!mod) return <Empty>{t("missingMod", { id: node.mod })}</Empty>;
    return <ModFrame key={`${node.mod}-${refreshKey}`} mod={mod} instance={`${studio.pageId}:${node.key}`} config={node.config} title={title} />;
  }
  if (node.type !== "component") return null;
  if (LEGACY.has(node.component)) {
    const widget: Widget = { id: node.key, type: node.component as WidgetType, title: node.title ?? "", x: node.x ?? 0, y: node.y ?? 0, w: node.w ?? 4, h: node.h ?? 6, config: node.props };
    const reader = node.component === "mail" && node.props.openIn === "reader";
    return (
      <WidgetBody
        widget={widget}
        refreshKey={refreshKey}
        onNotesSave={(text) => void studio.patch([{ op: "set", pointer: `${node.ptr}/props`, value: { ...node.props, text } }]).then((e) => e && studio.toast(e))}
        custom={(cw) => <CustomWidget key={`${cw.id}-${refreshKey}`} html={String(cw.config.html ?? "")} title={title} />}
        onOpenMail={reader ? (m) => studio.select({ kind: "mail.thread", id: m.threadId, href: m.href, label: m.subject }) : undefined}
        activeMail={reader && studio.selection?.kind === "mail.thread" ? studio.selection.id : null}
      />
    );
  }
  switch (node.component) {
    case "mail.thread":
      return <MailThread node={node} refreshKey={refreshKey} />;
    case "chat.conversation":
      return <ChatConversation node={node} refreshKey={refreshKey} />;
    case "calendar.week":
      return <CalendarWeek node={node} refreshKey={refreshKey} />;
    case "drive.folder":
      return <DriveFolder node={node} refreshKey={refreshKey} />;
    case "doc.markdown":
      return <DocMarkdown node={node} refreshKey={refreshKey} />;
    case "meetings.next":
      return <MeetingsNext node={node} refreshKey={refreshKey} />;
    case "claude":
      return <ClaudeBlock />;
    default:
      return <Empty>{t("unknown", { name: node.component })}</Empty>;
  }
}

