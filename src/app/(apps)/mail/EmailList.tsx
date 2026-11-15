import { ChevronLeft, ChevronRight, Paperclip, RotateCw } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import type { EmailSummary } from "@/lib/mail";

export const PAGE_SIZE = 50;

function formatDate(iso: string, locale: string) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(d);
  if (d.getFullYear() === now.getFullYear())
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(d);
  return new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(d);
}

export async function EmailList({
  emails,
  total,
  page,
  basePath,
  emptyText,
}: {
  emails: EmailSummary[];
  total: number;
  page: number;
  basePath: string;
  emptyText: string;
}) {
  const t = await getTranslations("mail");
  const locale = await getLocale();
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  const sep = basePath.includes("?") ? "&" : "?";
  const pageHref = (p: number) => (p === 0 ? basePath : `${basePath}${sep}page=${p}`);

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3">
        <Link href={pageHref(page)} className="icon-btn h-9 w-9" aria-label={t("refresh")} title={t("refresh")}>
          <RotateCw size={17} aria-hidden />
        </Link>
        <span className="ml-auto font-mono text-[12px] tabular-nums text-ink-mute">
          {t("range", { from, to, total })}
        </span>
        <Link
          href={pageHref(page - 1)}
          aria-disabled={page === 0}
          className="icon-btn h-9 w-9 aria-disabled:pointer-events-none aria-disabled:opacity-35"
          aria-label="Previous page"
        >
          <ChevronLeft size={18} aria-hidden />
        </Link>
        <Link
          href={pageHref(page + 1)}
          aria-disabled={to >= total}
          className="icon-btn h-9 w-9 aria-disabled:pointer-events-none aria-disabled:opacity-35"
          aria-label="Next page"
        >
          <ChevronRight size={18} aria-hidden />
        </Link>
      </div>

      {emails.length === 0 ? (
        <div className="grid flex-1 place-items-center p-10 text-center">
          <div className="rise">
            <p className="text-[17px] font-medium text-ink">{emptyText}</p>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-mute">
              {t("empty")}
            </p>
          </div>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {emails.map((e, i) => {
            const unread = !e.keywords?.["$seen"];
            const sender = e.from?.[0];
            const senderLabel = sender?.name || sender?.email || t("unknownSender");
            return (
              <li
                key={e.id}
                className="rise group flex h-11 cursor-default items-center gap-4 border-b border-line/70 px-5 text-[14px] transition-colors hover:bg-hover hover:shadow-[inset_3px_0_0_var(--color-primary)]"
                style={{ animationDelay: `${Math.min(i, 12) * 18}ms` }}
              >
                <span
                  className={`w-[200px] shrink-0 truncate ${unread ? "font-semibold text-ink" : "text-ink-soft"}`}
                  title={sender?.email}
                >
                  {senderLabel}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className={unread ? "font-semibold text-ink" : "text-ink-soft"}>
                    {e.subject || t("noSubject")}
                  </span>
                  {e.preview && <span className="text-ink-mute"> — {e.preview}</span>}
                </span>
                {e.hasAttachment && <Paperclip size={15} className="shrink-0 text-ink-mute" aria-label="Attachment" />}
                <time
                  dateTime={e.receivedAt}
                  className={`w-16 shrink-0 text-right text-[12.5px] tabular-nums ${unread ? "font-semibold text-ink" : "text-ink-mute"}`}
                >
                  {formatDate(e.receivedAt, locale)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
