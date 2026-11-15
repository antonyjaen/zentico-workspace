import { getTranslations } from "next-intl/server";
import { notFound, unstable_rethrow } from "next/navigation";
import { EmailList, PAGE_SIZE } from "../../EmailList";
import { getEmails, getMailboxes } from "@/lib/mail";
import { LABEL_ID, labelKeyword } from "@/lib/mail-labels";
import { getLabels } from "@/lib/mail-settings";

/** Conversations carrying a label (JMAP keyword `zwl_<id>`), across every folder. */
export default async function LabelPage({
  params,
  searchParams,
}: {
  params: Promise<{ labelId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { labelId } = await params;
  if (!LABEL_ID.test(labelId)) notFound();
  const page = Math.max(0, Number.parseInt((await searchParams).page ?? "0", 10) || 0);
  const t = await getTranslations("mail");
  const tl = await getTranslations("mailActions.labels");

  try {
    const [{ emails, total }, mailboxes, labels] = await Promise.all([
      getEmails({ hasKeyword: labelKeyword(labelId) }, { limit: PAGE_SIZE, position: page * PAGE_SIZE }),
      getMailboxes(),
      getLabels(),
    ]);
    const label = labels.find((l) => l.id === labelId);
    return (
      <EmailList
        emails={emails}
        total={total}
        page={page}
        basePath={`/mail/label/${labelId}`}
        emptyText={tl("emptyLabel")}
        mailboxId={`label:${labelId}`}
        mailboxes={mailboxes}
        labels={labels}
        view="label"
        title={label?.name ?? labelId}
      />
    );
  } catch (e) {
    unstable_rethrow(e);
    return <p className="p-8 text-[15px] text-ink-soft">{t("error")}</p>;
  }
}
