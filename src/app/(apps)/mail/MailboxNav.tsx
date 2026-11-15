"use client";

import { Archive, File, Folder, Inbox, OctagonAlert, Send, Trash2, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { Mailbox } from "@/lib/mail";
import { DRAG_MIME, DROP_EVENT, mailboxTree, type DropDetail } from "./listShared";

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
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  return (
    <nav className="flex flex-col gap-0.5 overflow-y-auto pr-2" aria-label="Mailboxes">
      {mailboxTree(mailboxes).map(({ mailbox: m, depth }) => {
        const Icon = (m.role && ROLE_ICON[m.role]) || Folder;
        const href = `/mail/${m.id}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        const label = m.role && t.has(m.role) ? t(m.role) : m.name;
        const count = m.role === "drafts" ? m.totalEmails : m.role === "trash" || m.role === "junk" ? 0 : m.unreadEmails;
        return (
          <Link
            key={m.id}
            href={href}
            aria-current={active ? "page" : undefined}
            data-drop={dropTarget === m.id || undefined}
            onDragOver={(e) => {
              if (active || !e.dataTransfer.types.includes(DRAG_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(m.id);
            }}
            onDragLeave={() => setDropTarget((d) => (d === m.id ? null : d))}
            onDrop={(e) => {
              setDropTarget(null);
              let keys: unknown;
              try {
                keys = JSON.parse(e.dataTransfer.getData(DRAG_MIME));
              } catch {
                return;
              }
              if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) return;
              e.preventDefault();
              window.dispatchEvent(
                new CustomEvent<DropDetail>(DROP_EVENT, { detail: { keys, mailboxId: m.id } }),
              );
            }}
            style={{ paddingLeft: 12 + depth * 16 }}
            className={`flex h-8 items-center gap-3 rounded-md pr-3 text-[14px] transition-colors hover:bg-hover hover:text-ink aria-[current=page]:bg-primary-soft aria-[current=page]:text-ink data-[drop]:bg-hover data-[drop]:text-ink data-[drop]:shadow-[inset_0_0_0_1px_var(--color-accent)] ${
              m.unreadEmails > 0 && count > 0 ? "font-medium text-ink" : "text-ink-soft aria-[current=page]:font-medium"
            }`}
          >
            <Icon size={16} aria-hidden className="shrink-0" />
            <span className="flex-1 truncate">{label}</span>
            {count > 0 && <span className="font-mono text-[12px] font-normal tabular-nums text-ink-mute">{count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
