import { getTranslations } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { ComposeButton, ComposeButtonFallback } from "./compose/ComposeButton";
import { Composer } from "./compose/Composer";
import { MailboxNav, type SharedInbox } from "./MailboxNav";
import { MailNavDrawer } from "./MailNavDrawer";
import { getMailboxes, getSharedMailboxes } from "@/lib/mail";
import { SETTINGS_CAP, accountFor, getLabels } from "@/lib/mail-settings";

export default async function MailLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("mail");
  const soft = <T,>(p: Promise<T>, fallback: T) =>
    p.catch((e) => {
      unstable_rethrow(e);
      return fallback;
    });
  const [mailboxes, labels, sieve, shared] = await Promise.all([
    soft(getMailboxes(), []),
    getLabels(),
    soft(accountFor(SETTINGS_CAP.sieve), null),
    soft(getSharedMailboxes(), [] as SharedInbox[]),
  ]);

  // One sidebar, two placements: the aside from lg up, a drawer (opened from the list header) below.
  const nav = (
    <>
      <Suspense fallback={<ComposeButtonFallback label={t("compose")} />}>
        <ComposeButton label={t("compose")} />
      </Suspense>
      <Suspense fallback={null}>
        <MailboxNav mailboxes={mailboxes} labels={labels} labelsAvailable={!!sieve} shared={shared} />
      </Suspense>
    </>
  );

  return (
    <MailNavDrawer nav={nav}>
      <aside className="hidden w-[248px] shrink-0 flex-col pl-2 lg:flex">{nav}</aside>
      <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      <Suspense fallback={null}>
        <Composer />
      </Suspense>
    </MailNavDrawer>
  );
}
