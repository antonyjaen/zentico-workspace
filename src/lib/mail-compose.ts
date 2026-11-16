// Server-side composer logic: identities, prefill for reply/forward/drafts, draft autosave,
// sending (Email/set + EmailSubmission/set), blob upload and contact autocomplete.
import { cache } from "react";
import { actingAccountId, getSession } from "./auth";
import { env } from "./env";
import { suggestRecipients } from "./contacts";
import { actAs, personalAccountId, type RawJmapSession } from "./delegation";
import { actingAccount, CAP, jmap, JmapError, primaryAccount } from "./jmap";
import { getMailboxes } from "./mail";

/* ------------------------------------------------------------------ types */

export type Address = { name: string | null; email: string };

export type Identity = {
  id: string;
  name: string;
  email: string;
  textSignature: string;
  htmlSignature: string;
};

export type ComposeAttachment = { blobId: string; name: string; type: string; size: number };

/** The original message that a reply/forward quotes. */
export type QuotedOriginal = {
  from: Address[];
  to: Address[];
  cc: Address[];
  subject: string;
  sentAt: string | null;
  html: string | null;
  text: string | null;
};

export type ComposePrefill = {
  identityId: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** Body for a reopened draft (HTML, unsanitized — the client sanitizes before rendering). */
  html: string | null;
  text: string | null;
  attachments: ComposeAttachment[];
  inReplyTo: string[] | null;
  references: string[] | null;
  quote: QuotedOriginal | null;
  /** Id of the draft being edited (draft mode). */
  draftId: string | null;
};

export type ComposeInput = {
  identityId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  attachments: ComposeAttachment[];
  inReplyTo: string[] | null;
  references: string[] | null;
};

/* ------------------------------------------------------------- validation */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_RECIPIENTS = 100;
const MAX_BODY_CHARS = 2_000_000;
const ID = /^[A-Za-z0-9_-]{1,255}$/;
const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const MSGID = /^[^\s<>]{1,998}$/;

export const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);

export class ComposeError extends Error {}

function fail(msg: string): never {
  throw new ComposeError(msg);
}

function cleanStr(v: unknown, max: number, field: string): string {
  if (typeof v !== "string") fail(`Invalid ${field}`);
  if (v.length > max) fail(`${field} too long`);
  return v;
}

function cleanEmails(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) fail(`Invalid ${field}`);
  if (v.length > MAX_RECIPIENTS) fail(`Too many recipients`);
  const out: string[] = [];
  for (const e of v) {
    if (typeof e !== "string" || !isEmail(e.trim())) fail(`Invalid email address in ${field}`);
    const email = e.trim();
    if (!out.some((x) => x.toLowerCase() === email.toLowerCase())) out.push(email);
  }
  return out;
}

function cleanMsgIds(v: unknown): string[] | null {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length > 200) fail("Invalid references");
  for (const id of v) if (typeof id !== "string" || !MSGID.test(id)) fail("Invalid message id");
  return v.length ? (v as string[]) : null;
}

function cleanAttachments(v: unknown): ComposeAttachment[] {
  if (!Array.isArray(v) || v.length > 50) fail("Invalid attachments");
  let total = 0;
  return v.map((a: Partial<ComposeAttachment>) => {
    if (!a || typeof a !== "object" || typeof a.blobId !== "string" || !ID.test(a.blobId)) fail("Invalid attachment");
    const size = Number(a.size);
    if (!Number.isFinite(size) || size < 0) fail("Invalid attachment size");
    total += size;
    if (total > MAX_ATTACHMENT_BYTES) fail("Attachments too large");
    const type = typeof a.type === "string" && MIME.test(a.type) ? a.type : "application/octet-stream";
    const name = cleanFileName(a.name);
    return { blobId: a.blobId, type, size, name };
  });
}

export function cleanFileName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim() : "";
  return (s || "attachment").slice(0, 200);
}

export function validateInput(raw: unknown): ComposeInput {
  if (!raw || typeof raw !== "object") fail("Invalid message");
  const r = raw as Record<string, unknown>;
  const identityId = cleanStr(r.identityId, 255, "identity");
  if (!ID.test(identityId)) fail("Invalid identity");
  return {
    identityId,
    to: cleanEmails(r.to, "To"),
    cc: cleanEmails(r.cc, "Cc"),
    bcc: cleanEmails(r.bcc, "Bcc"),
    subject: cleanStr(r.subject, 998, "subject").replace(/[\r\n]+/g, " "),
    html: cleanStr(r.html, MAX_BODY_CHARS, "body"),
    text: cleanStr(r.text, MAX_BODY_CHARS, "body"),
    attachments: cleanAttachments(r.attachments),
    inReplyTo: cleanMsgIds(r.inReplyTo),
    references: cleanMsgIds(r.references),
  };
}

/* ---------------------------------------------------------------- session */

type ComposeSession = RawJmapSession & {
  apiUrl: string;
  uploadUrl: string;
  capabilities: Record<string, unknown>;
  primaryAccounts: Record<string, string>;
  /** The token owner's own account: uploads go there even while acting as a delegated account. */
  uploadAccountId: string | null;
  token: string;
};

/** JMAP session for compose-specific needs (upload URL, capability checks). */
export const getComposeSession = async () => composeSessionFor(await actingAccountId());

const composeSessionFor = cache(async (acting: string | null): Promise<ComposeSession | null> => {
  const session = await getSession();
  if (!session) return null;
  const res = await fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`JMAP session failed: ${res.status}`);
  const raw = (await res.json()) as Omit<ComposeSession, "token" | "uploadAccountId">;
  return { ...actAs(raw, acting), uploadAccountId: personalAccountId(raw), token: session.accessToken };
});

/* ------------------------------------------------------------- identities */

const USING_SUBMIT = [CAP.core, CAP.mail, CAP.submission];

/** Identity id standing for the delegated account's own address (it has no JMAP identities). */
const DELEGATED_IDENTITY = "delegated";

export const getIdentities = async () => identitiesFor(await actingAccountId());

const identitiesFor = cache(async (acting: string | null): Promise<Identity[]> => {
  // Acting as a delegated account: Stalwart keeps Identity/* owner-only, so drafts carry the
  // account's own address (its Drafts are writable through the share); sending is refused below.
  const delegated = acting ? await actingAccount() : null;
  if (delegated) {
    const { name } = (await getSession()) ?? { name: "" };
    return [{ id: DELEGATED_IDENTITY, email: delegated.email, name, textSignature: "", htmlSignature: "" }];
  }
  const accountId = await primaryAccount(CAP.submission);
  const r = await jmap(
    [
      [
        "Identity/get",
        { accountId, properties: ["name", "email", "textSignature", "htmlSignature"] },
        "i",
      ],
    ],
    USING_SUBMIT,
  );
  const list = (r.i.list as Partial<Identity>[]) ?? [];
  return list
    .filter((i): i is Partial<Identity> & { id: string; email: string } => !!i.id && !!i.email)
    .map((i) => ({
      id: i.id,
      email: i.email,
      name: i.name ?? "",
      textSignature: i.textSignature ?? "",
      htmlSignature: i.htmlSignature ?? "",
    }));
});

/* ---------------------------------------------------------------- prefill */

type RawPart = { partId?: string; type?: string; blobId?: string; name?: string | null; size?: number };
type RawEmail = {
  id: string;
  messageId?: string[] | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  from?: Address[] | null;
  to?: Address[] | null;
  cc?: Address[] | null;
  bcc?: Address[] | null;
  replyTo?: Address[] | null;
  subject?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  keywords?: Record<string, boolean>;
  bodyValues?: Record<string, { value: string }>;
  textBody?: RawPart[];
  htmlBody?: RawPart[];
  attachments?: RawPart[];
};

async function getEmail(id: string): Promise<RawEmail> {
  if (!ID.test(id)) fail("Invalid message id");
  const accountId = await primaryAccount(CAP.mail);
  const r = await jmap([
    [
      "Email/get",
      {
        accountId,
        ids: [id],
        properties: [
          "messageId", "inReplyTo", "references", "from", "to", "cc", "bcc", "replyTo", "subject",
          "sentAt", "receivedAt", "keywords", "bodyValues", "textBody", "htmlBody", "attachments",
        ],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: 1_000_000,
      },
      "e",
    ],
  ]);
  const email = (r.e.list as RawEmail[] | undefined)?.[0];
  if (!email) fail("Message not found");
  return email;
}

function bodyOf(e: RawEmail, which: "htmlBody" | "textBody"): string | null {
  const parts = (e[which] ?? []).filter((p) => p.partId && e.bodyValues?.[p.partId]);
  if (!parts.length) return null;
  if (which === "htmlBody" && !parts.some((p) => p.type === "text/html")) return null;
  return parts.map((p) => e.bodyValues![p.partId!].value).join("\n");
}

function attachmentsOf(e: RawEmail): ComposeAttachment[] {
  return (e.attachments ?? [])
    .filter((a) => a.blobId)
    .map((a) => ({
      blobId: a.blobId!,
      name: cleanFileName(a.name),
      type: a.type || "application/octet-stream",
      size: a.size ?? 0,
    }));
}

const lower = (s: string) => s.toLowerCase();

function dedupe(list: Address[], exclude: Set<string>): Address[] {
  const seen = new Set(exclude);
  const out: Address[] = [];
  for (const a of list) {
    if (!a?.email) continue;
    const k = lower(a.email);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name: a.name ?? null, email: a.email });
  }
  return out;
}

function prefixed(prefix: "Re" | "Fwd", subject: string): string {
  const s = subject.trim();
  const re = prefix === "Re" ? /^re:/i : /^(fwd?|rv):/i;
  return re.test(s) ? s : `${prefix}: ${s}`;
}

export async function getPrefill(mode: string, emailId?: string): Promise<ComposePrefill> {
  const identities = await getIdentities();
  const own = new Set(identities.map((i) => lower(i.email)));
  const empty: ComposePrefill = {
    identityId: identities[0]?.id ?? null,
    to: [], cc: [], bcc: [], subject: "", html: null, text: null, attachments: [],
    inReplyTo: null, references: null, quote: null, draftId: null,
  };
  if (mode === "new" || !emailId) return empty;

  const e = await getEmail(emailId);
  const matchIdentity = (addrs: Address[]) =>
    identities.find((i) => addrs.some((a) => lower(a.email ?? "") === lower(i.email)))?.id ?? empty.identityId;

  if (mode === "draft") {
    return {
      ...empty,
      identityId: matchIdentity(e.from ?? []),
      to: e.to ?? [],
      cc: e.cc ?? [],
      bcc: e.bcc ?? [],
      subject: e.subject ?? "",
      html: bodyOf(e, "htmlBody"),
      text: bodyOf(e, "textBody"),
      attachments: attachmentsOf(e),
      inReplyTo: e.inReplyTo ?? null,
      references: e.references ?? null,
      draftId: e.keywords?.$draft ? e.id : null,
    };
  }

  const quote: QuotedOriginal = {
    from: e.from ?? [],
    to: e.to ?? [],
    cc: e.cc ?? [],
    subject: e.subject ?? "",
    sentAt: e.sentAt ?? e.receivedAt ?? null,
    html: bodyOf(e, "htmlBody"),
    text: bodyOf(e, "textBody"),
  };
  const identityId = matchIdentity([...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? []), ...(e.from ?? [])]);

  if (mode === "forward") {
    return { ...empty, identityId, subject: prefixed("Fwd", quote.subject), attachments: attachmentsOf(e), quote };
  }

  // reply / replyAll
  const fromMe = (e.from ?? []).some((a) => own.has(lower(a.email ?? "")));
  const primary = fromMe ? (e.to ?? []) : (e.replyTo?.length ? e.replyTo : (e.from ?? []));
  let to = dedupe(primary, fromMe ? new Set() : own);
  let cc: Address[] = [];
  if (mode === "replyAll") {
    cc = dedupe([...(e.to ?? []), ...(e.cc ?? [])], new Set([...own, ...to.map((a) => lower(a.email))]));
    if (!to.length) [to, cc] = [cc.slice(0, 1), cc.slice(1)];
  }
  const msgIds = e.messageId ?? [];
  return {
    ...empty,
    identityId,
    to,
    cc,
    subject: prefixed("Re", quote.subject),
    inReplyTo: msgIds.length ? msgIds : null,
    references: msgIds.length || e.references?.length ? [...(e.references ?? []), ...msgIds] : null,
    quote,
  };
}

/* --------------------------------------------------------- drafts & send */

async function roleBoxes() {
  const boxes = await getMailboxes();
  const drafts = boxes.find((b) => b.role === "drafts")?.id;
  const sent = boxes.find((b) => b.role === "sent")?.id;
  if (!drafts) fail("No Drafts mailbox");
  return { drafts, sent };
}

async function resolveIdentity(identityId: string): Promise<Identity> {
  const identity = (await getIdentities()).find((i) => i.id === identityId);
  if (!identity) fail("Identity does not belong to this account");
  return identity;
}

function emailObject(input: ComposeInput, identity: Identity, mailboxId: string, includeBcc: boolean) {
  const addr = (list: string[]) => (list.length ? list.map((email) => ({ email })) : null);
  // Stalwart rejects explicit nulls on create (e.g. `cc: null`), so empty fields are omitted.
  return omitNulls({
    mailboxIds: { [mailboxId]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ name: identity.name || null, email: identity.email }],
    to: addr(input.to),
    cc: addr(input.cc),
    bcc: includeBcc ? addr(input.bcc) : null,
    subject: input.subject,
    inReplyTo: input.inReplyTo,
    references: input.references,
    bodyValues: { text: { value: input.text }, html: { value: input.html } },
    textBody: [{ partId: "text", type: "text/plain" }],
    htmlBody: [{ partId: "html", type: "text/html" }],
    attachments: input.attachments.map((a) => ({
      blobId: a.blobId,
      type: a.type,
      name: a.name,
      disposition: "attachment",
    })),
  });
}

function omitNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null)) as Partial<T>;
}

function cleanDraftId(id: unknown): string | null {
  if (id == null) return null;
  if (typeof id !== "string" || !ID.test(id)) fail("Invalid draft id");
  return id;
}

/** Saves a new draft version and destroys the previous one. Returns the new draft id. */
export async function saveDraft(raw: unknown, previousId: unknown): Promise<string> {
  const input = validateInput(raw);
  const prev = cleanDraftId(previousId);
  const identity = await resolveIdentity(input.identityId);
  const { drafts } = await roleBoxes();
  const accountId = await primaryAccount(CAP.mail);
  const r = await jmap([
    [
      "Email/set",
      {
        accountId,
        create: { draft: emailObject(input, identity, drafts, true) },
      },
      "s",
    ],
  ]);
  const created = (r.s.created as Record<string, { id: string }> | undefined)?.draft;
  if (!created) {
    console.error("[compose] draft rejected:", JSON.stringify(r.s.notCreated));
    fail(`Draft not saved: ${describeSetError(r.s.notCreated)}`);
  }
  await destroyQuietly(accountId, prev);
  return created.id;
}

/** Deletes a draft. */
export async function discardDraft(draftId: unknown): Promise<void> {
  const id = cleanDraftId(draftId);
  if (!id) return;
  const accountId = await primaryAccount(CAP.mail);
  await jmap([["Email/set", { accountId, destroy: [id] }, "d"]]);
}

/**
 * Sends: creates the final message in Drafts (replacing the previous draft version) and submits
 * it; on success the server moves it to Sent and clears $draft. Bcc recipients only go in the
 * SMTP envelope, never in the delivered headers.
 */
export async function sendMessage(
  raw: unknown,
  previousId: unknown,
): Promise<{ ok: true } | { ok: false; error: string; draftId: string | null }> {
  const input = validateInput(raw);
  const prev = cleanDraftId(previousId);
  const rcpt = [...input.to, ...input.cc, ...input.bcc];
  if (!rcpt.length) fail("Add at least one recipient");
  const identity = await resolveIdentity(input.identityId);
  if (identity.id === DELEGATED_IDENTITY) {
    // Stalwart only lets an account's owner (or a group member) submit mail from it; a delegated
    // share can read and write the mailbox but not send. Keep the message as a draft instead.
    const draftId = await saveDraft(raw, prev);
    return { ok: false, error: `Sending as ${identity.email} needs a sign-in to that account. The message was saved in its Drafts.`, draftId };
  }
  const { drafts, sent } = await roleBoxes();
  const accountId = await primaryAccount(CAP.mail);

  // Move Drafts -> Sent (if there is no Sent mailbox, the message stays where it is).
  const onSuccess: Record<string, unknown> = { "keywords/$draft": null };
  if (sent) Object.assign(onSuccess, { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true });

  // Create first so a rejection reports the real reason, then submit by id.
  const r = await jmap([
    ["Email/set", { accountId, create: { msg: emailObject(input, identity, drafts, false) } }, "e"],
  ]);
  const created = (r.e.created as Record<string, { id: string }> | undefined)?.msg;
  if (!created) {
    console.error("[compose] Email/set rejected:", JSON.stringify(r.e.notCreated));
    return { ok: false, error: describeSetError(r.e.notCreated), draftId: prev };
  }
  // The previous draft version is replaced only once the new message exists.
  await destroyQuietly(accountId, prev);
  const s = await jmap(
    [
      [
        "EmailSubmission/set",
        {
          accountId,
          create: {
            sub: {
              identityId: identity.id,
              emailId: created.id,
              envelope: {
                mailFrom: { email: identity.email, parameters: null },
                rcptTo: rcpt.map((email) => ({ email, parameters: null })),
              },
            },
          },
          onSuccessUpdateEmail: { "#sub": onSuccess },
        },
        "s",
      ],
    ],
    USING_SUBMIT,
  );
  const submitted = (s.s.created as Record<string, unknown> | undefined)?.sub;
  if (!submitted) {
    console.error("[compose] EmailSubmission/set rejected:", JSON.stringify(s.s.notCreated));
    return { ok: false, error: describeSetError(s.s.notCreated), draftId: created.id };
  }
  return { ok: true };
}

async function destroyQuietly(accountId: string, id: string | null) {
  if (!id) return;
  await jmap([["Email/set", { accountId, destroy: [id] }, "d"]]).catch(() => undefined);
}

function describeSetError(notCreated: unknown): string {
  const first = notCreated && typeof notCreated === "object" ? Object.values(notCreated)[0] : null;
  const e = first as { type?: string; description?: string } | null;
  return e?.description || e?.type || "Unknown error";
}

/* ----------------------------------------------------------------- upload */

/** Uploads a blob to the JMAP server with the user's token (server side only). */
export async function uploadBlob(
  body: ArrayBuffer,
  type: string,
): Promise<{ blobId: string; type: string; size: number }> {
  const session = await getComposeSession();
  if (!session) fail("Not signed in");
  // Own account: Stalwart only accepts uploads there; Email/set in a shared account can use the blob.
  const accountId = session.uploadAccountId ?? session.primaryAccounts[CAP.mail];
  if (!accountId || !session.uploadUrl) fail("Upload not available");
  const url = session.uploadUrl.replace("{accountId}", encodeURIComponent(accountId));
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.token}`, "Content-Type": MIME.test(type) ? type : "application/octet-stream" },
    body,
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`Upload failed: ${res.status}`);
  const out = (await res.json()) as { blobId: string; type: string; size: number };
  return { blobId: out.blobId, type: out.type, size: out.size };
}

/* --------------------------------------------------------------- contacts */

/** Contact suggestions for recipient autocomplete; returns [] if contacts aren't available. */
export async function suggestContacts(query: string): Promise<Address[]> {
  const q = query.trim().slice(0, 100);
  if (q.length < 2) return [];
  try {
    return (await suggestRecipients(q)).map((c) => ({ name: c.name || null, email: c.email }));
  } catch {
    return []; // contacts unavailable: autocomplete simply stays empty
  }
}
