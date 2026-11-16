// Chat data access: users, conversations, teams/channels, messages, reactions, read state,
// meetings and files. Every function that takes a `userId` authorizes against membership.
// Server-only (imports the SQLite connection).
import { randomBytes } from "node:crypto";
import type { Row } from "node:sqlite";
import {
  MEETING_LIVE_MS,
  PAGE_SIZE,
  type BotCard,
  type CallMeta,
  type ChatMessage,
  type ChatOverview,
  type ChatUser,
  type ConversationDetail,
  type ConversationKind,
  type ConversationSummary,
  type DriveRef,
  type FileMeta,
  type MeetingInfo,
  type MeetingMeta,
  type MessageKind,
  type MessageMeta,
  type NoticeMeta,
  type Person,
  type Reaction,
  type SystemMeta,
  type TeamSummary,
} from "@/app/(apps)/chat/shared";
import { botByUserId, botInfoOf, canUseBot, isBotUser } from "./bots";
import { all, get, run, tx } from "./db";
import { publish } from "./events";
import { onAddedToConversation, onChatMessage, onConversationRead } from "../notifications/chat";

/** A failed check whose message is safe to show the user (as an error code). */
export class ChatError extends Error {}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function newId(length = 16): string {
  return Array.from(randomBytes(length), (b) => ALPHABET[b % ALPHABET.length]).join("");
}

const num = (v: unknown) => Number(v ?? 0);
const strv = (v: unknown) => (typeof v === "string" ? v : "");

// ---------- Users ----------

function toUser(r: Row): ChatUser {
  const user: ChatUser = { id: num(r.id), name: strv(r.name) || strv(r.email), email: strv(r.email) };
  const bot = r.bot_id == null ? undefined : botInfoOf(user.id);
  return bot ? { ...user, bot } : user;
}

/** Inserts/updates the signed-in user (matched by OIDC sub, then by email). */
export function upsertUser({ sub, email, name }: { sub: string; email: string; name: string }): ChatUser {
  const mail = email.trim().toLowerCase();
  const now = Date.now();
  return tx(() => {
    let row = get("SELECT * FROM users WHERE sub = ?", sub) ?? get("SELECT * FROM users WHERE email = ?", mail);
    if (row) {
      // Another row may already own the new email (created from the directory); keep the old one then.
      const clash = get("SELECT id FROM users WHERE email = ? AND id != ?", mail, num(row.id));
      run(
        "UPDATE users SET sub = ?, email = ?, name = ?, last_seen = ? WHERE id = ?",
        sub,
        clash ? strv(row.email) : mail,
        name || strv(row.name),
        now,
        num(row.id),
      );
    } else {
      run("INSERT INTO users (sub, email, name, last_seen) VALUES (?, ?, ?, ?)", sub, mail, name, now);
    }
    row = get("SELECT * FROM users WHERE sub = ?", sub)!;
    return toUser(row);
  });
}

/** Users for people picked from the directory (created on first mention, without a sub). */
export function ensureUsers(people: Person[]): number[] {
  return tx(() =>
    people.map((p) => {
      const email = p.email.toLowerCase();
      const row = get("SELECT id, name FROM users WHERE email = ?", email);
      if (row) {
        if (!strv(row.name) && p.name) run("UPDATE users SET name = ? WHERE id = ?", p.name, num(row.id));
        return num(row.id);
      }
      return num(run("INSERT INTO users (email, name) VALUES (?, ?)", email, p.name).lastInsertRowid);
    }),
  );
}

/** Everyone who has used Chat (for the people picker when the directory is unavailable). Apps excluded. */
export function knownUsers(): ChatUser[] {
  return all("SELECT * FROM users WHERE bot_id IS NULL ORDER BY name COLLATE NOCASE LIMIT 2000").map(toUser);
}

function usersByIds(ids: number[]): ChatUser[] {
  if (ids.length === 0) return [];
  return all(`SELECT * FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).map(toUser);
}

// ---------- Access ----------

type ConvRow = {
  id: string;
  kind: ConversationKind;
  name: string | null;
  description: string;
  team_id: string | null;
  is_private: number;
  created_by: number;
  last_activity: number;
};

const convRow = (r: Row): ConvRow => ({
  id: strv(r.id),
  kind: strv(r.kind) as ConversationKind,
  name: typeof r.name === "string" ? r.name : null,
  description: strv(r.description),
  team_id: typeof r.team_id === "string" ? r.team_id : null,
  is_private: num(r.is_private),
  created_by: num(r.created_by),
  last_activity: num(r.last_activity),
});

const isMember = (convId: string, userId: number) =>
  !!get("SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?", convId, userId);
export const isConversationMember = isMember;
const teamRole = (teamId: string, userId: number): "owner" | "member" | null => {
  const r = get("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?", teamId, userId);
  return r ? (strv(r.role) as "owner" | "member") : null;
};

/** Loads a conversation the user may read: a member, or a team member for a public channel. */
function readable(convId: string, userId: number): { conv: ConvRow; member: boolean } {
  const r = get("SELECT * FROM conversations WHERE id = ?", convId);
  if (!r) throw new ChatError("notFound");
  const conv = convRow(r);
  const member = isMember(convId, userId);
  if (member) return { conv, member };
  if (conv.kind === "channel" && !conv.is_private && conv.team_id && teamRole(conv.team_id, userId)) return { conv, member };
  throw new ChatError("notFound");
}

/** Loads a conversation the user belongs to (needed to post, react, start meetings…). */
function writable(convId: string, userId: number): ConvRow {
  const { conv, member } = readable(convId, userId);
  if (!member) throw new ChatError("notMember");
  return conv;
}

export function memberIds(convId: string): number[] {
  return all("SELECT user_id FROM conversation_members WHERE conversation_id = ?", convId).map((r) => num(r.user_id));
}

/** Who should get live events for a conversation (members; plus team members for public channels). */
function audience(conv: ConvRow): number[] {
  const ids = memberIds(conv.id);
  if (conv.kind === "channel" && !conv.is_private && conv.team_id) {
    for (const r of all("SELECT user_id FROM team_members WHERE team_id = ?", conv.team_id)) ids.push(num(r.user_id));
  }
  return ids;
}

export function canReadConversation(convId: string, userId: number): boolean {
  try {
    readable(convId, userId);
    return true;
  } catch {
    return false;
  }
}

// ---------- Messages ----------

const MESSAGE_SELECT = `
  SELECT m.*, u.name AS author_name, u.email AS author_email, u.bot_id AS author_bot,
    (SELECT count(*) FROM messages r WHERE r.thread_root_id = m.id AND r.deleted = 0) AS reply_count,
    (SELECT max(r.created) FROM messages r WHERE r.thread_root_id = m.id AND r.deleted = 0) AS last_reply_at
  FROM messages m LEFT JOIN users u ON u.id = m.author_id`;

function parseMeta(v: unknown): MessageMeta | null {
  if (typeof v !== "string" || !v) return null;
  try {
    return JSON.parse(v) as MessageMeta;
  } catch {
    return null;
  }
}

function toMessages(rows: Row[]): ChatMessage[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => num(r.id));
  const reactions = new Map<number, Reaction[]>();
  for (const r of all(
    `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY created`,
    ...ids,
  )) {
    const list = reactions.get(num(r.message_id)) ?? [];
    const emoji = strv(r.emoji);
    const entry = list.find((x) => x.emoji === emoji);
    if (entry) entry.users.push(num(r.user_id));
    else list.push({ emoji, users: [num(r.user_id)] });
    reactions.set(num(r.message_id), list);
  }
  return rows.map((r) => {
    const deleted = num(r.deleted) === 1;
    const bot = r.author_bot == null || r.author_id == null ? undefined : botInfoOf(num(r.author_id));
    return {
      id: num(r.id),
      conversationId: strv(r.conversation_id),
      author:
        r.author_id == null
          ? null
          : { id: num(r.author_id), name: strv(r.author_name) || strv(r.author_email), email: strv(r.author_email), ...(bot ? { bot } : {}) },
      body: deleted ? "" : strv(r.body),
      created: num(r.created),
      edited: r.edited == null ? null : num(r.edited),
      deleted,
      threadRoot: r.thread_root_id == null ? null : num(r.thread_root_id),
      kind: strv(r.kind) as MessageKind,
      meta: deleted ? null : parseMeta(r.meta),
      reactions: deleted ? [] : (reactions.get(num(r.id)) ?? []),
      replyCount: num(r.reply_count),
      lastReplyAt: r.last_reply_at == null ? null : num(r.last_reply_at),
    };
  });
}

function messageById(id: number): ChatMessage | null {
  return toMessages(all(`${MESSAGE_SELECT} WHERE m.id = ?`, id))[0] ?? null;
}

/** Top-level messages, newest page first (returned oldest → newest). */
export function listMessages(convId: string, userId: number, before: number | null): { messages: ChatMessage[]; hasMore: boolean } {
  readable(convId, userId);
  const rows = all(
    `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.thread_root_id IS NULL AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
    convId,
    before ?? Number.MAX_SAFE_INTEGER,
    PAGE_SIZE + 1,
  );
  const hasMore = rows.length > PAGE_SIZE;
  return { messages: toMessages(rows.slice(0, PAGE_SIZE).reverse()), hasMore };
}

export function listThread(rootId: number, userId: number): { root: ChatMessage; replies: ChatMessage[] } {
  const root = messageById(rootId);
  if (!root || root.threadRoot !== null) throw new ChatError("notFound");
  readable(root.conversationId, userId);
  const replies = toMessages(all(`${MESSAGE_SELECT} WHERE m.thread_root_id = ? ORDER BY m.id LIMIT 1000`, rootId));
  return { root, replies };
}

function insertMessage(
  conv: ConvRow,
  authorId: number | null,
  { body = "", kind, meta = null, threadRoot = null }: { body?: string; kind: MessageKind; meta?: MessageMeta | null; threadRoot?: number | null },
): number {
  const now = Date.now();
  const id = num(
    run(
      "INSERT INTO messages (conversation_id, author_id, body, created, kind, meta, thread_root_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      conv.id,
      authorId,
      body,
      now,
      kind,
      meta ? JSON.stringify(meta) : null,
      threadRoot,
    ).lastInsertRowid,
  );
  if (threadRoot === null) {
    run("UPDATE conversations SET last_activity = ? WHERE id = ?", now, conv.id);
    // My own message counts as read.
    if (authorId !== null)
      run("UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?", id, conv.id, authorId);
  }
  return id;
}

/** Inserts a message and pushes it (plus the updated thread root, for replies) to everyone. */
function postAndPublish(
  conv: ConvRow,
  authorId: number | null,
  input: { body?: string; kind: MessageKind; meta?: MessageMeta | null; threadRoot?: number | null },
): ChatMessage {
  const id = tx(() => insertMessage(conv, authorId, input));
  const message = messageById(id)!;
  const to = audience(conv);
  publish(to, { type: "message", message });
  if (message.threadRoot !== null) {
    const root = messageById(message.threadRoot);
    if (root) publish(to, { type: "update", message: root });
  }
  onChatMessage(message);
  return message;
}

function checkThreadRoot(convId: string, threadRoot: number | null | undefined) {
  if (threadRoot == null) return;
  const root = get("SELECT conversation_id, thread_root_id, deleted FROM messages WHERE id = ?", threadRoot);
  if (!root || strv(root.conversation_id) !== convId || root.thread_root_id != null) throw new ChatError("notFound");
}

/** Hands a person's message to the apps in the conversation (mentions, DMs, slash commands). */
function dispatchToBots(message: ChatMessage) {
  void import("./bot-events")
    .then((m) => m.onHumanMessage(message))
    .catch((e) => console.error("[bots] dispatch failed:", e instanceof Error ? e.message : e));
}

export function postMessage(
  convId: string,
  userId: number,
  input: {
    body: string;
    kind?: "text" | "file";
    files?: FileMeta[];
    drive?: DriveRef[];
    threadRoot?: number | null;
    /** Posted by an agent on the user's behalf (MCP): apps are not triggered, so agents can't loop. */
    fromAgent?: boolean;
  },
): ChatMessage {
  const conv = writable(convId, userId);
  if (isBotUser(userId)) throw new ChatError("forbidden");
  checkThreadRoot(convId, input.threadRoot);
  const meta: MessageMeta | null = input.files?.length ? { files: input.files } : input.drive?.length ? { drive: input.drive } : null;
  const message = postAndPublish(conv, userId, {
    body: input.body,
    kind: meta ? "file" : "text",
    meta,
    threadRoot: input.threadRoot ?? null,
  });
  if (!input.fromAgent) dispatchToBots(message);
  if (input.body.includes("https://")) unfurlLinks(message);
  return message;
}

/** Link previews from the author's connected apps (lib/connect/unfurl), after posting. */
function unfurlLinks(message: ChatMessage) {
  void import("../connect/unfurl")
    .then((m) => m.unfurlMessage(message))
    .catch((e) => console.error("[chat] unfurl failed:", e instanceof Error ? e.message : e));
}

/** Attaches link-preview cards to a person's message (once: only while it has no cards). */
export function attachUnfurls(messageId: number, cards: BotCard[]): void {
  const row = get("SELECT * FROM messages WHERE id = ?", messageId);
  if (!row || num(row.deleted) || (strv(row.kind) !== "text" && strv(row.kind) !== "file")) return;
  const meta = parseMeta(row.meta) ?? {};
  if (meta.cards?.length) return;
  run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify({ ...meta, cards }), messageId);
  const c = get("SELECT * FROM conversations WHERE id = ?", strv(row.conversation_id));
  if (c) publishUpdate(convRow(c), messageId);
}

// ---------- Apps & bots ----------

export type ConversationBrief = { id: string; kind: ConversationKind; name: string | null; memberCount: number };

export function conversationBrief(convId: string): ConversationBrief | null {
  const r = get("SELECT * FROM conversations WHERE id = ?", convId);
  if (!r) return null;
  const conv = convRow(r);
  const memberCount = num(get("SELECT count(*) AS n FROM conversation_members WHERE conversation_id = ?", convId)?.n);
  return { id: conv.id, kind: conv.kind, name: conv.name, memberCount };
}

/**
 * Posts as an app/bot user. HTTP apps and Claude must be members of the conversation; webhooks
 * belong to their conversation and aren't members. Goes through the same publish + notifications
 * path as people's messages (a bot never notifies itself: bots aren't notification readers).
 */
export function postBotMessage(
  convId: string,
  botUserId: number,
  input: { body: string; cards?: BotCard[]; threadRoot?: number | null },
): ChatMessage {
  const bot = botByUserId(botUserId);
  if (!bot || bot.deleted) throw new ChatError("forbidden");
  const r = get("SELECT * FROM conversations WHERE id = ?", convId);
  if (!r) throw new ChatError("notFound");
  const conv = convRow(r);
  if (bot.kind === "webhook" ? bot.conversationId !== convId : !isMember(convId, botUserId)) throw new ChatError("notMember");
  checkThreadRoot(convId, input.threadRoot);
  if (!input.body && !input.cards?.length) throw new ChatError("empty");
  return postAndPublish(conv, botUserId, {
    body: input.body,
    kind: "text",
    meta: input.cards?.length ? { cards: input.cards } : null,
    threadRoot: input.threadRoot ?? null,
  });
}

let ephemeralSeq = 0;

/** A message from an app shown only to one person, never stored (gone after a reload). */
export function postEphemeral(
  convId: string,
  toUserId: number,
  botUserId: number,
  input: { body?: string; notice?: NoticeMeta; threadRoot?: number | null },
): void {
  const author = get("SELECT * FROM users WHERE id = ?", botUserId);
  if (!author) return;
  const last = num(get("SELECT max(id) AS id FROM messages WHERE conversation_id = ?", convId)?.id);
  ephemeralSeq = (ephemeralSeq % 998) + 1;
  const message: ChatMessage = {
    id: last + ephemeralSeq / 1000,
    conversationId: convId,
    author: toUser(author),
    body: input.body ?? "",
    created: Date.now(),
    edited: null,
    deleted: false,
    threadRoot: input.threadRoot ?? null,
    kind: "text",
    meta: input.notice ? { notice: input.notice } : null,
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    ephemeral: true,
  };
  publish([toUserId], { type: "message", message });
}

/** Tells one person's tabs that something about their Claude in this conversation changed. */
export function signalClaude(convId: string, userId: number): void {
  publish([userId], { type: "claude", conversationId: convId });
}

/** The latest messages of a conversation (top level) or of a thread (root + replies), oldest first. */
export function contextMessages(convId: string, threadRoot: number | null, limit: number): ChatMessage[] {
  const rows =
    threadRoot === null
      ? all(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.thread_root_id IS NULL AND m.deleted = 0 ORDER BY m.id DESC LIMIT ?`, convId, limit)
      : all(
          `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND (m.id = ? OR m.thread_root_id = ?) AND m.deleted = 0 ORDER BY m.id DESC LIMIT ?`,
          convId,
          threadRoot,
          threadRoot,
          limit,
        );
  return toMessages(rows.reverse());
}

/** Adds apps (that I may use) to a conversation I belong to. Returns the bot user ids added. */
export function addBots(convId: string, userId: number, botUserIds: number[]): number[] {
  const conv = writable(convId, userId);
  if (isBotUser(userId)) throw new ChatError("forbidden");
  for (const id of botUserIds) {
    const b = botByUserId(id);
    if (!b || !canUseBot(b, userId)) throw new ChatError("forbidden");
  }
  const added = tx(() => addMembersRaw(convId, botUserIds));
  if (!added.length) return [];
  systemMessage(conv, userId, { action: "added", names: nameList(added) });
  publish(audience(conv), { type: "conversations" });
  return added;
}

/** Removes an app from a conversation (any member may, like in Google Chat). */
export function removeBot(convId: string, userId: number, botUserId: number): boolean {
  const conv = writable(convId, userId);
  if (!isBotUser(botUserId) || isBotUser(userId)) throw new ChatError("forbidden");
  const r = run("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?", convId, botUserId);
  if (!num(r.changes)) return false;
  systemMessage(conv, userId, { action: "removed", names: nameList([botUserId]) });
  publish(audience(conv), { type: "conversations" });
  return true;
}

/** Tells the members of conversations an app just left (deleted) to refresh. */
export function conversationsChanged(convIds: string[]): void {
  for (const id of new Set(convIds)) {
    const r = get("SELECT * FROM conversations WHERE id = ?", id);
    if (r) publish(audience(convRow(r)), { type: "conversations" });
  }
}

/** Everyone who can read a conversation I can read (members; plus the team for public channels). */
export function readers(convId: string, userId: number): ChatUser[] {
  const { conv } = readable(convId, userId);
  return usersByIds([...new Set(audience(conv))]);
}

/** A message I can read (null when it doesn't exist or isn't visible to me). */
export function readableMessage(messageId: number, userId: number): ChatMessage | null {
  const m = messageById(messageId);
  if (!m || m.deleted || !canReadConversation(m.conversationId, userId)) return null;
  return m;
}

function ownMessage(messageId: number, userId: number): { conv: ConvRow; row: Row } {
  const row = get("SELECT * FROM messages WHERE id = ?", messageId);
  if (!row || num(row.deleted)) throw new ChatError("notFound");
  const conv = writable(strv(row.conversation_id), userId);
  if (num(row.author_id) !== userId) throw new ChatError("forbidden");
  return { conv, row };
}

function publishUpdate(conv: ConvRow, messageId: number) {
  const message = messageById(messageId);
  if (message) publish(audience(conv), { type: "update", message });
  return message;
}

export function editMessage(messageId: number, userId: number, body: string): ChatMessage {
  const { conv, row } = ownMessage(messageId, userId);
  const kind = strv(row.kind);
  if (kind !== "text" && kind !== "file") throw new ChatError("forbidden");
  if (!body && kind === "text") throw new ChatError("empty");
  run("UPDATE messages SET body = ?, edited = ? WHERE id = ?", body, Date.now(), messageId);
  return publishUpdate(conv, messageId)!;
}

/** Soft-deletes my message; returns ids of attached files so the caller can remove them from disk. */
export function deleteMessage(messageId: number, userId: number): string[] {
  const { conv, row } = ownMessage(messageId, userId);
  const files = (parseMeta(row.meta)?.files ?? []).map((f) => f.id);
  tx(() => {
    run("UPDATE messages SET deleted = 1, body = '', meta = NULL, edited = ? WHERE id = ?", Date.now(), messageId);
    run("DELETE FROM reactions WHERE message_id = ?", messageId);
    if (files.length) run(`DELETE FROM files WHERE id IN (${files.map(() => "?").join(",")})`, ...files);
    if (strv(row.kind) === "meeting") run("UPDATE meetings SET ended_at = coalesce(ended_at, ?) WHERE message_id = ?", Date.now(), messageId);
  });
  publishUpdate(conv, messageId);
  if (row.thread_root_id != null) publishUpdate(conv, num(row.thread_root_id));
  if (strv(row.kind) === "meeting") publish(audience(conv), { type: "meeting", conversationId: conv.id });
  return files;
}

export function toggleReaction(messageId: number, userId: number, emoji: string): ChatMessage {
  const row = get("SELECT conversation_id, deleted FROM messages WHERE id = ?", messageId);
  if (!row || num(row.deleted)) throw new ChatError("notFound");
  const conv = writable(strv(row.conversation_id), userId);
  tx(() => {
    const removed = run("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", messageId, userId, emoji);
    if (!num(removed.changes))
      run("INSERT INTO reactions (message_id, user_id, emoji, created) VALUES (?, ?, ?, ?)", messageId, userId, emoji, Date.now());
  });
  return publishUpdate(conv, messageId)!;
}

/** Moves my read marker forward (never back) and tells my other tabs. */
export function markRead(convId: string, userId: number, messageId: number): void {
  if (!isMember(convId, userId)) return;
  const max = num(get("SELECT max(id) AS id FROM messages WHERE conversation_id = ?", convId)?.id);
  const target = Math.min(messageId, max);
  const r = run(
    "UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ? AND last_read_id < ?",
    target,
    convId,
    userId,
    target,
  );
  if (num(r.changes)) {
    publish([userId], { type: "read", conversationId: convId, lastReadId: target });
    onConversationRead(convId, userId);
  }
}

export function typing(convId: string, user: ChatUser, threadRoot: number | null): void {
  const conv = writable(convId, user.id);
  publish(
    audience(conv).filter((id) => id !== user.id),
    { type: "typing", conversationId: convId, threadRoot, user },
  );
}

const UNREAD_WHERE = `m.thread_root_id IS NULL AND m.deleted = 0 AND m.kind != 'system'
  AND (m.author_id IS NULL OR m.author_id != cm.user_id) AND m.id > cm.last_read_id`;

export function unreadTotal(userId: number): number {
  return num(
    get(
      `SELECT count(*) AS n FROM messages m JOIN conversation_members cm
         ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
       WHERE ${UNREAD_WHERE}`,
      userId,
    )?.n,
  );
}

// ---------- Conversations ----------

function displayName(conv: ConvRow, members: ChatUser[], userId: number): { name: string; peer: ChatUser | null } {
  if (conv.kind === "dm") {
    // An app added to a DM between two people doesn't replace the person.
    const peer = members.find((m) => m.id !== userId && !m.bot) ?? members.find((m) => m.id !== userId) ?? members[0] ?? null;
    return { name: peer?.name ?? "", peer };
  }
  if (conv.name) return { name: conv.name, peer: null };
  const others = members.filter((m) => m.id !== userId).map((m) => m.name.split(" ")[0]);
  return { name: others.slice(0, 4).join(", ") + (others.length > 4 ? ` +${others.length - 4}` : ""), peer: null };
}

function previewOf(r: Row): string {
  const kind = strv(r.kind);
  if (kind === "file") {
    const meta = parseMeta(r.meta);
    return strv(r.body) || [...(meta?.files ?? []), ...(meta?.drive ?? [])].map((f) => f.name).join(", ") || "";
  }
  if (kind === "meeting") return parseMeta(r.meta)?.meeting?.title ?? "";
  if (!strv(r.body)) {
    const card = parseMeta(r.meta)?.cards?.[0];
    if (card) return (card.title ?? card.sections[0]?.text ?? "").slice(0, 140);
  }
  return strv(r.body)
    .replace(/[*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 140);
}

function summarize(conv: ConvRow, userId: number): ConversationSummary {
  const memberRows = all(
    "SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? ORDER BY cm.joined LIMIT 6",
    conv.id,
  ).map(toUser);
  const memberCount = num(get("SELECT count(*) AS n FROM conversation_members WHERE conversation_id = ?", conv.id)?.n);
  const mine = get("SELECT last_read_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?", conv.id, userId);
  const last = get(
    `SELECT m.*, u.name AS author_name FROM messages m LEFT JOIN users u ON u.id = m.author_id
     WHERE m.conversation_id = ? AND m.thread_root_id IS NULL AND m.deleted = 0 AND m.kind != 'system'
     ORDER BY m.id DESC LIMIT 1`,
    conv.id,
  );
  const unread = mine
    ? num(
        get(
          `SELECT count(*) AS n FROM messages m JOIN conversation_members cm
             ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
           WHERE m.conversation_id = ? AND ${UNREAD_WHERE}`,
          userId,
          conv.id,
        )?.n,
      )
    : 0;
  const { name, peer } = displayName(conv, memberRows, userId);
  return {
    id: conv.id,
    kind: conv.kind,
    name,
    rawName: conv.kind === "dm" ? null : conv.name,
    teamId: conv.team_id,
    isPrivate: !!conv.is_private,
    peer,
    memberCount,
    joined: !!mine,
    unread,
    lastMessage: last
      ? { preview: previewOf(last), author: last.author_id == null ? null : strv(last.author_name), kind: strv(last.kind) as MessageKind, created: num(last.created) }
      : null,
    lastActivity: conv.last_activity,
  };
}

export function overview(user: ChatUser): ChatOverview {
  const teams: TeamSummary[] = all(
    `SELECT t.*, tm.role FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ? ORDER BY t.name COLLATE NOCASE`,
    user.id,
  ).map((t) => {
    const channels = all(
      `SELECT c.* FROM conversations c WHERE c.team_id = ? AND c.kind = 'channel'
         AND (c.is_private = 0 OR EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.user_id = ?))
       ORDER BY c.created`,
      strv(t.id),
      user.id,
    ).map((c) => summarize(convRow(c), user.id));
    return { id: strv(t.id), name: strv(t.name), description: strv(t.description), role: strv(t.role) as "owner" | "member", channels };
  });
  const chats = all(
    `SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
     WHERE c.kind IN ('dm', 'group') ORDER BY c.last_activity DESC LIMIT 300`,
    user.id,
  ).map((c) => summarize(convRow(c), user.id));
  return { me: user, teams, chats };
}

function meetingInfo(r: Row): MeetingInfo {
  return {
    id: num(r.id),
    code: strv(r.code),
    type: strv(r.type) as "instant" | "scheduled",
    title: strv(r.title),
    start: num(r.starts_at),
    end: r.ends_at == null ? null : num(r.ends_at),
    startedBy: r.user_id == null ? null : { id: num(r.user_id), name: strv(r.user_name) || strv(r.user_email), email: strv(r.user_email) },
    messageId: r.message_id == null ? null : num(r.message_id),
  };
}

const MEETING_SELECT = `SELECT mt.*, u.id AS user_id, u.name AS user_name, u.email AS user_email
  FROM meetings mt LEFT JOIN users u ON u.id = mt.created_by`;

function meetingsOf(convId: string): { ongoing: MeetingInfo | null; upcoming: MeetingInfo[] } {
  const now = Date.now();
  const live = get(
    `${MEETING_SELECT} WHERE mt.conversation_id = ? AND mt.type = 'instant' ORDER BY mt.starts_at DESC LIMIT 1`,
    convId,
  );
  const ongoing = live && live.ended_at == null && num(live.starts_at) > now - MEETING_LIVE_MS ? meetingInfo(live) : null;
  const upcoming = all(
    `${MEETING_SELECT} WHERE mt.conversation_id = ? AND mt.type = 'scheduled' AND mt.ended_at IS NULL AND mt.ends_at > ?
     ORDER BY mt.starts_at LIMIT 10`,
    convId,
    now,
  ).map(meetingInfo);
  return { ongoing, upcoming };
}

export function detail(convId: string, userId: number): ConversationDetail {
  const { conv } = readable(convId, userId);
  const summary = summarize(conv, userId);
  const members = all(
    `SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ?
     ORDER BY u.name COLLATE NOCASE LIMIT 1000`,
    convId,
  ).map(toUser);
  const team = conv.team_id ? get("SELECT name FROM teams WHERE id = ?", conv.team_id) : undefined;
  const role = conv.team_id ? teamRole(conv.team_id, userId) : null;
  const teamOwners = conv.team_id
    ? new Set(all("SELECT user_id FROM team_members WHERE team_id = ? AND role = 'owner'", conv.team_id).map((r) => num(r.user_id)))
    : new Set<number>();
  const lastRead = get("SELECT last_read_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?", convId, userId);
  const canManage =
    summary.joined &&
    (conv.kind === "group" || (conv.kind === "channel" && (role === "owner" || conv.created_by === userId || !!conv.is_private)));
  return {
    ...summary,
    description: conv.description,
    teamName: team ? strv(team.name) : null,
    members: members.map((m) => ({ ...m, role: teamOwners.has(m.id) ? "owner" : "member" })),
    canManage,
    lastReadId: num(lastRead?.last_read_id),
    ...meetingsOf(convId),
  };
}

function systemMessage(conv: ConvRow, actorId: number, meta: SystemMeta) {
  postAndPublish(conv, actorId, { kind: "system", meta: { system: meta } });
}

const nameList = (ids: number[]) => usersByIds(ids).map((u) => u.name);

function addMembersRaw(convId: string, ids: number[]): number[] {
  const now = Date.now();
  const added: number[] = [];
  for (const id of ids) {
    const r = run("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined) VALUES (?, ?, ?)", convId, id, now);
    if (num(r.changes)) added.push(id);
  }
  return added;
}

function convById(id: string): ConvRow {
  return convRow(get("SELECT * FROM conversations WHERE id = ?", id)!);
}

/** Opens (or creates) the DM between me and another person. */
export function openDm(userId: number, otherId: number): string {
  if (otherId === userId) throw new ChatError("invalid");
  const key = [userId, otherId].sort((a, b) => a - b).join(":");
  const existing = get("SELECT id FROM conversations WHERE dm_key = ?", key);
  if (existing) return strv(existing.id);
  const id = newId();
  tx(() => {
    const now = Date.now();
    run(
      "INSERT INTO conversations (id, kind, dm_key, created_by, created, last_activity) VALUES (?, 'dm', ?, ?, ?, ?)",
      id,
      key,
      userId,
      now,
      now,
    );
    addMembersRaw(id, [userId, otherId]);
  });
  publish([userId, otherId], { type: "conversations" });
  return id;
}

export function createGroup(userId: number, others: number[], name: string | null): string {
  const id = newId();
  const members = [...new Set([userId, ...others])];
  tx(() => {
    const now = Date.now();
    run(
      "INSERT INTO conversations (id, kind, name, created_by, created, last_activity) VALUES (?, 'group', ?, ?, ?, ?)",
      id,
      name,
      userId,
      now,
      now,
    );
    addMembersRaw(id, members);
  });
  systemMessage(convById(id), userId, { action: "created", name: name ?? undefined });
  publish(members, { type: "conversations" });
  onAddedToConversation(id, userId, members);
  return id;
}

export function addMembers(convId: string, userId: number, ids: number[]): void {
  const conv = writable(convId, userId);
  if (!detail(convId, userId).canManage) throw new ChatError("forbidden");
  if (conv.kind === "channel" && conv.team_id) {
    for (const id of ids) if (!teamRole(conv.team_id, id)) throw new ChatError("notTeamMember");
  }
  const added = tx(() => addMembersRaw(convId, ids));
  if (!added.length) return;
  systemMessage(conv, userId, { action: "added", names: nameList(added) });
  publish([...audience(conv), ...added], { type: "conversations" });
  onAddedToConversation(convId, userId, added);
}

export function leaveConversation(convId: string, userId: number): void {
  const conv = writable(convId, userId);
  if (conv.kind === "dm") throw new ChatError("forbidden");
  systemMessage(conv, userId, { action: "left" });
  run("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?", convId, userId);
  // My Claude only works for me: it leaves with me.
  for (const r of all(
    "SELECT cm.user_id FROM conversation_members cm JOIN bots b ON b.user_id = cm.user_id WHERE cm.conversation_id = ? AND b.kind = 'claude' AND b.owner_id = ?",
    convId,
    userId,
  ))
    run("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?", convId, num(r.user_id));
  publish([...audience(conv), userId], { type: "conversations" });
}

export function joinChannel(convId: string, userId: number): void {
  const { conv, member } = readable(convId, userId);
  if (member) return;
  if (conv.kind !== "channel" || conv.is_private) throw new ChatError("forbidden");
  addMembersRaw(convId, [userId]);
  systemMessage(conv, userId, { action: "joined" });
  publish(audience(conv), { type: "conversations" });
}

export function renameConversation(convId: string, userId: number, name: string | null, description?: string): void {
  const conv = writable(convId, userId);
  if (conv.kind === "dm" || !detail(convId, userId).canManage) throw new ChatError("forbidden");
  if (conv.kind === "channel" && !name) throw new ChatError("invalid");
  run(
    "UPDATE conversations SET name = ?, description = ? WHERE id = ?",
    name,
    description ?? conv.description,
    convId,
  );
  if ((name ?? "") !== (conv.name ?? "")) systemMessage(conv, userId, { action: "renamed", name: name ?? undefined });
  publish(audience(conv), { type: "conversations" });
}

// ---------- Teams & channels ----------

function insertChannel(teamId: string, userId: number, name: string, description: string, isPrivate: boolean, members: number[]): string {
  const id = newId();
  const now = Date.now();
  run(
    `INSERT INTO conversations (id, kind, name, description, team_id, is_private, created_by, created, last_activity)
     VALUES (?, 'channel', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    name,
    description,
    teamId,
    isPrivate ? 1 : 0,
    userId,
    now,
    now,
  );
  addMembersRaw(id, members);
  return id;
}

export function createTeam(
  userId: number,
  { name, description, members, general }: { name: string; description: string; members: number[]; general: string },
): { teamId: string; channelId: string } {
  const teamId = newId();
  const all_ = [...new Set([userId, ...members])];
  const channelId = tx(() => {
    const now = Date.now();
    run("INSERT INTO teams (id, name, description, created_by, created) VALUES (?, ?, ?, ?, ?)", teamId, name, description, userId, now);
    for (const id of all_)
      run(
        "INSERT INTO team_members (team_id, user_id, role, joined) VALUES (?, ?, ?, ?)",
        teamId,
        id,
        id === userId ? "owner" : "member",
        now,
      );
    return insertChannel(teamId, userId, general, "", false, all_);
  });
  systemMessage(convById(channelId), userId, { action: "created", name });
  publish(all_, { type: "conversations" });
  return { teamId, channelId };
}

export function addTeamMembers(teamId: string, userId: number, ids: number[]): void {
  if (teamRole(teamId, userId) !== "owner") throw new ChatError("forbidden");
  const added = tx(() => {
    const now = Date.now();
    const out: number[] = [];
    for (const id of ids) {
      const r = run("INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined) VALUES (?, ?, 'member', ?)", teamId, id, now);
      if (num(r.changes)) out.push(id);
    }
    // New team members join every public channel.
    for (const c of all("SELECT id FROM conversations WHERE team_id = ? AND kind = 'channel' AND is_private = 0", teamId))
      addMembersRaw(strv(c.id), out);
    return out;
  });
  if (!added.length) return;
  const general = get("SELECT * FROM conversations WHERE team_id = ? AND is_private = 0 ORDER BY created LIMIT 1", teamId);
  if (general) systemMessage(convRow(general), userId, { action: "added", names: nameList(added) });
  publish(all("SELECT user_id FROM team_members WHERE team_id = ?", teamId).map((r) => num(r.user_id)), { type: "conversations" });
}

export function teamMembers(teamId: string, userId: number): (ChatUser & { role: "owner" | "member" })[] {
  if (!teamRole(teamId, userId)) throw new ChatError("notFound");
  return all(
    "SELECT u.*, tm.role FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY u.name COLLATE NOCASE",
    teamId,
  ).map((r) => ({ ...toUser(r), role: strv(r.role) as "owner" | "member" }));
}

export function createChannel(
  teamId: string,
  userId: number,
  { name, description, isPrivate, members }: { name: string; description: string; isPrivate: boolean; members: number[] },
): string {
  if (!teamRole(teamId, userId)) throw new ChatError("notFound");
  const teamIds = all("SELECT user_id FROM team_members WHERE team_id = ?", teamId).map((r) => num(r.user_id));
  const allowed = new Set(teamIds);
  if (members.some((id) => !allowed.has(id))) throw new ChatError("notTeamMember");
  const memberList = isPrivate ? [...new Set([userId, ...members])] : teamIds;
  const id = tx(() => insertChannel(teamId, userId, name, description, isPrivate, memberList));
  systemMessage(convById(id), userId, { action: "created", name });
  publish(isPrivate ? memberList : teamIds, { type: "conversations" });
  if (isPrivate) onAddedToConversation(id, userId, memberList);
  return id;
}

// ---------- Meetings ----------

function meetingCard(conv: ConvRow, userId: number, meeting: MeetingMeta, body = ""): ChatMessage {
  return postAndPublish(conv, userId, { kind: "meeting", body, meta: { meeting } });
}

export function startInstantMeeting(convId: string, userId: number, code: string, title: string, call?: CallMeta): ChatMessage {
  const conv = writable(convId, userId);
  const meetingId = num(
    run(
      "INSERT INTO meetings (conversation_id, code, type, title, starts_at, created_by) VALUES (?, ?, 'instant', ?, ?, ?)",
      convId,
      code,
      title,
      Date.now(),
      userId,
    ).lastInsertRowid,
  );
  const message = meetingCard(conv, userId, { meetingId, code, type: "instant", title, ...(call ? { call } : {}) });
  run("UPDATE meetings SET message_id = ? WHERE id = ?", message.id, meetingId);
  publish(audience(conv), { type: "meeting", conversationId: convId });
  return message;
}

export function scheduleMeeting(
  convId: string,
  userId: number,
  m: { code: string; title: string; description: string; start: number; end: number; timeZone: string; eventId: string | null },
): ChatMessage {
  const conv = writable(convId, userId);
  const meetingId = num(
    run(
      `INSERT INTO meetings (conversation_id, code, type, title, starts_at, ends_at, created_by, calendar_event_id)
       VALUES (?, ?, 'scheduled', ?, ?, ?, ?, ?)`,
      convId,
      m.code,
      m.title,
      m.start,
      m.end,
      userId,
      m.eventId,
    ).lastInsertRowid,
  );
  const message = meetingCard(
    conv,
    userId,
    { meetingId, code: m.code, type: "scheduled", title: m.title, start: m.start, end: m.end, timeZone: m.timeZone, calendar: !!m.eventId },
    m.description,
  );
  run("UPDATE meetings SET message_id = ? WHERE id = ?", message.id, meetingId);
  publish(audience(conv), { type: "meeting", conversationId: convId });
  return message;
}

/** Marks a meeting as ended (any member may); updates its card. */
export function endMeeting(meetingId: number, userId: number): void {
  const r = get("SELECT * FROM meetings WHERE id = ?", meetingId);
  if (!r) throw new ChatError("notFound");
  const conv = writable(strv(r.conversation_id), userId);
  if (r.ended_at != null) return;
  const now = Date.now();
  tx(() => {
    run("UPDATE meetings SET ended_at = ? WHERE id = ?", now, meetingId);
    if (r.message_id != null) {
      const msg = get("SELECT meta FROM messages WHERE id = ?", num(r.message_id));
      const meta = parseMeta(msg?.meta);
      if (meta?.meeting) {
        meta.meeting.ended = now;
        run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify(meta), num(r.message_id));
      }
    }
  });
  if (r.message_id != null) publishUpdate(conv, num(r.message_id));
  publish(audience(conv), { type: "meeting", conversationId: conv.id });
  // A ringing call in this meeting stops ringing; an answered one ends.
  void import("./calls")
    .then((m) => m.onMeetingEnded(meetingId))
    .catch((e) => console.error("[calls] meeting end:", e instanceof Error ? e.message : e));
}

// ---------- Calls (lib/chat/calls.ts owns the call state; these keep chat in step) ----------

/** Who a call in this conversation would ring: its people other than me (no apps). Requires membership. */
export function callTarget(convId: string, userId: number): { id: string; kind: ConversationKind; name: string | null; title: string; others: number[] } {
  const conv = writable(convId, userId);
  if (isBotUser(userId)) throw new ChatError("forbidden");
  const others = all(
    `SELECT u.id FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ? AND u.id != ? AND u.bot_id IS NULL ORDER BY cm.joined LIMIT 1000`,
    convId,
    userId,
  ).map((r) => num(r.id));
  return { id: conv.id, kind: conv.kind, name: conv.kind === "dm" ? null : conv.name, title: summarize(conv, userId).name, others };
}

/**
 * Updates the call shown on a meeting's card (state, answered/ended times). `end` also marks the
 * meeting itself as ended, so the conversation's "ongoing" banner goes away.
 */
export function patchMeetingCall(meetingId: number, patch: Partial<CallMeta>, end: boolean): void {
  const r = get("SELECT * FROM meetings WHERE id = ?", meetingId);
  if (!r) return;
  const now = Date.now();
  tx(() => {
    if (end && r.ended_at == null) run("UPDATE meetings SET ended_at = ? WHERE id = ?", now, meetingId);
    if (r.message_id == null) return;
    const meta = parseMeta(get("SELECT meta FROM messages WHERE id = ?", num(r.message_id))?.meta);
    if (!meta?.meeting?.call) return;
    meta.meeting.call = { ...meta.meeting.call, ...patch };
    if (end) meta.meeting.ended ??= now;
    run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify(meta), num(r.message_id));
  });
  const conv = convById(strv(r.conversation_id));
  if (r.message_id != null) publishUpdate(conv, num(r.message_id));
  if (end) publish(audience(conv), { type: "meeting", conversationId: conv.id });
}

/** "Missed call from X" / "X's call was declined" line in the conversation (authored by the caller). */
export function callSystemMessage(convId: string, callerId: number, meta: SystemMeta): void {
  const r = get("SELECT * FROM conversations WHERE id = ?", convId);
  if (r) systemMessage(convRow(r), callerId, meta);
}

/** A system line authored by `actorId` in a conversation (e.g. "Ana assigned you 'X'" from tasks). */
export function postSystemMessage(convId: string, actorId: number, meta: SystemMeta): void {
  const r = get("SELECT * FROM conversations WHERE id = ?", convId);
  if (r) systemMessage(convRow(r), actorId, meta);
}

export function conversationMeetings(convId: string, userId: number) {
  readable(convId, userId);
  return meetingsOf(convId);
}

// ---------- Files ----------

export function recordFile(convId: string, userId: number, f: { id: string; name: string; mime: string; size: number }): void {
  writable(convId, userId);
  run(
    "INSERT INTO files (id, conversation_id, uploader_id, name, mime, size, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
    f.id,
    convId,
    userId,
    f.name,
    f.mime,
    f.size,
    Date.now(),
  );
}

export function removeFileRecords(ids: string[]): void {
  if (ids.length) run(`DELETE FROM files WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
}

/** A file the user may download (member of its conversation, or a reader of a public channel). */
export function fileFor(fileId: string, userId: number): { id: string; conversationId: string; name: string; mime: string; size: number } | null {
  const r = get("SELECT * FROM files WHERE id = ?", fileId);
  if (!r || !canReadConversation(strv(r.conversation_id), userId)) return null;
  return { id: strv(r.id), conversationId: strv(r.conversation_id), name: strv(r.name), mime: strv(r.mime), size: num(r.size) };
}
