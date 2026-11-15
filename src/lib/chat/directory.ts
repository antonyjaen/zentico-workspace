// The organization directory as Chat sees it: Stalwart principals plus everyone known to Chat,
// completed (when the server only shares part of the directory) with address-book contacts and
// recent mail correspondents on the org's domains. One person's mailboxes across the org's
// domains fold into one entry. Server-only; used by Chat actions and the MCP server.
import { unstable_rethrow } from "next/navigation";
import {
  readableName,
  type ChatUser,
  type DirectoryDiagnostics,
  type DirectoryEntry,
  type DirectorySource,
  type Person,
} from "@/app/(apps)/chat/shared";
import { getCalendarSession, getPrincipals, type Principal } from "../calendar";
import { getContactsData, type AddressBook, type Contact } from "../contacts";
import { CAP, jmap, primaryAccount } from "../jmap";
import * as store from "./store";

export const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
// Control characters except tab and newline.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export type DirPerson = Person & { principalId: string | null; source: DirectorySource };
export type DirectoryResult = {
  people: DirPerson[];
  partial: boolean;
  orgDomains: string[];
  contacts: Contact[] | null;
  books: AddressBook[];
  diagnostics: DirectoryDiagnostics;
};

export const localPart = (email: string) => email.slice(0, email.lastIndexOf("@"));
export const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
/** System mailboxes nobody chats with. */
const HIDDEN_LOCALS = new Set(["admin", "administrator", "postmaster", "abuse", "mailer-daemon", "noreply", "no-reply"]);
/** Team mailboxes (one per domain) shown apart from people. */
const SHARED_LOCALS = new Set(["soporte", "support", "facturas", "billing", "info", "ventas", "sales", "contacto", "contact", "rrhh", "hr"]);
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Extra org domains from the environment (comma separated), on top of the ones we can infer. */
function envDomains(): string[] {
  return (process.env.ORG_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,63}$/.test(d));
}

/** Addresses in the From/To/Cc of my last 200 messages. */
async function mailCorrespondents(): Promise<Person[]> {
  const accountId = await primaryAccount(CAP.mail);
  const r = await jmap([
    ["Email/query", { accountId, sort: [{ property: "receivedAt", isAscending: false }], limit: 200 }, "q"],
    [
      "Email/get",
      { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["from", "to", "cc"] },
      "g",
    ],
  ]);
  type Addr = { name?: string | null; email?: string | null };
  const out = new Map<string, Person>();
  for (const m of (r.g.list as Record<string, Addr[] | null>[]) ?? [])
    for (const a of [...(m.from ?? []), ...(m.to ?? []), ...(m.cc ?? [])]) {
      const email = (a.email ?? "").trim().toLowerCase();
      if (!EMAIL.test(email)) continue;
      const name = (a.name ?? "").replace(CONTROL, "").trim().slice(0, 200);
      const prev = out.get(email);
      if (!prev || (prev.name === prev.email && name)) out.set(email, { email, name: name || email });
    }
  return [...out.values()];
}

// Directory lookups hit Stalwart (and, in fallback mode, the mailbox); keep them per user briefly.
const DIRECTORY_TTL_MS = 60_000;
const gDir = globalThis as typeof globalThis & {
  __zwChatDirectory?: Map<number, { at: number; value: Promise<DirectoryResult> }>;
};
const directoryCache = (gDir.__zwChatDirectory ??= new Map());

export function loadDirectory(me: ChatUser, fresh = false): Promise<DirectoryResult> {
  const hit = directoryCache.get(me.id);
  if (!fresh && hit && Date.now() - hit.at < DIRECTORY_TTL_MS) return hit.value;
  const value = buildDirectory(me);
  value.catch(() => {
    if (directoryCache.get(me.id)?.value === value) directoryCache.delete(me.id);
  });
  if (directoryCache.size > 1000) directoryCache.clear();
  directoryCache.set(me.id, { at: Date.now(), value });
  return value;
}

/**
 * Stalwart principals (people) plus everyone known to Chat. When the server only shares part of
 * the directory (Principal/query returning just me, no principals capability, or an error), the
 * list is completed with address-book contacts and recent mail correspondents within the org's
 * domains, and flagged `partial`.
 */
async function buildDirectory(me: ChatUser): Promise<DirectoryResult> {
  const myLocal = localPart(me.email);
  const myDomain = domainOf(me.email);
  const d: DirectoryDiagnostics = {
    at: Date.now(),
    userId: me.id,
    principalsAccount: false,
    availability: false,
    principals: 0,
    individuals: 0,
    others: 0,
    onlySelf: false,
    error: null,
    partial: false,
    fallback: { chat: 0, contacts: 0, mail: 0, contactsError: null, mailError: null },
    orgDomains: [],
    total: 0,
  };

  let principals: Principal[] = [];
  try {
    const session = await getCalendarSession();
    d.principalsAccount = !!session.principalsAccount;
    d.availability = session.availability;
    if (session.principalsAccount) principals = await getPrincipals();
  } catch (e) {
    unstable_rethrow(e);
    d.error = errText(e);
  }
  const individuals = principals.filter((p) => p.type === "individual" && EMAIL.test(p.email));
  const isMe = (email: string) => email === me.email || localPart(email) === myLocal;
  d.principals = principals.length;
  d.individuals = individuals.length;
  d.others = individuals.filter((p) => !isMe(p.email)).length;
  d.onlySelf = d.principalsAccount && !d.error && d.others === 0;
  d.partial = !d.principalsAccount || !!d.error || d.others === 0;

  const out = new Map<string, DirPerson>();
  const add = (p: Person, source: DirectorySource, principalId: string | null = null) => {
    if (!out.has(p.email)) out.set(p.email, { email: p.email, name: readableName(p.name, p.email), principalId, source });
  };
  for (const p of individuals) add({ email: p.email, name: p.name }, "directory", p.id);

  const known = store.knownUsers();
  for (const u of known) {
    if (!out.has(u.email)) d.fallback.chat++;
    add({ email: u.email, name: u.name }, "chat");
  }

  const domains = new Set([
    myDomain,
    ...envDomains(),
    ...principals.map((p) => (p.email.includes("@") ? domainOf(p.email) : "")),
    ...known.map((u) => domainOf(u.email)),
  ]);
  domains.delete("");
  d.orgDomains = [...domains].sort();

  // Contacts are shown in the People tab anyway; they only feed the directory in fallback mode.
  let contacts: Contact[] | null = null;
  let books: AddressBook[] = [];
  try {
    const data = await getContactsData();
    contacts = data.contacts;
    books = data.books;
  } catch (e) {
    unstable_rethrow(e);
    d.fallback.contactsError = errText(e);
  }

  if (d.partial) {
    for (const c of contacts ?? [])
      for (const e of c.emails) {
        const email = e.value.trim().toLowerCase();
        if (!EMAIL.test(email) || !domains.has(domainOf(email)) || out.has(email)) continue;
        add({ email, name: c.displayName }, "contacts");
        d.fallback.contacts++;
      }
    try {
      for (const p of await mailCorrespondents()) {
        if (!domains.has(domainOf(p.email)) || out.has(p.email)) continue;
        add(p, "mail");
        d.fallback.mail++;
      }
    } catch (e) {
      unstable_rethrow(e);
      d.fallback.mailError = errText(e);
    }
  }

  // Me (on any of the org's domains) is never part of my own directory.
  // System mailboxes (admin@, postmaster@…) are hidden too.
  for (const email of [...out.keys()])
    if (email === me.email || (domains.has(domainOf(email)) && (isMe(email) || HIDDEN_LOCALS.has(localPart(email))))) out.delete(email);
  const people = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  d.total = people.length;

  const log = d.partial ? console.warn : console.info;
  log(
    `[chat] directory user=${me.id} principalsAccount=${d.principalsAccount ? "yes" : "MISSING"} ` +
      `principals=${d.principals} individuals=${d.individuals} others=${d.others} onlySelf=${d.onlySelf} ` +
      `partial=${d.partial} fallback(chat=${d.fallback.chat} contacts=${d.fallback.contacts} mail=${d.fallback.mail}) ` +
      `total=${d.total} domains=${d.orgDomains.join(",")}` +
      (d.error ? ` error="${d.error}"` : "") +
      (d.fallback.contactsError ? ` contactsError="${d.fallback.contactsError}"` : "") +
      (d.fallback.mailError ? ` mailError="${d.fallback.mailError}"` : ""),
  );
  return { people, partial: d.partial, orgDomains: d.orgDomains, contacts, books, diagnostics: d };
}

/** Directory people (Stalwart principals) plus everyone already known to Chat (and fallbacks). */
export async function directory(me: ChatUser): Promise<Person[]> {
  return (await loadDirectory(me)).people.map(({ email, name }) => ({ email, name }));
}

/**
 * Folds one person's mailboxes on the org's domains (same local part) into one entry, preferring
 * the signed-in user's domain, and picks the address Chat already knows for DMs.
 */
export function foldPeople(people: DirPerson[], orgDomains: Set<string>, myDomain: string): DirectoryEntry[] {
  const known = new Set(store.knownUsers().map((u) => u.email));
  const rank: Record<DirectorySource, number> = { directory: 0, chat: 1, contacts: 2, mail: 3 };
  const groups = new Map<string, DirPerson[]>();
  for (const p of people) {
    const key = orgDomains.has(domainOf(p.email)) ? localPart(p.email) : p.email;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups]
    .map(([key, list]): DirectoryEntry => {
      list.sort(
        (a, b) =>
          Number(domainOf(b.email) === myDomain) - Number(domainOf(a.email) === myDomain) ||
          rank[a.source] - rank[b.source] ||
          a.email.localeCompare(b.email),
      );
      const first = list[0];
      return {
        key,
        name: list.find((p) => p.name && p.name !== p.email)?.name ?? first.email,
        email: first.email,
        emails: list.map((p) => p.email),
        chatEmail: list.find((p) => known.has(p.email))?.email ?? first.email,
        principalId: list.find((p) => p.principalId)?.principalId ?? null,
        shared: orgDomains.has(domainOf(first.email)) && SHARED_LOCALS.has(key),
        source: list.reduce<DirectorySource>((s, p) => (rank[p.source] < rank[s] ? p.source : s), first.source),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
