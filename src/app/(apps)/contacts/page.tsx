import { Search, Trash2, UserPlus, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { deleteGroup } from "./actions";
import { ContactDetail } from "./ContactDetail";
import { ContactForm } from "./ContactForm";
import { avatarGradient, contactsHref, initials, type ContactsView } from "./hrefs";
import { getContactsData, searchContactIds, type Contact } from "@/lib/contacts";
import { getMailboxes } from "@/lib/mail";

type Params = { q?: string; book?: string; group?: string; id?: string; edit?: string; new?: string };

const one = (v: unknown, max = 255) => (typeof v === "string" && v.length <= max ? v : undefined);

function sectionKey(name: string) {
  const ch = name.normalize("NFD").replace(/[̀-ͯ]/g, "").charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : "#";
}

function matchesLocally(c: Contact, q: string) {
  const needle = q.toLowerCase();
  return [c.displayName, c.company, ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value)].some((v) =>
    v.toLowerCase().includes(needle),
  );
}

function Unavailable({ message, hint }: { message: string; hint: string }) {
  return (
    <div className="grid flex-1 place-items-center p-10 text-center">
      <div className="rise max-w-sm">
        <span
          className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-line bg-sheet-muted"
          style={{ color: "var(--color-app-contacts)" }}
        >
          <Users size={26} aria-hidden />
        </span>
        <p className="mt-6 text-[17px] font-medium text-ink">{message}</p>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">{hint}</p>
      </div>
    </div>
  );
}

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const t = await getTranslations("contacts");
  const q = one(sp.q, 200)?.trim() || undefined;
  const view: ContactsView = { q, book: one(sp.book), group: one(sp.group) };
  const selectedId = one(sp.id);
  const isNew = sp.new === "1";
  const isEdit = sp.edit === "1";

  let data: Awaited<ReturnType<typeof getContactsData>>;
  try {
    data = await getContactsData();
  } catch (e) {
    unstable_rethrow(e);
    return <Unavailable message={t("unavailable")} hint={t("unavailableHint")} />;
  }
  const { books, groups, contacts } = data;
  const group = view.group ? groups.find((g) => g.id === view.group) : undefined;
  const book = view.book ? books.find((b) => b.id === view.book) : undefined;

  let list = contacts;
  if (book) list = list.filter((c) => c.addressBookIds.includes(book.id));
  if (group) {
    const members = new Set(group.members);
    list = list.filter((c) => members.has(c.uid));
  }
  if (q) {
    const ids = await searchContactIds(q, book?.id).catch((e) => {
      unstable_rethrow(e);
      return null;
    });
    list = ids ? list.filter((c) => ids.has(c.id) || matchesLocally(c, q)) : list.filter((c) => matchesLocally(c, q));
  }

  const sections = new Map<string, Contact[]>();
  for (const c of list) {
    const k = sectionKey(c.displayName);
    sections.set(k, [...(sections.get(k) ?? []), c]);
  }
  const keys = [...sections.keys()].sort((a, b) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)));

  const selected = selectedId ? contacts.find((c) => c.id === selectedId) : undefined;
  const panelOpen = isNew || !!selected;

  const inboxId = selected?.emails.length
    ? await getMailboxes()
        .then((m) => (m.find((x) => x.role === "inbox") ?? m[0])?.id)
        .catch((e) => {
          unstable_rethrow(e);
          return undefined;
        })
    : undefined;

  const heading = group?.name ?? (book && books.length > 1 ? book.name : t("all"));
  const defaultBookId = (book ?? books.find((b) => b.isDefault) ?? books[0])?.id ?? "";

  return (
    <div className="flex min-h-0 flex-1">
      <section
        className={`min-h-0 flex-col border-line md:w-[380px] md:shrink-0 md:border-r ${panelOpen ? "hidden md:flex" : "flex flex-1 md:flex-none"}`}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
          <form action="/contacts" role="search" className="flex-1">
            {view.book && <input type="hidden" name="book" value={view.book} />}
            {view.group && <input type="hidden" name="group" value={view.group} />}
            <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-sheet px-2.5 transition-colors focus-within:border-line-strong hover:border-line-strong">
              <Search size={15} className="shrink-0 text-ink-mute" aria-hidden />
              <span className="sr-only">{t("search")}</span>
              <input
                name="q"
                type="search"
                defaultValue={q}
                maxLength={200}
                placeholder={t("search")}
                autoComplete="off"
                className="h-full w-full bg-transparent text-[13.5px] text-ink placeholder:text-ink-mute focus:outline-none"
              />
            </label>
          </form>
          <Link href={contactsHref({ new: true })} className="icon-btn h-8 w-8 lg:hidden" aria-label={t("new")} title={t("new")}>
            <UserPlus size={16} aria-hidden />
          </Link>
        </div>

        <div className="flex h-10 shrink-0 items-center gap-2 px-4">
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{heading}</h1>
          <span className="font-mono text-[12px] tabular-nums text-ink-mute">{list.length}</span>
          {group && (
            <form action={deleteGroup}>
              <input type="hidden" name="groupId" value={group.id} />
              <button type="submit" className="icon-btn h-7 w-7" aria-label={t("deleteGroup")} title={t("deleteGroup")}>
                <Trash2 size={14} aria-hidden />
              </button>
            </form>
          )}
        </div>

        {list.length === 0 ? (
          <div className="grid flex-1 place-items-center p-10 text-center">
            <div className="rise">
              <p className="text-[15px] font-medium text-ink">
                {q ? t("noResults") : group ? t("emptyGroup") : t("empty")}
              </p>
              {!q && !group && (
                <Link
                  href={contactsHref({ new: true })}
                  className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-line px-3.5 text-[13.5px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
                >
                  <UserPlus size={15} aria-hidden />
                  {t("new")}
                </Link>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto pb-2">
            {keys.map((k) => (
              <section key={k} aria-label={k}>
                <h2 className="sticky top-0 z-10 bg-sheet/95 px-4 pt-3 pb-1 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-ink-mute backdrop-blur">
                  {k}
                </h2>
                <ul>
                  {sections.get(k)!.map((c) => {
                    const active = c.id === selected?.id;
                    const sub = [c.emails[0]?.value, c.company].filter(Boolean).join(" · ") || c.phones[0]?.value;
                    return (
                      <li key={c.id}>
                        <Link
                          href={contactsHref({ ...view, id: c.id })}
                          aria-current={active ? "true" : undefined}
                          className="mx-2 flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-hover aria-[current=true]:bg-primary-soft"
                        >
                          <span
                            aria-hidden
                            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[12.5px] font-semibold text-white ring-1 ring-line"
                            style={{ background: avatarGradient(c.emails[0]?.value || c.uid) }}
                          >
                            {initials(c.displayName)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[14px] font-medium text-ink">
                              {c.displayName || t("noName")}
                            </span>
                            {sub && <span className="block truncate text-[12.5px] text-ink-mute">{sub}</span>}
                          </span>
                          {c.phones[0] && c.emails[0] && (
                            <span className="hidden truncate font-mono text-[11.5px] text-ink-mute xl:block">
                              {c.phones[0].value}
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </section>

      <section className={`min-h-0 min-w-0 flex-1 flex-col ${panelOpen ? "flex" : "hidden md:flex"}`}>
        {isNew ? (
          <ContactForm books={books} defaultBookId={defaultBookId} backHref={contactsHref(view)} />
        ) : selected && isEdit ? (
          <ContactForm
            books={books}
            defaultBookId={selected.addressBookIds[0] ?? defaultBookId}
            contact={selected}
            backHref={contactsHref({ ...view, id: selected.id })}
          />
        ) : selected ? (
          <ContactDetail
            contact={selected}
            groups={groups}
            books={books}
            view={view}
            inboxId={inboxId}
          />
        ) : (
          <div className="grid flex-1 place-items-center p-10 text-center">
            <p className="text-[14px] text-ink-mute">{selectedId ? t("notFound") : t("selectHint")}</p>
          </div>
        )}
      </section>
    </div>
  );
}
