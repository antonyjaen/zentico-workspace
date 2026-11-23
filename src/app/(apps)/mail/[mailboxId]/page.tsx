import { getTranslations } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { EmailList, PAGE_SIZE } from "../EmailList";
import { getEmails, getMailAccounts, getMailboxes, resolveAccount } from "@/lib/mail";
import { getLabels } from "@/lib/mail-settings";

export default async function MailboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ mailboxId: string }>;
  searchParams: Promise<{ page?: string; account?: string }>;
}) {
  const { mailboxId } = await params;
  const sp = await searchParams;
  const page = Math.max(0, Number.parseInt(sp.page ?? "0", 10) || 0);
  const t = await getTranslations("mail");

  try {
    // `?account=` browses another address: a signed-in one or a mailbox shared with the user.
    const accountId = await resolveAccount(sp.account);
    const accounts = await getMailAccounts();
    const shared = accounts.find((a) => a.id === accountId && !a.isPrimary);
    const [{ emails, total }, mailboxes, labels] = await Promise.all([
      getEmails({ inMailbox: mailboxId }, { limit: PAGE_SIZE, position: page * PAGE_SIZE, accountId }),
      getMailboxes(accountId),
      getLabels(),
    ]);
    const mailbox = mailboxes.find((m) => m.id === mailboxId);
    const isInbox = mailbox?.role === "inbox";
    const folder = mailbox ? (mailbox.role && t.has(`folders.${mailbox.role}`) ? t(`folders.${mailbox.role}`) : mailbox.name) : "";
    return (
      <EmailList
        emails={emails}
        total={total}
        page={page}
        basePath={shared ? `/mail/${mailboxId}?account=${encodeURIComponent(shared.id)}` : `/mail/${mailboxId}`}
        emptyText={isInbox ? t("emptyInbox") : t("empty")}
        mailboxId={mailboxId}
        mailboxes={mailboxes}
        labels={labels}
        account={shared?.id}
        title={shared ? `${shared.email || shared.name} · ${folder}` : undefined}
      />
    );
  } catch (e) {
    unstable_rethrow(e);
    return <p className="p-8 text-[15px] text-ink-soft">{t("error")}</p>;
  }
}
