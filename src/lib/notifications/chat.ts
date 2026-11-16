// Chat → notifications: who gets notified about a new message, a started meeting or being added
// to a conversation. Called by src/lib/chat/store.ts after it publishes; reads the Chat database
// directly (no store import, to keep the dependency one-way). Server-only.
import type { ChatMessage, ConversationKind } from "@/app/(apps)/chat/shared";
import { meetHref } from "@/app/(apps)/meet/shared";
import { all, get } from "../chat/db";
import { getPrefs, markReadByRef, notify } from "./store";

type Conv = { id: string; kind: ConversationKind; name: string | null; team_id: string | null; is_private: number };
type Reader = { id: number; email: string; member: boolean };

const num = (v: unknown) => Number(v ?? 0);
const strv = (v: unknown) => (typeof v === "string" ? v : "");

function loadConv(id: string): Conv | null {
  const r = get("SELECT id, kind, name, team_id, is_private FROM conversations WHERE id = ?", id);
  if (!r) return null;
  return {
    id: strv(r.id),
    kind: strv(r.kind) as ConversationKind,
    name: typeof r.name === "string" && r.name ? r.name : null,
    team_id: typeof r.team_id === "string" ? r.team_id : null,
    is_private: num(r.is_private),
  };
}

/** Everyone who can read the conversation (members; plus the team for public channels). Apps never get notifications. */
function readers(conv: Conv): Reader[] {
  const out = new Map<number, Reader>();
  for (const r of all(
    "SELECT u.id, u.email FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? AND u.bot_id IS NULL",
    conv.id,
  )) {
    out.set(num(r.id), { id: num(r.id), email: strv(r.email), member: true });
  }
  if (conv.kind === "channel" && !conv.is_private && conv.team_id) {
    for (const r of all("SELECT u.id, u.email FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ?", conv.team_id)) {
      if (!out.has(num(r.id))) out.set(num(r.id), { id: num(r.id), email: strv(r.email), member: false });
    }
  }
  return [...out.values()].filter((r) => r.email);
}

function groupName(conv: Conv, recipientId: number): string {
  if (conv.name) return conv.name;
  const names = all(
    "SELECT u.name, u.email FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? AND u.id != ? ORDER BY cm.joined LIMIT 4",
    conv.id,
    recipientId,
  ).map((r) => (strv(r.name) || strv(r.email)).split(/[\s@]/)[0]);
  return names.join(", ");
}

const MENTION = /(?<![\w@])@([a-z0-9][a-z0-9._-]*[a-z0-9])/gi;

function mentionedHandles(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION)) out.add(m[1].toLowerCase());
  return out;
}

function preview(m: ChatMessage): string {
  const files = [...(m.meta?.files ?? []), ...(m.meta?.drive ?? [])].map((f) => f.name).join(", ");
  const text = m.body.replace(/[*_`~>]/g, "").replace(/\s+/g, " ").trim();
  return (text || files || m.meta?.cards?.[0]?.title || "").slice(0, 200);
}

const chatHref = (convId: string) => `/chat?c=${convId}`;

/** Notifications for a newly posted message (text, file or an instant meeting card). */
export function onChatMessage(message: ChatMessage): void {
  try {
    if (message.deleted || message.kind === "system" || !message.author) return;
    const conv = loadConv(message.conversationId);
    if (!conv) return;
    const authorId = message.author.id;
    const author = message.author.name || message.author.email;
    const others = readers(conv).filter((r) => r.id !== authorId);
    if (!others.length) return;

    // A meeting started here: everyone who can read the conversation.
    if (message.kind === "meeting") {
      const meeting = message.meta?.meeting;
      // Calls ring the people instead (lib/chat/calls.ts); a missed one is notified there.
      if (!meeting || meeting.type !== "instant" || meeting.call) return;
      for (const r of others) {
        if (!r.member && conv.kind === "channel") continue;
        const where = conv.kind === "dm" ? "" : conv.kind === "channel" ? `#${conv.name ?? ""}` : groupName(conv, r.id);
        notify(r.email, {
          category: "meet",
          kind: "meeting",
          title: author,
          body: [meeting.title, where].filter(Boolean).join(" · "),
          href: meetHref(meeting.code),
          priority: "high",
          ref: conv.id,
          key: `meeting:${meeting.meetingId}`,
          once: true,
        });
      }
      return;
    }

    const body = preview(message);
    const handles = mentionedHandles(message.body);
    let threadPeople = new Set<number>();
    if (message.threadRoot !== null) {
      threadPeople = new Set(
        all(
          "SELECT DISTINCT author_id FROM messages WHERE (id = ? OR thread_root_id = ?) AND deleted = 0 AND author_id IS NOT NULL",
          message.threadRoot,
          message.threadRoot,
        ).map((r) => num(r.author_id)),
      );
    }

    for (const r of others) {
      const handle = r.email.split("@")[0]?.toLowerCase() ?? "";
      const mentioned = !!handle && handles.has(handle);
      const inThread = message.threadRoot !== null && threadPeople.has(r.id);
      const name = conv.kind === "channel" ? `#${conv.name ?? ""}` : conv.kind === "group" ? groupName(conv, r.id) : "";
      const title = name ? `${author} · ${name}` : author;
      const base = { category: "chat" as const, body, href: chatHref(conv.id), ref: conv.id };
      // Direct messages, group messages and mentions interrupt (in-app toast) like a chat app;
      // thread replies and channel chatter only land in the bell (or a desktop notification).
      const direct = { ...base, priority: "high" as const };

      if (mentioned) {
        notify(r.email, { ...direct, kind: "mention", title, key: `mention:${message.id}`, once: true });
      } else if (inThread) {
        notify(r.email, { ...base, kind: "reply", title, key: `thread:${message.threadRoot}` });
      } else if (message.threadRoot === null && r.member) {
        if (conv.kind === "dm") notify(r.email, { ...direct, kind: "dm", title, key: `chat:${conv.id}` });
        else if (conv.kind === "group") notify(r.email, { ...direct, kind: "group", title, key: `chat:${conv.id}` });
        else if (!getPrefs(r.email).channelMentionsOnly) notify(r.email, { ...base, kind: "channel", title, key: `chat:${conv.id}` });
      }
    }
  } catch (e) {
    console.error("[notifications] chat message:", e instanceof Error ? e.message : e);
  }
}

/** "X added you to <conversation>" for the people just added (not the person who added them). */
export function onAddedToConversation(convId: string, actorId: number, addedIds: number[]): void {
  try {
    const conv = loadConv(convId);
    if (!conv || conv.kind === "dm") return;
    const actor = get("SELECT name, email FROM users WHERE id = ?", actorId);
    const actorName = strv(actor?.name) || strv(actor?.email);
    for (const id of new Set(addedIds)) {
      if (id === actorId) continue;
      const u = get("SELECT email, bot_id FROM users WHERE id = ?", id);
      const email = strv(u?.email);
      if (!email || u?.bot_id != null) continue;
      notify(email, {
        category: "chat",
        kind: "added",
        title: actorName,
        body: conv.kind === "channel" ? `#${conv.name ?? ""}` : groupName(conv, id),
        href: chatHref(conv.id),
        ref: conv.id,
        key: `added:${conv.id}`,
        once: true,
      });
    }
  } catch (e) {
    console.error("[notifications] added:", e instanceof Error ? e.message : e);
  }
}

/** The user read a conversation: its chat notifications are read too. */
export function onConversationRead(convId: string, userId: number): void {
  const u = get("SELECT email FROM users WHERE id = ?", userId);
  const email = strv(u?.email);
  if (email) markReadByRef(email, convId, ["chat"]);
}
