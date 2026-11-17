import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { listAccountsWithDelegated } from "@/lib/jmap";
import { env } from "@/lib/env";
import type { Session } from "@/lib/session";
import { AccountMenu } from "./AccountMenu";
import { AppLauncher } from "./AppLauncher";
import { LogoMark, Wordmark } from "./Logo";
import { NotificationBell } from "./notifications/NotificationBell";
import { SearchBox } from "./SearchBox";
import { SettingsMenu } from "./SettingsMenu";
import { ThemeMenu } from "./ThemeMenu";
import { ShellItem } from "./UiShell";
import { TopSlot } from "./WorkspaceUi";

export async function TopBar({ session, query }: { session: Session; query?: string }) {
  const t = await getTranslations("topbar");
  const accounts = await listAccountsWithDelegated();
  // Explicit sessions without account cookies still show the signed-in user.
  if (!accounts.some((a) => a.active)) {
    accounts.unshift({ slot: -1, email: session.email, name: session.name, active: true, expired: false });
  }

  return (
    <header className="flex h-14 min-w-0 shrink-0 items-center gap-2 pr-2 pl-3 sm:gap-3 sm:pr-3 sm:pl-4 md:pl-1">
      {/* Phones get the mark only: the full wordmark plus the action buttons overflow ~360–412px. */}
      <Link href="/" className="shrink-0 sm:hidden" aria-label="Zentico Workspace">
        <LogoMark size={28} />
      </Link>
      <Link href="/" className="hidden shrink-0 sm:block md:hidden" aria-label="Zentico Workspace">
        <Wordmark />
      </Link>
      <ShellItem name="search">
        <SearchBox placeholder={t("search")} defaultValue={query} />
      </ShellItem>
      <div className="ml-auto flex min-w-0 items-center gap-0.5 sm:gap-1">
        <TopSlot />
        <ShellItem name="notifications">
          <NotificationBell />
        </ShellItem>
        {/* Never hideable: holds "Restore default UI" (see SettingsMenu). */}
        <SettingsMenu />
        <ShellItem name="theme">
          <ThemeMenu />
        </ShellItem>
        <ShellItem name="launcher">
          <AppLauncher />
        </ShellItem>
        <AccountMenu accounts={accounts} accountUrl={`${env.issuer}/account/`} />
      </div>
    </header>
  );
}
