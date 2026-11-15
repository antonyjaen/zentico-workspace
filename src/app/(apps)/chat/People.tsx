"use client";

// Chat → People: the organization directory (one entry per person across the org's domains) and
// my address-book contacts, with a profile view and quick actions (message, call, email, meet).
import {
  ArrowLeft,
  BookUser,
  Building2,
  CalendarClock,
  Download,
  ExternalLink,
  Info,
  Loader2,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Phone,
  RefreshCw,
  StickyNote,
  UserPlus,
  Video,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePopover } from "@/components/usePopover";
import type { Contact } from "@/lib/contacts";
import { saveContactInline } from "../contacts/actions";
import { ContactForm } from "../contacts/ContactForm";
import { ImportVcf } from "../contacts/SideForms";
import { getMeetings, getPeopleDirectory, getPersonAvailability, startChat, startMeeting } from "./actions";
import type { BusyBlock, DirectoryEntry, PeopleData } from "./shared";
import { Avatar, BTN, BTN_MEET, BTN_PRIMARY, fold, openMeeting, timeOf, useErrorText } from "./ui";

export type PeopleView =
  | { kind: "person"; key: string }
  | { kind: "contact"; id: string }
  | { kind: "editContact"; id: string; back: PeopleView | null }
  | { kind: "newContact"; draft?: Pick<Contact, "given" | "surname" | "emails">; back: PeopleView | null };

/** Loads the People data once `enabled`; `reload(true)` bypasses the server-side cache. */
export function usePeopleData(enabled: boolean) {
  const [data, setData] = useState<PeopleData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async (fresh = false) => {
    setLoading(true);
    const r = await getPeopleDirectory(fresh).catch(() => null);
    setLoading(false);
    if (r?.ok) {
      setData(r.data);
      setError(false);
    } else setError(true);
  }, []);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (enabled && !started) {
      setStarted(true);
      void reload();
    }
  }, [enabled, started, reload]);
  return { data, error, loading, reload };
}

const composeHref = (email: string) => `/mail?compose=new&to=${encodeURIComponent(email)}`;
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
const lower = (s: string) => s.trim().toLowerCase();

/** The directory entry owning one of `emails`, if any. */
function entryFor(data: PeopleData, emails: string[]): DirectoryEntry | null {
  const set = new Set(emails.map(lower));
  return data.people.find((p) => p.emails.some((e) => set.has(e))) ?? null;
}

/** The address-book contact holding one of `emails`, if any. */
function contactFor(data: PeopleData, emails: string[]): Contact | null {
  const set = new Set(emails.map(lower));
  return data.contacts?.find((c) => c.emails.some((e) => set.has(lower(e.value)))) ?? null;
}

function splitName(name: string): { given: string; surname: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || name.includes("@")) return { given: name.includes("@") ? "" : name.trim(), surname: "" };
  return { given: parts[0], surname: parts.slice(1).join(" ") };
}

// ---------- Sidebar list ----------

export function PeopleList({
  query,
  people,
  view,
  onSelect,
}: {
  query: string;
  people: ReturnType<typeof usePeopleData>;
  view: PeopleView | null;
  onSelect: (v: PeopleView) => void;
}) {
  const t = useTranslations("chat");
  const { data, error, loading, reload } = people;
  const q = fold(query.trim());

  const sections = useMemo(() => {
    if (!data) return [];
    const match = (p: DirectoryEntry) => !q || fold(p.name).includes(q) || p.emails.some((e) => fold(e).includes(q));
    const byDomain = new Map<string, DirectoryEntry[]>();
    for (const p of data.people.filter((p) => !p.shared && match(p))) {
      const d = domainOf(p.email);
      byDomain.set(d, [...(byDomain.get(d) ?? []), p]);
    }
    return [...byDomain].sort(([a], [b]) => Number(b === data.myDomain) - Number(a === data.myDomain) || a.localeCompare(b));
  }, [data, q]);

  const shared = useMemo(
    () =>
      (data?.people ?? []).filter(
        (p) => p.shared && (!q || fold(p.name).includes(q) || p.emails.some((e) => fold(e).includes(q))),
      ),
    [data, q],
  );

  const contacts = useMemo(() => {
    if (!data?.contacts) return [];
    return data.contacts.filter(
      (c) =>
        !q ||
        [c.displayName, c.company, ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value)].some((v) => fold(v).includes(q)),
    );
  }, [data, q]);

  if (!data)
    return error ? (
      <div className="px-3 py-6 text-center">
        <p className="text-[12.5px] text-ink-mute">{t("people.loadFailed")}</p>
        <button type="button" onClick={() => reload(true)} className={`${BTN} mt-3`}>
          <RefreshCw size={13} aria-hidden />
          {t("people.retry")}
        </button>
      </div>
    ) : (
      <div className="space-y-1 px-2 pt-2" aria-label={t("loadingPeople")}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
            <span className="h-8 w-8 animate-pulse rounded-full bg-hover" />
            <span className="h-3 w-32 animate-pulse rounded bg-hover" />
          </div>
        ))}
      </div>
    );

  const selectedKey = view?.kind === "person" ? view.key : null;
  const selectedContact = view?.kind === "contact" || view?.kind === "editContact" ? view.id : null;

  return (
    <>
      {data.partial && (
        <p className="mx-2 mt-1 mb-1 flex items-start gap-1.5 rounded-md bg-sheet-muted px-2 py-1.5 text-[11.5px] leading-snug text-ink-mute">
          <Info size={12} className="mt-px shrink-0" aria-hidden />
          {t("people.partial")}
        </p>
      )}

      <div className="flex items-center justify-between px-2 pt-3 pb-1">
        <span className="font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase">{t("people.directory")}</span>
        <button
          type="button"
          onClick={() => reload(true)}
          className="icon-btn h-6 w-6"
          aria-label={t("people.refresh")}
          title={t("people.refresh")}
          disabled={loading}
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden />
        </button>
      </div>
      {sections.length === 0 ? (
        <p className="px-2 pb-3 text-[12.5px] leading-relaxed text-ink-mute">{q ? t("noMatches") : t("people.noPeople")}</p>
      ) : (
        sections.map(([domain, list]) => (
          <section key={domain} aria-label={domain} className="mb-1">
            {(sections.length > 1 || domain !== data.myDomain) && (
              <h3 className="px-2 pt-1.5 pb-0.5 text-[11.5px] text-ink-mute">@{domain}</h3>
            )}
            <ul className="space-y-px">
              {list.map((p) => (
                <li key={p.key}>
                  <PersonRow
                    name={p.name}
                    email={p.email}
                    sub={p.emails.length > 1 ? t("people.addresses", { email: p.email, count: p.emails.length - 1 }) : p.email}
                    active={selectedKey === p.key}
                    onClick={() => onSelect({ kind: "person", key: p.key })}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {shared.length > 0 && (
        <>
          <div className="px-2 pt-3 pb-1">
            <span className="font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase">{t("people.sharedMailboxes")}</span>
          </div>
          <ul className="space-y-px">
            {shared.map((p) => (
              <li key={p.key}>
                <PersonRow
                  name={p.name}
                  email={p.email}
                  sub={p.emails.length > 1 ? t("people.addresses", { email: p.email, count: p.emails.length - 1 }) : p.email}
                  active={selectedKey === p.key}
                  onClick={() => onSelect({ kind: "person", key: p.key })}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="flex items-center justify-between px-2 pt-3 pb-1">
        <span className="font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase">{t("people.contacts")}</span>
        {data.contacts && (
          <button
            type="button"
            onClick={() => onSelect({ kind: "newContact", back: view })}
            className="icon-btn h-6 w-6"
            aria-label={t("people.newContact")}
            title={t("people.newContact")}
          >
            <UserPlus size={13} aria-hidden />
          </button>
        )}
      </div>
      {!data.contacts ? (
        <p className="px-2 pb-3 text-[12.5px] leading-relaxed text-ink-mute">{t("people.contactsUnavailable")}</p>
      ) : contacts.length === 0 ? (
        <p className="px-2 pb-3 text-[12.5px] leading-relaxed text-ink-mute">{q ? t("noMatches") : t("people.noContacts")}</p>
      ) : (
        <ul className="space-y-px">
          {contacts.map((c) => (
            <li key={c.id}>
              <PersonRow
                name={c.displayName || t("people.noName")}
                email={c.emails[0]?.value ?? c.uid}
                sub={[c.emails[0]?.value, c.company].filter(Boolean).join(" · ") || c.phones[0]?.value || ""}
                active={selectedContact === c.id}
                onClick={() => onSelect({ kind: "contact", id: c.id })}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PersonRow({ name, email, sub, active, onClick }: { name: string; email: string; sub: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover aria-[current=page]:bg-primary-soft"
    >
      <Avatar name={name} email={email} size={30} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-ink">{name}</span>
        {sub && <span className="block truncate text-[12px] text-ink-mute">{sub}</span>}
      </span>
    </button>
  );
}

/** Header menu of the People tab: address-book management (import/export, groups). */
export function AddressBookMenu({ onImported }: { onImported: () => void }) {
  const t = useTranslations("chat");
  const menu = usePopover();
  return (
    <div ref={menu.ref} className="relative">
      <button
        type="button"
        onClick={menu.toggle}
        className="icon-btn h-8 w-8"
        aria-label={t("people.addressBook")}
        title={t("people.addressBook")}
        aria-expanded={menu.open}
        aria-haspopup="menu"
      >
        <MoreHorizontal size={17} aria-hidden />
      </button>
      {/* Kept mounted while closed so an import in progress keeps its state. */}
      <div role="menu" hidden={!menu.open} className="pop absolute top-9 right-0 z-30 w-56 p-1">
        <p className="px-3 pt-1.5 pb-1 font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase">{t("people.addressBook")}</p>
        <ImportVcf onImported={onImported} />
        <a
          href="/contacts/export"
          download
          role="menuitem"
          className="flex h-8 items-center gap-3 rounded-md px-3 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
        >
          <Download size={16} aria-hidden className="shrink-0" />
          {t("people.export")}
        </a>
        <Link
          href="/contacts"
          role="menuitem"
          className="flex h-8 items-center gap-3 rounded-md px-3 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
        >
          <BookUser size={16} aria-hidden className="shrink-0" />
          {t("people.manage")}
          <ExternalLink size={12} aria-hidden className="ml-auto text-ink-mute" />
        </Link>
      </div>
    </div>
  );
}

// ---------- Main area ----------

export function PeoplePane({
  view,
  people,
  onSelect,
  onBack,
  onOpenConversation,
}: {
  view: PeopleView;
  people: ReturnType<typeof usePeopleData>;
  onSelect: (v: PeopleView | null) => void;
  onBack: () => void;
  onOpenConversation: (id: string, schedule?: boolean) => void;
}) {
  const t = useTranslations("chat");
  const { data, reload } = people;

  if (!data)
    return (
      <div className="grid flex-1 place-items-center">
        <Loader2 size={18} className="animate-spin text-ink-mute" aria-label={t("loading")} />
      </div>
    );

  const books = data.books;
  const defaultBook = (books.find((b) => b.isDefault) ?? books[0])?.id ?? "";
  const saved = async (id: string) => {
    await reload(true);
    onSelect({ kind: "contact", id });
  };

  if (view.kind === "newContact" || view.kind === "editContact") {
    const contact = view.kind === "editContact" ? data.contacts?.find((c) => c.id === view.id) : undefined;
    if (!data.contacts || !books.length || (view.kind === "editContact" && !contact))
      return <p className="p-10 text-center text-[13.5px] text-ink-mute">{t("people.contactsUnavailable")}</p>;
    return (
      <ContactForm
        key={view.kind === "editContact" ? view.id : "new"}
        books={books}
        defaultBookId={contact?.addressBookIds[0] ?? defaultBook}
        contact={contact}
        draft={view.kind === "newContact" ? view.draft : undefined}
        saveAction={saveContactInline}
        onSaved={saved}
        onCancel={() => onSelect(view.back)}
      />
    );
  }

  let entry: DirectoryEntry | null;
  let contact: Contact | null;
  if (view.kind === "person") {
    entry = data.people.find((p) => p.key === view.key) ?? null;
    contact = entry ? contactFor(data, entry.emails) : null;
  } else {
    contact = data.contacts?.find((c) => c.id === view.id) ?? null;
    entry = contact ? entryFor(data, contact.emails.map((e) => e.value)) : null;
  }
  if (!entry && !contact) return <p className="p-10 text-center text-[13.5px] text-ink-mute">{t("people.notFound")}</p>;

  return (
    <Profile
      key={view.kind === "person" ? `p:${view.key}` : `c:${view.id}`}
      entry={entry}
      contact={contact}
      canAddContact={!!data.contacts && books.length > 0}
      onBack={onBack}
      onEdit={() => contact && onSelect({ kind: "editContact", id: contact.id, back: view })}
      onAdd={() =>
        entry &&
        onSelect({
          kind: "newContact",
          draft: { ...splitName(entry.name), emails: entry.emails.map((value) => ({ label: "work" as const, value })) },
          back: view,
        })
      }
      onOpenConversation={onOpenConversation}
    />
  );
}

function Profile({
  entry,
  contact,
  canAddContact,
  onBack,
  onEdit,
  onAdd,
  onOpenConversation,
}: {
  entry: DirectoryEntry | null;
  contact: Contact | null;
  canAddContact: boolean;
  onBack: () => void;
  onEdit: () => void;
  onAdd: () => void;
  onOpenConversation: (id: string, schedule?: boolean) => void;
}) {
  const t = useTranslations("chat");
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = entry?.name ?? (contact?.displayName || t("people.noName"));
  const emails = entry?.emails ?? [];
  const contactEmails = (contact?.emails ?? []).map((e) => e.value).filter((e) => !emails.includes(lower(e)));
  const mainEmail = entry?.email ?? contact?.emails[0]?.value ?? "";
  /** Chat-able person (shared mailboxes and external contacts only get email). */
  const person = entry && !entry.shared ? entry : null;

  /** Opens (or creates) my DM with this person; null on failure. */
  const dm = async (): Promise<string | null> => {
    if (!entry) return null;
    const r = await startChat([{ email: entry.chatEmail, name: entry.name }], null);
    if (!r.ok) {
      setError(errorText(r.error));
      return null;
    }
    return r.data;
  };

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError(errorText("failed"));
    } finally {
      setBusy(false);
    }
  };

  const message = () =>
    run(async () => {
      const id = await dm();
      if (id) onOpenConversation(id);
    });

  const call = () =>
    run(async () => {
      let convId: string | null = null;
      const ok = await openMeeting(async () => {
        convId = await dm();
        if (!convId) return null;
        const m = await getMeetings(convId);
        if (m.ok && m.data.ongoing) return m.data.ongoing.code;
        const s = await startMeeting(convId);
        if (!s.ok) {
          setError(errorText(s.error));
          return null;
        }
        return s.data.code;
      });
      if (ok && convId) onOpenConversation(convId);
    });

  const schedule = () =>
    run(async () => {
      const id = await dm();
      if (id) onOpenConversation(id, true);
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <button type="button" onClick={onBack} className="icon-btn h-8 w-8 md:hidden" aria-label={t("back")}>
          <ArrowLeft size={17} aria-hidden />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-ink">{t("people.profile")}</h2>
        {contact ? (
          <button type="button" onClick={onEdit} className={BTN}>
            <Pencil size={14} aria-hidden />
            {t("people.editContact")}
          </button>
        ) : (
          entry &&
          canAddContact && (
            <button type="button" onClick={onAdd} className={BTN}>
              <UserPlus size={14} aria-hidden />
              {t("people.addContact")}
            </button>
          )
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[620px] px-6 py-8">
          <div className="flex items-center gap-4">
            <Avatar name={name} email={mainEmail || name} size={64} />
            <div className="min-w-0">
              <h1 className="truncate text-[22px] font-semibold tracking-tight text-ink">{name}</h1>
              {(contact?.title || contact?.company) && (
                <p className="truncate text-[13.5px] text-ink-soft">{[contact.title, contact.company].filter(Boolean).join(" · ")}</p>
              )}
              {entry?.shared && <p className="mt-0.5 text-[12px] text-ink-mute">{t("people.sharedMailbox")}</p>}
              {entry && !entry.shared && entry.source !== "directory" && (
                <p className="mt-0.5 text-[12px] text-ink-mute">{t(`people.source.${entry.source}`)}</p>
              )}
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            {person && (
              <>
                <button type="button" onClick={message} disabled={busy} className={BTN_PRIMARY}>
                  <MessageSquare size={14} aria-hidden />
                  {t("people.message")}
                </button>
                <button type="button" onClick={call} disabled={busy} className={BTN_MEET} style={{ background: "var(--color-app-meet)" }}>
                  <Video size={14} aria-hidden />
                  {t("people.call")}
                </button>
              </>
            )}
            {mainEmail && (
              <a href={composeHref(mainEmail)} className={BTN}>
                <Mail size={14} aria-hidden />
                {t("people.email")}
              </a>
            )}
            {person && (
              <button type="button" onClick={schedule} disabled={busy} className={BTN}>
                <CalendarClock size={14} aria-hidden />
                {t("people.schedule")}
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="mt-3 text-[12.5px] text-danger">
              {error}
            </p>
          )}
          {!entry && contact && <p className="mt-3 text-[12px] text-ink-mute">{t("people.externalHint")}</p>}

          <dl className="mt-8 divide-y divide-line border-y border-line">
            {(emails.length > 0 || contactEmails.length > 0) && (
              <Row icon={<Mail size={16} />} label={t("people.emails")}>
                {[...emails, ...contactEmails].map((e, i) => (
                  <a key={e} href={composeHref(e)} className="block truncate text-[14px] text-ink hover:underline">
                    {e}
                    {i === 0 && emails.length > 1 && <span className="ml-2 text-[11.5px] text-ink-mute">{t("people.preferred")}</span>}
                  </a>
                ))}
              </Row>
            )}
            {contact && contact.phones.length > 0 && (
              <Row icon={<Phone size={16} />} label={t("people.phones")}>
                {contact.phones.map((p) => (
                  <a key={p.value} href={`tel:${p.value.replace(/[^0-9+]/g, "")}`} className="block text-[14px] text-ink hover:underline">
                    {p.value}
                  </a>
                ))}
              </Row>
            )}
            {contact?.company && (
              <Row icon={<Building2 size={16} />} label={t("people.company")}>
                <p className="text-[14px] text-ink">{[contact.company, contact.title].filter(Boolean).join(" · ")}</p>
              </Row>
            )}
            {contact?.notes && (
              <Row icon={<StickyNote size={16} />} label={t("people.notes")}>
                <p className="text-[14px] whitespace-pre-wrap text-ink-soft">{contact.notes}</p>
              </Row>
            )}
          </dl>

          {person?.principalId && <Availability principalId={person.principalId} />}
        </div>
      </div>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-3.5">
      <span className="mt-0.5 shrink-0 text-ink-mute" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <dt className="sr-only">{label}</dt>
        <dd className="space-y-1">{children}</dd>
      </div>
    </div>
  );
}

const DAY_FROM = 7;
const DAY_TO = 21;

/** Today's busy blocks of a directory person (Principal/getAvailability). */
function Availability({ principalId }: { principalId: string }) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const [state, setState] = useState<{ supported: boolean; busy: BusyBlock[] } | null | "error">(null);
  const day = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);

  useEffect(() => {
    let live = true;
    getPersonAvailability(principalId, day, day + 86_400_000)
      .then((r) => live && setState(r.ok ? r.data : "error"))
      .catch(() => live && setState("error"));
    return () => {
      live = false;
    };
  }, [principalId, day]);

  if (state === null)
    return (
      <section className="mt-8">
        <h3 className="mb-2 font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase">{t("people.today")}</h3>
        <div className="h-6 animate-pulse rounded bg-hover" />
      </section>
    );
  if (state === "error" || !state.supported) return null;

  const now = Date.now();
  const busy = state.busy.filter((b) => b.status !== "free").sort((a, b) => a.start - b.start);
  const current = busy.find((b) => b.start <= now && b.end > now);
  const from = day + DAY_FROM * 3_600_000;
  const to = day + DAY_TO * 3_600_000;
  const pct = (ms: number) => `${(Math.min(Math.max(ms, from), to) - from) / (to - from) * 100}%`;

  return (
    <section className="mt-8">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase">{t("people.today")}</h3>
        <span className={`text-[12.5px] ${current ? "text-amber" : "text-ink-soft"}`}>
          {current ? t("people.busyUntil", { time: timeOf(current.end, locale) }) : t("people.freeNow")}
        </span>
      </div>
      <div className="relative h-6 overflow-hidden rounded border border-line bg-sheet-muted" aria-hidden>
        {busy.map((b) => (
          <span
            key={`${b.start}-${b.end}`}
            className="absolute inset-y-0 bg-primary/35"
            style={{ left: pct(b.start), width: `calc(${pct(b.end)} - ${pct(b.start)})` }}
          />
        ))}
        {now > from && now < to && <span className="absolute inset-y-0 w-px bg-danger" style={{ left: pct(now) }} />}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-ink-mute tabular-nums" aria-hidden>
        {[DAY_FROM, 10, 13, 16, 19, DAY_TO].map((h) => (
          <span key={h}>{String(h).padStart(2, "0")}:00</span>
        ))}
      </div>
      <p className="mt-2 text-[12.5px] text-ink-soft">
        {busy.length === 0
          ? t("people.freeAllDay")
          : t("people.busyAt", { times: busy.map((b) => `${timeOf(b.start, locale)}–${timeOf(b.end, locale)}`).join(", ") })}
      </p>
    </section>
  );
}
