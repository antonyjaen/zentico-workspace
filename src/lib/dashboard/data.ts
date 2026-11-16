// Read-only data queries for dashboard widgets (built-in and custom), run as the signed-in user.
// Backed by the same read tools as the MCP server (src/lib/mcp/*-tools.ts) with a read-only
// context, so every argument is validated there too. Server-only.
import { threadHref } from "@/app/(apps)/mail/hrefs";
import { nativeKind, openHref } from "@/app/(apps)/docs/shared";
import { DATA_QUERIES, DashError, isTimeZoneName, type DataQuery } from "@/app/(apps)/dashboard/model";
import { recentFiles, type DriveNode } from "@/lib/drive";
import type { Session } from "@/lib/session";
import { runTool } from "@/lib/mcp/tools";
import { docKind } from "@/lib/wopi";

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(args: Raw, keys: string[]) {
  for (const k of Object.keys(args)) if (!keys.includes(k)) throw new DashError(`Unknown argument "${k}" (allowed: ${keys.join(", ") || "none"})`);
}

function intArg(args: Raw, key: string, min: number, max: number, def: number): number {
  const v = args[key];
  if (v == null) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new DashError(`"${key}" must be an integer between ${min} and ${max}`);
  return v;
}

function strArg(args: Raw, key: string, max: number): string | undefined {
  const v = args[key];
  if (v == null || v === "") return undefined;
  if (typeof v !== "string" || v.length > max) throw new DashError(`"${key}" must be a string (max ${max} characters)`);
  return v;
}

function boolArg(args: Raw, key: string): boolean {
  const v = args[key];
  if (v == null) return false;
  if (typeof v !== "boolean") throw new DashError(`"${key}" must be true or false`);
  return v;
}

/** "YYYY-MM-DD" of today in `tz`, plus `days`. */
function dayIn(tz: string, days: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const MEET_LINK = /\/meet\/([a-z0-9-]{3,64})\b/;

type ToolEvent = { id: string; title: string; start: string; end: string; allDay?: boolean; location?: string; description?: string; attendees?: string[]; myStatus?: string };

async function tool(session: Session, name: string, args: Raw): Promise<Raw> {
  const out = await runTool(name, args, { session, scope: "read", tokenName: "dashboard", tokenExpires: null, commandId: null });
  if (!out.ok) throw new DashError(out.error);
  return (out.value ?? {}) as Raw;
}

const calHref = (start: string) => `/calendar?view=day&date=${start.slice(0, 10)}`;

function compactEvent(e: ToolEvent) {
  const link = MEET_LINK.exec(`${e.location ?? ""} ${e.description ?? ""}`);
  return {
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: !!e.allDay,
    location: e.location ?? null,
    attendees: e.attendees?.length ?? 0,
    declined: e.myStatus === "declined",
    href: calHref(e.start),
    meetHref: link ? `/meet/${link[1]}` : null,
  };
}

async function events(session: Session, tz: string, days: number, limit: number) {
  const r = await tool(session, "calendar_list_events", { start: dayIn(tz, 0), end: dayIn(tz, days), timeZone: tz, limit: 200 });
  return { timeZone: tz, events: ((r.events as ToolEvent[]) ?? []).slice(0, limit).map(compactEvent), all: (r.events as ToolEvent[]) ?? [] };
}

const driveItem = (n: { id: string; name: string; folder?: boolean; isFolder?: boolean; type?: string; size?: number; modified?: string | null }) => {
  const folder = !!(n.folder ?? n.isFolder);
  return {
    id: n.id,
    name: n.name,
    folder,
    type: folder ? null : (n.type ?? null),
    size: folder ? null : (n.size ?? null),
    modified: n.modified ?? null,
    href: folder
      ? `/drive?folder=${encodeURIComponent(n.id)}`
      : nativeKind(n.name) || docKind(n.name)
        ? openHref(n.id, n.name, "drive")
        : `/api/drive/file/${encodeURIComponent(n.id)}?inline=1`,
  };
};

/** Runs a whitelisted query. Throws DashError for invalid input or a failing source. */
export async function runQuery(session: Session, name: DataQuery, rawArgs: unknown, timeZone: string | null): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(DATA_QUERIES, name)) throw new DashError("Unknown query");
  const args = rawArgs == null ? {} : rawArgs;
  if (!isObj(args)) throw new DashError("Arguments must be an object");
  const tz = timeZone && isTimeZoneName(timeZone) ? timeZone : "UTC";

  switch (name) {
    case "calendar.events": {
      onlyKeys(args, ["days", "limit"]);
      const { timeZone: zone, events: list } = await events(session, tz, intArg(args, "days", 1, 14, 3), intArg(args, "limit", 1, 50, 12));
      return { timeZone: zone, events: list };
    }
    case "meetings.upcoming": {
      onlyKeys(args, ["days", "limit"]);
      const limit = intArg(args, "limit", 1, 20, 5);
      const { all } = await events(session, tz, intArg(args, "days", 1, 14, 7), 200);
      const now = Date.now();
      const items = all
        .filter((e) => !e.allDay && Date.parse(e.end) > now && ((e.attendees?.length ?? 0) > 1 || MEET_LINK.test(`${e.location ?? ""} ${e.description ?? ""}`)))
        .slice(0, limit)
        .map(compactEvent);
      return { timeZone: tz, events: items };
    }
    case "meetings.recordings": {
      onlyKeys(args, ["limit"]);
      const r = await tool(session, "meetings_list", { limit: intArg(args, "limit", 1, 20, 5) });
      const list = (r.meetings as { id: string; title: string; startedAt: number | string; durationMinutes?: number; status: string; url?: string }[]) ?? [];
      return {
        items: list.map((m) => ({
          id: m.id,
          title: m.title,
          startedAt: m.startedAt,
          durationMinutes: m.durationMinutes ?? null,
          status: m.status,
          href: `/meet/recordings/${encodeURIComponent(m.id)}`,
        })),
      };
    }
    case "mail.search": {
      onlyKeys(args, ["query", "folder", "unreadOnly", "limit"]);
      const query = strArg(args, "query", 200);
      const folder = strArg(args, "folder", 100);
      const r = await tool(session, "mail_search", { query, folder, unread: boolArg(args, "unreadOnly") || undefined, limit: intArg(args, "limit", 1, 50, 8) });
      const list =
        (r.conversations as { threadId: string; emailId: string; from: string[]; subject: string; preview: string; receivedAt: string; unread?: boolean; flagged?: boolean; messages: number }[]) ??
        [];
      return {
        total: r.total ?? list.length,
        items: list.map((c) => ({
          threadId: c.threadId,
          from: (c.from?.[0] ?? "").replace(/\s*<[^>]*>$/, ""),
          subject: c.subject,
          preview: c.preview,
          receivedAt: c.receivedAt,
          unread: !!c.unread,
          flagged: !!c.flagged,
          messages: c.messages,
          href: threadHref("search", c.threadId),
        })),
      };
    }
    case "chat.conversations": {
      onlyKeys(args, ["unreadOnly", "limit"]);
      const r = await tool(session, "chat_list_conversations", { unreadOnly: boolArg(args, "unreadOnly"), limit: intArg(args, "limit", 1, 50, 8) });
      const list =
        (r.conversations as { id: string; kind: string; name: string; team?: string; unread?: number; lastMessage?: { author: string; preview: string; at: string } }[]) ?? [];
      return {
        items: list
          .sort((a, b) => (b.lastMessage?.at ?? "").localeCompare(a.lastMessage?.at ?? ""))
          .map((c) => ({ id: c.id, kind: c.kind, name: c.name, team: c.team ?? null, unread: c.unread ?? 0, lastMessage: c.lastMessage ?? null, href: `/chat?c=${encodeURIComponent(c.id)}` })),
      };
    }
    case "chat.messages": {
      onlyKeys(args, ["conversationId", "limit"]);
      const conversationId = strArg(args, "conversationId", 64);
      if (!conversationId) throw new DashError('"conversationId" is required');
      const limit = intArg(args, "limit", 1, 50, 8);
      const r = await tool(session, "chat_read_messages", { conversationId });
      const list = (r.messages as { id: number; author: string | null; at: string; body: string; kind?: string }[]) ?? [];
      return {
        conversationId,
        href: `/chat?c=${encodeURIComponent(conversationId)}`,
        items: list.slice(-limit).map((m) => ({ id: m.id, author: m.author, at: m.at, body: String(m.body ?? "").slice(0, 500), kind: m.kind ?? "text" })),
      };
    }
    case "drive.recent": {
      onlyKeys(args, ["limit"]);
      const limit = intArg(args, "limit", 1, 50, 10);
      const nodes: DriveNode[] = await recentFiles(limit);
      return { items: nodes.slice(0, limit).map((n) => driveItem({ ...n, folder: n.isFolder })) };
    }
    case "drive.folder": {
      onlyKeys(args, ["folderId", "limit"]);
      const folderId = strArg(args, "folderId", 255);
      if (!folderId) throw new DashError('"folderId" is required');
      const limit = intArg(args, "limit", 1, 50, 10);
      const r = await tool(session, "drive_list", { folderId, limit });
      const list = (r.entries as { id: string; name: string; folder?: boolean; type?: string; size?: number; modified?: string }[]) ?? [];
      return { folderId, href: `/drive?folder=${encodeURIComponent(folderId)}`, total: r.total ?? list.length, items: list.map(driveItem) };
    }
  }
}
