import { Pencil } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { MailboxNav } from "./MailboxNav";
import { getMailboxes } from "@/lib/mail";

export default async function MailLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("mail");
  const mailboxes = await getMailboxes().catch((e) => {
    unstable_rethrow(e);
    return [];
  });

  return (
    <>
      <aside className="hidden w-[248px] shrink-0 flex-col pl-2 lg:flex">
        <button
          type="button"
          disabled
          title="Coming soon"
          className="mb-4 ml-1 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors duration-150 hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Pencil size={15} aria-hidden />
          {t("compose")}
        </button>
        <MailboxNav mailboxes={mailboxes} />
      </aside>
      <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </>
  );
}
