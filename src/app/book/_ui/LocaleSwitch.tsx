"use client";

import { Languages } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocale } from "@/lib/preferences";

/** es/en switch for visitors (the language cookie the workspace uses too). */
export function LocaleSwitch({ locale }: { locale: "es" | "en" }) {
  const t = useTranslations("booking.public");
  const router = useRouter();
  const [pending, start] = useTransition();
  const next = locale === "es" ? "en" : "es";
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(async () => {
        await setLocale(next);
        router.refresh();
      })}
      aria-label={t("language")}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
    >
      <Languages size={14} aria-hidden />
      {next === "en" ? "English" : "Español"}
    </button>
  );
}
