import { getLocale, getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import type { Mailbox, ThreadSummary } from "@/lib/mail";
import type { Label } from "@/lib/mail-labels";
import { DENSITY_COOKIE, parseDensity } from "./listShared";
import { MailListClient, type ListView, type MailRow } from "./MailListClient";

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

/** Server shell for a conversation list: formats rows, then hands off to the interactive client. */
export async function EmailList({
  emails,
  total,
  page,
  basePath,
  emptyText,
  mailboxId,
  mailboxes,
  labels = [],
  view = "mailbox",
  account,
  accountNames,
  title,
}: {
  emails: ThreadSummary[];
  total: number;
  page: number;
  basePath: string;
  emptyText: string;
  /** The listed mailbox id, or a virtual list id ("search", "label:<id>", "unified"). */
  mailboxId: string;
  /** Folders of the listed account (move targets, role detection). */
  mailboxes: Mailbox[];
  labels?: Label[];
  view?: ListView;
  /** Shared (non-primary) account the list belongs to. */
  account?: string;
  /** Account id -> display name, for rows of the unified inbox. */
  accountNames?: Record<string, string>;
  /** Heading shown above the list (labels, shared inboxes, unified inbox). */
  title?: string;
}) {
  const t = await getTranslations("mail");
  const locale = await getLocale();
  const density = parseDensity((await cookies()).get(DENSITY_COOKIE)?.value);
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  const sep = basePath.includes("?") ? "&" : "?";
  const pageHref = (p: number) => (p === 0 ? basePath : `${basePath}${sep}page=${p}`);
  const draftsId = mailboxes.find((m) => m.role === "drafts")?.id;
  const full = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" });

  // Rows from another (shared) account carry its id so actions and links target that account.
  const shared = (e: ThreadSummary) => !!account || !!accountNames?.[e.accountId];
  const rows: MailRow[] = emails.map((e) => {
    const sender = e.from?.[0];
    return {
      key: shared(e) ? `${e.accountId}:${e.threadId}` : e.threadId,
      accountId: shared(e) ? e.accountId : undefined,
      accountName: accountNames?.[e.accountId],
      labels: e.labels,
      emailId: e.id,
      threadId: e.threadId,
      emailIds: e.emailIds,
      isDraft: !!e.keywords?.["$draft"] || (!!draftsId && !!e.mailboxIds[draftsId]),
      sender: sender?.name || sender?.email || t("unknownSender"),
      senderEmail: sender?.email,
      subject: e.subject ?? "",
      preview: e.preview ?? "",
      receivedAt: e.receivedAt,
      dateLabel: formatDate(e.receivedAt, locale),
      dateTitle: full.format(new Date(e.receivedAt)),
      hasAttachment: e.hasAttachment,
      threadSize: e.threadSize,
      unread: e.unread,
      flagged: e.flagged,
    };
  });

  return (
    <MailListClient
      rows={rows}
      mailboxId={mailboxId}
      view={view}
      labels={labels}
      account={account}
      title={title}
      role={mailboxes.find((m) => m.id === mailboxId)?.role ?? null}
      mailboxes={mailboxes.map(({ id, name, role, parentId }) => ({ id, name, role, parentId }))}
      currentPath={pageHref(page)}
      prevHref={page > 0 ? pageHref(page - 1) : null}
      nextHref={to < total ? pageHref(page + 1) : null}
      rangeLabel={t("range", { from, to, total })}
      emptyText={emptyText}
      initialDensity={density}
    />
  );
}
