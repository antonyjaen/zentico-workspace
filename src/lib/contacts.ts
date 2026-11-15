// Contacts over JMAP for Contacts (RFC 9610): AddressBook + ContactCard (JSContact, RFC 9553).
// The UI works on a flattened `Contact` shape; `toCardProps` maps it back to JSContact.
import { cache } from "react";
import { CAP, jmap, primaryAccount } from "./jmap";

export const CONTACTS_USING = [CAP.core, CAP.contacts];

export type AddressBook = { id: string; name: string; isDefault: boolean; sortOrder: number; count: number };

export type EmailLabel = "work" | "home" | "other";
export type PhoneLabel = "mobile" | "work" | "home" | "other";
export type PostalAddress = { street: string; locality: string; region: string; postcode: string; country: string };

export type Contact = {
  id: string;
  uid: string;
  addressBookIds: string[];
  given: string;
  surname: string;
  displayName: string;
  emails: { label: EmailLabel; value: string }[];
  phones: { label: PhoneLabel; value: string }[];
  company: string;
  title: string;
  address: PostalAddress | null;
  /** YYYY-MM-DD, or --MM-DD when the year is unknown. */
  birthday: string;
  notes: string;
};

export type Group = { id: string; uid: string; name: string; members: string[]; addressBookIds: string[] };

/** What the create/edit form and the vCard importer produce. */
export type ContactInput = {
  given: string;
  surname: string;
  emails: { label: EmailLabel; value: string }[];
  phones: { label: PhoneLabel; value: string }[];
  company: string;
  title: string;
  address: PostalAddress;
  birthday: string;
  notes: string;
  addressBookId: string;
};

// ---------- JSContact (loosely typed: servers may omit anything) ----------

type Ctx = Record<string, boolean> | undefined;
type JSComponent = { kind?: string; value?: string };
export type JSCard = {
  id: string;
  uid?: string;
  kind?: string;
  addressBookIds?: Record<string, boolean>;
  name?: { full?: string; components?: JSComponent[] };
  emails?: Record<string, { address?: string; contexts?: Ctx; label?: string; pref?: number }>;
  phones?: Record<string, { number?: string; features?: Ctx; contexts?: Ctx; label?: string; pref?: number }>;
  organizations?: Record<string, { name?: string }>;
  titles?: Record<string, { name?: string; kind?: string }>;
  addresses?: Record<
    string,
    { full?: string; components?: JSComponent[]; street?: string; locality?: string; region?: string; postcode?: string; country?: string }
  >;
  anniversaries?: Record<string, { kind?: string; date?: unknown }>;
  notes?: Record<string, { note?: string }>;
  members?: Record<string, boolean>;
};

const byPref = <T extends { pref?: number }>(m: Record<string, T> | undefined): T[] =>
  Object.values(m ?? {}).sort((a, b) => (a.pref ?? 100) - (b.pref ?? 100));

const comp = (list: JSComponent[] | undefined, kind: string) =>
  (list ?? []).filter((c) => c.kind === kind).map((c) => c.value ?? "").join(" ").trim();

function emailLabel(e: { contexts?: Ctx }): EmailLabel {
  if (e.contexts?.work) return "work";
  if (e.contexts?.private) return "home";
  return "other";
}

function phoneLabel(p: { features?: Ctx; contexts?: Ctx }): PhoneLabel {
  if (p.features?.mobile) return "mobile";
  if (p.contexts?.work) return "work";
  if (p.contexts?.private) return "home";
  return "other";
}

function readDate(date: unknown): string {
  if (typeof date === "string") return date.slice(0, 10);
  if (!date || typeof date !== "object") return "";
  const d = date as { year?: number; month?: number; day?: number; utc?: string };
  if (d.utc) return d.utc.slice(0, 10);
  if (!d.month || !d.day) return "";
  const md = `${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  return d.year ? `${String(d.year).padStart(4, "0")}-${md}` : `--${md}`;
}

export function fromCard(card: JSCard): Contact {
  const given = comp(card.name?.components, "given");
  const surname = comp(card.name?.components, "surname");
  const emails = byPref(card.emails)
    .filter((e) => e.address)
    .map((e) => ({ label: emailLabel(e), value: e.address! }));
  const phones = byPref(card.phones)
    .filter((p) => p.number)
    .map((p) => ({ label: phoneLabel(p), value: p.number! }));
  const company = Object.values(card.organizations ?? {})[0]?.name ?? "";
  const title = Object.values(card.titles ?? {}).find((t) => t.kind !== "role")?.name ?? "";
  const a = Object.values(card.addresses ?? {})[0];
  const address: PostalAddress | null = a
    ? {
        street:
          [comp(a.components, "number"), comp(a.components, "name")].filter(Boolean).join(" ") ||
          a.street ||
          (a.components ? "" : (a.full ?? "")),
        locality: comp(a.components, "locality") || a.locality || "",
        region: comp(a.components, "region") || a.region || "",
        postcode: comp(a.components, "postcode") || a.postcode || "",
        country: comp(a.components, "country") || a.country || "",
      }
    : null;
  const bday = Object.values(card.anniversaries ?? {}).find((x) => x.kind === "birth");
  const fullName = card.name?.full?.trim() || [given, surname].filter(Boolean).join(" ");
  return {
    id: card.id,
    uid: card.uid ?? card.id,
    addressBookIds: Object.keys(card.addressBookIds ?? {}),
    given,
    surname,
    displayName: fullName || emails[0]?.value || company || "",
    emails,
    phones,
    company,
    title,
    address: address && Object.values(address).some(Boolean) ? address : null,
    birthday: bday ? readDate(bday.date) : "",
    notes: Object.values(card.notes ?? {})
      .map((n) => n.note ?? "")
      .filter(Boolean)
      .join("\n\n"),
  };
}

const EMAIL_CTX: Record<EmailLabel, Ctx> = { work: { work: true }, home: { private: true }, other: undefined };
const PHONE_CTX: Record<PhoneLabel, Ctx> = { work: { work: true }, home: { private: true }, mobile: undefined, other: undefined };

/**
 * JSContact properties for a create, or the replacement values for an update. Empty fields are
 * `null` so an update clears them; strip nulls before a create with `withoutNulls`.
 */
export function toCardProps(input: ContactInput): Record<string, unknown> {
  const full = [input.given, input.surname].filter(Boolean).join(" ");
  const components = [
    input.given && { "@type": "NameComponent", kind: "given", value: input.given },
    input.surname && { "@type": "NameComponent", kind: "surname", value: input.surname },
  ].filter(Boolean);
  const a = input.address;
  const addrComponents = (
    [
      ["name", a.street],
      ["locality", a.locality],
      ["region", a.region],
      ["postcode", a.postcode],
      ["country", a.country],
    ] as const
  )
    .filter(([, v]) => v)
    .map(([kind, value]) => ({ "@type": "AddressComponent", kind, value }));
  const bday = parseBirthday(input.birthday);

  return {
    name: full ? { "@type": "Name", components, full } : null,
    emails: input.emails.length
      ? Object.fromEntries(
          input.emails.map((e, i) => [
            `e${i + 1}`,
            { "@type": "EmailAddress", address: e.value, contexts: EMAIL_CTX[e.label], pref: i === 0 ? 1 : undefined },
          ]),
        )
      : null,
    phones: input.phones.length
      ? Object.fromEntries(
          input.phones.map((p, i) => [
            `p${i + 1}`,
            {
              "@type": "Phone",
              number: p.value,
              features: p.label === "mobile" ? { mobile: true } : { voice: true },
              contexts: PHONE_CTX[p.label],
              pref: i === 0 ? 1 : undefined,
            },
          ]),
        )
      : null,
    organizations: input.company ? { o1: { "@type": "Organization", name: input.company } } : null,
    titles: input.title ? { t1: { "@type": "Title", kind: "title", name: input.title } } : null,
    addresses: addrComponents.length ? { a1: { "@type": "Address", components: addrComponents } } : null,
    anniversaries: bday ? { b1: { "@type": "Anniversary", kind: "birth", date: { "@type": "PartialDate", ...bday } } } : null,
    notes: input.notes ? { n1: { "@type": "Note", note: input.notes } } : null,
  };
}

export function withoutNulls(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
}

export function newCard(input: ContactInput): Record<string, unknown> {
  return {
    "@type": "Card",
    version: "1.0",
    uid: `urn:uuid:${crypto.randomUUID()}`,
    kind: "individual",
    addressBookIds: { [input.addressBookId]: true },
    ...withoutNulls(toCardProps(input)),
  };
}

/** Accepts YYYY-MM-DD or --MM-DD; returns a JSContact PartialDate body or null. */
export function parseBirthday(value: string): { year?: number; month: number; day: number } | null {
  const m = /^(?:(\d{4})|--)-?(\d{2})-?(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return m[1] ? { year: Number(m[1]), month, day } : { month, day };
}

// ---------- Reads ----------

export const contactsAccount = () => primaryAccount(CAP.contacts);

const PAGE = 500;
const MAX_CARDS = 5000;

/** Every card in the account (individuals and groups), paged to stay under maxObjectsInGet. */
export const getAllCards = cache(async (): Promise<JSCard[]> => {
  const accountId = await contactsAccount();
  const out: JSCard[] = [];
  for (let position = 0; position < MAX_CARDS; position += PAGE) {
    const r = await jmap(
      [
        ["ContactCard/query", { accountId, position, limit: PAGE, calculateTotal: true }, "q"],
        ["ContactCard/get", { accountId, "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" } }, "g"],
      ],
      CONTACTS_USING,
    );
    const list = (r.g.list as JSCard[]) ?? [];
    out.push(...list);
    const total = (r.q.total as number) ?? 0;
    if (list.length < PAGE || out.length >= total) break;
  }
  return out;
});

const isGroup = (c: JSCard) => c.kind === "group";

const collator = () => new Intl.Collator(undefined, { sensitivity: "base" });

export async function getContactsData(): Promise<{ books: AddressBook[]; groups: Group[]; contacts: Contact[] }> {
  const accountId = await contactsAccount();
  const [r, cards] = await Promise.all([
    jmap([["AddressBook/get", { accountId }, "b"]], CONTACTS_USING),
    getAllCards(),
  ]);
  const contacts = cards
    .filter((c) => !isGroup(c))
    .map(fromCard)
    .sort((a, b) => collator().compare(a.displayName, b.displayName));
  const rawBooks = (r.b.list as { id: string; name?: string; isDefault?: boolean; sortOrder?: number }[]) ?? [];
  const books = rawBooks
    .map((b) => ({
      id: b.id,
      name: b.name ?? "",
      isDefault: !!b.isDefault,
      sortOrder: b.sortOrder ?? 0,
      count: contacts.filter((c) => c.addressBookIds.includes(b.id)).length,
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const groups = cards
    .filter(isGroup)
    .map((g) => ({
      id: g.id,
      uid: g.uid ?? g.id,
      name: g.name?.full?.trim() || comp(g.name?.components, "given") || "—",
      members: Object.keys(g.members ?? {}).filter((k) => g.members![k]),
      addressBookIds: Object.keys(g.addressBookIds ?? {}),
    }))
    .sort((a, b) => collator().compare(a.name, b.name));
  return { books, groups, contacts };
}

/** Ids of cards matching a server-side full-text search (ContactCard/query `text` filter). */
export async function searchContactIds(text: string, addressBookId?: string): Promise<Set<string>> {
  const accountId = await contactsAccount();
  const filter: Record<string, unknown> = { text };
  if (addressBookId) filter.inAddressBook = addressBookId;
  const r = await jmap([["ContactCard/query", { accountId, filter, limit: MAX_CARDS }, "q"]], CONTACTS_USING);
  return new Set((r.q.ids as string[]) ?? []);
}

/** Up to `limit` {name, email} pairs for mail autocomplete. */
export async function suggestRecipients(q: string, limit = 8): Promise<{ name: string; email: string }[]> {
  // Stalwart's `text` filter matches whole words only, so typing "Prue" would never find
  // "Prueba"; autocomplete matches prefixes and substrings locally instead.
  const cards = await getAllCards();
  const needle = q.toLowerCase();
  const out: { name: string; email: string; score: number }[] = [];
  for (const card of cards) {
    if (isGroup(card)) continue;
    const c = fromCard(card);
    for (const e of c.emails) {
      const name = c.displayName === e.value ? "" : c.displayName;
      const hay = `${name} ${e.value}`.toLowerCase();
      if (!hay.includes(needle)) continue;
      const score = e.value.toLowerCase().startsWith(needle) || name.toLowerCase().startsWith(needle) ? 0 : 1;
      out.push({ name, email: e.value, score });
    }
  }
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.score - b.score)
    .filter((x) => !seen.has(x.email.toLowerCase()) && seen.add(x.email.toLowerCase()))
    .slice(0, limit)
    .map(({ name, email }) => ({ name, email }));
}
