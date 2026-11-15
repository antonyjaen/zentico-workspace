// Client-safe Chat types and helpers (no server imports here).
import type { AddressBook, Contact } from "@/lib/contacts";

export type ConversationKind = "dm" | "group" | "channel";
export type MessageKind = "text" | "meeting" | "system" | "file";

export type ChatUser = { id: number; name: string; email: string };

export type FileMeta = { id: string; name: string; mime: string; size: number };

export type MeetingMeta = {
  meetingId: number;
  code: string;
  type: "instant" | "scheduled";
  title?: string;
  /** Scheduled meetings: UTC instants (ms) and the organizer's time zone. */
  start?: number;
  end?: number;
  timeZone?: string;
  /** Epoch ms when someone marked the meeting as ended. */
  ended?: number;
  /** A calendar event with invitations was created. */
  calendar?: boolean;
};

export type SystemMeta = {
  action: "created" | "added" | "joined" | "left" | "renamed" | "removed";
  names?: string[];
  name?: string;
};

export type MessageMeta = { files?: FileMeta[]; meeting?: MeetingMeta; system?: SystemMeta };

export type Reaction = { emoji: string; users: number[] };

export type ChatMessage = {
  id: number;
  conversationId: string;
  author: ChatUser | null;
  body: string;
  created: number;
  edited: number | null;
  deleted: boolean;
  threadRoot: number | null;
  kind: MessageKind;
  meta: MessageMeta | null;
  reactions: Reaction[];
  replyCount: number;
  lastReplyAt: number | null;
};

export type ConversationSummary = {
  id: string;
  kind: ConversationKind;
  /** Display name (for DMs: the other person; for unnamed groups: the members). */
  name: string;
  /** Group/channel name as stored (null for DMs and unnamed groups). */
  rawName: string | null;
  teamId: string | null;
  isPrivate: boolean;
  /** Other person in a DM (for the avatar). */
  peer: ChatUser | null;
  memberCount: number;
  joined: boolean;
  unread: number;
  lastMessage: { preview: string; author: string | null; kind: MessageKind; created: number } | null;
  lastActivity: number;
};

export type TeamSummary = {
  id: string;
  name: string;
  description: string;
  role: "owner" | "member";
  channels: ConversationSummary[];
};

export type ChatOverview = { me: ChatUser; teams: TeamSummary[]; chats: ConversationSummary[] };

export type MeetingInfo = {
  id: number;
  code: string;
  type: "instant" | "scheduled";
  title: string;
  start: number;
  end: number | null;
  startedBy: ChatUser | null;
  messageId: number | null;
};

export type ConversationDetail = ConversationSummary & {
  description: string;
  teamName: string | null;
  members: (ChatUser & { role: "owner" | "member" })[];
  /** I may add people / rename (group members, team owners, channel creator). */
  canManage: boolean;
  /** Last read message id when the conversation was loaded (for the unread marker). */
  lastReadId: number;
  ongoing: MeetingInfo | null;
  upcoming: MeetingInfo[];
};

export type Person = { email: string; name: string };

/** Where a directory entry came from (principals are the real directory; the rest are fallbacks). */
export type DirectorySource = "directory" | "chat" | "contacts" | "mail";

/** One person of the organization: their mailboxes across the org's domains folded into one entry. */
export type DirectoryEntry = {
  /** Local part for org addresses (same person on every domain), otherwise the address. */
  key: string;
  name: string;
  /** Preferred address (the signed-in user's domain when the person has one there). */
  email: string;
  /** Every known address, preferred first. */
  emails: string[];
  /** Address to open a DM with (one already known to Chat when possible). */
  chatEmail: string;
  /** Stalwart principal id (for availability), when the directory exposes it. */
  principalId: string | null;
  /** A team mailbox (soporte@, facturas@…) rather than a person. */
  shared: boolean;
  source: DirectorySource;
};

export type PeopleData = {
  people: DirectoryEntry[];
  /** The server only shared part of the directory; the list was completed from other sources. */
  partial: boolean;
  /** Address-book contacts (null when the contacts service is unavailable). */
  contacts: Contact[] | null;
  books: AddressBook[];
  myDomain: string;
  orgDomains: string[];
};

export type DirectoryDiagnostics = {
  at: number;
  userId: number;
  principalsAccount: boolean;
  availability: boolean;
  /** Principals returned by Principal/query + get (all types). */
  principals: number;
  individuals: number;
  /** Individuals other than the signed-in user (any of their domains). */
  others: number;
  onlySelf: boolean;
  error: string | null;
  partial: boolean;
  fallback: { chat: number; contacts: number; mail: number; contactsError: string | null; mailError: string | null };
  orgDomains: string[];
  total: number;
};

export type BusyBlock = { start: number; end: number; status: string };

export type ChatEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "update"; message: ChatMessage }
  | { type: "typing"; conversationId: string; threadRoot: number | null; user: ChatUser }
  | { type: "read"; conversationId: string; lastReadId: number }
  | { type: "meeting"; conversationId: string }
  | { type: "conversations" };

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

export const PAGE_SIZE = 50;
export const BODY_MAX = 8000;
export const NAME_MAX = 80;
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢", "👀", "✅"] as const;
/** The "ongoing meeting" banner hides once the latest instant meeting is older than this. */
export const MEETING_LIVE_MS = 2 * 60 * 60 * 1000;
export const TYPING_TTL_MS = 5000;

export const CONVERSATION_ID = /^[a-z0-9]{16}$/;
export const isConversationId = (v: unknown): v is string => typeof v === "string" && CONVERSATION_ID.test(v);

/** Same-tab signal so the rail badge refreshes right after the chat app reads something. */
export const UNREAD_EVENT = "zw-chat-unread";

/** Deterministic two-hue gradient per person (matches the account menu avatar). */
export function avatarGradient(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 80)) % 360;
  return `linear-gradient(135deg, oklch(0.72 0.16 ${a}), oklch(0.62 0.18 ${b}))`;
}

export function initials(name: string): string {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const fileHref = (id: string, download = false) => `/api/chat/file/${id}${download ? "?download=1" : ""}`;

/** Image types we preview inline (no SVG: it can carry script). */
export const isPreviewableImage = (mime: string) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mime);
