// Mail tools: search, read, compose (send / draft / reply / forward), folders, labels, filters
// and attachments.
import { createFolder as createMailFolder, createLabel, destroyEmails, moveToRole } from "@/app/(apps)/mail/actions";
import { CAP, jmap, primaryAccount } from "../jmap";
import { getEmails, getMailboxes, type EmailFilter, type Mailbox } from "../mail";
import { getIdentities, getPrefill, saveDraft, sendMessage, type ComposeInput, type ComposePrefill, type Identity } from "../mail-compose";
import { LABEL_COLOR_NAMES, LABEL_ID, labelKeyword } from "../mail-labels";
import { cleanFileName, expandDownloadUrl, getMailSession } from "../mail-read";
import {
  FILTER_SCRIPT_NAME,
  getFilters,
  getLabels,
  readConfigForUpdate,
  sanitizeHtml,
  validateRules,
  writeConfig,
  type FilterRule,
} from "../mail-settings";
import { bool, emailList, id, idList, int, oneOf, str, strList, ToolError, truncate, type Args } from "./args";
import { parseWhen, userTimeZone } from "./calendar-tools";
import { extractText, readCapped } from "./convert";
import { A, addr, appUrl, B, I, iso, S, type JsonSchema, type Tool } from "./kit";
import { escapeHtml, htmlToText, mailDocument, markdownToHtml, textToHtml } from "./text";

/* --------------------------------------------------------------------- mail */

const MAIL_ROLES = ["inbox", "drafts", "sent", "junk", "trash", "archive"];

async function findMailbox(value: string): Promise<Mailbox> {
  const boxes = await getMailboxes();
  const v = value.trim().toLowerCase();
  const box =
    boxes.find((b) => b.id === value) ??
    boxes.find((b) => b.role === v) ??
    boxes.find((b) => b.name.toLowerCase() === v) ??
    (v === "spam" ? boxes.find((b) => b.role === "junk") : undefined);
  if (!box) throw new ToolError(`Unknown folder "${value}". Folders: ${boxes.map((b) => b.name).join(", ")}`);
  return box;
}

/** A defined label by id or display name (labels are stored as `zwl_<id>` keywords). */
async function findLabel(value: string) {
  const v = value.trim().toLowerCase();
  const labels = await getLabels();
  return labels.find((l) => l.id === v || l.name.toLowerCase() === v) ?? null;
}

/** Label id from an id or a display name; unknown slugs are accepted as raw label ids. */
async function labelId(value: string): Promise<string> {
  const hit = await findLabel(value);
  if (hit) return hit.id;
  const v = value.trim().toLowerCase();
  if (!LABEL_ID.test(v)) throw new ToolError(`Unknown label "${value}"`);
  return v;
}

const KEYWORD = /^\$?[A-Za-z0-9_-]{1,64}$/;

async function threadEmailIds(threadId: string): Promise<string[]> {
  const accountId = await primaryAccount(CAP.mail);
  const r = await jmap([["Thread/get", { accountId, ids: [threadId] }, "t"]]);
  const ids = (r.t.list as { emailIds: string[] }[] | undefined)?.[0]?.emailIds;
  if (!ids?.length) throw new ToolError("Thread not found");
  return ids;
}

async function targetEmailIds(args: Args): Promise<string[]> {
  const ids = idList(args, "emailIds");
  const threadId = id(args, "threadId");
  if (threadId) ids.push(...(await threadEmailIds(threadId)));
  if (!ids.length) throw new ToolError('Provide "emailIds" or "threadId"');
  return [...new Set(ids)];
}

async function emailSet(update: Record<string, Record<string, unknown>>): Promise<{ updated: string[]; failed: Record<string, string> }> {
  const accountId = await primaryAccount(CAP.mail);
  const r = await jmap([["Email/set", { accountId, update }, "s"]]);
  const notUpdated = (r.s.notUpdated as Record<string, { type?: string; description?: string }> | null) ?? {};
  return {
    updated: Object.keys((r.s.updated as Record<string, unknown> | null) ?? {}),
    failed: Object.fromEntries(Object.entries(notUpdated).map(([k, e]) => [k, e.description || e.type || "error"])),
  };
}

type RawPart = { partId?: string; type?: string; name?: string | null; size?: number };
type RawMail = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: { name: string | null; email: string }[] | null;
  to: { name: string | null; email: string }[] | null;
  cc: { name: string | null; email: string }[] | null;
  subject: string | null;
  sentAt: string | null;
  receivedAt: string;
  textBody?: RawPart[];
  bodyValues?: Record<string, { value: string; isTruncated?: boolean }>;
  attachments?: RawPart[];
};

/** Compose input shared by mail_send and mail_create_draft. */
async function composeInput(args: Args) {
  const replyTo = id(args, "replyToEmailId");
  const replyAll = bool(args, "replyAll");
  const prefill = replyTo ? await getPrefill(replyAll ? "replyAll" : "reply", replyTo) : null;
  const identities = await getIdentities();
  if (!identities.length) throw new ToolError("No sending identity is configured for this account");
  const fromEmail = str(args, "fromEmail", { max: 254 })?.toLowerCase();
  const identity = fromEmail
    ? identities.find((i) => i.email.toLowerCase() === fromEmail)
    : (identities.find((i) => i.id === prefill?.identityId) ?? identities[0]);
  if (!identity) throw new ToolError(`"fromEmail" must be one of: ${identities.map((i) => i.email).join(", ")}`);

  let to = emailList(args, "to");
  let cc = emailList(args, "cc");
  if (prefill && !to.length) {
    to = prefill.to.map((a) => a.email);
    if (!cc.length) cc = prefill.cc.map((a) => a.email);
  }
  const body = str(args, "body", { required: true, max: 500_000 });
  const format = oneOf(args, "format", ["markdown", "text"] as const, "markdown");
  const html = mailDocument(format === "markdown" ? markdownToHtml(body) : textToHtml(body));
  return {
    identityId: identity.id,
    to,
    cc,
    bcc: emailList(args, "bcc"),
    subject: str(args, "subject", { max: 998 }) ?? prefill?.subject ?? "",
    html,
    text: body,
    attachments: [],
    inReplyTo: prefill?.inReplyTo ?? null,
    references: prefill?.references ?? null,
  };
}

const COMPOSE_PROPS: Record<string, JsonSchema> = {
  to: A('Recipients ("a@b.com" or "Name <a@b.com>"). Optional when replying (defaults to the original sender).'),
  cc: A("Cc recipients."),
  bcc: A("Bcc recipients."),
  subject: S('Subject. Optional when replying (defaults to "Re: <original subject>").'),
  body: S("Message body."),
  format: S('Body format: "markdown" (default, rendered to HTML) or "text".', { enum: ["markdown", "text"] }),
  replyToEmailId: S("Email id being replied to: sets threading headers, default recipients and subject."),
  replyAll: B("When replying, also include the original To/Cc recipients."),
  fromEmail: S("Send from this identity's address (default: the primary identity)."),
};


/* --------------------------------------------------------- reply / forward */

async function pickIdentity(args: Args, preferred: string | null): Promise<Identity> {
  const identities = await getIdentities();
  if (!identities.length) throw new ToolError("No sending identity is configured for this account");
  const fromEmail = str(args, "fromEmail", { max: 254 })?.toLowerCase();
  const identity = fromEmail
    ? identities.find((i) => i.email.toLowerCase() === fromEmail)
    : (identities.find((i) => i.id === preferred) ?? identities[0]);
  if (!identity) throw new ToolError(`"fromEmail" must be one of: ${identities.map((i) => i.email).join(", ")}`);
  return identity;
}

const QUOTE_STYLE = "margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex";
const formatAddr = (list: { name: string | null; email: string }[]) => addr(list).join(", ");

/**
 * The message body as the Mail composer builds it: the new text, the signature, then the quoted
 * original (reply: "On <date>, <sender> wrote:" + blockquote; forward: a forwarded-message header).
 */
async function replyBody(args: Args, identity: Identity, prefill: ComposePrefill, mode: "reply" | "forward") {
  const body = (mode === "reply" ? str(args, "body", { required: true, max: 500_000 }) : str(args, "body", { max: 500_000 })) ?? "";
  const format = oneOf(args, "format", ["markdown", "text"] as const, "markdown");
  const htmlParts: string[] = [];
  const textParts: string[] = [];
  if (body.trim()) {
    htmlParts.push(format === "markdown" ? markdownToHtml(body) : textToHtml(body));
    textParts.push(body.trim());
  }
  if (bool(args, "includeSignature", true)) {
    const sigHtml = identity.htmlSignature.trim()
      ? sanitizeHtml(identity.htmlSignature)
      : identity.textSignature.trim()
        ? textToHtml(identity.textSignature)
        : "";
    const sigText = identity.textSignature.trim() || (identity.htmlSignature.trim() ? htmlToText(identity.htmlSignature) : "");
    if (sigHtml) htmlParts.push(`<div>-- <br>${sigHtml}</div>`);
    if (sigText) textParts.push(`-- \n${sigText}`);
  }
  const q = prefill.quote;
  if (q) {
    const tz = await userTimeZone();
    const date = q.sentAt
      ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(q.sentAt))
      : "";
    const from = formatAddr(q.from);
    const originalHtml = q.html ? sanitizeHtml(q.html) : textToHtml(q.text ?? "");
    const originalText = (q.text ?? (q.html ? htmlToText(q.html) : "")).trim();
    if (mode === "forward") {
      const lines = [
        "---------- Forwarded message ---------",
        `From: ${from}`,
        date && `Date: ${date}`,
        `Subject: ${q.subject}`,
        q.to.length ? `To: ${formatAddr(q.to)}` : "",
        q.cc.length ? `Cc: ${formatAddr(q.cc)}` : "",
      ].filter(Boolean);
      htmlParts.push(`<div>${lines.map(escapeHtml).join("<br>")}</div><br><div>${originalHtml}</div>`);
      textParts.push(`${lines.join("\n")}\n\n${originalText}`);
    } else {
      const header = date ? `On ${date}, ${from} wrote:` : `${from} wrote:`;
      htmlParts.push(`<div>${escapeHtml(header)}</div><blockquote style="${QUOTE_STYLE}">${originalHtml}</blockquote>`);
      textParts.push(`${header}\n${originalText.split("\n").map((l) => `> ${l}`).join("\n")}`);
    }
  }
  return { html: mailDocument(htmlParts.join("\n<br>\n")), text: textParts.join("\n\n") };
}

/** Sends (send=true) or saves a draft of a prepared message. */
async function mailDestination(send: boolean, input: ComposeInput) {
  if (send) {
    if (!input.to.length && !input.cc.length && !input.bcc.length) throw new ToolError("Add at least one recipient");
    const result = await sendMessage(input, null);
    if (!result.ok) throw new ToolError(`Not sent: ${result.error}`);
    return { sent: true, to: input.to, cc: input.cc.length ? input.cc : undefined, subject: input.subject };
  }
  const draftId = await saveDraft(input, null);
  return { sent: false, draftId, to: input.to, cc: input.cc.length ? input.cc : undefined, subject: input.subject, url: `${appUrl()}/mail` };
}

/* ------------------------------------------------------- folders & filters */

type RawAttachment = { partId?: string; blobId?: string; name?: string | null; type?: string; size?: number };
const MAX_ATTACHMENT_READ = 25 * 1024 * 1024;

const FILTER_FIELDS = ["from", "to", "subject", "listId", "hasAttachment", "sizeOver"];
const FILTER_ACTIONS = ["move", "label", "markRead", "star", "forward", "delete"];

/** Readable path of a folder ("Projects/2026"). */
function folderPath(box: Mailbox, byId: Map<string, Mailbox>): string {
  const parts: string[] = [];
  for (let m: Mailbox | undefined = box, guard = 0; m && guard < 20; m = m.parentId ? byId.get(m.parentId) : undefined, guard++) {
    parts.unshift(m.name);
  }
  return parts.join("/");
}

function describeRule(r: FilterRule, boxes: Map<string, string>, labels: Map<string, string>) {
  return {
    name: r.name || undefined,
    enabled: r.enabled,
    match: r.match,
    conditions: r.conditions.map((c) =>
      c.field === "hasAttachment"
        ? "has attachment"
        : c.field === "sizeOver"
          ? `size over ${c.value}`
          : `${c.field} ${c.op === "notContains" ? "does not contain" : "contains"} "${c.value}"`,
    ),
    actions: r.actions.map((a) =>
      a.type === "move"
        ? `move to ${boxes.get(a.target ?? "") ?? a.target}`
        : a.type === "label"
          ? `label "${labels.get(a.target ?? "") ?? a.target}"`
          : a.type === "forward"
            ? `forward to ${a.target}`
            : a.type,
    ),
    stop: r.stop || undefined,
  };
}

const TARGET_PROPS: Record<string, JsonSchema> = {
  emailIds: A("Email ids."),
  threadId: S("Apply to every message of this thread."),
};

export const MAIL_TOOLS: Tool[] = [
  {
    name: "mail_search",
    description:
      "Searches mail and returns matching conversations (newest first). Combine full-text `query` with filters. Use mail_get_thread to read one.",
    inputSchema: {
      type: "object",
      properties: {
        query: S("Full-text search over sender, recipients, subject and body."),
        folder: S(`Folder name, role (${MAIL_ROLES.join(", ")}) or id. Default: all folders when searching, else inbox.`),
        label: S("Only conversations with this label (id or name)."),
        keyword: S("Only messages with this JMAP keyword (e.g. $flagged)."),
        from: S("Sender address or name contains."),
        to: S("Recipient address or name contains."),
        unread: B("Only unread messages."),
        flagged: B("Only starred/flagged messages."),
        after: S("Received on/after this ISO date (e.g. 2026-11-01)."),
        before: S("Received before this ISO date."),
        limit: I("Max results.", 1, 100, 20),
        position: I("Offset for pagination (use nextPosition from the previous call).", 0, 100_000, 0),
      },
    },
    async run(args) {
      const conds: EmailFilter[] = [];
      const query = str(args, "query", { max: 500 });
      if (query) conds.push({ text: query });
      const folder = str(args, "folder", { max: 200 });
      const hasFilters = query || args.label || args.keyword || args.from || args.to;
      if (folder) conds.push({ inMailbox: (await findMailbox(folder)).id });
      else if (!hasFilters) conds.push({ inMailbox: (await findMailbox("inbox")).id });
      const label = str(args, "label", { max: 100 });
      if (label) conds.push({ hasKeyword: labelKeyword(await labelId(label)) });
      const keyword = str(args, "keyword", { max: 65 });
      if (keyword) {
        if (!KEYWORD.test(keyword)) throw new ToolError('"keyword" is not a valid keyword');
        conds.push({ hasKeyword: keyword });
      }
      const from = str(args, "from", { max: 200 });
      if (from) conds.push({ from });
      const to = str(args, "to", { max: 200 });
      if (to) conds.push({ to });
      if (bool(args, "unread")) conds.push({ notKeyword: "$seen" });
      if (bool(args, "flagged")) conds.push({ hasKeyword: "$flagged" });
      const after = str(args, "after", { max: 40 });
      if (after) conds.push({ after: iso(parseWhen(after, "UTC", "after")) });
      const before = str(args, "before", { max: 40 });
      if (before) conds.push({ before: iso(parseWhen(before, "UTC", "before")) });

      const limit = int(args, "limit", { min: 1, max: 100, def: 20 });
      const position = int(args, "position", { min: 0, max: 100_000, def: 0 });
      const filter: EmailFilter = conds.length === 1 ? conds[0] : { operator: "AND", conditions: conds };
      const { emails, total } = await getEmails(filter, { limit, position });
      return {
        total,
        nextPosition: position + emails.length < total ? position + emails.length : null,
        conversations: emails.map((e) => ({
          threadId: e.threadId,
          emailId: e.id,
          from: addr(e.from),
          subject: e.subject,
          preview: truncate(e.preview, 200),
          receivedAt: e.receivedAt,
          messages: e.threadSize,
          unread: e.unread || undefined,
          flagged: e.flagged || undefined,
          labels: e.labels.length ? e.labels : undefined,
          attachments: e.hasAttachment || undefined,
        })),
      };
    },
  },
  {
    name: "mail_get_thread",
    description: "Reads a mail conversation as plain text (oldest message first), with attachment names. Pass threadId or emailId.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: S("Thread id (from mail_search)."),
        emailId: S("Any email id in the thread."),
        maxCharsPerMessage: I("Truncate each message body to this many characters.", 200, 100_000, 20_000),
      },
    },
    async run(args) {
      const accountId = await primaryAccount(CAP.mail);
      let threadId = id(args, "threadId");
      const emailId = id(args, "emailId");
      if (!threadId && emailId) {
        const r = await jmap([["Email/get", { accountId, ids: [emailId], properties: ["threadId"] }, "e"]]);
        threadId = (r.e.list as { threadId: string }[] | undefined)?.[0]?.threadId;
      }
      if (!threadId) throw new ToolError(emailId ? "Email not found" : 'Provide "threadId" or "emailId"');
      const maxChars = int(args, "maxCharsPerMessage", { min: 200, max: 100_000, def: 20_000 });
      const [r, boxes] = await Promise.all([
        jmap([
          ["Thread/get", { accountId, ids: [threadId] }, "t"],
          [
            "Email/get",
            {
              accountId,
              "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
              properties: ["threadId", "mailboxIds", "keywords", "from", "to", "cc", "subject", "sentAt", "receivedAt", "textBody", "bodyValues", "attachments"],
              bodyProperties: ["partId", "type", "name", "size"],
              fetchTextBodyValues: true,
              maxBodyValueBytes: Math.min(maxChars * 4, 1_000_000),
            },
            "e",
          ],
        ]),
        getMailboxes(),
      ]);
      const list = (r.e.list as RawMail[] | undefined) ?? [];
      if (!list.length) throw new ToolError("Thread not found");
      const boxName = new Map(boxes.map((b) => [b.id, b.role ?? b.name]));
      list.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
      return {
        threadId,
        subject: list[0].subject ?? "",
        messages: list.map((m) => {
          const text = (m.textBody ?? [])
            .map((p) => {
              const v = p.partId ? m.bodyValues?.[p.partId]?.value ?? "" : "";
              return p.type === "text/html" ? htmlToText(v) : v;
            })
            .join("\n")
            .trim();
          return {
            emailId: m.id,
            from: addr(m.from),
            to: addr(m.to),
            cc: m.cc?.length ? addr(m.cc) : undefined,
            date: m.sentAt ?? m.receivedAt,
            subject: m.subject ?? "",
            folders: Object.keys(m.mailboxIds ?? {}).map((b) => boxName.get(b) ?? b),
            unread: !m.keywords?.$seen || undefined,
            flagged: m.keywords?.$flagged || undefined,
            draft: m.keywords?.$draft || undefined,
            keywords: Object.keys(m.keywords ?? {}).filter((k) => !["$seen", "$flagged", "$draft"].includes(k)),
            body: truncate(text, maxChars),
            attachments: (m.attachments ?? []).length
              ? (m.attachments ?? []).map((a) => ({ name: a.name ?? "attachment", type: a.type, size: a.size }))
              : undefined,
          };
        }),
      };
    },
  },
  {
    name: "mail_send",
    description:
      "Sends an email immediately from the user's account (Markdown body by default). For replies pass replyToEmailId to keep threading. Prefer mail_create_draft when the user should review first.",
    inputSchema: { type: "object", properties: COMPOSE_PROPS, required: ["body"] },
    write: true,
    openWorld: true,
    async run(args) {
      const input = await composeInput(args);
      if (!input.to.length && !input.cc.length && !input.bcc.length) throw new ToolError("Add at least one recipient");
      if (!input.subject.trim()) throw new ToolError('"subject" is required');
      const result = await sendMessage(input, null);
      if (!result.ok) throw new ToolError(`Not sent: ${result.error}`);
      return { sent: true, to: input.to, cc: input.cc, subject: input.subject };
    },
  },
  {
    name: "mail_create_draft",
    description: "Saves an email as a draft in the Drafts folder for the user to review and send from the Mail app.",
    inputSchema: { type: "object", properties: COMPOSE_PROPS, required: ["body"] },
    write: true,
    async run(args) {
      const input = await composeInput(args);
      const draftId = await saveDraft(input, null);
      return { draftId, subject: input.subject, url: `${appUrl()}/mail` };
    },
  },
  {
    name: "mail_move",
    description: "Moves messages (or a whole thread) to a folder, e.g. archive, trash, or a custom folder name.",
    inputSchema: {
      type: "object",
      properties: {
        emailIds: A("Email ids to move."),
        threadId: S("Move every message of this thread."),
        folder: S(`Target folder name, role (${MAIL_ROLES.join(", ")}) or id.`),
      },
      required: ["folder"],
    },
    write: true,
    destructive: true,
    async run(args) {
      const target = await findMailbox(str(args, "folder", { required: true, max: 200 }));
      const ids = await targetEmailIds(args);
      const { updated, failed } = await emailSet(Object.fromEntries(ids.map((i) => [i, { mailboxIds: { [target.id]: true } }])));
      return { folder: target.name, moved: updated.length, failed: Object.keys(failed).length ? failed : undefined };
    },
  },
  {
    name: "mail_set_keywords",
    description: "Marks messages read/unread, starred/unstarred, and adds or removes labels (or raw JMAP keywords).",
    inputSchema: {
      type: "object",
      properties: {
        emailIds: A("Email ids to change."),
        threadId: S("Change every message of this thread."),
        read: { type: "boolean", description: "true = mark read, false = mark unread." },
        flagged: { type: "boolean", description: "true = star, false = unstar." },
        addLabels: A("Label ids or names to add."),
        removeLabels: A("Label ids or names to remove."),
        addKeywords: A("Raw JMAP keywords to add (e.g. $important)."),
        removeKeywords: A("Raw JMAP keywords to remove."),
      },
    },
    write: true,
    async run(args) {
      const patch: Record<string, true | null> = {};
      if (typeof args.read === "boolean") patch["keywords/$seen"] = args.read ? true : null;
      if (typeof args.flagged === "boolean") patch["keywords/$flagged"] = args.flagged ? true : null;
      for (const l of strList(args, "addLabels", { max: 20 })) patch[`keywords/${labelKeyword(await labelId(l))}`] = true;
      for (const l of strList(args, "removeLabels", { max: 20 })) patch[`keywords/${labelKeyword(await labelId(l))}`] = null;
      for (const k of strList(args, "addKeywords", { max: 20 })) {
        if (!KEYWORD.test(k)) throw new ToolError(`Invalid keyword "${k}"`);
        patch[`keywords/${k}`] = true;
      }
      for (const k of strList(args, "removeKeywords", { max: 20 })) {
        if (!KEYWORD.test(k)) throw new ToolError(`Invalid keyword "${k}"`);
        patch[`keywords/${k}`] = null;
      }
      if (!Object.keys(patch).length) throw new ToolError("Nothing to change");
      const ids = await targetEmailIds(args);
      const { updated, failed } = await emailSet(Object.fromEntries(ids.map((i) => [i, patch])));
      return { updated: updated.length, failed: Object.keys(failed).length ? failed : undefined };
    },
  },
  {
    name: "mail_reply",
    description:
      'Replies (or replies to all) to an email: keeps threading, quotes the original below your text ("On <date>, <sender> wrote:") and adds your signature, like the Mail composer. Saves a draft unless send=true.',
    inputSchema: {
      type: "object",
      properties: {
        emailId: S("Email id to reply to (from mail_search / mail_get_thread)."),
        body: S("Your reply (Markdown by default)."),
        format: S('Body format: "markdown" (default) or "text".', { enum: ["markdown", "text"] }),
        replyAll: B("Also reply to the original To/Cc recipients."),
        cc: A("Extra Cc recipients."),
        send: B("Send now. Default false: save as a draft for the user to review."),
        includeSignature: B("Add the identity's signature.", true),
        fromEmail: S("Reply from this identity's address (default: the address the original was sent to)."),
      },
      required: ["emailId", "body"],
    },
    write: true,
    openWorld: true,
    async run(args) {
      const emailId = id(args, "emailId", { required: true });
      const prefill = await getPrefill(bool(args, "replyAll") ? "replyAll" : "reply", emailId);
      const identity = await pickIdentity(args, prefill.identityId);
      const { html, text } = await replyBody(args, identity, prefill, "reply");
      const cc = [...new Set([...prefill.cc.map((a) => a.email), ...emailList(args, "cc")])];
      return mailDestination(bool(args, "send"), {
        identityId: identity.id,
        to: prefill.to.map((a) => a.email),
        cc,
        bcc: [],
        subject: prefill.subject,
        html,
        text,
        attachments: [],
        inReplyTo: prefill.inReplyTo,
        references: prefill.references,
      });
    },
  },
  {
    name: "mail_forward",
    description:
      "Forwards an email (with its attachments by default) with an optional note above the forwarded message. Saves a draft unless send=true.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: S("Email id to forward."),
        to: A("Recipients."),
        cc: A("Cc recipients."),
        bcc: A("Bcc recipients."),
        body: S("Optional note above the forwarded message (Markdown by default)."),
        format: S('Note format: "markdown" (default) or "text".', { enum: ["markdown", "text"] }),
        includeAttachments: B("Forward the original attachments.", true),
        send: B("Send now. Default false: save as a draft for the user to review."),
        includeSignature: B("Add the identity's signature.", true),
        fromEmail: S("Send from this identity's address."),
      },
      required: ["emailId", "to"],
    },
    write: true,
    openWorld: true,
    async run(args) {
      const emailId = id(args, "emailId", { required: true });
      const to = emailList(args, "to");
      if (!to.length) throw new ToolError('"to" is required');
      const prefill = await getPrefill("forward", emailId);
      const identity = await pickIdentity(args, prefill.identityId);
      const { html, text } = await replyBody(args, identity, prefill, "forward");
      const attachments = bool(args, "includeAttachments", true) ? prefill.attachments : [];
      const result = await mailDestination(bool(args, "send"), {
        identityId: identity.id,
        to,
        cc: emailList(args, "cc"),
        bcc: emailList(args, "bcc"),
        subject: prefill.subject,
        html,
        text,
        attachments,
        inReplyTo: null,
        references: null,
      });
      return { ...result, attachments: attachments.length ? attachments.map((a) => a.name) : undefined };
    },
  },
  {
    name: "mail_mark_read",
    description: "Marks messages (or a whole thread) as read, or as unread with read=false.",
    inputSchema: {
      type: "object",
      properties: { ...TARGET_PROPS, read: B("true = read (default), false = unread.", true) },
    },
    write: true,
    async run(args) {
      const ids = await targetEmailIds(args);
      const read = bool(args, "read", true);
      const { updated, failed } = await emailSet(Object.fromEntries(ids.map((i) => [i, { "keywords/$seen": read ? true : null }])));
      return { read, updated: updated.length, failed: Object.keys(failed).length ? failed : undefined };
    },
  },
  {
    name: "mail_list_labels",
    description: "Lists the user's mail labels (id, name, color). Use the name or id with mail_label or mail_search.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const labels = await getLabels();
      return { labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })) };
    },
  },
  {
    name: "mail_label",
    description:
      'Applies or removes a label on messages (or a whole thread), or creates a label. action="apply" creates a missing label first (createIfMissing, default true).',
    inputSchema: {
      type: "object",
      properties: {
        action: S('"apply" (default), "remove" or "create".', { enum: ["apply", "remove", "create"] }),
        label: S("Label name or id."),
        color: S(`Color for a new label: ${LABEL_COLOR_NAMES.join(", ")}.`, { enum: LABEL_COLOR_NAMES }),
        createIfMissing: B("When applying, create the label if it doesn't exist.", true),
        ...TARGET_PROPS,
      },
      required: ["label"],
    },
    write: true,
    async run(args) {
      const action = oneOf(args, "action", ["apply", "remove", "create"] as const, "apply");
      const name = str(args, "label", { required: true, max: 60 }).trim();
      if (!name) throw new ToolError('"label" is required');
      const color = oneOf(args, "color", LABEL_COLOR_NAMES, "gray");
      let label = await findLabel(name);
      let created = false;
      if (!label && (action === "create" || (action === "apply" && bool(args, "createIfMissing", true)))) {
        const r = await createLabel({ name, color });
        if (!r.ok) throw new ToolError(`Could not create the label: ${r.error}${r.detail ? ` (${r.detail})` : ""}`);
        label = r.label ?? null;
        created = true;
      }
      if (!label) throw new ToolError(`Unknown label "${name}". Labels: ${(await getLabels()).map((l) => l.name).join(", ") || "none"}`);
      if (action === "create") return { label: { id: label.id, name: label.name, color: label.color }, created };
      const ids = await targetEmailIds(args);
      const keyword = labelKeyword(label.id);
      const { updated, failed } = await emailSet(
        Object.fromEntries(ids.map((i) => [i, { [`keywords/${keyword}`]: action === "apply" ? true : null }])),
      );
      return {
        label: label.name,
        action,
        created: created || undefined,
        updated: updated.length,
        failed: Object.keys(failed).length ? failed : undefined,
      };
    },
  },
  {
    name: "mail_list_folders",
    description: "Lists mail folders with their path, role (inbox, sent, trash…) and unread/total counts.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const boxes = await getMailboxes();
      const byId = new Map(boxes.map((b) => [b.id, b]));
      return {
        folders: boxes.map((b) => ({
          id: b.id,
          name: b.name,
          path: folderPath(b, byId),
          role: b.role ?? undefined,
          unread: b.unreadEmails,
          total: b.totalEmails,
        })),
      };
    },
  },
  {
    name: "mail_create_folder",
    description: "Creates a mail folder at the top level or inside another folder.",
    inputSchema: {
      type: "object",
      properties: {
        name: S("Folder name (no slashes)."),
        parent: S("Parent folder name, role or id (omit for the top level)."),
      },
      required: ["name"],
    },
    write: true,
    async run(args) {
      const name = str(args, "name", { required: true, max: 100 }).trim();
      const parentArg = str(args, "parent", { max: 200 });
      const parent = parentArg ? await findMailbox(parentArg) : null;
      const r = await createMailFolder({ name, parentId: parent?.id ?? null });
      if (!r.ok) {
        const why =
          r.error === "exists" ? "a folder with that name already exists there" : r.error === "invalidName" || r.error === "invalid" ? "invalid name" : r.error;
        throw new ToolError(`Could not create the folder: ${why}${r.detail ? ` (${r.detail})` : ""}`);
      }
      return { id: r.id, name, parent: parent?.name };
    },
  },
  {
    name: "mail_delete",
    description: "Moves messages (or a whole thread) to Trash. permanent=true deletes them forever instead and requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPS,
        permanent: B("Delete permanently instead of moving to Trash."),
        confirm: B("Must be true for a permanent delete (ask the user first)."),
      },
    },
    write: true,
    destructive: true,
    async run(args) {
      const ids = await targetEmailIds(args);
      const permanent = bool(args, "permanent");
      if (permanent && !bool(args, "confirm")) throw new ToolError("Permanent deletion needs confirm=true (ask the user first)");
      try {
        if (permanent) {
          await destroyEmails(ids);
          return { deleted: ids.length, permanent: true };
        }
        await moveToRole(ids, "trash");
        return { trashed: ids.length };
      } catch (e) {
        throw new ToolError(`Could not delete: ${e instanceof Error ? e.message : "failed"}`);
      }
    },
  },
  {
    name: "mail_filters_list",
    description: "Lists the user's mail filter rules (conditions → actions) in the order they run.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const state = await getFilters();
      if (!state) throw new ToolError("Mail filters are not available on this server");
      const boxes = await getMailboxes();
      const byId = new Map(boxes.map((b) => [b.id, b]));
      const boxNames = new Map(boxes.map((b) => [b.id, folderPath(b, byId)]));
      const labelNames = new Map(state.labels.map((l) => [l.id, l.name]));
      return {
        rules: state.rules.map((r, i) => ({ index: i + 1, ...describeRule(r, boxNames, labelNames) })),
        unreadable: state.unreadable || undefined,
        otherActiveScript: state.active && state.active.name !== FILTER_SCRIPT_NAME ? state.active.name : undefined,
      };
    },
  },
  {
    name: "mail_filters_add",
    description:
      'Adds a mail filter rule for incoming mail. Conditions: {field: from|to|subject|listId, op: contains|notContains, value}, {field: hasAttachment} or {field: sizeOver, value: "500K"|"5M"}. Actions: {type: move, target: folder}, {type: label, target: label}, {type: markRead}, {type: star}, {type: forward, target: email}, {type: delete}.',
    inputSchema: {
      type: "object",
      properties: {
        name: S("Rule name."),
        match: S('"all" (default) or "any" of the conditions.', { enum: ["all", "any"] }),
        conditions: {
          type: "array",
          description: "1–10 conditions.",
          items: {
            type: "object",
            properties: {
              field: { type: "string", enum: FILTER_FIELDS },
              op: { type: "string", enum: ["contains", "notContains"] },
              value: { type: "string" },
            },
            required: ["field"],
          },
        },
        actions: {
          type: "array",
          description: "1+ actions. Folder and label targets accept names or ids.",
          items: {
            type: "object",
            properties: { type: { type: "string", enum: FILTER_ACTIONS }, target: { type: "string" } },
            required: ["type"],
          },
        },
        stop: B("When this rule matches, skip the moves/forwards/deletes of later rules."),
        activate: B("Turn the workspace filters on even if another (hand-written) Sieve script is active."),
      },
      required: ["conditions", "actions"],
    },
    write: true,
    async run(args) {
      if (!Array.isArray(args.conditions) || !Array.isArray(args.actions)) throw new ToolError('"conditions" and "actions" must be arrays');
      if (args.actions.length > 10) throw new ToolError("Too many actions");
      let config;
      try {
        config = await readConfigForUpdate();
      } catch (e) {
        const m = e instanceof Error ? e.message : "";
        if (m === "unavailable") throw new ToolError("Mail filters are not available on this server");
        if (m === "unreadable") throw new ToolError("The existing filters can't be read; edit them in Mail → Settings first");
        throw e;
      }
      const boxes = await getMailboxes();
      const actions: { type: string; target?: string }[] = [];
      for (const raw of args.actions as unknown[]) {
        const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const type = typeof a.type === "string" ? a.type : "";
        const target = typeof a.target === "string" ? a.target.trim().slice(0, 254) : undefined;
        if (type === "move") {
          if (!target) throw new ToolError("A move action needs a target folder");
          actions.push({ type, target: (await findMailbox(target)).id });
        } else if (type === "label") {
          const label = target ? await findLabel(target) : null;
          if (!label) throw new ToolError(`Unknown label "${target ?? ""}" (create it first with mail_label action=create)`);
          actions.push({ type, target: label.id });
        } else actions.push(target ? { type, target } : { type });
      }
      const rule = {
        name: str(args, "name", { max: 80 }) ?? "",
        enabled: true,
        match: oneOf(args, "match", ["all", "any"] as const, "all"),
        conditions: args.conditions,
        actions,
        stop: bool(args, "stop"),
      };
      let rules: FilterRule[];
      try {
        rules = validateRules([...config.rules, rule], {
          mailboxIds: new Set(boxes.map((b) => b.id)),
          labelIds: new Set(config.labels.map((l) => l.id)),
        });
      } catch (e) {
        const m = e instanceof Error ? e.message : "invalid";
        throw new ToolError(`Invalid rule (${m}): check the condition fields/values and the action targets`);
      }
      const err = await writeConfig({ rules, labels: config.labels }, boxes, { activate: bool(args, "activate") });
      if (err) throw new ToolError(`Could not save the filters: ${String(err.description ?? err.type ?? "error")}`);
      const active = (await getFilters().catch(() => null))?.active?.name;
      const byId = new Map(boxes.map((b) => [b.id, b]));
      return {
        added: describeRule(
          rules[rules.length - 1],
          new Map(boxes.map((b) => [b.id, folderPath(b, byId)])),
          new Map(config.labels.map((l) => [l.id, l.name])),
        ),
        totalRules: rules.length,
        warning:
          active && active !== FILTER_SCRIPT_NAME
            ? `Another filter script ("${active}") is active, so these rules don't run yet. Call again with activate=true to switch.`
            : undefined,
      };
    },
  },
  {
    name: "mail_get_attachment_text",
    description:
      "Reads an email attachment as text: text-like files (txt, csv, md, json, html, ics…) directly; office documents (docx, xlsx, pptx, odt…) converted via Collabora when available. Other files return binary=true.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: S("Email id holding the attachment."),
        attachment: S("Attachment name, 1-based index or blobId (default: the first attachment)."),
        maxChars: I("Return at most this many characters.", 100, 1_000_000, 100_000),
      },
      required: ["emailId"],
    },
    async run(args) {
      const emailId = id(args, "emailId", { required: true });
      const maxChars = int(args, "maxChars", { min: 100, max: 1_000_000, def: 100_000 });
      const accountId = await primaryAccount(CAP.mail);
      const r = await jmap([
        [
          "Email/get",
          { accountId, ids: [emailId], properties: ["attachments"], bodyProperties: ["partId", "blobId", "name", "type", "size"] },
          "e",
        ],
      ]);
      const email = (r.e.list as { attachments?: RawAttachment[] }[] | undefined)?.[0];
      if (!email) throw new ToolError("Email not found");
      const list = (email.attachments ?? []).filter((a) => a.blobId);
      if (!list.length) throw new ToolError("This email has no attachments");
      const want = str(args, "attachment", { max: 512 })?.trim();
      const index = want && /^\d{1,3}$/.test(want) ? Number(want) - 1 : -1;
      const att = !want
        ? list[0]
        : (list[index] ?? list.find((a) => a.blobId === want) ?? list.find((a) => (a.name ?? "").toLowerCase() === want.toLowerCase()));
      if (!att?.blobId) {
        throw new ToolError(`Attachment not found. Attachments: ${list.map((a, i) => `${i + 1}. ${a.name ?? "attachment"}`).join(", ")}`);
      }
      const name = cleanFileName(att.name);
      const type = att.type || "application/octet-stream";
      const session = await getMailSession();
      const res = await fetch(expandDownloadUrl(session.downloadUrl, { accountId, blobId: att.blobId, name, type }), {
        headers: { Authorization: `Bearer ${session.token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new ToolError(`Could not download the attachment (HTTP ${res.status})`);
      const { bytes, truncated } = await readCapped(res, MAX_ATTACHMENT_READ);
      const out = await extractText(bytes, name, type, { maxChars, partial: truncated });
      const meta = { emailId, name, type, size: att.size ?? bytes.byteLength };
      if (!out.ok) return { ...meta, binary: true, reason: out.reason };
      return { ...meta, truncated: out.truncated || undefined, convertedWith: out.via === "collabora" ? "collabora" : undefined, content: out.text };
    },
  },
];
