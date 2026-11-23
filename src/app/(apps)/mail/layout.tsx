import { getTranslations } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { ComposeButton, ComposeButtonFallback } from "./compose/ComposeButton";
import { Composer } from "./compose/Composer";
import { MailboxNav } from "./MailboxNav";
import { MailNavDrawer } from "./MailNavDrawer";
import { listAccounts, type AccountSummary } from "@/lib/auth";
import { getMailAccounts, getMailboxes, type Mailbox, type MailAccount } from "@/lib/mail";
import { SETTINGS_CAP, accountFor, getLabels } from "@/lib/mail-settings";
import { MAX_ACCOUNTS } from "@/lib/session";

export default async function MailLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("mail");
  const soft = <T,>(p: Promise<T>, fallback: T) =>
    p.catch((e) => {
      unstable_rethrow(e);
      return fallback;
    });
  const [accounts, signedIn, ownMailboxes, labels, sieve] = await Promise.all([
    soft(getMailAccounts(), [] as MailAccount[]),
    soft(listAccounts(), [] as AccountSummary[]),
    soft(getMailboxes(), [] as Mailbox[]),
    getLabels(),
    soft(accountFor(SETTINGS_CAP.sieve), null),
  ]);
  // Every other address (signed-in or shared), each with its own folders; one failing doesn't hide the rest.
  const others = await Promise.all(
    accounts
      .filter((a) => a.kind !== "own")
      .map(async (account) => ({ account, mailboxes: await soft(getMailboxes(account.id), [] as Mailbox[]) })),
  );
  const own = { account: accounts.find((a) => a.kind === "own") ?? null, mailboxes: ownMailboxes };
  // Signed-in addresses whose sign-in ran out: shown with "Sign in again" instead of vanishing.
  const listed = new Set(accounts.map((a) => a.email.toLowerCase()));
  const stale = signedIn.filter((a) => a.expired && !a.active && !a.account && !listed.has(a.email.toLowerCase())).map((a) => a.email);
  // A 6th sign-in would silently replace the least recently used one.
  const canAdd = signedIn.length < MAX_ACCOUNTS;

  // One sidebar, two placements: the aside from lg up, a drawer (opened from the list header) below.
  const nav = (
    <>
      <Suspense fallback={<ComposeButtonFallback label={t("compose")} />}>
        <ComposeButton label={t("compose")} />
      </Suspense>
      <Suspense fallback={null}>
        <MailboxNav own={own} others={others} stale={stale} canAdd={canAdd} labels={labels} labelsAvailable={!!sieve} />
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
