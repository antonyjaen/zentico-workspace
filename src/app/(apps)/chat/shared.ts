// Client-safe Chat types and helpers (no server imports here).
import type { AddressBook, Contact } from "@/lib/contacts";

export type ConversationKind = "dm" | "group" | "channel";
export type MessageKind = "text" | "meeting" | "system" | "file";

/**
 * Apps and bots are chat users too (a `users` row with a synthetic address on BOT_EMAIL_DOMAIN):
 * "http" = an HTTP app with an endpoint (Settings → Apps & bots), "webhook" = an incoming webhook
 * of one conversation, "claude" = a person's own Claude (runs on their bridge, only obeys them),
 * "builtin" = an app that ships with Zentico (e.g. GitHub, acting with each person's own connection).
 */
export type BotKind = "http" | "webhook" | "claude" | "builtin";
export type BuiltinApp = "github";
export type BotCommand = { name: string; description: string };
export type BotInfo = {
  id: string;
  kind: BotKind;
  description: string;
  /** Avatar hue (0-359); null = derived from the name. */
  color: number | null;
  /** Optional emoji shown instead of the initials. */
  avatar: string | null;
  ownerId: number;
  ownerName: string;
  /** HTTP and built-in apps: slash commands. */
  commands?: BotCommand[];
  /** Built-in apps: which one. */
  app?: BuiltinApp;
  /** Deleted apps keep their identity on old messages. */
  deleted?: boolean;
};

export type ChatUser = { id: number; name: string; email: string; bot?: BotInfo };

/** Domain of the synthetic addresses of app/bot users (.invalid never resolves or receives mail). */
export const BOT_EMAIL_DOMAIN = "apps.zentico.invalid";
export const isBotEmail = (email: string) => email.toLowerCase().endsWith(`@${BOT_EMAIL_DOMAIN}`);

/** A link button on a bot card (http/https only). */
export type CardButton = { text: string; url: string };
/** Normalized subset of Google Chat cards (cards / cardsV2): header + sections of text and link buttons. */
export type BotCard = {
  title?: string;
  subtitle?: string;
  sections: { header?: string; text?: string; buttons?: CardButton[] }[];
};

/** Ephemeral notices from apps (localized on the client). */
export type NoticeMeta =
  | { code: "claudeOwnerOnly"; owner: string }
  | { code: "claudeWorking" }
  | { code: "claudeQueued" }
  | { code: "claudeNoToken" }
  | { code: "claudeFailed"; error: string }
  /** Built-in apps (Connected apps). `provider` is a provider name such as "GitHub". */
  | { code: "connectRequired"; provider: string }
  | { code: "githubUsage" }
  | { code: "githubSubscribed"; repo: string }
  | { code: "githubUnsubscribed"; repo: string }
  | { code: "githubNotSubscribed"; repo: string }
  | { code: "githubSubscriptions"; repos: string[] }
  | { code: "appError"; error: string };

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

/**
 * A Drive file or folder posted in a conversation (a `file` message with `meta.drive`). Name,
 * type and size are a snapshot from when it was sent; viewers re-resolve it with their own rights.
 */
export type DriveRef = {
  source: "drive";
  /** Owning JMAP account (always the real id, never null). */
  accountId: string;
  fileId: string;
  name: string;
  mediaType: string;
  size: number;
  isFolder: boolean;
  /** Owner's display name when it was sent (account name, or the sender for their own drive). */
  owner?: string;
};

export type MessageMeta = {
  files?: FileMeta[];
  drive?: DriveRef[];
  meeting?: MeetingMeta;
  system?: SystemMeta;
  /** Cards posted by an app or webhook. */
  cards?: BotCard[];
  /** Ephemeral app notice (never stored). */
  notice?: NoticeMeta;
};

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
  /** Shown only to one person and never stored (its id is fractional: it sorts after the last message). */
  ephemeral?: boolean;
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

export type Person = { email: string; name: string; bot?: BotInfo };

/**
 * Stalwart principals often carry the address as their name; turn "leo.park@x" into
 * "Leo Park" so people read like people. Real names are kept.
 */
export function readableName(name: string | null | undefined, email: string): string {
  const n = (name ?? "").trim();
  if (n && !n.includes("@")) return n;
  const local = email.split("@")[0] ?? email;
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || email
  );
}

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
  | { type: "conversations" }
  /** Something changed about my Claude's commands in a conversation (e.g. a write awaits my approval). */
  | { type: "claude"; conversationId: string };

/** GET /api/chat/claude?c=… : my Claude's running commands and approvals waiting in a conversation. */
export type ClaudeChatState = {
  commands: { id: string; text: string; status: string; progress: string | null }[];
  confirmations: { id: string; commandId: string; tool: string; summary: string; expiresAt: number }[];
};

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
/** Same-tab request (detail: conversation id) to open a conversation in the mounted Chat app. */
export const OPEN_CONVERSATION_EVENT = "zw-chat-open";

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

// ---------- Drive files in Chat ----------

export const MAX_DRIVE_PICKS = 10;
const DRIVE_ID = /^[A-Za-z0-9_-]{1,255}$/;
export const isDriveId = (v: unknown): v is string => typeof v === "string" && DRIVE_ID.test(v);

/** A file or folder picked in the Drive picker / Drive's "Send in Chat" (accountId null = my drive). */
export type DrivePick = { accountId: string | null; fileId: string };

/** One row of the Drive picker. */
export type DrivePickItem = {
  id: string;
  /** Owning account (real id). */
  accountId: string;
  name: string;
  isFolder: boolean;
  type: string;
  size: number;
  modified: string | null;
  /** Folder path ("Projects / 2026"); null = top level. */
  location: string | null;
  /** Owner for items outside my drive; null = me. */
  owner: string | null;
};

export type DriveBrowse = { items: DrivePickItem[]; path: { id: string; name: string }[] };

/** Who in a conversation can't open the picked files (computed by the server with the sender's view). */
export type DriveAccessCheck = {
  /** False when the server doesn't report grants (no access step then). */
  supported: boolean;
  files: {
    accountId: string;
    fileId: string;
    name: string;
    isFolder: boolean;
    /** The sender may change grants (myRights.mayShare). */
    canShare: boolean;
    /** Members who can't open it (and can be granted access). */
    missing: { id: number; name: string }[];
    /** Members without access who aren't in the Drive directory (can't be granted here). */
    unknown: { id: number; name: string }[];
  }[];
};

export type DriveGrant = "viewer" | "editor" | "none";

/** A Drive card as the viewer sees it (resolved with their own rights). */
export type DriveCardData =
  | { ok: true; ref: DriveRef; mine: boolean; modified: string | null }
  | { ok: false; reason: "noAccess" };

/** Universal open link: the server sends each viewer to the right editor, folder or preview. */
export const driveOpenHref = (r: { accountId: string | null; fileId: string }) =>
  `/api/chat/drive/open?${new URLSearchParams({ ...(r.accountId ? { account: r.accountId } : {}), id: r.fileId })}`;

export const driveDownloadHref = (r: { accountId: string | null; fileId: string }) =>
  `/api/drive/file/${encodeURIComponent(r.fileId)}${r.accountId ? `?account=${encodeURIComponent(r.accountId)}` : ""}`;

/** Hosts whose links unfurl into Drive cards (besides the current origin). */
export const DRIVE_LINK_HOSTS = ["team.zentico.dev"];

const DRIVE_PATH = /^\/(?:drive|docs\/(?:edit|md|draw)\/[^/]+|api\/drive\/file\/[^/]+|api\/chat\/drive\/open)$/;

/** Links in a message body that may point at Drive files/folders (at most 3, deduplicated). */
export function driveLinksIn(body: string, currentHost?: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/https?:\/\/[^\s<>"()\]]+/g)) {
    const raw = m[0].replace(/[.,;:!?'*_~]+$/, "");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (!(DRIVE_LINK_HOSTS.includes(u.host) || (currentHost && u.host === currentHost))) continue;
    if (!DRIVE_PATH.test(u.pathname)) continue;
    if (u.pathname === "/drive" && !u.searchParams.get("folder") && !u.searchParams.get("preview")) continue;
    if (u.pathname === "/api/chat/drive/open" && !u.searchParams.get("id")) continue;
    if (!out.includes(u.toString())) out.push(u.toString());
    if (out.length === 3) break;
  }
  return out;
}

/** Image types we preview inline (no SVG: it can carry script). */
export const isPreviewableImage = (mime: string) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mime);
