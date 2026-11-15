// People tools: the user's contacts (search, create, update, delete) and the organization
// directory (one entry per person across the org's domains, with readable names).
import { getPrincipals } from "../calendar";
import {
  CONTACTS_USING,
  contactsAccount,
  fromCard,
  getAllCards,
  newCard,
  parseBirthday,
  toCardProps,
  type Contact,
  type ContactInput,
  type EmailLabel,
  type JSCard,
  type PhoneLabel,
} from "../contacts";
import { jmap } from "../jmap";
import { bool, id, int, isEmail, str, ToolError, type Args } from "./args";
import { B, fold, I, page, personName, S, type JsonSchema, type Tool } from "./kit";

/* ---------------------------------------------------------------- contacts */

const EMAIL_LABELS: EmailLabel[] = ["work", "home", "other"];
const PHONE_LABELS: PhoneLabel[] = ["mobile", "work", "home", "other"];
const PHONE = /^[0-9+()\-.\s/#*xX]{3,50}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const localPart = (email: string) => email.slice(0, email.lastIndexOf("@")).toLowerCase();

/** A contact's name for display: its own name, else a readable form of its first address. */
const contactName = (c: Contact) =>
  c.displayName && !c.displayName.includes("@") ? c.displayName : c.emails[0] ? personName(null, c.emails[0].value) : c.displayName || c.company;

/**
 * Contacts in the shape returned to clients. Cards of the same person (same readable name and
 * the same address local part, e.g. one card per company domain) are merged into one entry.
 */
function compactContacts(list: Contact[]) {
  const out = new Map<string, { id: string; ids: string[]; name: string; emails: string[]; phones: string[]; company?: string; title?: string }>();
  for (const c of list) {
    const name = contactName(c);
    const emails = c.emails.map((e) => e.value);
    const key = `${fold(name)}|${emails[0] ? localPart(emails[0]) : c.id}`;
    const prev = out.get(key);
    if (prev) {
      prev.ids.push(c.id);
      for (const e of emails) if (!prev.emails.some((x) => x.toLowerCase() === e.toLowerCase())) prev.emails.push(e);
      for (const p of c.phones) if (!prev.phones.includes(p.value)) prev.phones.push(p.value);
      prev.company ??= c.company || undefined;
      prev.title ??= c.title || undefined;
      continue;
    }
    out.set(key, {
      id: c.id,
      ids: [c.id],
      name,
      emails,
      phones: c.phones.map((p) => p.value),
      company: c.company || undefined,
      title: c.title || undefined,
    });
  }
  return [...out.values()].map(({ ids, phones, ...c }) => ({
    ...c,
    otherIds: ids.length > 1 ? ids.slice(1) : undefined,
    phones: phones.length ? phones : undefined,
  }));
}

function cleanText(a: Args, key: string, max: number): string | undefined {
  const v = str(a, key, { max });
  return v === undefined ? undefined : v.replace(CONTROL, "").trim();
}

/** Emails as strings ("a@b.c") or objects ({ value, label }). */
function emailItems(a: Args, key: string): { label: EmailLabel; value: string }[] | undefined {
  const v = a[key];
  if (v == null) return undefined;
  const list = typeof v === "string" ? v.split(",") : v;
  if (!Array.isArray(list) || list.length > 10) throw new ToolError(`"${key}" must be a list of up to 10 addresses`);
  return list
    .map((x) => {
      const o = (typeof x === "object" && x ? x : { value: x }) as { value?: unknown; label?: unknown };
      const value = typeof o.value === "string" ? o.value.trim() : "";
      if (!value) return null;
      if (!isEmail(value)) throw new ToolError(`Invalid email address: ${value}`);
      const label = EMAIL_LABELS.includes(o.label as EmailLabel) ? (o.label as EmailLabel) : "work";
      return { label, value };
    })
    .filter((x): x is { label: EmailLabel; value: string } => !!x);
}

function phoneItems(a: Args, key: string): { label: PhoneLabel; value: string }[] | undefined {
  const v = a[key];
  if (v == null) return undefined;
  const list = typeof v === "string" ? v.split(",") : v;
  if (!Array.isArray(list) || list.length > 10) throw new ToolError(`"${key}" must be a list of up to 10 numbers`);
  return list
    .map((x) => {
      const o = (typeof x === "object" && x ? x : { value: x }) as { value?: unknown; label?: unknown };
      const value = typeof o.value === "string" ? o.value.trim() : "";
      if (!value) return null;
      if (!PHONE.test(value)) throw new ToolError(`Invalid phone number: ${value}`);
      const label = PHONE_LABELS.includes(o.label as PhoneLabel) ? (o.label as PhoneLabel) : "mobile";
      return { label, value };
    })
    .filter((x): x is { label: PhoneLabel; value: string } => !!x);
}

/** Applies the contact fields present in `args` on top of `base`. */
function contactInput(args: Args, base: ContactInput): ContactInput {
  const next: ContactInput = { ...base, address: { ...base.address } };
  const full = cleanText(args, "name", 200);
  if (full !== undefined) {
    const parts = full.split(/\s+/).filter(Boolean);
    next.given = parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] ?? "");
    next.surname = parts.length > 1 ? parts[parts.length - 1] : "";
  }
  next.given = cleanText(args, "given", 200) ?? next.given;
  next.surname = cleanText(args, "surname", 200) ?? next.surname;
  next.company = cleanText(args, "company", 200) ?? next.company;
  next.title = cleanText(args, "title", 200) ?? next.title;
  next.notes = cleanText(args, "notes", 5000) ?? next.notes;
  const birthday = cleanText(args, "birthday", 10);
  if (birthday !== undefined) {
    if (birthday && !parseBirthday(birthday)) throw new ToolError('"birthday" must be YYYY-MM-DD or --MM-DD');
    next.birthday = birthday;
  }
  const emails = emailItems(args, "emails");
  if (emails) next.emails = emails;
  for (const e of emailItems(args, "addEmails") ?? []) if (!next.emails.some((x) => x.value.toLowerCase() === e.value.toLowerCase())) next.emails.push(e);
  const remove = new Set((emailItems(args, "removeEmails") ?? []).map((e) => e.value.toLowerCase()));
  next.emails = next.emails.filter((e) => !remove.has(e.value.toLowerCase())).slice(0, 10);
  const phones = phoneItems(args, "phones");
  if (phones) next.phones = phones;
  const addr = args.address;
  if (addr != null) {
    if (typeof addr !== "object" || Array.isArray(addr)) throw new ToolError('"address" must be an object');
    const a = addr as Args;
    for (const k of ["street", "locality", "region", "postcode", "country"] as const) {
      const v = cleanText(a, k, k === "street" ? 300 : 200);
      if (v !== undefined) next.address[k] = v;
    }
  }
  if (!next.given && !next.surname && !next.emails.length && !next.phones.length && !next.company) {
    throw new ToolError("A contact needs at least a name, an email, a phone or a company");
  }
  return next;
}

async function addressBooks(): Promise<{ id: string; name: string; isDefault: boolean }[]> {
  const accountId = await contactsAccount();
  const r = await jmap([["AddressBook/get", { accountId }, "b"]], CONTACTS_USING);
  return ((r.b.list as { id: string; name?: string; isDefault?: boolean }[]) ?? []).map((b) => ({ id: b.id, name: b.name ?? "", isDefault: !!b.isDefault }));
}

async function getCard(contactId: string): Promise<JSCard> {
  const accountId = await contactsAccount();
  const r = await jmap([["ContactCard/get", { accountId, ids: [contactId] }, "g"]], CONTACTS_USING);
  const card = ((r.g.list as JSCard[]) ?? [])[0];
  if (!card || card.kind === "group") throw new ToolError("Contact not found");
  return card;
}

function setError(r: Record<string, unknown>, key: "notCreated" | "notUpdated" | "notDestroyed"): string | null {
  const errs = r[key] as Record<string, { type?: string; description?: string }> | null | undefined;
  const first = errs && Object.values(errs)[0];
  return first ? first.description || first.type || "error" : null;
}

const fullContact = (c: Contact) => ({
  id: c.id,
  name: contactName(c),
  emails: c.emails.length ? c.emails.map((e) => `${e.value} (${e.label})`) : undefined,
  phones: c.phones.length ? c.phones.map((p) => `${p.value} (${p.label})`) : undefined,
  company: c.company || undefined,
  title: c.title || undefined,
  birthday: c.birthday || undefined,
  address: c.address ? Object.values(c.address).filter(Boolean).join(", ") : undefined,
  notes: c.notes || undefined,
});

const CONTACT_PROPS: Record<string, JsonSchema> = {
  name: S('Full name ("Ana García López": the last word becomes the surname). Or use given/surname.'),
  given: S("Given (first) name."),
  surname: S("Surname."),
  emails: {
    type: "array",
    description: 'Email addresses: strings or { value, label: "work"|"home"|"other" }. Replaces the list on update.',
    items: { anyOf: [{ type: "string" }, { type: "object", properties: { value: { type: "string" }, label: { type: "string" } } }] },
  },
  phones: {
    type: "array",
    description: 'Phone numbers: strings or { value, label: "mobile"|"work"|"home"|"other" }. Replaces the list on update.',
    items: { anyOf: [{ type: "string" }, { type: "object", properties: { value: { type: "string" }, label: { type: "string" } } }] },
  },
  company: S("Company / organization."),
  title: S("Job title."),
  birthday: S('Birthday "YYYY-MM-DD" (or "--MM-DD" without year).'),
  address: {
    type: "object",
    description: "Postal address.",
    properties: { street: { type: "string" }, locality: { type: "string" }, region: { type: "string" }, postcode: { type: "string" }, country: { type: "string" } },
  },
  notes: S("Notes."),
};

/* --------------------------------------------------------------- directory */

type DirectoryPerson = { name: string; email: string; emails?: string[]; principalId?: string; teamMailbox?: boolean };

/**
 * The organization directory: Chat's folded directory (one entry per person across the org's
 * domains, readable names), or the raw principals folded the same way when Chat isn't available.
 */
async function directoryPeople(): Promise<DirectoryPerson[]> {
  try {
    const [dir, session] = await Promise.all([import("@/lib/chat/directory"), import("@/lib/chat/session")]);
    const me = await session.chatUser();
    const r = await dir.loadDirectory(me);
    return dir.foldPeople(r.people, new Set(r.orgDomains), dir.domainOf(me.email)).map((p) => ({
      name: personName(p.name, p.email),
      email: p.email,
      emails: p.emails.length > 1 ? p.emails : undefined,
      principalId: p.principalId ?? undefined,
      teamMailbox: p.shared || undefined,
    }));
  } catch (e) {
    console.error("[mcp] chat directory unavailable, using principals:", e instanceof Error ? e.message : e);
  }
  const principals = (await getPrincipals().catch(() => [])).filter((p) => p.type === "individual" && p.email.includes("@"));
  const byKey = new Map<string, DirectoryPerson>();
  for (const p of principals) {
    const key = localPart(p.email);
    const prev = byKey.get(key);
    if (prev) prev.emails = [...(prev.emails ?? [prev.email]), p.email];
    else byKey.set(key, { name: personName(p.name, p.email), email: p.email, principalId: p.id });
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const matches = (q: string, ...fields: (string | undefined)[]) => fold(fields.filter(Boolean).join("\n")).includes(q);

export const PEOPLE_TOOLS: Tool[] = [
  {
    name: "contacts_search",
    description:
      "Searches the user's contacts (name, email, company, phone) and, optionally, the organization directory of colleagues. People appear once, with readable names, even when they have addresses on several domains.",
    inputSchema: {
      type: "object",
      properties: {
        query: S("Text to match (case- and accent-insensitive substring)."),
        includeDirectory: B("Also search colleagues in the organization directory.", true),
        limit: I("Max results per list.", 1, 100, 20),
      },
      required: ["query"],
    },
    async run(args) {
      const q = fold(str(args, "query", { required: true, max: 200 }).trim());
      if (!q) throw new ToolError('"query" is required');
      const limit = int(args, "limit", { min: 1, max: 100, def: 20 });
      const cards = await getAllCards().catch(() => [] as JSCard[]);
      const found = cards
        .filter((c) => c.kind !== "group")
        .map(fromCard)
        .filter((c) => matches(q, c.displayName, contactName(c), c.company, c.title, ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value)));
      const contacts = compactContacts(found).slice(0, limit);
      let directory: DirectoryPerson[] | undefined;
      if (bool(args, "includeDirectory", true)) {
        const known = new Set(contacts.flatMap((c) => c.emails.map((e) => e.toLowerCase())));
        directory = (await directoryPeople())
          .filter((p) => matches(q, p.name, p.email, ...(p.emails ?? [])))
          // Colleagues already listed as contacts aren't repeated.
          .filter((p) => ![p.email, ...(p.emails ?? [])].some((e) => known.has(e.toLowerCase())))
          .slice(0, limit);
      }
      return { contacts, directory };
    },
  },
  {
    name: "directory_search",
    description:
      "Searches the organization directory: one entry per colleague (all their addresses across the org's domains), with readable names and the address to use. Omit query to list everyone (paginated).",
    inputSchema: {
      type: "object",
      properties: {
        query: S("Name or address contains (case- and accent-insensitive)."),
        includeTeamMailboxes: B("Also list team mailboxes such as support@ or billing@."),
        limit: I("Max results.", 1, 200, 50),
        position: I("Offset for pagination.", 0, 10_000, 0),
      },
    },
    async run(args) {
      const q = fold(str(args, "query", { max: 200 })?.trim() ?? "");
      const limit = int(args, "limit", { min: 1, max: 200, def: 50 });
      const position = int(args, "position", { min: 0, max: 10_000, def: 0 });
      const teams = bool(args, "includeTeamMailboxes");
      const all = (await directoryPeople()).filter((p) => (teams || !p.teamMailbox) && (!q || matches(q, p.name, p.email, ...(p.emails ?? []))));
      const { total, nextPosition, items } = page(all, position, limit);
      return { total, nextPosition, people: items };
    },
  },
  {
    name: "contacts_create",
    description: "Adds a contact to the user's address book.",
    inputSchema: {
      type: "object",
      properties: { ...CONTACT_PROPS, addressBookId: S("Address book id (default: the default address book).") },
    },
    write: true,
    async run(args) {
      const books = await addressBooks();
      const wanted = id(args, "addressBookId");
      const book = wanted ? books.find((b) => b.id === wanted) : (books.find((b) => b.isDefault) ?? books[0]);
      if (!book) throw new ToolError(wanted ? "Unknown address book" : "No address book is available");
      const input = contactInput(args, {
        given: "",
        surname: "",
        emails: [],
        phones: [],
        company: "",
        title: "",
        address: { street: "", locality: "", region: "", postcode: "", country: "" },
        birthday: "",
        notes: "",
        addressBookId: book.id,
      });
      const accountId = await contactsAccount();
      const r = await jmap([["ContactCard/set", { accountId, create: { c: newCard(input) } }, "s"]], CONTACTS_USING);
      const created = (r.s.created as Record<string, { id: string }> | null)?.c;
      if (!created) throw new ToolError(`Could not create the contact: ${setError(r.s, "notCreated") ?? "error"}`);
      return { created: true, contact: fullContact(fromCard({ ...(newCard(input) as Omit<JSCard, "id">), id: created.id })) };
    },
  },
  {
    name: "contacts_update",
    description:
      "Updates a contact: only the fields you pass change. emails/phones replace the lists; addEmails/removeEmails edit the email list.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: S("Contact id (from contacts_search)."),
        ...CONTACT_PROPS,
        addEmails: { type: "array", items: { type: "string" }, description: "Addresses to add." },
        removeEmails: { type: "array", items: { type: "string" }, description: "Addresses to remove." },
      },
      required: ["contactId"],
    },
    write: true,
    async run(args) {
      const contactId = id(args, "contactId", { required: true });
      const card = await getCard(contactId);
      const c = fromCard(card);
      const input = contactInput(args, {
        given: c.given,
        surname: c.surname,
        emails: c.emails,
        phones: c.phones,
        company: c.company,
        title: c.title,
        address: c.address ?? { street: "", locality: "", region: "", postcode: "", country: "" },
        birthday: c.birthday,
        notes: c.notes,
        addressBookId: c.addressBookIds[0] ?? "",
      });
      // Only the card properties behind the fields passed are rewritten, so untouched parts keep
      // whatever the card holds beyond the flattened view (e.g. a full name without components).
      const all = toCardProps(input);
      const touched: Record<string, string[]> = {
        name: ["name", "given", "surname"],
        emails: ["emails", "addEmails", "removeEmails"],
        phones: ["phones"],
        organizations: ["company"],
        titles: ["title"],
        addresses: ["address"],
        anniversaries: ["birthday"],
        notes: ["notes"],
      };
      const props = Object.fromEntries(Object.entries(all).filter(([k]) => (touched[k] ?? []).some((a) => args[a] != null)));
      if (!Object.keys(props).length) throw new ToolError("Nothing to change");
      const accountId = await contactsAccount();
      const r = await jmap([["ContactCard/set", { accountId, update: { [contactId]: props } }, "s"]], CONTACTS_USING);
      const err = setError(r.s, "notUpdated");
      if (err) throw new ToolError(`Could not update the contact: ${err}`);
      return { updated: true, contact: fullContact(fromCard(await getCard(contactId))) };
    },
  },
  {
    name: "contacts_delete",
    description: "Deletes a contact from the user's address book.",
    inputSchema: { type: "object", properties: { contactId: S("Contact id (from contacts_search).") }, required: ["contactId"] },
    write: true,
    destructive: true,
    async run(args) {
      const contactId = id(args, "contactId", { required: true });
      const card = await getCard(contactId);
      const accountId = await contactsAccount();
      const r = await jmap([["ContactCard/set", { accountId, destroy: [contactId] }, "d"]], CONTACTS_USING);
      const err = setError(r.d, "notDestroyed");
      if (err) throw new ToolError(`Could not delete the contact: ${err}`);
      return { deleted: true, name: contactName(fromCard(card)) };
    },
  },
];
