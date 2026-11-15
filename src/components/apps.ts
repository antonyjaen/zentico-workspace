import { CalendarDays, FileText, HardDrive, Mail, Users, Video, type LucideIcon } from "lucide-react";

export type AppId = "mail" | "calendar" | "contacts" | "drive" | "docs" | "meet";

export const APPS: { id: AppId; href: string; icon: LucideIcon; color: string; ready: boolean }[] = [
  { id: "mail", href: "/mail", icon: Mail, color: "var(--color-app-mail)", ready: true },
  { id: "calendar", href: "/calendar", icon: CalendarDays, color: "var(--color-app-calendar)", ready: false },
  { id: "contacts", href: "/contacts", icon: Users, color: "var(--color-app-contacts)", ready: false },
  { id: "drive", href: "/drive", icon: HardDrive, color: "var(--color-app-drive)", ready: false },
  { id: "docs", href: "/docs", icon: FileText, color: "var(--color-app-docs)", ready: false },
  { id: "meet", href: "/meet", icon: Video, color: "var(--color-app-meet)", ready: false },
];

export const UPCOMING_APPS = APPS.filter((a) => !a.ready).map((a) => a.id);
