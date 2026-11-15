import { getTranslations } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { EmailList, PAGE_SIZE } from "../EmailList";
import { getEmails, getMailboxes } from "@/lib/mail";

export default async function MailboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ mailboxId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { mailboxId } = await params;
  const page = Math.max(0, Number.parseInt((await searchParams).page ?? "0", 10) || 0);
  const t = await getTranslations("mail");

  try {
    const [{ emails, total }, mailboxes] = await Promise.all([
      getEmails({ inMailbox: mailboxId }, { limit: PAGE_SIZE, position: page * PAGE_SIZE }),
      getMailboxes(),
    ]);
    const isInbox = mailboxes.find((m) => m.id === mailboxId)?.role === "inbox";
    return (
      <EmailList
        emails={emails}
        total={total}
        page={page}
        basePath={`/mail/${mailboxId}`}
        emptyText={isInbox ? t("emptyInbox") : t("empty")}
      />
    );
  } catch (e) {
    unstable_rethrow(e);
    return <p className="p-8 text-[15px] text-ink-soft">{t("error")}</p>;
  }
}
