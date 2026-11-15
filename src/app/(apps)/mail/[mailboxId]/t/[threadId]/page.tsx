import { Download, ImageOff, Paperclip, Reply, Star } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { Fragment } from "react";
import { composeHref, threadHref } from "../../../hrefs";
import { MessageFrame } from "./MessageFrame";
import { MarkSeen, ThreadToolbar } from "./ThreadClient";
import { getSession } from "@/lib/auth";
import { getMailboxes, type Mailbox } from "@/lib/mail";
import { getThread, type Address, type ReadMessage } from "@/lib/mail-read";

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ mailboxId: string; threadId: string }>;
  searchParams: Promise<{ images?: string }>;
}) {
  const { mailboxId, threadId } = await params;
  const allowImages = (await searchParams).images === "1";
  const t = await getTranslations("mailRead");
  const locale = await getLocale();

  let messages: ReadMessage[] | null;
  let mailboxes: Mailbox[];
  try {
    [messages, mailboxes] = await Promise.all([getThread(threadId, { allowRemoteImages: allowImages }), getMailboxes()]);
  } catch (e) {
    unstable_rethrow(e);
    return <p className="p-8 text-[15px] text-ink-soft">{t("error")}</p>;
  }
  if (!messages?.length) notFound();

  const session = await getSession();
  const me = session?.email.toLowerCase();
  const mailbox = mailboxes.find((m) => m.id === mailboxId);
  const hidden = new Set(mailboxes.filter((m) => m.role === "sent" || m.role === "drafts").map((m) => m.id));

  // Move actions target the messages in the mailbox the thread was opened from; from search,
  // everything except the user's own sent messages and drafts.
  const inScope = messages.filter((m) =>
    mailbox ? m.mailboxIds[mailbox.id] : !Object.keys(m.mailboxIds).every((id) => hidden.has(id)),
  );
  const actionIds = (inScope.length ? inScope : messages).map((m) => m.id);
  const allIds = messages.map((m) => m.id);
  const unreadIds = messages.filter((m) => !m.keywords.$seen && !m.keywords.$draft).map((m) => m.id);
  const latest = messages[messages.length - 1];
  const basePath = threadHref(mailboxId, threadId);
  const currentPath = allowImages ? `${basePath}?images=1` : basePath;
  const anyRemote = !allowImages && messages.some((m) => m.hasRemoteImages);
  const subject = latest.subject || messages.find((m) => m.subject)?.subject || t("noSubject");

  const fmtFull = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const name = (a: Address) => (me && a.email.toLowerCase() === me ? t("me") : a.name || a.email);

  return (
    <>
      <MarkSeen ids={unreadIds} />
      <ThreadToolbar
        backHref={mailbox ? `/mail/${mailbox.id}` : mailboxId === "search" ? null : "/mail"}
        role={mailbox?.role ?? null}
        actionIds={actionIds}
        allIds={allIds}
        latestId={latest.id}
        starred={messages.some((m) => m.keywords.$flagged)}
        currentPath={currentPath}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[920px] px-3 pb-10 pt-5 sm:px-6">
          <h1 className="rise break-words px-1 text-[20px] font-semibold leading-tight tracking-[-0.01em] text-ink sm:text-[22px]">
            {subject}
            {messages.length > 1 && (
              <span className="ml-2 align-middle font-mono text-[12px] font-normal text-ink-mute">
                {t("messages", { count: messages.length })}
              </span>
            )}
          </h1>

          {anyRemote && (
            <div className="rise mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-sheet-muted px-3.5 py-2.5 text-[13px] text-ink-soft">
              <ImageOff size={15} aria-hidden className="shrink-0 text-ink-mute" />
              <span className="min-w-0 flex-1">{t("imagesBlocked")}</span>
              <Link
                href={`${basePath}?images=1`}
                className="inline-flex h-7 items-center rounded-md border border-line-strong bg-sheet px-2.5 font-medium text-ink transition-colors hover:bg-hover"
              >
                {t("showImages")}
              </Link>
            </div>
          )}

          <ol className="mt-4 flex flex-col gap-2">
            {messages.map((m, i) => {
              const isLatest = i === messages.length - 1;
              const open = isLatest || unreadIds.includes(m.id);
              const sender = m.from[0];
              const senderLabel = sender ? sender.name || sender.email : t("unknownSender");
              const date = m.sentAt ?? m.receivedAt;
              return (
                <li key={m.id} className="rise" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                  <details open={open} className="group rounded-lg border border-line bg-sheet [&[open]]:border-line-strong">
                    <summary className="flex cursor-pointer list-none items-start gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-hover sm:px-4 [&::-webkit-details-marker]:hidden">
                      <span
                        className="mt-0.5 h-8 w-8 shrink-0 rounded-full ring-1 ring-line"
                        style={{ background: avatarGradient(sender?.email ?? senderLabel) }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-[14px] font-semibold text-ink" title={sender?.email}>
                            {senderLabel}
                          </span>
                          {sender && sender.name && (
                            <span className="hidden truncate text-[12.5px] text-ink-mute sm:group-open:inline">
                              &lt;{sender.email}&gt;
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[13px] text-ink-mute group-open:hidden">{m.preview}</span>
                        <span className="hidden text-[12.5px] text-ink-mute group-open:block">
                          <Recipients m={m} name={name} t={t} />
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
                        {m.attachments.length > 0 && <Paperclip size={14} className="text-ink-mute" aria-label={t("attachments")} />}
                        {m.keywords.$flagged && <Star size={14} className="fill-amber text-amber" aria-label={t("starred")} />}
                        <time dateTime={date} className="text-[12px] tabular-nums text-ink-mute" title={fmtFull.format(new Date(date))}>
                          {formatShort(date, locale)}
                        </time>
                      </span>
                    </summary>

                    <div className="px-3 pb-4 sm:px-4 sm:pl-[60px]">
                      <div className="mb-3 flex justify-end">
                        <Link
                          href={composeHref(currentPath, "reply", m.id)}
                          scroll={false}
                          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
                        >
                          <Reply size={14} aria-hidden />
                          {t("reply")}
                        </Link>
                      </div>
                      {m.html !== null ? (
                        <MessageFrame srcDoc={m.html} title={t("messageFrom", { sender: senderLabel })} />
                      ) : (
                        <PlainText text={m.text ?? ""} />
                      )}
                      {m.truncated && <p className="mt-3 text-[12.5px] text-ink-mute">{t("truncated")}</p>}
                      {m.attachments.length > 0 && (
                        <div className="mt-4 border-t border-line pt-3">
                          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute">
                            {t("attachmentCount", { count: m.attachments.length })}
                          </p>
                          <ul className="flex flex-wrap gap-2">
                            {m.attachments.map((a) => (
                              <li key={a.blobId + a.name}>
                                <a
                                  href={a.href}
                                  download={a.name}
                                  className="flex h-10 max-w-[260px] items-center gap-2.5 rounded-md border border-line px-3 text-[13px] transition-colors hover:border-line-strong hover:bg-hover"
                                  title={`${t("download")} ${a.name}`}
                                >
                                  <Paperclip size={14} className="shrink-0 text-ink-mute" aria-hidden />
                                  <span className="min-w-0 truncate text-ink">{a.name}</span>
                                  <span className="shrink-0 font-mono text-[11px] text-ink-mute">{formatBytes(a.size)}</span>
                                  <Download size={14} className="shrink-0 text-ink-mute" aria-hidden />
                                </a>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>

          <div className="mt-5 flex flex-wrap gap-2 px-1">
            <ComposeButton href={composeHref(currentPath, "reply", latest.id)} label={t("reply")} />
            <ComposeButton href={composeHref(currentPath, "replyAll", latest.id)} label={t("replyAll")} />
            <ComposeButton href={composeHref(currentPath, "forward", latest.id)} label={t("forward")} />
          </div>
        </div>
      </div>
    </>
  );
}

function ComposeButton({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      scroll={false}
      className="inline-flex h-9 items-center rounded-lg border border-line-strong px-4 text-[13.5px] font-medium text-ink transition-colors hover:bg-hover"
    >
      {label}
    </Link>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<"mailRead">>>;

function Recipients({ m, name, t }: { m: ReadMessage; name: (a: Address) => string; t: T }) {
  const groups: [string, Address[]][] = [
    [t("to"), m.to],
    [t("cc"), m.cc],
    [t("bcc"), m.bcc],
  ];
  const visible = groups.filter(([, list]) => list.length > 0);
  if (!visible.length) return <>{t("noRecipients")}</>;
  return (
    <>
      {visible.map(([label, list], gi) => (
        <Fragment key={label}>
          {gi > 0 && " · "}
          {label}{" "}
          {list.map((a, i) => (
            <Fragment key={a.email + i}>
              {i > 0 && ", "}
              <span className="text-ink-soft" title={a.email}>
                {name(a)}
              </span>
            </Fragment>
          ))}
        </Fragment>
      ))}
      {m.replyTo.length > 0 && m.replyTo[0].email !== m.from[0]?.email && (
        <>
          {" · "}
          {t("replyTo")} <span className="text-ink-soft">{m.replyTo.map((a) => a.email).join(", ")}</span>
        </>
      )}
    </>
  );
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

/** Plain-text body with whitespace preserved and URLs turned into links. */
function PlainText({ text }: { text: string }) {
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
    <div className="whitespace-pre-wrap break-words text-[14px] leading-[1.6] text-ink [overflow-wrap:anywhere]">{nodes}</div>
  );
}

function formatShort(iso: string, locale: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(d);
  if (d.getFullYear() === now.getFullYear())
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Deterministic two-hue gradient per sender (same recipe as the account avatar). */
function avatarGradient(seed: string) {
  let h = 0;
  for (const ch of seed.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 80)) % 360;
  return `linear-gradient(135deg, oklch(0.72 0.16 ${a}), oklch(0.62 0.18 ${b}))`;
}
