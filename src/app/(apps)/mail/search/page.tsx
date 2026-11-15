import { getTranslations } from "next-intl/server";
import { redirect, unstable_rethrow } from "next/navigation";
import { EmailList, PAGE_SIZE } from "../EmailList";
import { getEmails, getMailboxes } from "@/lib/mail";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { q, page: rawPage } = await searchParams;
  const query = q?.trim().slice(0, 200);
  if (!query) redirect("/mail");
  const page = Math.max(0, Number.parseInt(rawPage ?? "0", 10) || 0);
  const t = await getTranslations("mail");

  try {
    const [{ emails, total }, mailboxes] = await Promise.all([
      getEmails({ text: query }, { limit: PAGE_SIZE, position: page * PAGE_SIZE }),
      getMailboxes(),
    ]);
    return (
      <EmailList
        emails={emails}
        total={total}
        page={page}
        basePath={`/mail/search?q=${encodeURIComponent(query)}`}
        emptyText={t("empty")}
        mailboxId="search"
        mailboxes={mailboxes}
      />
    );
  } catch (e) {
    unstable_rethrow(e);
    return <p className="p-8 text-[15px] text-ink-soft">{t("error")}</p>;
  }
}
