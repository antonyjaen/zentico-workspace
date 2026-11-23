// Server-side composer logic: identities, prefill for reply/forward/drafts, draft autosave,
// sending (Email/set + EmailSubmission/set), blob upload and contact autocomplete.
import { cache } from "react";
import { actingAccountId, getSession } from "./auth";
import { env } from "./env";
import { suggestRecipients } from "./contacts";
import { actAs, personalAccountId, type RawJmapSession } from "./delegation";
import { actingAccount, CAP, jmap, JmapError, primaryAccount, sessionForAccount, tokenForAccount } from "./jmap";
import { getMailAccounts, getMailboxes, resolveAccount } from "./mail";

/* ------------------------------------------------------------------ types */

export type Address = { name: string | null; email: string };

export type Identity = {
  id: string;
  /** JMAP account the identity sends from (identity ids are only unique per account). */
  accountId: string;
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
  /** Account of `identityId` (identity ids are only unique per account). */
  identityAccountId: string | null;
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
  /** Account the draft being edited lives in. */
  draftAccountId: string | null;
  /** Sending account whose sign-in can use `attachments` (blobs are per account); null if none. */
  attachmentsAccountId: string | null;
};

export type ComposeInput = {
  identityId: string;
  /** Account of the identity (default: the first identity with that id). */
  identityAccountId?: string | null;
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
  const identityAccountId = r.identityAccountId ?? null;
  if (identityAccountId !== null && (typeof identityAccountId !== "string" || !ID.test(identityAccountId))) fail("Invalid identity");
  return {
    identityId,
    identityAccountId,
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
    return [{ id: DELEGATED_IDENTITY, accountId: delegated.id, email: delegated.email, name, textSignature: "", htmlSignature: "" }];
  }
  // Every account the browser can send from: the active one first, then the other signed-in ones.
  const senders = (await getMailAccounts()).filter((a) => a.canSend);
  if (!senders.length) return identitiesOf(await primaryAccount(CAP.submission));
  const lists = await Promise.all(
    senders.map((a) =>
      identitiesOf(a.id).catch((e) => {
        if (a.kind === "own") throw e;
        console.error("[compose] identities unavailable:", e instanceof Error ? e.message : e);
        return [] as Identity[];
      }),
    ),
  );
  return lists.flat();
});

/** Identity/get on one account (jmap() picks the signed-in account's token that reaches it). */
async function identitiesOf(accountId: string): Promise<Identity[]> {
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
      accountId,
      email: i.email,
      name: i.name ?? "",
      textSignature: i.textSignature ?? "",
      htmlSignature: i.htmlSignature ?? "",
    }));
}

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

async function getEmail(id: string, accountId: string): Promise<RawEmail> {
  if (!ID.test(id)) fail("Invalid message id");
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

/**
 * Prefill for a compose mode. `account` is the mailbox account the user is looking at (validated):
 * the original message is read from it, and the default From is one of its identities (for a
 * shared mailbox, the identity with the shared address if any, else the user's own).
 */
export async function getPrefill(mode: string, emailId?: string, account?: string | null): Promise<ComposePrefill> {
  const [identities, accountId, accounts] = await Promise.all([
    getIdentities(),
    resolveAccount(account ?? null),
    getMailAccounts(),
  ]);
  const box = accounts.find((a) => a.id === accountId);
  const ownId = accounts.find((a) => a.kind === "own")?.id;
  // Identities of the mailbox's account first, so address matching prefers them.
  const ordered = [...identities.filter((i) => i.accountId === accountId), ...identities.filter((i) => i.accountId !== accountId)];
  // Shared mailbox: its own address, else the address of the signed-in account that reaches it.
  const via = box?.kind === "shared" ? await sessionForAccount(accountId) : null;
  const preferred =
    box?.kind === "shared"
      ? (identities.find((i) => lower(i.email) === lower(box.email)) ??
        identities.find((i) => !!via && lower(i.email) === lower(via.email)) ??
        identities.find((i) => i.accountId === ownId))
      : ordered[0];
  const fallback = preferred ?? identities[0];
  const empty: ComposePrefill = {
    identityId: fallback?.id ?? null,
    identityAccountId: fallback?.accountId ?? null,
    to: [], cc: [], bcc: [], subject: "", html: null, text: null, attachments: [],
    inReplyTo: null, references: null, quote: null, draftId: null, draftAccountId: null,
    attachmentsAccountId: accounts.find((a) => a.canSend && !!box && a.slot === box.slot)?.id ?? null,
  };
  if (mode === "new" || !emailId) return empty;
  // Email ids are only unique per account: never read another account's message with this id.
  if (account && accountId !== account) fail("Mailbox unavailable");

  const e = await getEmail(emailId, accountId);
  const matchIdentity = (addrs: Address[]): Identity | undefined =>
    ordered.find((i) => addrs.some((a) => lower(a.email ?? "") === lower(i.email))) ?? fallback;
  const pick = (i: Identity | undefined) => ({ identityId: i?.id ?? null, identityAccountId: i?.accountId ?? null });

  if (mode === "draft") {
    return {
      ...empty,
      ...pick(matchIdentity(e.from ?? [])),
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
      draftAccountId: e.keywords?.$draft ? accountId : null,
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
  const sender = matchIdentity([...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? []), ...(e.from ?? [])]);

  if (mode === "forward") {
    return { ...empty, ...pick(sender), subject: prefixed("Fwd", quote.subject), attachments: attachmentsOf(e), quote };
  }

  // reply / replyAll. "Me": the sending account's addresses, plus the shared mailbox replied from.
  const own = new Set(identities.filter((i) => i.accountId === sender?.accountId).map((i) => lower(i.email)));
  if (box?.kind === "shared" && box.email) own.add(lower(box.email));
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
    ...pick(sender),
    to,
    cc,
    subject: prefixed("Re", quote.subject),
    inReplyTo: msgIds.length ? msgIds : null,
    references: msgIds.length || e.references?.length ? [...(e.references ?? []), ...msgIds] : null,
    quote,
  };
}

/* --------------------------------------------------------- drafts & send */

async function roleBoxes(accountId: string) {
  const boxes = await getMailboxes(accountId);
  const drafts = boxes.find((b) => b.role === "drafts")?.id;
  const sent = boxes.find((b) => b.role === "sent")?.id;
  if (!drafts) fail("No Drafts mailbox");
  return { drafts, sent };
}

async function resolveIdentity(identityId: string, accountId?: string | null): Promise<Identity> {
  const identity = (await getIdentities()).find((i) => i.id === identityId && (!accountId || i.accountId === accountId));
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

/** The (validated) account a previous draft lives in; `fallback` when not given. */
async function draftAccount(account: unknown, fallback: string): Promise<string> {
  if (typeof account !== "string" || !account) return fallback;
  // No fallback: a draft id destroyed in the wrong account could delete an unrelated message.
  const id = await resolveAccount(account);
  if (id !== account) fail("Draft account unavailable");
  return id;
}

/**
 * Saves a new draft version in the identity's account and destroys the previous one (which may
 * live in another account: `previousAccount`). Returns the new draft id.
 */
export async function saveDraft(raw: unknown, previousId: unknown, previousAccount?: unknown): Promise<string> {
  const input = validateInput(raw);
  const prev = cleanDraftId(previousId);
  const identity = await resolveIdentity(input.identityId, input.identityAccountId);
  const accountId = identity.accountId;
  const { drafts } = await roleBoxes(accountId);
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
  await destroyQuietly(await draftAccount(previousAccount, accountId), prev);
  return created.id;
}

/** Deletes a draft (in `account`, validated; default the primary account). */
export async function discardDraft(draftId: unknown, account?: unknown): Promise<void> {
  const id = cleanDraftId(draftId);
  if (!id) return;
  // Only an absent `account` means the primary one; a given one must still be reachable.
  if (account != null && account !== "" && typeof account !== "string") fail("Invalid account");
  const accountId = account ? await draftAccount(account, "") : await resolveAccount(null);
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
  previousAccount?: unknown,
): Promise<{ ok: true } | { ok: false; error: string; draftId: string | null }> {
  const input = validateInput(raw);
  const prev = cleanDraftId(previousId);
  const rcpt = [...input.to, ...input.cc, ...input.bcc];
  if (!rcpt.length) fail("Add at least one recipient");
  const identity = await resolveIdentity(input.identityId, input.identityAccountId);
  if (identity.id === DELEGATED_IDENTITY) {
    // Stalwart only lets an account's owner (or a group member) submit mail from it; a delegated
    // share can read and write the mailbox but not send. Keep the message as a draft instead.
    const draftId = await saveDraft(raw, prev, previousAccount);
    return { ok: false, error: `Sending as ${identity.email} needs a sign-in to that account. The message was saved in its Drafts.`, draftId };
  }
  // The identity's account sends (jmap() uses the token of the signed-in account that owns it).
  const accountId = identity.accountId;
  const { drafts, sent } = await roleBoxes(accountId);

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
  await destroyQuietly(await draftAccount(previousAccount, accountId), prev);
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

/**
 * Where a blob goes: the own account of the signed-in account that will send (`account`: the
 * chosen identity's account), else the active one's. Stalwart only accepts uploads to the token
 * owner's account; Email/set in a shared account can use the blob.
 */
async function uploadTarget(account?: string | null): Promise<{ url: string; token: string } | null> {
  if (account && ID.test(account) && !(await actingAccountId())) {
    const owner = await tokenForAccount(account);
    if (owner) {
      const id = personalAccountId(owner.session);
      const url = owner.session.uploadUrl;
      if (id && url) return { url: url.replace("{accountId}", encodeURIComponent(id)), token: owner.token };
    }
  }
  const session = await getComposeSession();
  if (!session) fail("Not signed in");
  const accountId = session.uploadAccountId ?? session.primaryAccounts[CAP.mail];
  if (!accountId || !session.uploadUrl) return null;
  return { url: session.uploadUrl.replace("{accountId}", encodeURIComponent(accountId)), token: session.token };
}

/** Uploads a blob to the JMAP server with the user's token (server side only). */
export async function uploadBlob(
  body: ArrayBuffer,
  type: string,
  account?: string | null,
): Promise<{ blobId: string; type: string; size: number }> {
  const target = await uploadTarget(account);
  if (!target) fail("Upload not available");
  const res = await fetch(target.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${target.token}`, "Content-Type": MIME.test(type) ? type : "application/octet-stream" },
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
  const needle = q.toLowerCase();
  const [contacts, pool] = await Promise.all([
    suggestRecipients(q).catch(() => []), // contacts unavailable: rely on the other sources
    recipientPool().catch(() => []),
  ]);
  // Address-book matches first, then directory people and recent correspondents.
  const others = pool
    .map((p) => {
      const name = p.name && p.name !== p.email ? p.name : "";
      const hay = `${name} ${p.email}`.toLowerCase();
      if (!hay.includes(needle)) return null;
      const prefix = p.email.toLowerCase().startsWith(needle) || name.toLowerCase().startsWith(needle);
      return { name, email: p.email, score: prefix ? 0 : 1 };
    })
    .filter((x) => x !== null)
    .sort((a, b) => a.score - b.score);
  const seen = new Set<string>();
  return [...contacts, ...others]
    .filter((c) => !seen.has(c.email.toLowerCase()) && seen.add(c.email.toLowerCase()))
    .slice(0, 8)
    .map((c) => ({ name: c.name || null, email: c.email }));
}

/** Directory + recent correspondents (lazy import: chat pulls in server-only stores). */
async function recipientPool() {
  const [{ chatUserOrNull }, { recipientPool: pool }] = await Promise.all([
    import("./chat/session"),
    import("./chat/directory"),
  ]);
  const me = await chatUserOrNull();
  return me ? pool(me) : [];
}
