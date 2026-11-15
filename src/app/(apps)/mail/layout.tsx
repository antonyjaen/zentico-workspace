import { getTranslations } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { ComposeButton, ComposeButtonFallback } from "./compose/ComposeButton";
import { Composer } from "./compose/Composer";
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
        <Suspense fallback={<ComposeButtonFallback label={t("compose")} />}>
          <ComposeButton label={t("compose")} />
        </Suspense>
        <MailboxNav mailboxes={mailboxes} />
      </aside>
      <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      <Suspense fallback={null}>
        <Composer />
      </Suspense>
    </>
  );
}
