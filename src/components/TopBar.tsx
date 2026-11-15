import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { env } from "@/lib/env";
import type { Session } from "@/lib/session";
import { AccountMenu } from "./AccountMenu";
import { AppLauncher } from "./AppLauncher";
import { Wordmark } from "./Logo";
import { SearchBox } from "./SearchBox";
import { SettingsLink } from "./SettingsLink";
import { ThemeMenu } from "./ThemeMenu";

export async function TopBar({ session, query }: { session: Session; query?: string }) {
  const t = await getTranslations("topbar");

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 pr-3 pl-4 md:pl-1">
      <Link href="/mail" className="shrink-0 md:hidden" aria-label="Zentico Workspace">
        <Wordmark />
      </Link>
      <SearchBox placeholder={t("search")} defaultValue={query} />
      <div className="ml-auto flex items-center gap-1">
        <SettingsLink />
        <ThemeMenu />
        <AppLauncher />
        <AccountMenu name={session.name} email={session.email} accountUrl={`${env.issuer}/account/`} />
      </div>
    </header>
  );
}
