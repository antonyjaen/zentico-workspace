"use client";

import { CalendarCheck, Download, FileText, MessageSquareReply, Pencil, SmilePlus, Trash2, Video } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { memo, useEffect, useRef, useState } from "react";
import { usePopover } from "@/components/usePopover";
import { meetHref } from "../meet/shared";
import { deleteMessage, editMessage, endMeeting, react } from "./actions";
import { Markdown, mentionsMe } from "./Markdown";
import {
  BODY_MAX,
  fileHref,
  formatSize,
  isPreviewableImage,
  MEETING_LIVE_MS,
  REACTIONS,
  type ChatMessage,
  type ChatUser,
  type FileMeta,
  type MeetingMeta,
} from "./shared";
import { Avatar, BTN, BTN_MEET, shortTime, timeOf, useErrorText } from "./ui";

type Props = {
  m: ChatMessage;
  me: ChatUser;
  /** Continuation of the previous message by the same author (no avatar/name). */
  grouped: boolean;
  nameOf: (userId: number) => string;
  onUpdate: (m: ChatMessage) => void;
  /** Opens the thread panel; omitted inside the thread itself. */
  onReply?: () => void;
  canInteract: boolean;
};

export const MessageItem = memo(function MessageItem({ m, me, grouped, nameOf, onUpdate, onReply, canInteract }: Props) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const errorText = useErrorText();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = usePopover();
  const mine = m.author?.id === me.id;
  const meHandle = me.email.split("@")[0].toLowerCase();

  if (m.kind === "system") return <SystemLine m={m} />;

  const toggleReaction = async (emoji: string) => {
    picker.setOpen(false);
    const r = await react(m.id, emoji);
    if (r.ok) onUpdate(r.data);
  };

  const remove = async () => {
    setConfirmDelete(false);
    const r = await deleteMessage(m.id);
    if (!r.ok) setError(errorText(r.error));
  };

  const highlighted = !mine && !m.deleted && mentionsMe(m.body, meHandle);

  return (
    <div
      className={`group relative flex gap-3 px-4 transition-colors hover:bg-hover/60 md:px-5 ${grouped ? "py-0.5" : "pt-2 pb-0.5"} ${highlighted ? "bg-amber/[0.07]" : ""}`}
      data-message-id={m.id}
    >
      <div className="w-8 shrink-0">
        {grouped ? (
          <span className="block pt-1 text-right text-[10px] text-ink-mute tabular-nums opacity-0 group-hover:opacity-100">
            {timeOf(m.created, locale)}
          </span>
        ) : (
          m.author && <Avatar name={m.author.name} email={m.author.email} size={32} className="mt-0.5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px] font-semibold text-ink">{m.author?.name ?? t("someone")}</span>
            <time dateTime={new Date(m.created).toISOString()} className="shrink-0 text-[11px] text-ink-mute tabular-nums" title={new Date(m.created).toLocaleString(locale)}>
              {shortTime(m.created, locale) === timeOf(m.created, locale) ? timeOf(m.created, locale) : `${shortTime(m.created, locale)} ${timeOf(m.created, locale)}`}
            </time>
          </div>
        )}

        {m.deleted ? (
          <p className="text-[13.5px] text-ink-mute italic">{t("deleted")}</p>
        ) : editing ? (
          <EditBox
            initial={m.body}
            onCancel={() => setEditing(false)}
            onSave={async (text) => {
              const r = await editMessage(m.id, text);
              if (r.ok) {
                onUpdate(r.data);
                setEditing(false);
              } else setError(errorText(r.error));
            }}
          />
        ) : (
          <>
            {m.kind === "meeting" && m.meta?.meeting ? (
              <MeetingCard created={m.created} meeting={m.meta.meeting} author={m.author} description={m.body} canInteract={canInteract} me={me} />
            ) : (
              m.body && (
                <div className="text-[14px] leading-relaxed break-words whitespace-pre-wrap text-ink">
                  <Markdown text={m.body} meHandle={meHandle} />
                  {m.edited && <span className="ml-1.5 text-[11px] text-ink-mute">{t("edited")}</span>}
                </div>
              )
            )}
            {m.meta?.files && m.meta.files.length > 0 && <Attachments files={m.meta.files} />}
          </>
        )}

        {error && <p className="mt-1 text-[12px] text-danger">{error}</p>}

        {m.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.reactions.map((r) => {
              const reacted = r.users.includes(me.id);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  disabled={!canInteract}
                  onClick={() => toggleReaction(r.emoji)}
                  title={r.users.map(nameOf).join(", ")}
                  aria-pressed={reacted}
                  className={`flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] tabular-nums transition-colors ${
                    reacted ? "border-accent/50 bg-accent/10 text-ink" : "border-line text-ink-soft hover:border-line-strong"
                  }`}
                >
                  <span aria-hidden>{r.emoji}</span>
                  {r.users.length}
                </button>
              );
            })}
          </div>
        )}

        {onReply && m.replyCount > 0 && (
          <button type="button" onClick={onReply} className="mt-1 flex items-center gap-1.5 text-[12.5px] font-medium text-accent hover:underline">
            <MessageSquareReply size={13} aria-hidden />
            {t("replies", { count: m.replyCount })}
            {m.lastReplyAt && <span className="font-normal text-ink-mute">· {shortTime(m.lastReplyAt, locale)}</span>}
          </button>
        )}
      </div>

      {canInteract && !m.deleted && !editing && (
        <div
          ref={picker.ref}
          className={`absolute -top-3 right-4 z-10 items-center gap-0.5 rounded-md border border-line bg-sheet p-0.5 shadow-sm ${
            picker.open || confirmDelete ? "flex" : "hidden group-focus-within:flex group-hover:flex"
          }`}
        >
          {confirmDelete ? (
            <>
              <span className="px-1.5 text-[12px] text-ink-soft">{t("confirmDelete")}</span>
              <button type="button" onClick={remove} className="h-7 rounded px-2 text-[12px] font-medium text-danger hover:bg-hover">
                {t("delete")}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="h-7 rounded px-2 text-[12px] text-ink-soft hover:bg-hover">
                {t("cancel")}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={picker.toggle} className="icon-btn h-7 w-7" aria-label={t("addReaction")} title={t("addReaction")} aria-expanded={picker.open}>
                <SmilePlus size={15} aria-hidden />
              </button>
              {onReply && (
                <button type="button" onClick={onReply} className="icon-btn h-7 w-7" aria-label={t("replyInThread")} title={t("replyInThread")}>
                  <MessageSquareReply size={15} aria-hidden />
                </button>
              )}
              {mine && (m.kind === "text" || m.kind === "file") && (
                <button type="button" onClick={() => setEditing(true)} className="icon-btn h-7 w-7" aria-label={t("edit")} title={t("edit")}>
                  <Pencil size={14} aria-hidden />
                </button>
              )}
              {mine && (
                <button type="button" onClick={() => setConfirmDelete(true)} className="icon-btn h-7 w-7 hover:text-danger" aria-label={t("delete")} title={t("delete")}>
                  <Trash2 size={14} aria-hidden />
                </button>
              )}
            </>
          )}
          {picker.open && (
            <div role="menu" className="pop absolute top-9 right-0 z-20 flex gap-0.5 p-1">
              {REACTIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  role="menuitem"
                  onClick={() => toggleReaction(e)}
                  className="grid h-8 w-8 place-items-center rounded-md text-[18px] transition-transform hover:scale-110 hover:bg-hover"
                  aria-label={e}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function SystemLine({ m }: { m: ChatMessage }) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const s = m.meta?.system;
  const who = m.author?.name ?? t("someone");
  let text = "";
  switch (s?.action) {
    case "created":
      text = s.name ? t("sys.createdNamed", { who, name: s.name }) : t("sys.created", { who });
      break;
    case "added":
      text = t("sys.added", { who, names: (s.names ?? []).join(", ") });
      break;
    case "joined":
      text = t("sys.joined", { who });
      break;
    case "left":
      text = t("sys.left", { who });
      break;
    case "renamed":
      text = s.name ? t("sys.renamed", { who, name: s.name }) : t("sys.renamedCleared", { who });
      break;
    default:
      text = m.body;
  }
  return (
    <p className="px-5 py-1.5 text-center text-[12px] text-ink-mute">
      {text} · <span className="tabular-nums">{timeOf(m.created, locale)}</span>
    </p>
  );
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const t = useTranslations("chat");
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    }
  }, [text]);
  const save = async () => {
    if (busy) return;
    if (text.trim() === initial.trim()) return onCancel();
    setBusy(true);
    await onSave(text);
    setBusy(false);
  };
  return (
    <div className="mt-1">
      <textarea
        ref={ref}
        value={text}
        maxLength={BODY_MAX}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
        rows={1}
        className="w-full resize-none rounded-md border border-line-strong bg-sheet px-2.5 py-1.5 text-[14px] leading-relaxed text-ink outline-none focus:border-ink-mute"
      />
      <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-mute">
        <button type="button" onClick={save} disabled={busy} className="font-medium text-accent hover:underline">
          {t("save")}
        </button>
        <button type="button" onClick={onCancel} className="hover:text-ink">
          {t("cancel")}
        </button>
        <span>{t("editHint")}</span>
      </div>
    </div>
  );
}

function Attachments({ files }: { files: FileMeta[] }) {
  const t = useTranslations("chat");
  const images = files.filter((f) => isPreviewableImage(f.mime));
  const others = files.filter((f) => !isPreviewableImage(f.mime));
  return (
    <div className="mt-1.5 space-y-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((f) => (
            <a key={f.id} href={fileHref(f.id)} target="_blank" rel="noopener" className="block overflow-hidden rounded-lg border border-line bg-sheet-muted" title={f.name}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fileHref(f.id)} alt={f.name} loading="lazy" className="max-h-64 max-w-[min(100%,360px)] object-contain" />
            </a>
          ))}
        </div>
      )}
      {others.map((f) => (
        <a
          key={f.id}
          href={fileHref(f.id, true)}
          className="flex max-w-sm items-center gap-3 rounded-lg border border-line px-3 py-2 transition-colors hover:border-line-strong hover:bg-hover"
          title={t("download")}
        >
          <FileText size={20} className="shrink-0 text-ink-mute" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-ink">{f.name}</span>
            <span className="block text-[11.5px] text-ink-mute">{formatSize(f.size)}</span>
          </span>
          <Download size={15} className="shrink-0 text-ink-mute" aria-hidden />
        </a>
      ))}
    </div>
  );
}

function MeetingCard({
  meeting,
  author,
  description,
  canInteract,
  me,
  created,
}: {
  created: number;
  meeting: MeetingMeta;
  author: ChatUser | null;
  description: string;
  canInteract: boolean;
  me: ChatUser;
}) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const who = author?.id === me.id ? t("you") : (author?.name ?? t("someone"));
  const scheduled = meeting.type === "scheduled";
  const over =
    !!meeting.ended || (scheduled ? !!meeting.end && meeting.end < now : now - created > MEETING_LIVE_MS);
  const href = meetHref(meeting.code);

  let when = "";
  if (scheduled && meeting.start && meeting.end) {
    const day = new Date(meeting.start).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
    when = `${day} · ${timeOf(meeting.start, locale)} – ${timeOf(meeting.end, locale)}`;
  }

  return (
    <div className="mt-1 max-w-md overflow-hidden rounded-lg border border-line">
      <div className="flex items-start gap-3 p-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white"
          style={{ background: over ? "var(--color-ink-mute)" : "var(--color-app-meet)" }}
          aria-hidden
        >
          <Video size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-ink">
            {scheduled ? t("meetingScheduled", { who }) : t("meetingStarted", { who })}
          </p>
          {scheduled && meeting.title && <p className="mt-0.5 truncate text-[13.5px] text-ink">{meeting.title}</p>}
          {when && <p className="mt-0.5 text-[12.5px] text-ink-soft">{when}</p>}
          <p className="mt-0.5 font-mono text-[11.5px] text-ink-mute">{meeting.code}</p>
          {meeting.calendar && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-mute">
              <CalendarCheck size={13} aria-hidden />
              {t("addedToCalendar")}
            </p>
          )}
        </div>
      </div>
      {description && (
        <p className="border-t border-line px-3 py-2 text-[13px] whitespace-pre-wrap text-ink-soft">{description}</p>
      )}
      <div className="flex items-center gap-2 border-t border-line bg-sheet-muted px-3 py-2">
        {over ? (
          <span className="text-[12.5px] text-ink-mute">
            {meeting.ended ? t("meetingEndedAt", { time: timeOf(meeting.ended, locale) }) : t("meetingOver")}
          </span>
        ) : (
          <>
            <a href={href} target="_blank" rel="noopener" className={BTN_MEET} style={{ background: "var(--color-app-meet)" }}>
              <Video size={14} aria-hidden />
              {t("join")}
            </a>
            {!scheduled && canInteract && (
              <button type="button" onClick={() => void endMeeting(meeting.meetingId)} className={BTN}>
                {t("endMeeting")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
