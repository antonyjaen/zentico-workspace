"use server";

// Contact mutations (ContactCard/set). Every input is validated here: forms are untrusted.
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { contactsHref } from "./hrefs";
import { parseVcards } from "./vcard";
import {
  CONTACTS_USING,
  contactsAccount,
  getContactsData,
  newCard,
  parseBirthday,
  toCardProps,
  type ContactInput,
  type EmailLabel,
  type PhoneLabel,
} from "@/lib/contacts";
import { jmap } from "@/lib/jmap";

export type FormState = { error?: string; ok?: string } | undefined;

const ID = /^[A-Za-z0-9_-]{1,255}$/;
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const PHONE = /^[0-9+()\-.\s/#*xX]{3,50}$/;
const EMAIL_LABELS: EmailLabel[] = ["work", "home", "other"];
const PHONE_LABELS: PhoneLabel[] = ["mobile", "work", "home", "other"];

class InvalidInput extends Error {}

function text(fd: FormData, key: string, max: number): string {
  const v = fd.get(key);
  if (v !== null && typeof v !== "string") throw new InvalidInput(key);
  const s = (v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (s.length > max) throw new InvalidInput(key);
  return s;
}

function id(fd: FormData, key: string): string {
  const v = fd.get(key);
  if (typeof v !== "string" || !ID.test(v)) throw new InvalidInput(key);
  return v;
}

/** JSON-pointer escaping for patch paths such as `members/<uid>`. */
const ptr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

function setErrors(r: Record<string, unknown>, key: "notCreated" | "notUpdated" | "notDestroyed") {
  const errs = r[key] as Record<string, { type?: string; description?: string }> | null | undefined;
  const first = errs && Object.values(errs)[0];
  return first ? first.description || first.type || "error" : null;
}

async function parseContact(fd: FormData): Promise<ContactInput> {
  const values = (k: string) => fd.getAll(k).map((v) => (typeof v === "string" ? v.trim() : ""));
  const emailValues = values("emailValue");
  const emailLabels = values("emailLabel");
  const phoneValues = values("phoneValue");
  const phoneLabels = values("phoneLabel");
  if (emailValues.length > 10 || phoneValues.length > 10) throw new InvalidInput("too many");

  const emails = emailValues
    .map((value, i) => ({ value, label: emailLabels[i] as EmailLabel }))
    .filter((e) => e.value);
  for (const e of emails) {
    if (e.value.length > 254 || !EMAIL.test(e.value)) throw new InvalidInput("email");
    if (!EMAIL_LABELS.includes(e.label)) e.label = "other";
  }
  const phones = phoneValues
    .map((value, i) => ({ value, label: phoneLabels[i] as PhoneLabel }))
    .filter((p) => p.value);
  for (const p of phones) {
    if (!PHONE.test(p.value)) throw new InvalidInput("phone");
    if (!PHONE_LABELS.includes(p.label)) p.label = "other";
  }

  const birthday = text(fd, "birthday", 10);
  if (birthday && !parseBirthday(birthday)) throw new InvalidInput("birthday");

  const input: ContactInput = {
    given: text(fd, "given", 200),
    surname: text(fd, "surname", 200),
    emails,
    phones,
    company: text(fd, "company", 200),
    title: text(fd, "title", 200),
    address: {
      street: text(fd, "street", 300),
      locality: text(fd, "locality", 200),
      region: text(fd, "region", 200),
      postcode: text(fd, "postcode", 40),
      country: text(fd, "country", 200),
    },
    birthday,
    notes: text(fd, "notes", 5000),
    addressBookId: id(fd, "addressBookId"),
  };
  if (!input.given && !input.surname && !emails.length && !phones.length && !input.company)
    throw new InvalidInput("empty");

  const { books } = await getContactsData();
  if (!books.some((b) => b.id === input.addressBookId)) throw new InvalidInput("addressBookId");
  return input;
}

const errorKey = (e: unknown) => {
  unstable_rethrow(e);
  if (e instanceof InvalidInput) return e.message === "empty" ? "empty" : `invalid:${e.message}`;
  return "failed";
};

/** Creates (no `id`) or updates a contact, then opens it. */
export async function saveContact(_prev: FormState, fd: FormData): Promise<FormState> {
  let savedId: string;
  try {
    const input = await parseContact(fd);
    const accountId = await contactsAccount();
    const existing = fd.get("id");
    if (existing) {
      const cardId = id(fd, "id");
      const r = await jmap(
        [
          [
            "ContactCard/set",
            {
              accountId,
              update: { [cardId]: { ...toCardProps(input), addressBookIds: { [input.addressBookId]: true } } },
            },
            "s",
          ],
        ],
        CONTACTS_USING,
      );
      const err = setErrors(r.s, "notUpdated");
      if (err) return { error: "failed" };
      savedId = cardId;
    } else {
      const r = await jmap([["ContactCard/set", { accountId, create: { c: newCard(input) } }, "s"]], CONTACTS_USING);
      const created = (r.s.created as Record<string, { id: string }> | null)?.c;
      if (!created) return { error: "failed" };
      savedId = created.id;
    }
  } catch (e) {
    return { error: errorKey(e) };
  }
  revalidatePath("/contacts", "layout");
  redirect(contactsHref({ id: savedId }));
}

export async function deleteContact(fd: FormData) {
  const cardId = id(fd, "id");
  const accountId = await contactsAccount();
  const r = await jmap([["ContactCard/set", { accountId, destroy: [cardId] }, "d"]], CONTACTS_USING);
  if (setErrors(r.d, "notDestroyed")) throw new Error("Could not delete contact");
  revalidatePath("/contacts", "layout");
  redirect("/contacts");
}

export async function createGroup(_prev: FormState, fd: FormData): Promise<FormState> {
  let groupId: string;
  try {
    const name = text(fd, "name", 120);
    if (!name) return { error: "empty" };
    const { books } = await getContactsData();
    const book = books[0];
    if (!book) return { error: "failed" };
    const accountId = await contactsAccount();
    const r = await jmap(
      [
        [
          "ContactCard/set",
          {
            accountId,
            create: {
              g: {
                "@type": "Card",
                version: "1.0",
                uid: `urn:uuid:${crypto.randomUUID()}`,
                kind: "group",
                name: { "@type": "Name", full: name },
                addressBookIds: { [book.id]: true },
              },
            },
          },
          "s",
        ],
      ],
      CONTACTS_USING,
    );
    const created = (r.s.created as Record<string, { id: string }> | null)?.g;
    if (!created) return { error: "failed" };
    groupId = created.id;
  } catch (e) {
    return { error: errorKey(e) };
  }
  revalidatePath("/contacts", "layout");
  redirect(contactsHref({ group: groupId }));
}

export async function deleteGroup(fd: FormData) {
  const groupId = id(fd, "groupId");
  const { groups } = await getContactsData();
  if (!groups.some((g) => g.id === groupId)) throw new Error("Unknown group");
  const accountId = await contactsAccount();
  await jmap([["ContactCard/set", { accountId, destroy: [groupId] }, "d"]], CONTACTS_USING);
  revalidatePath("/contacts", "layout");
  redirect("/contacts");
}

/** Adds (`on=1`) or removes a contact from a group. Members are keyed by the contact's uid. */
export async function setMembership(fd: FormData) {
  const groupId = id(fd, "groupId");
  const contactId = id(fd, "contactId");
  const on = fd.get("on") === "1";
  const { groups, contacts } = await getContactsData();
  const contact = contacts.find((c) => c.id === contactId);
  if (!contact || !groups.some((g) => g.id === groupId)) throw new Error("Unknown contact or group");
  const accountId = await contactsAccount();
  const r = await jmap(
    [
      [
        "ContactCard/set",
        { accountId, update: { [groupId]: { [`members/${ptr(contact.uid)}`]: on ? true : null } } },
        "s",
      ],
    ],
    CONTACTS_USING,
  );
  if (setErrors(r.s, "notUpdated")) throw new Error("Could not update group");
  revalidatePath("/contacts", "layout");
}

const MAX_VCF_BYTES = 2 * 1024 * 1024;

export async function importVcf(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "noFile" };
    if (file.size > MAX_VCF_BYTES) return { error: "tooLarge" };
    const { books } = await getContactsData();
    const bookId = (fd.get("addressBookId") as string | null) || books.find((b) => b.isDefault)?.id || books[0]?.id;
    if (!bookId || !books.some((b) => b.id === bookId)) return { error: "failed" };

    const inputs = parseVcards(await file.text(), bookId, 1000);
    if (!inputs.length) return { error: "noCards" };

    const accountId = await contactsAccount();
    let created = 0;
    for (let i = 0; i < inputs.length; i += 100) {
      const chunk = inputs.slice(i, i + 100);
      const create = Object.fromEntries(chunk.map((c, j) => [`c${j}`, newCard(c)]));
      const r = await jmap([["ContactCard/set", { accountId, create }, "s"]], CONTACTS_USING);
      created += Object.keys((r.s.created as Record<string, unknown> | null) ?? {}).length;
    }
    revalidatePath("/contacts", "layout");
    return { ok: String(created) };
  } catch (e) {
    return { error: errorKey(e) };
  }
}
