"use client";

import {
  ChevronDown,
  Code,
  Download,
  Ellipsis,
  EllipsisVertical,
  Forward,
  ListFilter,
  Lock,
  MailOpen,
  Paperclip,
  Reply,
  ReplyAll,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { forwardRef, Fragment, useState } from "react";
import { composeHref } from "../../../hrefs";
import type { Address, ReadMessage } from "@/lib/mail-read";
import { usePopover } from "@/components/usePopover";
import { AttachmentGrid } from "./Attachments";
import { avatarGradient, formatFull, formatRelative, formatShort, initials } from "./format";
import { MessageFrame, type AppTheme, type FrameMode } from "./MessageFrame";

export type MessageAction = "markUnreadFromHere" | "delete" | "source" | "star";

type Props = {
  m: ReadMessage;
  me: string | null;
  expanded: boolean;
  focused: boolean;
  theme: AppTheme | null;
  currentPath: string;
  inTrash: boolean;
  starred: boolean;
  onToggle: () => void;
  onAction: (action: MessageAction) => void;
  onPreview: (attachmentIndex: number) => void;
  onToast: (message: string) => void;
};

export const MessageCard = forwardRef<HTMLLIElement, Props>(function MessageCard(
  { m, me, expanded, focused, theme, currentPath, inTrash, starred, onToggle, onAction, onPreview, onToast },
  ref,
) {
  const t = useTranslations("mailRead");
  const locale = useLocale();
  const sender = m.from[0];
  const senderLabel = sender ? sender.name || sender.email : t("unknownSender");
  const date = new Date(m.sentAt ?? m.receivedAt);
  const isMe = (a: Address) => !!me && a.email.toLowerCase() === me;
  const name = (a: Address) => (isMe(a) ? t("me") : a.name || a.email);
  const isDraft = !!m.keywords.$draft;

  const focusRing = focused ? "shadow-[inset_2px_0_0_var(--color-accent)]" : "";

  if (!expanded) {
    return (
      <li ref={ref} data-message-id={m.id} className={`scroll-mt-4 ${focusRing} print:hidden`}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-hover sm:px-4"
        >
          <Avatar address={sender} label={senderLabel} size={32} />
          <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-3">
            <span className="shrink-0 truncate text-[13.5px] font-semibold text-ink sm:max-w-[34%]">
              {isDraft ? <span className="text-danger">{t("draft")}</span> : senderLabel}
            </span>
            <span className="min-w-0 truncate text-[13px] text-ink-mute">{m.preview}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {m.attachments.length > 0 && <Paperclip size={13} className="text-ink-mute" aria-label={t("attachments")} />}
            {starred && <Star size={13} className="fill-amber text-amber" aria-label={t("starred")} />}
            <time dateTime={date.toISOString()} suppressHydrationWarning className="text-[12px] tabular-nums text-ink-mute">
              {formatShort(date, locale)}
            </time>
          </span>
        </button>
      </li>
    );
  }

  // Relative time depends on "now": only after hydration (theme is null until then).
  const relative = theme ? formatRelative(date, locale) : null;

  return (
    <li ref={ref} data-message-id={m.id} className={`scroll-mt-4 ${focusRing}`}>
      <article aria-label={t("messageFrom", { sender: senderLabel })} className="px-3 pb-5 pt-3.5 sm:px-5">
        <header className="flex items-start gap-3">
          <button type="button" onClick={onToggle} aria-label={t("collapse")} className="shrink-0 rounded-full print:hidden">
            <Avatar address={sender} label={senderLabel} size={40} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex cursor-pointer flex-wrap items-baseline gap-x-2" onClick={onToggle}>
              <span className="truncate text-[14.5px] font-semibold text-ink">{senderLabel}</span>
              {sender?.name && <span className="truncate text-[12.5px] text-ink-mute">&lt;{sender.email}&gt;</span>}
              {isDraft && <span className="text-[12px] font-medium text-danger">{t("draft")}</span>}
            </div>
            <Details m={m} name={name} senderLabel={senderLabel} date={date} />
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <time
              dateTime={date.toISOString()}
              title={formatFull(date, locale)}
              suppressHydrationWarning
              className="mr-1 hidden text-right text-[12px] tabular-nums leading-tight text-ink-mute sm:block"
            >
              {formatShort(date, locale)}
              {relative && <span className="block text-[11px] text-ink-mute/80">{relative}</span>}
            </time>
            <button
              type="button"
              onClick={() => onAction("star")}
              aria-pressed={starred}
              aria-label={starred ? t("unstar") : t("star")}
              title={starred ? t("unstar") : t("star")}
              className="icon-btn h-8 w-8 print:hidden"
            >
              <Star size={16} aria-hidden className={starred ? "fill-amber text-amber" : ""} />
            </button>
            <Link
              href={composeHref(currentPath, isDraft ? "draft" : "reply", m.id)}
              scroll={false}
              aria-label={isDraft ? t("editDraft") : t("reply")}
              title={isDraft ? t("editDraft") : t("reply")}
              className="icon-btn h-8 w-8 print:hidden"
            >
              <Reply size={16} aria-hidden />
            </Link>
            <MessageMenu m={m} currentPath={currentPath} inTrash={inTrash} onAction={onAction} />
          </div>
        </header>

        <div className="mt-3 sm:pl-[52px]">
          <time dateTime={date.toISOString()} suppressHydrationWarning className="mb-2 block text-[12px] text-ink-mute sm:hidden">
            {formatShort(date, locale)}
            {relative && ` · ${relative}`}
          </time>
          <MessageBody m={m} theme={theme} senderLabel={senderLabel} />
          {m.truncated && <p className="mt-3 text-[12.5px] text-ink-mute">{t("truncated")}</p>}
          {m.attachments.length > 0 && <AttachmentGrid attachments={m.attachments} onPreview={onPreview} onToast={onToast} />}
        </div>
      </article>
    </li>
  );
});

/* ------------------------------------------------------------------ body */

function MessageBody({ m, theme, senderLabel }: { m: ReadMessage; theme: AppTheme | null; senderLabel: string }) {
  const t = useTranslations("mailRead");
  const [showQuotes, setShowQuotes] = useState(false);
  const [hasQuotes, setHasQuotes] = useState(false);
  // Per-message override of the automatic look (only offered in dark theme).
  const [original, setOriginal] = useState<boolean | null>(null);

  if (m.html === null) {
    const [body, quote] = splitQuote(m.text ?? "");
    return (
      <>
        <PlainText text={body} />
        {quote && (
          <>
            <QuoteToggle open={showQuotes} onClick={() => setShowQuotes((v) => !v)} />
            {showQuotes && (
              <div className="mt-2 border-l-2 border-line pl-3 text-ink-soft">
                <PlainText text={quote} muted />
              </div>
            )}
          </>
        )}
      </>
    );
  }

  const dark = theme === "dark";
  // Simple mail blends with the app; designed mail keeps its white paper (or an inverted dark take).
  const auto: FrameMode = m.rich ? "paper" : "themed";
  const mode: FrameMode = !dark || original === null ? auto : m.rich ? (original ? "paper" : "inverted") : original ? "paper" : "themed";
  const showingOriginal = mode === "paper";

  return (
    <>
      {dark && (
        <div className="mb-2 flex justify-end print:hidden">
          <button
            type="button"
            onClick={() => setOriginal(!showingOriginal)}
            className="inline-flex h-6 items-center rounded-md px-2 text-[11.5px] text-ink-mute transition-colors hover:bg-hover hover:text-ink"
          >
            {showingOriginal ? (m.rich ? t("viewDark") : t("matchTheme")) : t("viewOriginal")}
          </button>
        </div>
      )}
      {theme ? (
        <MessageFrame
          srcDoc={m.html}
          title={t("messageFrom", { sender: senderLabel })}
          theme={theme}
          mode={mode}
          showQuotes={showQuotes}
          onQuotes={setHasQuotes}
        />
      ) : (
        <div className="h-[120px]" aria-hidden />
      )}
      {hasQuotes && <QuoteToggle open={showQuotes} onClick={() => setShowQuotes((v) => !v)} />}
    </>
  );
}

function QuoteToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  const t = useTranslations("mailRead");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={open ? t("hideQuoted") : t("showQuoted")}
      title={open ? t("hideQuoted") : t("showQuoted")}
      className="mt-2 inline-flex h-5 items-center rounded-full border border-line-strong bg-sheet-muted px-2 text-ink-mute transition-colors hover:bg-hover hover:text-ink print:hidden"
    >
      <Ellipsis size={14} aria-hidden />
    </button>
  );
}

const ATTRIBUTION_LINE = /^(On\b.*\bwrote:|El\b.*\bescribió:|Le\b.*\ba écrit\s?:|Am\b.*\bschrieb\b.*:)\s*$/i;
const ORIGINAL_HEADER = /^-{2,}\s*(Original Message|Mensaje original|Message d'origine)\s*-{2,}\s*$/i;

/** Splits a plain-text body into what was written and the quoted history after it. */
function splitQuote(text: string): [string, string | null] {
  const lines = text.split(/\r?\n/);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (ATTRIBUTION_LINE.test(l) || ORIGINAL_HEADER.test(l)) {
      idx = i;
      break;
    }
    // Wrapped attribution: "On Mon, … Ada Lovelace" / "<ada@x.io> wrote:"
    if (/^(On|El)\b/i.test(l) && i + 1 < lines.length && /(wrote|escribió):\s*$/i.test(lines[i + 1].trim()) && l.length < 200) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    // A trailing block of "> " lines.
    let j = lines.length;
    while (j > 0 && (lines[j - 1].startsWith(">") || !lines[j - 1].trim())) j--;
    if (j < lines.length && lines.slice(j).some((l) => l.startsWith(">"))) idx = j;
  }
  if (idx <= 0) return [text, null];
  const body = lines.slice(0, idx).join("\n").replace(/\s+$/, "");
  if (!body.trim()) return [text, null];
  return [body, lines.slice(idx).join("\n")];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

/** Plain-text body with whitespace preserved and URLs turned into links. */
function PlainText({ text, muted }: { text: string; muted?: boolean }) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(
      <a key={start} href={match[0]} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline">
        {match[0]}
      </a>,
    );
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return (
    <div
      className={`whitespace-pre-wrap break-words text-[14px] leading-[1.6] [overflow-wrap:anywhere] ${muted ? "text-ink-soft" : "text-ink"}`}
    >
      {nodes}
    </div>
  );
}

/* --------------------------------------------------------------- header */

function Avatar({ address, label, size }: { address: Address | undefined; label: string; size: number }) {
  return (
    <span
      className="grid shrink-0 select-none place-items-center rounded-full font-semibold text-white ring-1 ring-line [text-shadow:0_1px_1px_rgb(0_0_0/0.25)] print:hidden"
      style={{ width: size, height: size, fontSize: size * 0.36, background: avatarGradient(address?.email ?? label) }}
      aria-hidden
    >
      {initials(address?.name ?? null, address?.email ?? label)}
    </span>
  );
}

function Details({
  m,
  name,
  senderLabel,
  date,
}: {
  m: ReadMessage;
  name: (a: Address) => string;
  senderLabel: string;
  date: Date;
}) {
  const t = useTranslations("mailRead");
  const locale = useLocale();
  const { open, toggle, ref } = usePopover();

  const summary: string[] = [];
  if (m.to.length) summary.push(`${t("to")} ${m.to.map(name).join(", ")}`);
  if (m.cc.length) summary.push(`${t("cc")} ${m.cc.map(name).join(", ")}`);
  if (m.bcc.length) summary.push(`${t("bcc")} ${m.bcc.map(name).join(", ")}`);
  const fmt = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email);
  const fromDomain = m.from[0]?.email.split("@")[1]?.toLowerCase();
  const d = m.delivery;

  const rows: [string, React.ReactNode][] = [
    [t("details.from"), m.from.length ? m.from.map(fmt).join(", ") : senderLabel],
  ];
  if (m.replyTo.length && m.replyTo[0].email !== m.from[0]?.email) rows.push([t("details.replyTo"), m.replyTo.map(fmt).join(", ")]);
  if (m.to.length) rows.push([t("details.to"), m.to.map(fmt).join(", ")]);
  if (m.cc.length) rows.push([t("details.cc"), m.cc.map(fmt).join(", ")]);
  if (m.bcc.length) rows.push([t("details.bcc"), m.bcc.map(fmt).join(", ")]);
  rows.push([t("details.date"), formatFull(date, locale)]);
  rows.push([t("details.subject"), m.subject || t("noSubject")]);
  if (d.mailedBy || fromDomain) rows.push([t("details.mailedBy"), d.mailedBy ?? fromDomain]);
  if (d.signedBy) rows.push([t("details.signedBy"), d.signedBy]);
  if (d.tls !== null)
    rows.push([
      t("details.security"),
      <span key="tls" className="inline-flex items-center gap-1.5">
        {d.tls && <Lock size={12} aria-hidden className="text-signal" />}
        {d.tls ? t("details.tls") : t("details.noTls")}
      </span>,
    ]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="-ml-1 inline-flex max-w-full items-center gap-0.5 rounded px-1 text-left text-[12.5px] text-ink-mute transition-colors hover:bg-hover hover:text-ink-soft"
      >
        <span className="truncate">{summary.length ? summary.join(" · ") : t("noRecipients")}</span>
        <ChevronDown size={13} aria-hidden className={`shrink-0 transition-transform print:hidden ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div role="dialog" aria-label={t("details.title")} className="pop absolute left-0 top-7 z-30 w-[min(460px,calc(100vw-2rem))] p-4" style={{ transformOrigin: "top left" }}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
            {rows.map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-right text-ink-mute">{label}</dt>
                <dd className="min-w-0 break-words text-ink [overflow-wrap:anywhere]">{value}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

function MessageMenu({
  m,
  currentPath,
  inTrash,
  onAction,
}: {
  m: ReadMessage;
  currentPath: string;
  inTrash: boolean;
  onAction: (a: MessageAction) => void;
}) {
  const t = useTranslations("mailRead");
  const { open, toggle, setOpen, ref } = usePopover();
  const pick = (a: MessageAction) => {
    setOpen(false);
    onAction(a);
  };

  return (
    <div ref={ref} className="relative print:hidden">
      <button type="button" onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label={t("more")} title={t("more")} className="icon-btn h-8 w-8">
        <EllipsisVertical size={16} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="pop absolute right-0 top-9 z-30 w-[230px] p-1.5">
          <MenuLink icon={Reply} label={t("reply")} href={composeHref(currentPath, "reply", m.id)} onClick={() => setOpen(false)} />
          <MenuLink icon={ReplyAll} label={t("replyAll")} href={composeHref(currentPath, "replyAll", m.id)} onClick={() => setOpen(false)} />
          <MenuLink icon={Forward} label={t("forward")} href={composeHref(currentPath, "forward", m.id)} onClick={() => setOpen(false)} />
          <hr className="my-1.5 border-line" />
          <MenuButton icon={MailOpen} label={t("markUnreadFromHere")} onClick={() => pick("markUnreadFromHere")} />
          {m.from[0]?.email && (
            <MenuLink
              icon={ListFilter}
              label={t("filterLike")}
              href={`/mail/settings?tab=filters&from=${encodeURIComponent(m.from[0].email)}`}
              onClick={() => setOpen(false)}
            />
          )}
          <MenuButton icon={Trash2} label={inTrash ? t("deleteMessageForever") : t("deleteMessage")} onClick={() => pick("delete")} danger />
          {m.emlHref && (
            <>
              <hr className="my-1.5 border-line" />
              <a role="menuitem" href={m.emlHref} download onClick={() => setOpen(false)} className={ITEM}>
                <Download size={15} aria-hidden className="text-ink-mute" />
                {t("downloadEml")}
              </a>
              <MenuButton icon={Code} label={t("showOriginal")} onClick={() => pick("source")} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

const ITEM = "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] text-ink transition-colors hover:bg-hover";

function MenuLink({ icon: Icon, label, href, onClick }: { icon: LucideIcon; label: string; href: string; onClick: () => void }) {
  return (
    <Link role="menuitem" href={href} scroll={false} onClick={onClick} className={ITEM}>
      <Icon size={15} aria-hidden className="text-ink-mute" />
      {label}
    </Link>
  );
}

function MenuButton({ icon: Icon, label, onClick, danger }: { icon: LucideIcon; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={`${ITEM} ${danger ? "text-danger" : ""}`}>
      <Icon size={15} aria-hidden className={danger ? "" : "text-ink-mute"} />
      {label}
    </button>
  );
}
