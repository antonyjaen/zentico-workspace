import { CalendarDays, HardDrive, LayoutDashboard, Mail, MessageSquare, Users, Video, type LucideIcon } from "lucide-react";

export type AppId = "mail" | "dashboard" | "chat" | "calendar" | "contacts" | "drive" | "meet";

/**
 * `rail: false` hides an app from the app rail and launcher while keeping its routes (Contacts
 * now lives inside Chat → People; /contacts stays for advanced address-book management). Docs is
 * not an app of its own: documents live in Drive (Documents section), editors under /docs/*.
 */
export const APPS: { id: AppId; href: string; icon: LucideIcon; color: string; ready: boolean; rail?: boolean; match?: string[] }[] = [
  { id: "mail", href: "/mail", icon: Mail, color: "var(--color-app-mail)", ready: true },
  // Widgets + a chat with the user's own Claude, who can customize it.
  { id: "dashboard", href: "/dashboard", icon: LayoutDashboard, color: "var(--color-accent)", ready: true },
  { id: "chat", href: "/chat", icon: MessageSquare, color: "var(--color-app-chat)", ready: true },
  { id: "calendar", href: "/calendar", icon: CalendarDays, color: "var(--color-app-calendar)", ready: true },
  { id: "contacts", href: "/contacts", icon: Users, color: "var(--color-app-contacts)", ready: true, rail: false },
  // The document editors (/docs/*) are part of Drive.
  { id: "drive", href: "/drive", icon: HardDrive, color: "var(--color-app-drive)", ready: true, match: ["/docs"] },
  { id: "meet", href: "/meet", icon: Video, color: "var(--color-app-meet)", ready: true },
];

/** Apps shown in the rail and the launcher. */
export const RAIL_APPS = APPS.filter((a) => a.rail !== false);

export const UPCOMING_APPS = APPS.filter((a) => !a.ready).map((a) => a.id);
