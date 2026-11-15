import { CalendarDays, FileText, HardDrive, Mail, MessageSquare, Users, Video, type LucideIcon } from "lucide-react";

export type AppId = "mail" | "chat" | "calendar" | "contacts" | "drive" | "docs" | "meet";

export const APPS: { id: AppId; href: string; icon: LucideIcon; color: string; ready: boolean }[] = [
  { id: "mail", href: "/mail", icon: Mail, color: "var(--color-app-mail)", ready: true },
  { id: "chat", href: "/chat", icon: MessageSquare, color: "var(--color-app-chat)", ready: true },
  { id: "calendar", href: "/calendar", icon: CalendarDays, color: "var(--color-app-calendar)", ready: true },
  { id: "contacts", href: "/contacts", icon: Users, color: "var(--color-app-contacts)", ready: true },
  { id: "drive", href: "/drive", icon: HardDrive, color: "var(--color-app-drive)", ready: true },
  { id: "docs", href: "/docs", icon: FileText, color: "var(--color-app-docs)", ready: true },
  { id: "meet", href: "/meet", icon: Video, color: "var(--color-app-meet)", ready: true },
];

export const UPCOMING_APPS = APPS.filter((a) => !a.ready).map((a) => a.id);
