"use client";

import { Archive, File, Folder, Inbox, OctagonAlert, Send, Trash2, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Mailbox } from "@/lib/mail";

const ROLE_ICON: Record<string, LucideIcon> = {
  inbox: Inbox,
  drafts: File,
  sent: Send,
  archive: Archive,
  junk: OctagonAlert,
  trash: Trash2,
};

export function MailboxNav({ mailboxes }: { mailboxes: Mailbox[] }) {
  const t = useTranslations("mail.folders");
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5 overflow-y-auto pr-2" aria-label="Mailboxes">
      {mailboxes.map((m) => {
        const Icon = (m.role && ROLE_ICON[m.role]) || Folder;
        const href = `/mail/${m.id}`;
        const active = pathname === href;
        const label = m.role && t.has(m.role) ? t(m.role) : m.name;
        const showCount = m.unreadEmails > 0 && m.role !== "trash" && m.role !== "junk";
        return (
          <Link
            key={m.id}
            href={href}
            aria-current={active ? "page" : undefined}
            className="flex h-8 items-center gap-3 rounded-md px-3 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink aria-[current=page]:bg-primary-soft aria-[current=page]:font-medium aria-[current=page]:text-ink"
          >
            <Icon size={16} aria-hidden className="shrink-0" />
            <span className="flex-1 truncate">{label}</span>
            {showCount && (
              <span className="font-mono text-[12px] tabular-nums text-ink-mute">
                {m.unreadEmails}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
