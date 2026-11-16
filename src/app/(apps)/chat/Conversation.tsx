"use client";

import { ArrowLeft, CalendarClock, CalendarPlus, Loader2, Upload, Video } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePopover } from "@/components/usePopover";
import { meetHref } from "../meet/shared";
import { endMeeting, getConversation, getMeetings, getMessages, joinChannel, markRead, startMeeting } from "./actions";
import type { Subscribe } from "./ChatApp";
import { Composer } from "./Composer";
import { ScheduleDialog } from "./Dialogs";
import { MessageItem } from "./MessageItem";
import { MembersPanel, ThreadPanel } from "./Panels";
import { TYPING_TTL_MS, type ChatMessage, type ChatUser, type ConversationDetail, type ConversationSummary, type MeetingInfo } from "./shared";
import { Avatar, BTN, BTN_MEET, BTN_PRIMARY, ConversationIcon, dayKey, dayLabel, openMeetNow, timeOf, useErrorText } from "./ui";

type Props = {
  id: string;
  me: ChatUser;
  summary: ConversationSummary | null;
  subscribe: Subscribe;
  onBack: () => void;
  onChanged: () => void;
  onOpen: (id: string | null) => void;
  onRead: () => void;
  /** Open the "schedule a meeting" dialog once the conversation has loaded (Chat → People). */
  autoSchedule?: boolean;
};

type Panel = { kind: "thread"; root: number } | { kind: "members" } | null;

const GROUP_GAP_MS = 5 * 60_000;
const groupable = (m: ChatMessage) => m.kind === "text" || m.kind === "file";

export function Conversation({ id, me, summary, subscribe, onBack, onChanged, onOpen, onRead, autoSchedule = false }: Props) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const errorText = useErrorText();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [marker, setMarker] = useState(0);
  const [typing, setTyping] = useState<Record<number, { name: string; until: number }>>({});
  const [panel, setPanel] = useState<Panel>(null);
  const [scheduling, setScheduling] = useState(false);
  const autoScheduled = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const stick = useRef(false);
  const initialScroll = useRef(true);
  const addFilesRef = useRef<((files: File[]) => void) | null>(null);
  const dragDepth = useRef(0);
  const detailRef = useRef(detail);
  detailRef.current = detail;

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 6000);
  }, []);

  const reloadDetail = useCallback(async () => {
    const r = await getConversation(id);
    if (r.ok) setDetail(r.data);
    return r;
  }, [id]);

  useEffect(() => {
    if (autoSchedule && detail?.joined && !autoScheduled.current) {
      autoScheduled.current = true;
      setScheduling(true);
    }
  }, [autoSchedule, detail]);

  // Initial load.
  useEffect(() => {
    let live = true;
    (async () => {
      const [d, m] = await Promise.all([getConversation(id), getMessages(id, null)]);
      if (!live) return;
      if (!d.ok || !m.ok) {
        setFailed(!d.ok ? d.error : m.ok ? "failed" : m.error);
        return;
      }
      setDetail(d.data);
      setMarker(d.data.lastReadId);
      setMessages(m.data.messages);
      setHasMore(m.data.hasMore);
    })();
    return () => {
      live = false;
    };
  }, [id]);

  const upsert = useCallback((m: ChatMessage, append: boolean) => {
    setMessages((list) => {
      if (!list) return list;
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) {
        const next = [...list];
        next[i] = m;
        return next;
      }
      if (!append) return list;
      // Keep id order (events may race the action's own response).
      const next = [...list, m];
      next.sort((a, b) => a.id - b.id);
      return next;
    });
  }, []);

  const refreshMeetings = useCallback(async () => {
    const r = await getMeetings(id);
    if (r.ok) setDetail((d) => (d ? { ...d, ...r.data } : d));
  }, [id]);

  // Live events for this conversation.
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "message" && e.message.conversationId === id && e.message.threadRoot === null) {
          if (atBottom.current || e.message.author?.id === me.id) stick.current = true;
          upsert(e.message, true);
          const author = e.message.author?.id;
          if (author)
            setTyping((tp) => {
              if (!tp[author]) return tp;
              const next = { ...tp };
              delete next[author];
              return next;
            });
        } else if (e.type === "update" && e.message.conversationId === id && e.message.threadRoot === null) {
          upsert(e.message, false);
        } else if (e.type === "typing" && e.conversationId === id && e.threadRoot === null && e.user.id !== me.id) {
          setTyping((tp) => ({ ...tp, [e.user.id]: { name: e.user.name, until: Date.now() + TYPING_TTL_MS } }));
        } else if (e.type === "meeting" && e.conversationId === id) {
          void refreshMeetings();
        } else if (e.type === "conversations") {
          void reloadDetail().then((r) => {
            if (!r.ok && r.error === "notFound") onOpen(null);
          });
        }
      }),
    [id, me.id, subscribe, upsert, refreshMeetings, reloadDetail, onOpen],
  );

  // Expire typing indicators.
  const typingNames = Object.values(typing).map((x) => x.name);
  useEffect(() => {
    if (typingNames.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setTyping((tp) => {
        const next = Object.fromEntries(Object.entries(tp).filter(([, v]) => v.until > now));
        return Object.keys(next).length === Object.keys(tp).length ? tp : next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [typingNames.length]);

  // Read marker: everything visible at the bottom counts as read.
  const lastId = messages?.at(-1)?.id ?? 0;
  const joined = detail?.joined ?? false;
  const sendRead = useCallback(() => {
    if (!joined || !lastId || document.visibilityState !== "visible" || !atBottom.current) return;
    void markRead(id, lastId);
    onRead();
  }, [id, joined, lastId, onRead]);
  useEffect(() => {
    sendRead();
    document.addEventListener("visibilitychange", sendRead);
    window.addEventListener("focus", sendRead);
    return () => {
      document.removeEventListener("visibilitychange", sendRead);
      window.removeEventListener("focus", sendRead);
    };
  }, [sendRead]);

  // Scroll management: initial position, keep position when prepending, stick to bottom.
  const firstUnread = useMemo(
    () => messages?.find((m) => m.id > marker && m.author?.id !== me.id && m.kind !== "system")?.id ?? null,
    [messages, marker, me.id],
  );
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !messages) return;
    if (initialScroll.current) {
      initialScroll.current = false;
      const target = firstUnread ? el.querySelector<HTMLElement>(`[data-unread-marker]`) : null;
      if (target) {
        el.scrollTop = Math.max(0, target.offsetTop - el.clientHeight / 3);
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      } else el.scrollTop = el.scrollHeight;
      return;
    }
    if (restore.current) {
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top;
      restore.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    stick.current = false;
  }, [messages, firstUnread]);

  const loaded = messages !== null;
  // Late-loading images change heights; stay pinned to the bottom when we were there.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [loaded]);

  const loadOlder = async () => {
    if (!messages?.length || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    const el = scroller.current!;
    const r = await getMessages(id, messages[0].id);
    if (r.ok) {
      restore.current = { height: el.scrollHeight, top: el.scrollTop };
      setMessages((list) => {
        const have = new Set((list ?? []).map((m) => m.id));
        return [...r.data.messages.filter((m) => !have.has(m.id)), ...(list ?? [])];
      });
      setHasMore(r.data.hasMore);
    }
    setLoadingOlder(false);
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const wasAtBottom = atBottom.current;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current && !wasAtBottom) sendRead();
    if (el.scrollTop < 150) void loadOlder();
  };

  const onSent = (m: ChatMessage) => {
    stick.current = true;
    atBottom.current = true;
    upsert(m, true);
  };

  const nameOf = useCallback(
    (userId: number) => (userId === me.id ? t("you") : (detail?.members.find((u) => u.id === userId)?.name ?? t("someone"))),
    [detail, me.id, t],
  );

  const meetNow = () => {
    if (busy) return;
    const ongoing = detailRef.current?.ongoing;
    if (!openMeetNow({ c: id })) return flash(errorText("failed"));
    // The new tab starts the meeting server-side; pick up its card shortly after.
    if (!ongoing) setTimeout(() => void refreshMeetings(), 2500);
  };

  const join = async () => {
    setBusy(true);
    const r = await joinChannel(id);
    setBusy(false);
    if (!r.ok) return flash(errorText(r.error));
    await reloadDetail();
    onChanged();
  };

  const view = detail ?? (summary ? ({ ...summary, members: [], description: "", teamName: null } as Partial<ConversationDetail> & ConversationSummary) : null);
  const title = view?.name ?? "";
  const subtitle = detail
    ? detail.kind === "channel"
      ? [detail.teamName, detail.description].filter(Boolean).join(" · ")
      : detail.kind === "group"
        ? t("memberCount", { count: detail.memberCount })
        : (detail.peer?.email ?? "")
    : "";

  if (failed) {
    return (
      <div className="grid flex-1 place-items-center p-10 text-center">
        <div>
          <p className="text-[15px] font-medium text-ink">{failed === "notFound" ? t("notFoundTitle") : t("errors.failed")}</p>
          <button type="button" onClick={onBack} className={`${BTN} mt-4`}>
            <ArrowLeft size={14} aria-hidden />
            {t("back")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        className="relative flex min-w-0 flex-1 flex-col"
        onDragEnter={(e) => {
          if (!joined || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (joined && e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          if (!joined) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) addFilesRef.current?.(files);
        }}
      >
        {/* Header */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-2 md:px-4">
          <button type="button" onClick={onBack} className="icon-btn h-9 w-9 md:hidden" aria-label={t("back")}>
            <ArrowLeft size={18} aria-hidden />
          </button>
          {view ? <ConversationIcon c={view} size={30} /> : <span className="h-[30px] w-[30px] animate-pulse rounded-full bg-hover" />}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[14.5px] font-semibold text-ink">{title || " "}</h2>
            {subtitle && <p className="truncate text-[12px] text-ink-mute">{subtitle}</p>}
          </div>

          {detail && detail.kind !== "dm" && (
            <button
              type="button"
              onClick={() => setPanel((p) => (p?.kind === "members" ? null : { kind: "members" }))}
              className="hidden h-8 items-center rounded-md px-1.5 hover:bg-hover sm:flex"
              aria-label={t("members")}
              aria-pressed={panel?.kind === "members"}
              title={t("members")}
            >
              <span className="flex -space-x-1.5">
                {detail.members.slice(0, 4).map((u) => (
                  <Avatar key={u.id} name={u.name} email={u.email} size={22} className="ring-2 ring-sheet" />
                ))}
              </span>
              <span className="ml-1.5 text-[12px] text-ink-mute tabular-nums">{detail.memberCount}</span>
            </button>
          )}

          {detail && <MeetingsPopover detail={detail} />}

          {joined && (
            <>
              <button
                type="button"
                onClick={() => setScheduling(true)}
                className={`${BTN} px-2 sm:px-3`}
                aria-label={t("schedule")}
                title={t("schedule")}
              >
                <CalendarPlus size={15} aria-hidden />
                <span className="hidden lg:inline">{t("schedule")}</span>
              </button>
              <button
                type="button"
                onClick={meetNow}
                disabled={busy}
                className={`${BTN_MEET} px-2 sm:px-3`}
                style={{ background: "var(--color-app-meet)" }}
                aria-label={detail?.ongoing ? t("joinMeeting") : t("meetNow")}
                title={detail?.ongoing ? t("joinMeeting") : t("meetNow")}
              >
                <Video size={15} aria-hidden />
                <span className="hidden sm:inline">{detail?.ongoing ? t("joinMeeting") : t("meetNow")}</span>
              </button>
            </>
          )}
          {detail && detail.kind !== "dm" && (
            <button
              type="button"
              onClick={() => setPanel((p) => (p?.kind === "members" ? null : { kind: "members" }))}
              className={`${BTN} px-2 sm:hidden`}
              aria-label={t("members")}
            >
              {detail.memberCount}
            </button>
          )}
        </header>

        {detail?.ongoing && <OngoingBanner meeting={detail.ongoing} me={me} canEnd={joined} />}
        {notice && (
          <p role="alert" className="shrink-0 border-b border-line bg-danger/10 px-4 py-2 text-[12.5px] text-danger">
            {notice}
          </p>
        )}

        {/* Messages */}
        <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-live="polite" aria-relevant="additions">
          <div ref={content} className="flex min-h-full flex-col justify-end pt-4 pb-2">
            {messages === null ? (
              <Skeleton />
            ) : (
              <>
                {hasMore ? (
                  <div className="grid h-10 place-items-center">
                    {loadingOlder && <Loader2 size={16} className="animate-spin text-ink-mute" aria-label={t("loading")} />}
                  </div>
                ) : (
                  view && <Intro c={view} />
                )}
                {messages.map((m, i) => {
                  const prev = messages[i - 1];
                  const newDay = !prev || dayKey(prev.created) !== dayKey(m.created);
                  const unreadLine = m.id === firstUnread;
                  const grouped =
                    !!prev &&
                    !newDay &&
                    !unreadLine &&
                    groupable(m) &&
                    groupable(prev) &&
                    !prev.deleted &&
                    prev.author?.id === m.author?.id &&
                    m.created - prev.created < GROUP_GAP_MS;
                  return (
                    <Fragment key={m.id}>
                      {newDay && (
                        <div className="flex items-center gap-3 px-5 pt-4 pb-2" role="separator">
                          <span className="h-px flex-1 bg-line" />
                          <span className="text-[11.5px] font-medium text-ink-mute">{dayLabel(m.created, locale, t)}</span>
                          <span className="h-px flex-1 bg-line" />
                        </div>
                      )}
                      {unreadLine && (
                        <div data-unread-marker className="flex items-center gap-3 px-5 py-1" role="separator">
                          <span className="h-px flex-1 bg-danger/50" />
                          <span className="text-[11px] font-semibold tracking-wide text-danger uppercase">{t("newMessages")}</span>
                          <span className="h-px flex-1 bg-danger/50" />
                        </div>
                      )}
                      <MessageItem
                        m={m}
                        me={me}
                        grouped={grouped}
                        nameOf={nameOf}
                        onUpdate={(x) => upsert(x, false)}
                        onReply={joined || m.replyCount > 0 ? () => setPanel({ kind: "thread", root: m.id }) : undefined}
                        canInteract={joined}
                      />
                    </Fragment>
                  );
                })}
              </>
            )}
          </div>
        </div>

        <div className="h-5 shrink-0 truncate px-5 text-[12px] text-ink-mute" aria-live="polite">
          {typingNames.length > 0 &&
            (typingNames.length === 1
              ? t("typingOne", { name: typingNames[0] })
              : typingNames.length === 2
                ? t("typingTwo", { a: typingNames[0], b: typingNames[1] })
                : t("typingMany"))}
        </div>

        {detail && !joined ? (
          <div className="flex shrink-0 items-center justify-center gap-3 border-t border-line px-4 py-3">
            <span className="text-[13px] text-ink-mute">{t("notInChannel")}</span>
            <button type="button" onClick={join} disabled={busy} className={BTN_PRIMARY}>
              {t("joinChannel")}
            </button>
          </div>
        ) : (
          detail && (
            <Composer
              conversationId={id}
              threadRoot={null}
              me={me}
              members={detail.members}
              placeholder={t("messagePlaceholder", { name: detail.kind === "channel" ? `#${detail.name}` : detail.name })}
              onSent={onSent}
              addFilesRef={addFilesRef}
            />
          )
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-sheet/90">
            <div className="text-center">
              <Upload size={26} className="mx-auto text-accent" aria-hidden />
              <p className="mt-2 text-[14px] font-medium text-ink">{t("dropFiles")}</p>
              <p className="mt-1 text-[12px] text-ink-mute">{t("dropFilesHint")}</p>
            </div>
          </div>
        )}
      </div>

      {panel && detail && (
        <aside className="absolute inset-0 z-20 flex flex-col bg-sheet lg:static lg:z-auto lg:w-[360px] lg:shrink-0 lg:border-l lg:border-line">
          {panel.kind === "thread" ? (
            <ThreadPanel
              key={panel.root}
              rootId={panel.root}
              conversation={detail}
              me={me}
              subscribe={subscribe}
              nameOf={nameOf}
              onClose={() => setPanel(null)}
            />
          ) : (
            <MembersPanel
              conversation={detail}
              me={me}
              onClose={() => setPanel(null)}
              onChanged={async () => {
                await reloadDetail();
                onChanged();
              }}
              onLeft={() => {
                onChanged();
                onOpen(null);
              }}
            />
          )}
        </aside>
      )}

      {scheduling && detail && (
        <ScheduleDialog
          conversation={detail}
          me={me}
          onClose={() => setScheduling(false)}
          onScheduled={(m) => {
            setScheduling(false);
            onSent(m);
            void refreshMeetings();
          }}
        />
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-5 px-5 py-4" aria-hidden>
      {[72, 48, 85, 60, 38].map((w, i) => (
        <div key={i} className="flex gap-3">
          <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-hover" />
          <div className="flex-1 space-y-2">
            <span className="block h-3 w-28 animate-pulse rounded bg-hover" />
            <span className="block h-3 animate-pulse rounded bg-hover" style={{ width: `${w}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Intro({ c }: { c: ConversationSummary }) {
  const t = useTranslations("chat");
  return (
    <div className="px-5 pt-6 pb-4">
      <ConversationIcon c={c} size={48} />
      <p className="mt-3 text-[17px] font-semibold text-ink">{c.kind === "channel" ? `#${c.name}` : c.name}</p>
      <p className="mt-1 text-[13px] text-ink-mute">
        {c.kind === "dm" ? t("introDm", { name: c.name }) : c.kind === "channel" ? t("introChannel", { name: c.name }) : t("introGroup")}
      </p>
    </div>
  );
}

function OngoingBanner({ meeting, me, canEnd }: { meeting: MeetingInfo; me: ChatUser; canEnd: boolean }) {
  const t = useTranslations("chat");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = Math.max(0, Math.round((now - meeting.start) / 60_000));
  const who = meeting.startedBy?.id === me.id ? t("you") : (meeting.startedBy?.name ?? t("someone"));
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line bg-[color-mix(in_oklab,var(--color-app-meet)_8%,transparent)] px-4 py-2">
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: "var(--color-app-meet)" }} />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: "var(--color-app-meet)" }} />
      </span>
      <p className="min-w-0 flex-1 truncate text-[13px] text-ink">
        <span className="font-medium">{t("ongoing")}</span>
        <span className="text-ink-mute"> · {t("ongoingDetail", { who, minutes })}</span>
      </p>
      {canEnd && (
        <button type="button" onClick={() => void endMeeting(meeting.id)} className="hidden text-[12.5px] text-ink-mute hover:text-ink sm:block">
          {t("endMeeting")}
        </button>
      )}
      <a href={meetHref(meeting.code)} target="_blank" rel="noopener" className={BTN_MEET} style={{ background: "var(--color-app-meet)" }}>
        <Video size={14} aria-hidden />
        {t("join")}
      </a>
    </div>
  );
}

function MeetingsPopover({ detail }: { detail: ConversationDetail }) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const pop = usePopover();
  const count = detail.upcoming.length;
  return (
    <div ref={pop.ref} className="relative">
      <button
        type="button"
        onClick={pop.toggle}
        className="icon-btn relative h-8 w-8"
        aria-label={t("upcomingMeetings")}
        title={t("upcomingMeetings")}
        aria-expanded={pop.open}
        aria-haspopup="dialog"
      >
        <CalendarClock size={17} aria-hidden />
        {count > 0 && (
          <span className="absolute top-0.5 right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent px-0.5 text-[9px] font-semibold text-white tabular-nums">
            {count}
          </span>
        )}
      </button>
      {pop.open && (
        <div role="dialog" aria-label={t("upcomingMeetings")} className="pop absolute top-10 right-0 z-30 w-[300px] p-2">
          <p className="px-2 pt-1 pb-2 font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase">{t("upcomingMeetings")}</p>
          {count === 0 ? (
            <p className="px-2 pb-2 text-[13px] text-ink-mute">{t("noUpcoming")}</p>
          ) : (
            <ul className="space-y-0.5">
              {detail.upcoming.map((m) => (
                <li key={m.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ink">{m.title || t("meeting")}</p>
                    <p className="text-[12px] text-ink-mute">
                      {new Date(m.start).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })} ·{" "}
                      {timeOf(m.start, locale)}
                      {m.end ? ` – ${timeOf(m.end, locale)}` : ""}
                    </p>
                  </div>
                  <a href={meetHref(m.code)} target="_blank" rel="noopener" className="shrink-0 text-[12.5px] font-medium text-accent hover:underline">
                    {t("join")}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
