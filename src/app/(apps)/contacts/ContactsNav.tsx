"use client";

import { BookUser, Tag, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { contactsHref } from "./hrefs";

type Item = { id: string; name: string; count: number };

const ITEM =
  "flex h-8 items-center gap-3 rounded-md px-3 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink aria-[current=page]:bg-primary-soft aria-[current=page]:font-medium aria-[current=page]:text-ink";

function Count({ n }: { n: number }) {
  return <span className="font-mono text-[12px] tabular-nums text-ink-mute">{n}</span>;
}

export function ContactsNav({ total, books, groups }: { total: number; books: Item[]; groups: Item[] }) {
  const t = useTranslations("contacts");
  const params = useSearchParams();
  const book = params.get("book");
  const group = params.get("group");

  return (
    <nav className="flex flex-col gap-0.5" aria-label={t("title")}>
      <Link href="/contacts" aria-current={!book && !group ? "page" : undefined} className={ITEM}>
        <Users size={16} aria-hidden className="shrink-0" style={{ color: "var(--color-app-contacts)" }} />
        <span className="flex-1 truncate">{t("all")}</span>
        <Count n={total} />
      </Link>

      {books.length > 1 && (
        <>
          <p className="mt-4 mb-1 px-3 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute">
            {t("addressBooks")}
          </p>
          {books.map((b) => (
            <Link
              key={b.id}
              href={contactsHref({ book: b.id })}
              aria-current={book === b.id ? "page" : undefined}
              className={ITEM}
            >
              <BookUser size={16} aria-hidden className="shrink-0" />
              <span className="flex-1 truncate">{b.name || t("defaultBook")}</span>
              <Count n={b.count} />
            </Link>
          ))}
        </>
      )}

      <p className="mt-4 mb-1 px-3 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute">{t("groups")}</p>
      {groups.length === 0 && <p className="px-3 text-[13px] text-ink-mute">{t("noGroups")}</p>}
      {groups.map((g) => (
        <Link
          key={g.id}
          href={contactsHref({ group: g.id })}
          aria-current={group === g.id ? "page" : undefined}
          className={ITEM}
        >
          <Tag size={16} aria-hidden className="shrink-0" />
          <span className="flex-1 truncate">{g.name}</span>
          <Count n={g.count} />
        </Link>
      ))}
    </nav>
  );
}
