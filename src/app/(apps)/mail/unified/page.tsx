import { getTranslations } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { EmailList, PAGE_SIZE } from "../EmailList";
import { getMailboxes, getUnifiedInbox } from "@/lib/mail";
import { getLabels } from "@/lib/mail-settings";

/** Every inbox the user can read — their own plus shared ones — merged by date. */
export default async function UnifiedInboxPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const page = Math.min(20, Math.max(0, Number.parseInt((await searchParams).page ?? "0", 10) || 0));
  const t = await getTranslations("mail");
  const tn = await getTranslations("mailActions.nav");

  try {
    const [{ emails, total, accounts }, mailboxes, labels] = await Promise.all([
      getUnifiedInbox({ limit: PAGE_SIZE, page }),
      getMailboxes(),
      getLabels(),
    ]);
    // Rows from shared accounts get a badge with the account name; the user's own rows don't.
    const accountNames = Object.fromEntries(accounts.filter((a) => !a.isPrimary).map((a) => [a.id, a.name]));
    return (
      <EmailList
        emails={emails}
        total={total}
        page={page}
        basePath="/mail/unified"
        emptyText={t("emptyInbox")}
        mailboxId="unified"
        mailboxes={mailboxes}
        labels={labels}
        view="unified"
        accountNames={accountNames}
        title={tn("unified")}
      />
    );
  } catch (e) {
    unstable_rethrow(e);
    return <p className="p-8 text-[15px] text-ink-soft">{t("error")}</p>;
  }
}
