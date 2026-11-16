"use client";

import { ShieldAlert, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const KEY = "zw-2fa-nudge-dismissed";

/**
 * Banner for accounts without two-step verification: a dismissible recommendation, or (during the
 * admin's grace period) a non-dismissible deadline.
 */
export function SecurityNudge({ deadline }: { deadline: number | null }) {
  const t = useTranslations("security.nudge");
  const locale = useLocale();
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(deadline === null && localStorage.getItem(KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, [deadline]);

  if (dismissed || pathname.startsWith("/settings/security")) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // Storage unavailable: hidden for this page view only.
    }
  };

  return (
    <div
      role="status"
      className={`mr-2 mb-2 flex items-center gap-3 rounded-lg border px-3 py-2 text-[13px] md:mr-3 ${
        deadline ? "border-amber/40 bg-amber/10 text-ink" : "border-line bg-sheet text-ink-soft"
      }`}
    >
      <ShieldAlert size={16} className="shrink-0 text-amber" aria-hidden />
      <span className="min-w-0 flex-1">
        {deadline
          ? t("required", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(deadline) })
          : t("recommended")}
      </span>
      <Link href="/settings/security" className="shrink-0 font-medium text-ink underline underline-offset-2">
        {t("setup")}
      </Link>
      {!deadline && (
        <button type="button" className="icon-btn h-7 w-7 shrink-0" aria-label={t("dismiss")} title={t("dismiss")} onClick={dismiss}>
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
