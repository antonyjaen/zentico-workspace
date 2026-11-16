// Client-safe notification types, preferences and helpers (no server imports here).

export type NotificationCategory = "chat" | "meet" | "mail" | "calendar" | "claude";

/**
 * What happened. chat: dm, group, channel (any channel message), mention, reply (thread I'm in),
 * added (to a conversation); meet: meeting (started in one of my conversations); mail: mail,
 * mailBatch (several at once; title is the count);
 * calendar: reminder, invite; claude: done, failed, confirm.
 */
export type NotificationKind =
  | "dm"
  | "group"
  | "channel"
  | "mention"
  | "reply"
  | "added"
  | "meeting"
  | "mail"
  | "mailBatch"
  | "reminder"
  | "invite"
  | "done"
  | "failed"
  | "confirm";

export type AppNotification = {
  id: string;
  category: NotificationCategory;
  kind: NotificationKind;
  title: string;
  body: string;
  /** In-app path to open (always starts with "/"). */
  href: string;
  /** Interrupts with an in-app toast while the app is visible. */
  priority: "high" | "normal";
  /** What it is about, for "already looking at it": a conversation id, meeting room or mail thread. */
  ref: string | null;
  /** Coalesced events (e.g. several messages in the same chat while unread). */
  count: number;
  created: number;
  read: boolean;
};

export type NotificationPrefs = {
  chat: boolean;
  /** Channels only notify @mentions and replies in my threads (otherwise every message). */
  channelMentionsOnly: boolean;
  mail: boolean;
  calendar: boolean;
  meetings: boolean;
  claude: boolean;
  desktop: boolean;
  sound: boolean;
  /** Epoch ms; no desktop notifications, toasts or sounds until then. 0 = off. */
  dndUntil: number;
};

export const DEFAULT_PREFS: NotificationPrefs = {
  chat: true,
  channelMentionsOnly: true,
  mail: true,
  calendar: true,
  meetings: true,
  claude: true,
  desktop: false,
  sound: false,
  dndUntil: 0,
};

const BOOL_PREFS = ["chat", "channelMentionsOnly", "mail", "calendar", "meetings", "claude", "desktop", "sound"] as const;
export const DND_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** Validates untrusted input into a full prefs object (unknown keys dropped, bad values defaulted). */
export function parsePrefs(input: unknown, base: NotificationPrefs = DEFAULT_PREFS): NotificationPrefs {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: NotificationPrefs = { ...base };
  for (const k of BOOL_PREFS) if (typeof src[k] === "boolean") out[k] = src[k] as boolean;
  if (typeof src.dndUntil === "number" && Number.isFinite(src.dndUntil)) {
    const v = Math.round(src.dndUntil);
    out.dndUntil = v <= Date.now() ? 0 : Math.min(v, Date.now() + DND_MAX_MS);
  }
  return out;
}

/** Which preference switches a kind of notification on or off. */
export function prefAllows(prefs: NotificationPrefs, category: NotificationCategory): boolean {
  switch (category) {
    case "chat":
      return prefs.chat;
    case "meet":
      return prefs.meetings;
    case "mail":
      return prefs.mail;
    case "calendar":
      return prefs.calendar;
    case "claude":
      return prefs.claude;
  }
}

/** Server → browser events on /api/notifications/stream. */
export type NotifyEvent =
  | { type: "notification"; notification: AppNotification }
  | { type: "read"; ids: string[] }
  | { type: "readAll" }
  | { type: "prefs"; prefs: NotificationPrefs };

export type NotificationsResponse = { items: AppNotification[]; unread: number; prefs: NotificationPrefs };

/** One upcoming event for client-side reminders (GET /api/notifications/upcoming). */
export type UpcomingEvent = {
  id: string;
  title: string;
  start: number;
  /** Minutes before start (event alerts, or the default). */
  alerts: number[];
  /** Day of the event in the calendar's time zone (YYYY-MM-DD), for the link. */
  date: string;
  /** Meet room linked from the event, if any. */
  meet: string | null;
};

export const LIST_LIMIT = 50;
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_REMINDER_MIN = 10;
