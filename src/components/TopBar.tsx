import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { listAccountsWithDelegated } from "@/lib/jmap";
import { env } from "@/lib/env";
import type { Session } from "@/lib/session";
import { AccountMenu } from "./AccountMenu";
import { AppLauncher } from "./AppLauncher";
import { Wordmark } from "./Logo";
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
    <header className="flex h-14 shrink-0 items-center gap-3 pr-3 pl-4 md:pl-1">
      <Link href="/" className="shrink-0 md:hidden" aria-label="Zentico Workspace">
        <Wordmark />
      </Link>
      <ShellItem name="search">
        <SearchBox placeholder={t("search")} defaultValue={query} />
      </ShellItem>
      <div className="ml-auto flex items-center gap-1">
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
