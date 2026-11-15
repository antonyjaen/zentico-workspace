"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { APPS } from "./apps";
import { LogoMark } from "./Logo";

export function AppRail() {
  const t = useTranslations("apps");
  const pathname = usePathname();

  return (
    <nav
      aria-label={t("launcher")}
      className="hidden w-[72px] shrink-0 flex-col items-center gap-0.5 py-3 md:flex"
    >
      <Link href="/mail" className="mb-4 rounded-lg p-1" aria-label="Zentico Workspace">
        <LogoMark size={30} />
      </Link>
      {APPS.map(({ id, href, icon: Icon, color }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={id}
            href={href}
            aria-current={active ? "page" : undefined}
            className="group flex w-full flex-col items-center gap-1 py-1.5 text-[11px] font-medium text-ink-mute transition-colors hover:text-ink aria-[current=page]:text-ink"
          >
            <span
              className="grid h-8 w-12 place-items-center rounded-lg transition-colors duration-150 group-hover:bg-hover group-aria-[current=page]:bg-primary-soft"
            >
              <Icon
                size={19}
                strokeWidth={active ? 2.2 : 1.8}
                style={active ? { color } : undefined}
                aria-hidden
              />
            </span>
            {t(id)}
          </Link>
        );
      })}
    </nav>
  );
}
