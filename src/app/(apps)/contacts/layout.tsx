import { Download, UserPlus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { ContactsNav } from "./ContactsNav";
import { contactsHref } from "./hrefs";
import { ImportVcf, NewGroup } from "./SideForms";
import { getContactsData } from "@/lib/contacts";

export default async function ContactsLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("contacts");
  const data = await getContactsData().catch((e) => {
    unstable_rethrow(e);
    return null;
  });

  return (
    <>
      <aside className="hidden w-[248px] shrink-0 flex-col pl-2 lg:flex">
        <Link
          href={contactsHref({ new: true })}
          aria-disabled={!data}
          className="mb-4 ml-1 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors duration-150 hover:bg-primary-hover aria-disabled:pointer-events-none aria-disabled:opacity-60"
        >
          <UserPlus size={15} aria-hidden />
          {t("new")}
        </Link>
        {data && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-2">
            <Suspense>
              <ContactsNav
                total={data.contacts.length}
                books={data.books.map(({ id, name, count }) => ({ id, name, count }))}
                groups={data.groups.map(({ id, name, members }) => ({ id, name, count: members.length }))}
              />
            </Suspense>
            <NewGroup />
            <div className="mt-auto flex flex-col gap-0.5 border-t border-line pt-3">
              <ImportVcf />
              <a
                href="/contacts/export"
                download
                className="flex h-8 items-center gap-3 rounded-md px-3 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
              >
                <Download size={16} aria-hidden className="shrink-0" />
                {t("export")}
              </a>
            </div>
          </div>
        )}
      </aside>
      <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </>
  );
}
