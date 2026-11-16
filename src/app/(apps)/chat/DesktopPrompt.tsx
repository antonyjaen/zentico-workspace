"use client";

import { BellRing, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { DESKTOP_PROMPT_KEY, useNotifications } from "@/components/notifications/NotificationsProvider";

/**
 * One-time, non-blocking nudge in Chat to turn on desktop notifications (asked from the click, as
 * browsers require). "Not now" is remembered in this browser, shared with the bell's prompt.
 */
export function DesktopPrompt() {
  const t = useTranslations("notifications");
  const { prefs, loaded, permission, enableDesktop } = useNotifications();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DESKTOP_PROMPT_KEY) === "1");
    } catch {
      setDismissed(true);
    }
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DESKTOP_PROMPT_KEY, "1");
    } catch {}
  };

  if (!loaded || dismissed || (prefs.desktop && permission === "granted") || (permission !== "default" && permission !== "granted")) return null;

  return (
    <div role="region" aria-label={t("desktopEnable")} className="flex shrink-0 items-start gap-2.5 border-b border-line bg-sheet-muted px-3 py-2.5 text-[12.5px]">
      <BellRing size={15} aria-hidden className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-ink-soft">{t("desktopBanner")}</p>
        <div className="mt-1.5 flex gap-2">
          <button
            type="button"
            onClick={async () => {
              await enableDesktop();
              dismiss();
            }}
            className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-[12.5px] font-medium text-primary-ink hover:bg-primary-hover"
          >
            {t("desktopEnable")}
          </button>
          <button type="button" onClick={dismiss} className="inline-flex h-7 items-center rounded-md px-2.5 text-[12.5px] text-ink-soft hover:bg-hover hover:text-ink">
            {t("desktopLater")}
          </button>
        </div>
      </div>
      <button type="button" onClick={dismiss} className="icon-btn h-7 w-7 shrink-0" aria-label={t("dismiss")}>
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
