import { Search } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { env } from "@/lib/env";
import type { Session } from "@/lib/session";
import { AccountMenu } from "./AccountMenu";
import { AppLauncher } from "./AppLauncher";
import { Wordmark } from "./Logo";
import { ThemeMenu } from "./ThemeMenu";

export async function TopBar({ session, query }: { session: Session; query?: string }) {
  const t = await getTranslations("topbar");

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 pr-3 pl-4 md:pl-2">
      <Link href="/mail" className="shrink-0 md:hidden" aria-label="Zentico Workspace">
        <Wordmark />
      </Link>

      <form action="/mail/search" role="search" className="hidden max-w-[720px] flex-1 sm:block">
        <label className="group flex h-12 items-center gap-3 rounded-full bg-sheet-muted px-4 ring-1 ring-transparent transition-all duration-200 focus-within:bg-sheet focus-within:shadow-[var(--shadow-sheet)] focus-within:ring-line hover:bg-hover">
          <Search size={19} className="shrink-0 text-ink-mute" aria-hidden />
          <span className="sr-only">{t("search")}</span>
          <input
            name="q"
            type="search"
            defaultValue={query}
            placeholder={t("search")}
            autoComplete="off"
            className="h-full w-full bg-transparent text-[15px] text-ink placeholder:text-ink-mute focus:outline-none"
          />
        </label>
      </form>

      <div className="ml-auto flex items-center gap-0.5">
        <ThemeMenu />
        <AppLauncher />
        <AccountMenu name={session.name} email={session.email} accountUrl={`${env.issuer}/account/`} />
      </div>
    </header>
  );
}
