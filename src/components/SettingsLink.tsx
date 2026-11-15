"use client";

import { Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Gear button linking to mail settings; meant for the top bar or the mail toolbar. */
export function SettingsLink({ className = "" }: { className?: string }) {
  const t = useTranslations("mailSettings");
  const active = usePathname().startsWith("/mail/settings");
  return (
    <Link
      href="/mail/settings"
      aria-label={t("title")}
      title={t("title")}
      aria-current={active ? "page" : undefined}
      className={`icon-btn aria-[current=page]:bg-primary-soft aria-[current=page]:text-ink ${className}`}
    >
      <Settings size={19} aria-hidden />
    </Link>
  );
}
