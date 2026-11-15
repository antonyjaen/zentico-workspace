// MCP tools over the workspace: mail, calendar, contacts, drive/docs, chat and meetings.
// Each tool runs inside runWithSession() (see app/api/mcp/route.ts), so the regular server libs
// work exactly as they do for the signed-in browser user.
import { addDays, DAY_MS, isTimeZone, utcToLocal, weekday, zonedParts, zonedToUtc } from "@/app/(apps)/calendar/time";
import { getAvailability, getEvents, getPrincipals, createMeetingEvent, type CalEvent } from "../calendar";
import { fromCard, getAllCards } from "../contacts";
import {
  createFile,
  fetchBlob,
  getNode,
  listChildren,
  replaceContent,
  searchNodes,
  uploadStream,
  validName,
  type DriveNode,
} from "../drive";
import { env } from "../env";
import { CAP, jmap, primaryAccount } from "../jmap";
import { getEmails, getMailboxes, type EmailFilter, type Mailbox } from "../mail";
import { getIdentities, getPrefill, saveDraft, sendMessage } from "../mail-compose";
import { LABEL_ID, labelKeyword } from "../mail-labels";
import type { Session } from "../session";
import {
  bool,
  emailList,
  id,
  idList,
  int,
  oneOf,
  str,
  strList,
  ToolError,
  truncate,
  type Args,
} from "./args";
import { awaitConfirmation } from "./agent";
import type { Scope } from "./db";
import {
  chatError,
  loadChat,
  loadMeetings,
  type ChatMsg,
  type ChatSummary,
  type MeetingSummary,
  type TranscriptSegment,
} from "./optional";
import { htmlToText, mailDocument, markdownToHtml, textToHtml } from "./text";

export type ToolContext = {
  session: Session;
  scope: Scope;
  tokenName: string;
  tokenExpires: number | null;
  /**
   * Set when the request carries X-Zentico-Command (sent by tools/zentico-bridge.mjs for a meeting
   * command): write tools then wait for the user's Approve / Reject in the call. null = normal MCP use.
   */
  commandId?: string | null;
};

type JsonSchema = Record<string, unknown>;
type Tool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, JsonSchema>; required?: string[] };
  write?: boolean;
  run(args: Args, ctx: ToolContext): Promise<unknown>;
};

/* ------------------------------------------------------------------ helpers */

const appUrl = () => env.appUrl;
const S = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extra });
const I = (description: string, minimum: number, maximum: number, def?: number): JsonSchema => ({
  type: "integer",
  description,
  minimum,
  maximum,
  ...(def !== undefined ? { default: def } : {}),
});
const B = (description: string, def = false): JsonSchema => ({ type: "boolean", description, default: def });
const A = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });

const iso = (ms: number) => new Date(ms).toISOString();
const addr = (list: { name: string | null; email: string }[] | null | undefined) =>
  (list ?? []).map((a) => (a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email));

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

/** Label id from an id or a display name (labels are stored as `zwl_<id>` keywords). */
async function labelId(value: string): Promise<string> {
  const v = value.trim();
  try {
    const { getLabels } = await import("../mail-settings");
    const labels = await getLabels();
    const hit = labels.find((l) => l.id === v.toLowerCase() || l.name.toLowerCase() === v.toLowerCase());
    if (hit) return hit.id;
  } catch {
    // Label settings unavailable: fall back to treating the value as an id.
  }
  if (!LABEL_ID.test(v.toLowerCase())) throw new ToolError(`Unknown label "${value}"`);
  return v.toLowerCase();
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

/* ----------------------------------------------------------------- calendar */

const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "YYYY-MM-DD" (midnight in tz), local "YYYY-MM-DDTHH:MM[:SS]" (in tz) or ISO with Z/offset. */
function parseWhen(value: string, tz: string, key: string): number {
  try {
    if (DATE.test(value)) return zonedToUtc(`${value}T00:00:00`, tz);
    if (LOCAL_DT.test(value)) return zonedToUtc(value, tz);
  } catch {
    throw new ToolError(`"${key}" is not a valid date/time`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new ToolError(`"${key}" must be an ISO 8601 date or date-time`);
  return ms;
}

function timeZoneArg(args: Args): string {
  const tz = str(args, "timeZone", { max: 64 }) ?? "UTC";
  if (!isTimeZone(tz)) throw new ToolError(`Unknown time zone "${tz}" (use an IANA name like "Europe/Madrid")`);
  return tz;
}

function compactEvent(e: CalEvent, tz: string) {
  return {
    id: e.baseId,
    title: e.title,
    start: e.allDay ? e.startDay : utcToLocal(e.utcStart, tz),
    end: e.allDay ? e.endDay : utcToLocal(e.utcEnd, tz),
    allDay: e.allDay || undefined,
    location: e.location || undefined,
    description: e.description ? truncate(e.description, 500) : undefined,
    recurring: e.recurrence !== "none" || undefined,
    organizer: e.isOrganizer || undefined,
    myStatus: e.myStatus ?? undefined,
    attendees: e.participants.length
      ? e.participants.map((p) => `${p.name ? `${p.name} <${p.email}>` : p.email}${p.status !== "needs-action" ? ` (${p.status})` : ""}`)
      : undefined,
  };
}

function roomCode(): string {
  const letters = "abcdefghijkmnopqrstuvwxyz";
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => letters[b % letters.length]);
  return `${chars.slice(0, 3).join("")}-${chars.slice(3, 7).join("")}-${chars.slice(7).join("")}`;
}

type Interval = { start: number; end: number };

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/* -------------------------------------------------------------------- drive */

const TEXT_EXTS = new Set(["md", "markdown", "txt", "json", "csv", "tsv", "log", "yaml", "yml", "xml", "html", "htm", "ics", "vcf", "ini", "toml", "srt", "vtt"]);
const WRITE_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
};
const MAX_TEXT_BYTES = 1024 * 1024;
const extOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

const isTextual = (n: DriveNode) =>
  TEXT_EXTS.has(extOf(n.name)) || /^text\//.test(n.type) || /(^application\/(json|xml|x-yaml|yaml)$)|\+(json|xml)$/.test(n.type);

function fileUrl(n: DriveNode): string {
  const ext = extOf(n.name);
  if (ext === "md" || ext === "markdown") return `${appUrl()}/docs/md/${encodeURIComponent(n.id)}`;
  return `${appUrl()}/api/drive/file/${encodeURIComponent(n.id)}`;
}

const compactNode = (n: DriveNode) => ({
  id: n.id,
  name: n.name,
  folder: n.isFolder || undefined,
  type: n.isFolder ? undefined : n.type || undefined,
  size: n.isFolder ? undefined : n.size,
  modified: n.modified ?? undefined,
  parentId: n.parentId ?? undefined,
  readOnly: n.rights.mayModifyContent ? undefined : true,
});

async function readText(node: DriveNode, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const res = await fetchBlob(node);
  if (!res.ok || !res.body) throw new ToolError(`Could not read the file (HTTP ${res.status})`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, bytes.byteLength - offset);
    bytes.set(c.subarray(0, take), offset);
    offset += take;
    if (offset >= bytes.byteLength) break;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), truncated };
}

function encodeText(content: string, ext: string): ArrayBuffer {
  if (ext === "json") {
    try {
      JSON.parse(content);
    } catch {
      throw new ToolError("Content is not valid JSON");
    }
  }
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_TEXT_BYTES) throw new ToolError("Content is larger than 1 MB");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function writeText(opts: {
  fileId?: string;
  name?: string;
  folderId?: string | null;
  content: string;
  overwrite: boolean;
  accountId?: string;
}): Promise<{ node: DriveNode; created: boolean }> {
  if (opts.fileId) {
    const node = await getNode(opts.fileId, opts.accountId);
    if (!node || node.isFolder) throw new ToolError("File not found");
    const ext = extOf(node.name);
    if (!WRITE_TYPES[ext]) throw new ToolError("Only .md, .txt and .json files can be written");
    const next = await replaceContent(node.id, encodeText(opts.content, ext), WRITE_TYPES[ext], opts.accountId);
    return { node: next, created: false };
  }
  const name = validName(opts.name);
  if (!name) throw new ToolError('Provide "fileId" to overwrite, or a valid "name" to create a file');
  const ext = extOf(name);
  if (!WRITE_TYPES[ext]) throw new ToolError("The file name must end in .md, .txt or .json");
  const body = encodeText(opts.content, ext);
  const parent = opts.folderId ?? null;
  if (parent) {
    const folder = await getNode(parent, opts.accountId);
    if (!folder?.isFolder) throw new ToolError("Folder not found");
  }
  if (opts.overwrite) {
    const existing = (await listChildren(parent, opts.accountId)).find((n) => !n.isFolder && n.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      const next = await replaceContent(existing.id, body, WRITE_TYPES[ext], opts.accountId);
      return { node: next, created: false };
    }
  }
  const blob = await uploadStream(body, WRITE_TYPES[ext], null, { accountId: opts.accountId });
  const node = await createFile(parent, name, { ...blob, type: WRITE_TYPES[ext] }, opts.accountId);
  return { node, created: true };
}

/* --------------------------------------------------------------------- chat */

const CONV_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CHAT_BODY_MAX = 8000;

const compactConv = (c: ChatSummary, team?: string) => ({
  id: c.id,
  kind: c.kind,
  name: c.name,
  team,
  unread: c.unread || undefined,
  joined: c.joined === false ? false : undefined,
  lastMessage: c.lastMessage ? { author: c.lastMessage.author, preview: truncate(c.lastMessage.preview, 140), at: iso(c.lastMessage.created) } : undefined,
});

const compactMsg = (m: ChatMsg) => ({
  id: m.id,
  author: m.author ? m.author.name || m.author.email : null,
  at: iso(m.created),
  kind: m.kind !== "text" ? m.kind : undefined,
  body: m.deleted ? "(deleted)" : m.body,
  edited: m.edited ? true : undefined,
  threadRoot: m.threadRoot ?? undefined,
  replies: m.replyCount || undefined,
  meta: m.kind === "text" || m.deleted ? undefined : m.meta,
});

/* ----------------------------------------------------------------- meetings */

/** Seconds → "mm:ss" (or "h:mm:ss"). */
function clock(seconds: number): string {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const compactMeeting = (m: MeetingSummary) => ({
  id: m.id,
  title: m.title,
  startedAt: m.startedAt,
  endedAt: m.endedAt ?? undefined,
  durationMinutes: m.durationSeconds != null ? Math.round(m.durationSeconds / 60) : undefined,
  status: m.status,
  error: m.error ?? undefined,
  startedBy: m.startedByName || m.startedBy,
  participants: m.participants?.map((p) => (p.name && p.name !== p.email ? `${p.name} <${p.email}>` : p.email)),
  transcriptFileId: m.driveFileId ?? undefined,
  url: m.url ? (m.url.startsWith("/") ? `${appUrl()}${m.url}` : m.url) : undefined,
});

/* -------------------------------------------------------------------- tools */

const TOOLS: Tool[] = [
  {
    name: "whoami",
    description: "Returns the signed-in workspace user, the token's name/scope/expiry and the workspace URL.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      return {
        name: ctx.session.name,
        email: ctx.session.email,
        token: { name: ctx.tokenName, scope: ctx.scope === "write" ? "read+write" : "read", expires: ctx.tokenExpires ? iso(ctx.tokenExpires) : null },
        workspace: appUrl(),
      };
    },
  },

  // ---------------------------------------------------------------- mail
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

  // ------------------------------------------------------------ calendar
  {
    name: "calendar_list_events",
    description:
      "Lists calendar events (own and shared calendars, recurrences expanded) overlapping a time range. Times are returned as local wall-clock times in `timeZone`.",
    inputSchema: {
      type: "object",
      properties: {
        start: S('Range start: "YYYY-MM-DD", local "YYYY-MM-DDTHH:MM" (in timeZone) or ISO with offset. Default: now.'),
        end: S("Range end (exclusive). Default: start + 7 days. Max range 92 days."),
        timeZone: S('IANA time zone for inputs and outputs, e.g. "Europe/Madrid". Default UTC.'),
        query: S("Only events whose title, description or location contains this text."),
        limit: I("Max events.", 1, 500, 100),
        position: I("Offset for pagination.", 0, 10_000, 0),
      },
    },
    async run(args, ctx) {
      const tz = timeZoneArg(args);
      const startArg = str(args, "start", { max: 40 });
      const endArg = str(args, "end", { max: 40 });
      const start = startArg ? parseWhen(startArg, tz, "start") : Date.now();
      const end = endArg ? parseWhen(endArg, tz, "end") : start + 7 * DAY_MS;
      if (end <= start) throw new ToolError('"end" must be after "start"');
      if (end - start > 92 * DAY_MS) throw new ToolError("The range can be at most 92 days");
      const q = str(args, "query", { max: 200 })?.toLowerCase();
      const limit = int(args, "limit", { min: 1, max: 500, def: 100 });
      const position = int(args, "position", { min: 0, max: 10_000, def: 0 });
      const { events } = await getEvents(start, end, tz, ctx.session.email);
      const inRange = events.filter(
        (e) => e.utcEnd > start && e.utcStart < end && (!q || `${e.title}\n${e.description}\n${e.location}`.toLowerCase().includes(q)),
      );
      const page = inRange.slice(position, position + limit);
      return {
        timeZone: tz,
        total: inRange.length,
        nextPosition: position + page.length < inRange.length ? position + page.length : null,
        events: page.map((e) => compactEvent(e, tz)),
      };
    },
  },
  {
    name: "calendar_create_event",
    description:
      "Creates an event in the user's default calendar and emails invitations to attendees. Optionally adds a Zentico Meet video link.",
    inputSchema: {
      type: "object",
      properties: {
        title: S("Event title."),
        start: S('Start: local "YYYY-MM-DDTHH:MM" in timeZone, or ISO with offset.'),
        end: S("End (same formats). Use either end or durationMinutes."),
        durationMinutes: I("Duration in minutes (default 30).", 5, 24 * 60),
        timeZone: S('IANA time zone, e.g. "Europe/Madrid". Default UTC.'),
        attendees: A("Attendee email addresses to invite."),
        location: S("Location (room, address or link)."),
        description: S("Description / agenda."),
        add_video_meeting: B("Create a Zentico Meet link for the event."),
      },
      required: ["title", "start"],
    },
    write: true,
    async run(args) {
      const tz = timeZoneArg(args);
      const title = str(args, "title", { required: true, max: 300 }).trim();
      if (!title) throw new ToolError('"title" is required');
      const start = parseWhen(str(args, "start", { required: true, max: 40 }), tz, "start");
      const endArg = str(args, "end", { max: 40 });
      const durationMs = endArg
        ? parseWhen(endArg, tz, "end") - start
        : int(args, "durationMinutes", { min: 5, max: 24 * 60, def: 30 }) * 60_000;
      if (durationMs <= 0) throw new ToolError('"end" must be after "start"');
      if (durationMs > 7 * DAY_MS) throw new ToolError("Events can last at most 7 days");
      const attendees = emailList(args, "attendees", 100).map((email) => ({ email }));
      let location = str(args, "location", { max: 500 }) ?? "";
      let description = str(args, "description", { max: 20_000 }) ?? "";
      let meetUrl: string | null = null;
      if (bool(args, "add_video_meeting")) {
        meetUrl = `${appUrl()}/meet/${roomCode()}`;
        if (!location) location = meetUrl;
        else description = `${description ? `${description}\n\n` : ""}Video meeting: ${meetUrl}`;
      }
      const created = await createMeetingEvent({
        title,
        description,
        start: utcToLocal(start, tz),
        timeZone: tz,
        durationMs,
        location,
        attendees,
      });
      return {
        id: created.id,
        title,
        start: utcToLocal(start, tz),
        end: utcToLocal(start + durationMs, tz),
        timeZone: tz,
        invited: attendees.map((a) => a.email),
        meetUrl: meetUrl ?? undefined,
      };
    },
  },
  {
    name: "calendar_find_free_time",
    description:
      "Finds time windows when the user and the given colleagues are all free (uses the user's calendar plus colleagues' free/busy). Returns free windows within working hours.",
    inputSchema: {
      type: "object",
      properties: {
        attendees: A("Colleague email addresses (the user is always included)."),
        start: S("Range start (date or date-time). Default: now."),
        end: S("Range end. Default: start + 7 days. Max 31 days."),
        durationMinutes: I("Required meeting length in minutes.", 5, 8 * 60, 30),
        timeZone: S("IANA time zone for working hours and output. Default UTC."),
        workdayStart: S('Working hours start "HH:MM" (default "09:00").'),
        workdayEnd: S('Working hours end "HH:MM" (default "18:00").'),
        includeWeekends: B("Also search Saturdays and Sundays."),
        limit: I("Max windows returned.", 1, 100, 20),
      },
    },
    async run(args, ctx) {
      const tz = timeZoneArg(args);
      const startArg = str(args, "start", { max: 40 });
      const endArg = str(args, "end", { max: 40 });
      const from = Math.max(startArg ? parseWhen(startArg, tz, "start") : Date.now(), Date.now());
      const to = endArg ? parseWhen(endArg, tz, "end") : from + 7 * DAY_MS;
      if (to <= from) throw new ToolError('"end" must be in the future and after "start"');
      if (to - from > 31 * DAY_MS) throw new ToolError("The range can be at most 31 days");
      const duration = int(args, "durationMinutes", { min: 5, max: 480, def: 30 }) * 60_000;
      const ws = str(args, "workdayStart", { max: 5 }) ?? "09:00";
      const we = str(args, "workdayEnd", { max: 5 }) ?? "18:00";
      if (!HHMM.test(ws) || !HHMM.test(we) || we <= ws) throw new ToolError("Working hours must be HH:MM with start before end");
      const weekends = bool(args, "includeWeekends");
      const limit = int(args, "limit", { min: 1, max: 100, def: 20 });

      const me = ctx.session.email.toLowerCase();
      const emails = [...new Set(emailList(args, "attendees", 50).map((e) => e.toLowerCase()))].filter((e) => e !== me);
      const [{ events }, principals] = await Promise.all([
        getEvents(from, to, tz, ctx.session.email),
        emails.length ? getPrincipals().catch(() => []) : Promise.resolve([]),
      ]);
      const busy: Interval[] = events
        .filter((e) => !e.allDay && e.myStatus !== "declined")
        .map((e) => ({ start: e.utcStart, end: e.utcEnd }));
      const checked: string[] = [];
      const unknown: string[] = [];
      await Promise.all(
        emails.map(async (email) => {
          const p = principals.find((x) => x.email === email && x.type === "individual") ?? principals.find((x) => x.email === email);
          if (!p) return void unknown.push(email);
          try {
            const blocks = await getAvailability(p.id, from, to);
            busy.push(...blocks.filter((b) => b.status !== "free").map((b) => ({ start: b.start, end: b.end })));
            checked.push(email);
          } catch {
            unknown.push(email);
          }
        }),
      );
      const merged = mergeIntervals(busy);

      const windows: { start: string; end: string; minutes: number }[] = [];
      const lastDay = zonedParts(to, tz).key;
      for (let day = zonedParts(from, tz).key; day <= lastDay && windows.length < limit; day = addDays(day, 1)) {
        const wd = weekday(day);
        if (!weekends && (wd === 0 || wd === 6)) continue;
        let cursor = Math.max(zonedToUtc(`${day}T${ws}:00`, tz), from);
        const dayEnd = Math.min(zonedToUtc(`${day}T${we}:00`, tz), to);
        // Start on a 5-minute boundary.
        cursor = Math.ceil(cursor / 300_000) * 300_000;
        for (const b of merged) {
          if (b.end <= cursor) continue;
          if (b.start >= dayEnd) break;
          if (b.start - cursor >= duration) windows.push({ start: utcToLocal(cursor, tz), end: utcToLocal(b.start, tz), minutes: Math.round((b.start - cursor) / 60_000) });
          cursor = Math.max(cursor, b.end);
          if (windows.length >= limit) break;
        }
        if (windows.length < limit && dayEnd - cursor >= duration) {
          windows.push({ start: utcToLocal(cursor, tz), end: utcToLocal(dayEnd, tz), minutes: Math.round((dayEnd - cursor) / 60_000) });
        }
      }
      return {
        timeZone: tz,
        durationMinutes: duration / 60_000,
        checked: [ctx.session.email, ...checked],
        unknownAvailability: unknown.length ? unknown : undefined,
        freeWindows: windows,
      };
    },
  },

  // ------------------------------------------------------------ contacts
  {
    name: "contacts_search",
    description: "Searches the user's contacts (name, email, company, phone) and, optionally, the organization directory of colleagues.",
    inputSchema: {
      type: "object",
      properties: {
        query: S("Text to match (case-insensitive substring)."),
        includeDirectory: B("Also search colleagues in the organization directory.", true),
        limit: I("Max results.", 1, 100, 20),
      },
      required: ["query"],
    },
    async run(args) {
      const q = str(args, "query", { required: true, max: 200 }).trim().toLowerCase();
      if (!q) throw new ToolError('"query" is required');
      const limit = int(args, "limit", { min: 1, max: 100, def: 20 });
      const cards = await getAllCards().catch(() => []);
      const contacts = cards
        .filter((c) => c.kind !== "group")
        .map(fromCard)
        .filter((c) =>
          [c.displayName, c.company, c.title, ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value)]
            .join("\n")
            .toLowerCase()
            .includes(q),
        )
        .slice(0, limit)
        .map((c) => ({
          id: c.id,
          name: c.displayName,
          emails: c.emails.map((e) => e.value),
          phones: c.phones.length ? c.phones.map((p) => p.value) : undefined,
          company: c.company || undefined,
          title: c.title || undefined,
        }));
      let directory: { name: string; email: string; type: string }[] | undefined;
      if (bool(args, "includeDirectory", true)) {
        const people = await getPrincipals().catch(() => []);
        directory = people
          .filter((p) => p.email && `${p.name}\n${p.email}`.toLowerCase().includes(q))
          .slice(0, limit)
          .map((p) => ({ name: p.name, email: p.email, type: p.type }));
      }
      return { contacts, directory };
    },
  },

  // --------------------------------------------------------------- drive
  {
    name: "drive_list",
    description: "Lists a Drive folder (default: My Drive root). Folders first, then files by name.",
    inputSchema: {
      type: "object",
      properties: {
        folderId: S("Folder id (omit for the root)."),
        accountId: S("Shared space / account id (omit for My Drive)."),
        limit: I("Max entries.", 1, 500, 100),
        position: I("Offset for pagination.", 0, 100_000, 0),
      },
    },
    async run(args) {
      const folderId = id(args, "folderId") ?? null;
      const accountId = id(args, "accountId");
      const limit = int(args, "limit", { min: 1, max: 500, def: 100 });
      const position = int(args, "position", { min: 0, max: 100_000, def: 0 });
      if (folderId) {
        const folder = await getNode(folderId, accountId);
        if (!folder?.isFolder) throw new ToolError("Folder not found");
      }
      const all = (await listChildren(folderId, accountId))
        .filter((n) => n.role !== "trash")
        .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name));
      const page = all.slice(position, position + limit);
      return {
        folderId,
        total: all.length,
        nextPosition: position + page.length < all.length ? position + page.length : null,
        entries: page.map(compactNode),
      };
    },
  },
  {
    name: "drive_search",
    description: "Finds Drive files and folders whose name contains the text (case- and accent-insensitive).",
    inputSchema: {
      type: "object",
      properties: {
        query: S("Text contained in the name."),
        accountId: S("Shared space / account id (omit for My Drive)."),
        limit: I("Max results.", 1, 200, 50),
      },
      required: ["query"],
    },
    async run(args) {
      const q = str(args, "query", { required: true, max: 200 }).trim();
      if (!q) throw new ToolError('"query" is required');
      const limit = int(args, "limit", { min: 1, max: 200, def: 50 });
      const found = await searchNodes(q, id(args, "accountId"));
      found.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
      return { total: found.length, results: found.slice(0, limit).map(compactNode) };
    },
  },
  {
    name: "drive_read_text",
    description: "Reads a text file from Drive (Markdown, plain text, JSON, CSV, transcripts…), up to 1 MB.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: S("File id (from drive_list / drive_search)."),
        accountId: S("Shared space / account id (omit for My Drive)."),
        maxBytes: I("Read at most this many bytes.", 1, MAX_TEXT_BYTES, MAX_TEXT_BYTES),
      },
      required: ["fileId"],
    },
    async run(args) {
      const node = await getNode(id(args, "fileId", { required: true }), id(args, "accountId"));
      if (!node || node.isFolder) throw new ToolError("File not found");
      if (!isTextual(node)) throw new ToolError(`"${node.name}" is not a text file (${node.type || "unknown type"})`);
      const { text, truncated } = await readText(node, int(args, "maxBytes", { min: 1, max: MAX_TEXT_BYTES, def: MAX_TEXT_BYTES }));
      return { id: node.id, name: node.name, type: node.type, size: node.size, modified: node.modified, truncated: truncated || undefined, content: text };
    },
  },
  {
    name: "drive_write_text",
    description:
      "Creates or overwrites a .md, .txt or .json file in Drive (max 1 MB). Pass fileId to overwrite, or name (+ folderId) to create.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: S("Existing file to overwrite."),
        name: S('New file name ending in .md, .txt or .json, e.g. "notes.md".'),
        folderId: S("Folder for a new file (omit for the root)."),
        overwrite: B("When creating by name and a file with that name exists in the folder, overwrite it (default: create a numbered copy)."),
        content: S("Full file content."),
        accountId: S("Shared space / account id (omit for My Drive)."),
      },
      required: ["content"],
    },
    write: true,
    async run(args) {
      const content = str(args, "content", { max: MAX_TEXT_BYTES }) ?? "";
      const { node, created } = await writeText({
        fileId: id(args, "fileId"),
        name: str(args, "name", { max: 255 }),
        folderId: id(args, "folderId") ?? null,
        overwrite: bool(args, "overwrite"),
        content,
        accountId: id(args, "accountId"),
      });
      return { created, id: node.id, name: node.name, size: node.size, url: fileUrl(node) };
    },
  },
  {
    name: "docs_create_markdown",
    description: "Creates a Markdown document (opens in the Docs Markdown editor) and returns its link. Good for meeting notes, summaries and plans.",
    inputSchema: {
      type: "object",
      properties: {
        title: S('Document title (becomes "<title>.md").'),
        content: S("Markdown content."),
        folderId: S("Drive folder id (omit for the root)."),
      },
      required: ["title", "content"],
    },
    write: true,
    async run(args) {
      const title = str(args, "title", { required: true, max: 200 })
        .replace(/[\u0000-\u001f\u007f/\\]/g, " ")
        .replace(/\.(md|markdown)$/i, "")
        .trim();
      if (!title || title === "." || title === "..") throw new ToolError('"title" is required');
      const { node } = await writeText({
        name: `${title}.md`,
        folderId: id(args, "folderId") ?? null,
        overwrite: false,
        content: str(args, "content", { max: MAX_TEXT_BYTES }) ?? "",
      });
      return { id: node.id, name: node.name, url: fileUrl(node) };
    },
  },

  // ---------------------------------------------------------------- chat
  {
    name: "chat_list_conversations",
    description: "Lists the user's chat conversations: direct messages, group chats and team channels, with unread counts.",
    inputSchema: {
      type: "object",
      properties: {
        query: S("Only conversations whose name contains this text."),
        unreadOnly: B("Only conversations with unread messages."),
        limit: I("Max conversations.", 1, 300, 50),
      },
    },
    async run(args) {
      const chat = await loadChat();
      try {
        const me = await chat.me();
        const { teams, chats } = chat.overview(me);
        const q = str(args, "query", { max: 200 })?.toLowerCase();
        const unreadOnly = bool(args, "unreadOnly");
        const limit = int(args, "limit", { min: 1, max: 300, def: 50 });
        const all = [
          ...chats.map((c) => compactConv(c)),
          ...teams.flatMap((t) => t.channels.map((c) => compactConv(c, t.name))),
        ].filter((c) => (!q || `${c.name}\n${c.team ?? ""}`.toLowerCase().includes(q)) && (!unreadOnly || c.unread));
        return { total: all.length, conversations: all.slice(0, limit) };
      } catch (e) {
        chatError(e);
      }
    },
  },
  {
    name: "chat_read_messages",
    description:
      "Reads messages of a chat conversation (oldest → newest, up to 50 per page). Pass `before` (a message id) to page back, or `threadRootId` to read a thread's replies.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: S("Conversation id (from chat_list_conversations)."),
        before: I("Return messages older than this message id.", 1, Number.MAX_SAFE_INTEGER),
        threadRootId: I("Read the replies of this thread instead.", 1, Number.MAX_SAFE_INTEGER),
      },
      required: ["conversationId"],
    },
    async run(args) {
      const convId = str(args, "conversationId", { required: true, max: 64 });
      if (!CONV_ID.test(convId)) throw new ToolError('"conversationId" is not valid');
      const chat = await loadChat();
      try {
        const me = await chat.me();
        const root = args.threadRootId == null ? null : int(args, "threadRootId", { min: 1, max: Number.MAX_SAFE_INTEGER, def: 1 });
        if (root !== null) {
          if (!chat.listThread) throw new ToolError("Reading threads is not available");
          const { root: r, replies } = chat.listThread(root, me.id);
          return { conversationId: convId, root: compactMsg(r), replies: replies.map(compactMsg) };
        }
        const before = args.before == null ? null : int(args, "before", { min: 1, max: Number.MAX_SAFE_INTEGER, def: 1 });
        const { messages, hasMore } = chat.listMessages(convId, me.id, before);
        return {
          conversationId: convId,
          messages: messages.map(compactMsg),
          olderBefore: hasMore && messages.length ? messages[0].id : null,
        };
      } catch (e) {
        chatError(e);
      }
    },
  },
  {
    name: "chat_post_message",
    description: "Posts a message as the user in a chat conversation (optionally as a thread reply).",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: S("Conversation id."),
        body: S("Message text (Markdown supported by the Chat app). Max 8000 characters."),
        threadRootId: I("Reply in the thread of this message id.", 1, Number.MAX_SAFE_INTEGER),
      },
      required: ["conversationId", "body"],
    },
    write: true,
    async run(args) {
      const convId = str(args, "conversationId", { required: true, max: 64 });
      if (!CONV_ID.test(convId)) throw new ToolError('"conversationId" is not valid');
      const body = str(args, "body", { required: true, max: CHAT_BODY_MAX })
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/\r\n?/g, "\n")
        .trim();
      if (!body) throw new ToolError('"body" is empty');
      const threadRoot = args.threadRootId == null ? null : int(args, "threadRootId", { min: 1, max: Number.MAX_SAFE_INTEGER, def: 1 });
      const chat = await loadChat();
      try {
        const me = await chat.me();
        const m = chat.postMessage(convId, me.id, { body, threadRoot });
        return { posted: true, message: compactMsg(m) };
      } catch (e) {
        chatError(e);
      }
    },
  },

  // ------------------------------------------------------------ meetings
  {
    name: "meetings_list",
    description: "Lists the user's recorded meetings (Zentico Meet) that have recordings or transcripts.",
    inputSchema: {
      type: "object",
      properties: {
        limit: I("Max meetings.", 1, 200, 30),
        position: I("Offset for pagination.", 0, 300, 0),
      },
    },
    async run(args, ctx) {
      const meetings = await loadMeetings();
      const limit = int(args, "limit", { min: 1, max: 200, def: 30 });
      const position = int(args, "position", { min: 0, max: 300, def: 0 });
      // Ask for one extra row to know whether there is a next page (the store caps at 500).
      const result = await meetings.listMeetings(ctx.session.email, { limit: position + limit + 1 });
      if (!Array.isArray(result)) return result;
      const page = (result as MeetingSummary[]).slice(position, position + limit);
      return {
        nextPosition: result.length > position + limit ? position + limit : null,
        meetings: page.map(compactMeeting),
      };
    },
  },
  {
    name: "meetings_get_transcript",
    description:
      "Gets the transcript of a recorded meeting as speaker-labelled lines (\"[mm:ss] Speaker: text\"). Use it to summarize, extract action items, then e.g. create a doc, send follow-up mail or schedule events.",
    inputSchema: {
      type: "object",
      properties: {
        meetingId: S("Meeting id (from meetings_list)."),
        offset: I("Index of the first transcript line (for long meetings).", 0, 1_000_000, 0),
        maxChars: I("Return lines up to about this many characters; continue with nextOffset.", 1000, 500_000, 200_000),
      },
      required: ["meetingId"],
    },
    async run(args, ctx) {
      const meetingId = str(args, "meetingId", { required: true, max: 128 });
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(meetingId)) throw new ToolError('"meetingId" is not valid');
      const offset = int(args, "offset", { min: 0, max: 1_000_000, def: 0 });
      const maxChars = int(args, "maxChars", { min: 1000, max: 500_000, def: 200_000 });
      const meetings = await loadMeetings();
      const result = (await meetings.getTranscript(meetingId, ctx.session.email)) as
        | { meeting?: MeetingSummary; segments?: TranscriptSegment[]; markdown?: string }
        | string
        | null;
      if (result == null) throw new ToolError("Meeting not found");
      if (typeof result === "string") {
        const text = result.slice(offset, offset + maxChars);
        return { meetingId, nextOffset: offset + text.length < result.length ? offset + text.length : null, transcript: text };
      }
      const meeting = result.meeting ? compactMeeting(result.meeting) : { id: meetingId };
      const segments = Array.isArray(result.segments) ? result.segments : [];
      if (!segments.length) {
        const markdown = typeof result.markdown === "string" ? result.markdown : "";
        if (!markdown) {
          const status = result.meeting?.status;
          throw new ToolError(
            status && status !== "ready" ? `No transcript yet: the meeting is ${status}.` : "This meeting has no transcript.",
          );
        }
        const text = markdown.slice(offset, offset + maxChars);
        return { meeting, nextOffset: offset + text.length < markdown.length ? offset + text.length : null, transcript: text };
      }
      const lines: string[] = [];
      let size = 0;
      let i = offset;
      for (; i < segments.length; i++) {
        const s = segments[i];
        const line = `[${clock(s.start)}] ${s.speaker || "Speaker"}: ${String(s.text ?? "").trim()}`;
        if (lines.length && size + line.length > maxChars) break;
        lines.push(line);
        size += line.length + 1;
      }
      return {
        meeting,
        lines: segments.length,
        nextOffset: i < segments.length ? i : null,
        transcript: lines.join("\n"),
      };
    },
  },
];

/* ----------------------------------------------------------------- registry */

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Tool listing for a token: write tools are only offered to read+write tokens. */
export function listTools(scope: Scope) {
  return TOOLS.filter((t) => scope === "write" || !t.write).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: !t.write,
      destructiveHint: t.name === "drive_write_text" || t.name === "mail_move",
      openWorldHint: t.name === "mail_send" || t.name === "calendar_create_event",
    },
  }));
}

/* ------------------------------------------------------ write confirmations */

const clip = (v: unknown, max: number): string => {
  const text = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const people = (v: unknown, max = 5): string => {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => clip(x, 80)) : [];
  return list.length > max ? `${list.slice(0, max).join(", ")} +${list.length - max}` : list.join(", ");
};
const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** One line describing what a write tool is about to do, shown on the in-call Approve / Reject card. */
export function describeWrite(name: string, args: Args): string {
  const parts: string[] = [];
  const add = (label: string, value: string) => value && parts.push(label ? `${label} ${value}` : value);
  switch (name) {
    case "mail_send":
    case "mail_create_draft":
      add("to", people(args.to) || (args.replyToEmailId ? "(reply to the original sender)" : ""));
      add("cc", people(args.cc));
      add("bcc", people(args.bcc));
      add("", args.subject ? `"${clip(args.subject, 120)}"` : "");
      add("", clip(args.body, 200));
      break;
    case "mail_move":
      add("", args.threadId ? "a whole conversation" : `${count(args.emailIds)} message(s)`);
      add("to", clip(args.folder, 80));
      break;
    case "mail_set_keywords":
      add("", args.threadId ? "a whole conversation" : `${count(args.emailIds)} message(s)`);
      if (typeof args.read === "boolean") add("", args.read ? "mark read" : "mark unread");
      if (typeof args.flagged === "boolean") add("", args.flagged ? "star" : "unstar");
      add("add labels", people(args.addLabels));
      add("remove labels", people(args.removeLabels));
      break;
    case "calendar_create_event":
      add("", `"${clip(args.title, 120)}"`);
      add("at", `${clip(args.start, 40)}${args.timeZone ? ` (${clip(args.timeZone, 40)})` : ""}`);
      add("inviting", people(args.attendees));
      break;
    case "drive_write_text":
      add("", args.fileId ? `overwrite file ${clip(args.fileId, 60)}` : `create "${clip(args.name, 120)}"`);
      add("", clip(args.content, 160));
      break;
    case "docs_create_markdown":
      add("", `"${clip(args.title, 120)}"`);
      add("", clip(args.content, 160));
      break;
    case "chat_post_message":
      add("", `"${clip(args.body, 240)}"`);
      break;
    default:
      add("", clip(JSON.stringify(args), 300));
  }
  return parts.join(" · ").slice(0, 600);
}

export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/** Runs a tool by name. Throws only for unexpected failures; user-facing problems come back as errors. */
export async function runTool(name: string, args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, error: `Unknown tool "${name}"` };
  if (tool.write && ctx.scope !== "write") {
    return { ok: false, error: "This token is read-only; create a read+write token in Settings → Integrations." };
  }
  // Meeting commands: reads run immediately, writes wait for the speaker's confirmation in the call.
  if (tool.write && ctx.commandId != null) {
    const confirmed = await awaitConfirmation(ctx.commandId, ctx.session.email, name, describeWrite(name, args ?? {}));
    if (!confirmed.ok) {
      return {
        ok: false,
        error:
          confirmed.reason === "unknown_command"
            ? "Not confirmed by the user (this meeting command is unknown or already finished)."
            : "Not confirmed by the user",
      };
    }
  }
  try {
    return { ok: true, value: await tool.run(args ?? {}, ctx) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, error: e.message };
    throw e;
  }
}
