// How a notification reads (popover, toast and desktop notification share this).
import { CalendarClock, Mail, MessageSquare, Sparkles, Video, type LucideIcon } from "lucide-react";
import type { AppNotification, NotificationCategory } from "@/lib/notifications/types";

type T = (key: string, values?: Record<string, string | number>) => string;

export const CATEGORY_ICON: Record<NotificationCategory, { icon: LucideIcon; color: string }> = {
  chat: { icon: MessageSquare, color: "var(--color-app-chat)" },
  meet: { icon: Video, color: "var(--color-app-meet)" },
  mail: { icon: Mail, color: "var(--color-app-mail)" },
  calendar: { icon: CalendarClock, color: "var(--color-app-calendar)" },
  claude: { icon: Sparkles, color: "var(--color-accent)" },
};

function when(ms: number, locale: string): string {
  const diff = ms - Date.now();
  if (diff > 0 && diff < 36 * 3_600_000) {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    const min = Math.round(diff / 60_000);
    return min < 90 ? rtf.format(Math.max(min, 0), "minute") : rtf.format(Math.round(min / 60), "hour");
  }
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);
}

/** Label (what happened), title (who / what) and body for a notification. */
export function describe(n: AppNotification, t: T, locale: string): { label: string; title: string; body: string } {
  switch (n.kind) {
    case "mailBatch": {
      const label = t("kind.mailBatch", { count: Number(n.title) || n.count });
      return { label, title: label, body: n.body };
    }
    case "reminder":
    case "invite": {
      const start = Number(n.body);
      const time = Number.isFinite(start) && start > 0 ? when(start, locale) : "";
      return { label: t(`kind.${n.kind}`, { when: time }), title: n.title, body: "" };
    }
    default:
      return { label: t(`kind.${n.kind}`), title: n.title, body: n.body };
  }
}

/** Short time for a list row: hh:mm today, otherwise the date. */
export function shortTime(ms: number, locale: string): string {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(d);
  }
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(d);
}
