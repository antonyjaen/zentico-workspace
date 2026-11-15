import { ArrowLeft, Building2, Cake, Check, Mail, MapPin, Pencil, Phone, Plus, StickyNote, Trash2 } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { deleteContact, setMembership } from "./actions";
import { avatarGradient, contactsHref, initials, type ContactsView } from "./hrefs";
import { composeHref } from "../mail/hrefs";
import type { AddressBook, Contact, Group } from "@/lib/contacts";

/** Opens the mail composer addressed to `email` (the composer reads `to` once it supports prefill). */
function sendEmailHref(email: string, inboxId?: string) {
  const base = composeHref(inboxId ? `/mail/${inboxId}` : "/mail", "new");
  return `${base}&to=${encodeURIComponent(email)}`;
}

function formatBirthday(value: string, locale: string) {
  const m = /^(\d{4}|-)-?(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const hasYear = m[1] !== "-";
  const d = new Date(Date.UTC(hasYear ? Number(m[1]) : 2000, Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    ...(hasYear ? { year: "numeric" } : {}),
  }).format(d);
}

function Row({ icon: Icon, children }: { icon: typeof Mail; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 border-b border-line py-3.5 last:border-b-0">
      <Icon size={17} aria-hidden className="mt-0.5 shrink-0 text-ink-mute" />
      <div className="min-w-0 flex-1 space-y-1.5">{children}</div>
    </div>
  );
}

const LABEL = "ml-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mute";

export async function ContactDetail({
  contact: c,
  groups,
  books,
  view,
  inboxId,
}: {
  contact: Contact;
  groups: Group[];
  books: AddressBook[];
  view: ContactsView;
  inboxId?: string;
}) {
  const t = await getTranslations("contacts");
  const locale = await getLocale();
  const a = c.address;
  const bookNames = books.filter((b) => c.addressBookIds.includes(b.id)).map((b) => b.name);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3">
        <Link href={contactsHref(view)} className="icon-btn h-9 w-9 md:hidden" aria-label={t("back")}>
          <ArrowLeft size={17} aria-hidden />
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <Link
            href={contactsHref({ ...view, id: c.id, edit: true })}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-line px-3 text-[13px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
          >
            <Pencil size={14} aria-hidden />
            {t("edit")}
          </Link>
          <form action={deleteContact}>
            <input type="hidden" name="id" value={c.id} />
            <button type="submit" className="icon-btn h-8 w-8 hover:text-danger" aria-label={t("delete")} title={t("delete")}>
              <Trash2 size={15} aria-hidden />
            </button>
          </form>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="rise mx-auto max-w-[640px] px-6 py-8">
          <div className="flex items-center gap-5">
            <span
              aria-hidden
              className="grid h-20 w-20 shrink-0 place-items-center rounded-full text-[26px] font-semibold text-white ring-1 ring-line"
              style={{ background: avatarGradient(c.emails[0]?.value || c.uid) }}
            >
              {initials(c.displayName)}
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-[24px] font-semibold tracking-tight text-ink">{c.displayName || t("noName")}</h2>
              {(c.title || c.company) && (
                <p className="mt-0.5 truncate text-[14.5px] text-ink-soft">{[c.title, c.company].filter(Boolean).join(" · ")}</p>
              )}
              {c.emails[0] && (
                <Link
                  href={sendEmailHref(c.emails[0].value, inboxId)}
                  className="mt-3 inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors hover:bg-primary-hover"
                >
                  <Mail size={14} aria-hidden />
                  {t("sendEmail")}
                </Link>
              )}
            </div>
          </div>

          <div className="mt-8 rounded-lg border border-line px-4">
            {c.emails.length > 0 && (
              <Row icon={Mail}>
                {c.emails.map((e, i) => (
                  <p key={i} className="truncate text-[14px]">
                    <Link href={sendEmailHref(e.value, inboxId)} className="text-ink hover:text-accent hover:underline">
                      {e.value}
                    </Link>
                    <span className={LABEL}>{t(`labels.${e.label}`)}</span>
                  </p>
                ))}
              </Row>
            )}
            {c.phones.length > 0 && (
              <Row icon={Phone}>
                {c.phones.map((p, i) => (
                  <p key={i} className="truncate text-[14px]">
                    <a href={`tel:${p.value.replace(/[^\d+]/g, "")}`} className="font-mono text-ink hover:text-accent">
                      {p.value}
                    </a>
                    <span className={LABEL}>{t(`labels.${p.label}`)}</span>
                  </p>
                ))}
              </Row>
            )}
            {(c.company || c.title) && (
              <Row icon={Building2}>
                {c.company && <p className="text-[14px] text-ink">{c.company}</p>}
                {c.title && <p className="text-[13.5px] text-ink-soft">{c.title}</p>}
              </Row>
            )}
            {a && (
              <Row icon={MapPin}>
                <p className="whitespace-pre-line text-[14px] text-ink">
                  {[a.street, [a.postcode, a.locality].filter(Boolean).join(" "), a.region, a.country]
                    .filter(Boolean)
                    .join("\n")}
                </p>
              </Row>
            )}
            {c.birthday && (
              <Row icon={Cake}>
                <p className="text-[14px] text-ink">{formatBirthday(c.birthday, locale)}</p>
              </Row>
            )}
            {c.notes && (
              <Row icon={StickyNote}>
                <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-soft">{c.notes}</p>
              </Row>
            )}
            {!c.emails.length && !c.phones.length && !c.company && !c.title && !a && !c.birthday && !c.notes && (
              <p className="py-4 text-[13.5px] text-ink-mute">{t("noDetails")}</p>
            )}
          </div>

          <h3 className="mt-8 mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute">{t("groups")}</h3>
          {groups.length === 0 ? (
            <p className="text-[13.5px] text-ink-mute">{t("noGroups")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {groups.map((g) => {
                const member = g.members.includes(c.uid);
                return (
                  <form key={g.id} action={setMembership}>
                    <input type="hidden" name="groupId" value={g.id} />
                    <input type="hidden" name="contactId" value={c.id} />
                    <input type="hidden" name="on" value={member ? "0" : "1"} />
                    <button
                      type="submit"
                      aria-pressed={member}
                      title={member ? t("removeFromGroup") : t("addToGroup")}
                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] text-ink-soft transition-colors hover:border-line-strong hover:text-ink aria-pressed:border-transparent aria-pressed:bg-primary-soft aria-pressed:text-ink"
                    >
                      {member ? <Check size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
                      {g.name}
                    </button>
                  </form>
                );
              })}
            </div>
          )}

          {bookNames.length > 0 && books.length > 1 && (
            <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mute">
              {t("addressBook")}: {bookNames.join(", ")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
