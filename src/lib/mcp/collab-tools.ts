// Chat and Meet tools: conversations, messages, reactions, teams, Drive cards in chat, meeting
// rooms, recordings and transcripts. Chat and recordings are loaded lazily (see optional.ts), so
// the MCP server keeps working where those modules aren't available.
import { REACTIONS, type DrivePick } from "@/app/(apps)/chat/shared";
import type { MeetingSummary as RecordingSummary } from "@/app/(apps)/meet/recording";
import { generateRoomCode } from "@/app/(apps)/meet/shared";
import { getEvents, getRawEvent, normalizeEvent, type CalEvent } from "../calendar";
import { bool, id, int, oneOf, str, strList, ToolError, truncate } from "./args";
import { localIso, userTimeZone } from "./calendar-tools";
import { A, appUrl, B, fold, I, iso, personName, S, type Tool } from "./kit";
import {
  chatError,
  loadChat,
  loadMeetings,
  type ChatMsg,
  type ChatSummary,
  type MeetingSummary,
  type TranscriptSegment,
} from "./optional";

/** Chat's server modules, loaded on demand (they open the Chat database). */
async function chatModules() {
  try {
    const [store, session, directory, drive] = await Promise.all([
      import("@/lib/chat/store"),
      import("@/lib/chat/session"),
      import("@/lib/chat/directory"),
      import("@/lib/chat/drive"),
    ]);
    return { store, directory, drive, me: await session.chatUser() };
  } catch (e) {
    if (e instanceof ToolError) throw e;
    console.error("[mcp] chat modules:", e instanceof Error ? e.message : e);
    throw new ToolError("Chat is not available on this server.");
  }
}

const chatUrl = (conversationId: string) => `${appUrl()}/chat?c=${encodeURIComponent(conversationId)}`;

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

const compactMsg = (m: ChatMsg) => {
  const bot = m.author?.bot;
  const cards = (m.meta as { cards?: unknown[] } | null | undefined)?.cards;
  return {
    id: m.id,
    author: m.author ? m.author.name || m.author.email : null,
    // Apps, webhooks and people's Claude bots post too: say so (they are not people).
    authorType: bot ? (bot.kind === "webhook" ? "webhook" : bot.kind === "claude" ? `claude bot of ${bot.ownerName}` : "app") : undefined,
    at: iso(m.created),
    kind: m.kind !== "text" ? m.kind : undefined,
    body: m.deleted ? "(deleted)" : m.body,
    cards: !m.deleted && cards?.length ? cards : undefined,
    edited: m.edited ? true : undefined,
    threadRoot: m.threadRoot ?? undefined,
    replies: m.replyCount || undefined,
    meta: m.kind === "text" || m.deleted ? undefined : m.meta,
  };
};

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
  videoStatus: m.video?.status ?? undefined,
  videoError: m.video?.error ?? undefined,
  videoFileId: m.video?.fileId ?? undefined,
  url: m.url ? (m.url.startsWith("/") ? `${appUrl()}${m.url}` : m.url) : undefined,
});

const REACTION_NAMES: Record<string, string> = {
  thumbsup: "👍",
  "+1": "👍",
  like: "👍",
  heart: "❤️",
  love: "❤️",
  laugh: "😂",
  joy: "😂",
  tada: "🎉",
  party: "🎉",
  wow: "😮",
  sad: "😢",
  eyes: "👀",
  check: "✅",
  done: "✅",
};

/** Speaker-labelled transcript lines from `offset`, up to about `maxChars`; `next` = first line not returned. */
function transcriptPage(segments: TranscriptSegment[], offset: number, maxChars: number): { text: string; next: number | null } {
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
  return { text: lines.join("\n"), next: i < segments.length ? i : null };
}

export const CHAT_TOOLS: Tool[] = [
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
        const m = chat.postMessage(convId, me.id, { body, threadRoot, fromAgent: true });
        return { posted: true, message: compactMsg(m) };
      } catch (e) {
        chatError(e);
      }
    },
  },
  {
    name: "chat_create_conversation",
    description:
      "Starts a chat: one person → your direct message with them (reused if it exists); several people (or a name) → a new group chat. People are colleagues from the directory, by email or name.",
    inputSchema: {
      type: "object",
      properties: {
        people: A("Colleagues to chat with (emails or names from directory_search)."),
        name: S("Group name (optional; makes a group even with one person)."),
      },
      required: ["people"],
    },
    write: true,
    async run(args) {
      const wanted = strList(args, "people", { max: 100, itemMax: 320 });
      if (!wanted.length) throw new ToolError('"people" is required');
      const groupName = str(args, "name", { max: 80 })?.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim() || null;
      const { store, directory, me } = await chatModules();
      try {
        const r = await directory.loadDirectory(me);
        const entries = directory.foldPeople(r.people, new Set(r.orgDomains), directory.domainOf(me.email)).filter((p) => !p.shared);
        const picked = new Map<string, { email: string; name: string }>();
        for (const w of wanted) {
          const lw = w.trim().toLowerCase().replace(/^.*<([^>]+)>\s*$/, "$1");
          const fw = fold(w);
          const hits = lw.includes("@")
            ? entries.filter((p) => p.emails.some((e) => e.toLowerCase() === lw))
            : entries.filter((p) => fold(p.name) === fw || fold(p.key) === fw || p.emails.some((e) => e.toLowerCase().startsWith(`${lw}@`)));
          if (!hits.length) throw new ToolError(`"${w}" is not in the directory (try directory_search)`);
          if (hits.length > 1) throw new ToolError(`"${w}" matches several people: ${hits.map((h) => h.email).join(", ")}`);
          const p = hits[0];
          if (p.emails.includes(me.email)) continue;
          picked.set(p.chatEmail, { email: p.chatEmail, name: personName(p.name, p.email) });
        }
        if (!picked.size) throw new ToolError("Pick at least one other person");
        const ids = store.ensureUsers([...picked.values()]);
        const conversationId = ids.length === 1 && !groupName ? store.openDm(me.id, ids[0]) : store.createGroup(me.id, ids, groupName);
        const conv = store.detail(conversationId, me.id);
        return {
          conversationId,
          kind: conv.kind,
          name: conv.name,
          members: conv.members.map((m) => m.name || m.email),
          url: chatUrl(conversationId),
        };
      } catch (e) {
        chatError(e);
      }
    },
  },
  {
    name: "chat_list_teams",
    description:
      "Lists your teams and their channels (public channels you haven't joined included, with joined=false). Read a channel with chat_read_messages.",
    inputSchema: { type: "object", properties: { query: S("Only teams or channels whose name contains this text.") } },
    async run(args) {
      const { store, me } = await chatModules();
      const q = fold(str(args, "query", { max: 200 }) ?? "");
      try {
        const teams = store.overview(me).teams.map((t) => {
          const teamHit = !q || fold(t.name).includes(q);
          return {
            id: t.id,
            name: t.name,
            description: t.description || undefined,
            role: t.role,
            channels: t.channels
              .filter((c) => teamHit || fold(c.name).includes(q))
              .map((c) => ({
                id: c.id,
                name: c.name,
                private: c.isPrivate || undefined,
                voice: c.mode === "voice" || undefined,
                connected: c.mode === "voice" && c.voice?.length ? c.voice.map((p) => p.name) : undefined,
                joined: c.joined ? undefined : false,
                members: c.memberCount,
                unread: c.unread || undefined,
                lastActivity: c.lastActivity ? iso(c.lastActivity) : undefined,
              })),
          };
        });
        return { teams: teams.filter((t) => !q || fold(t.name).includes(q) || t.channels.length) };
      } catch (e) {
        chatError(e);
      }
    },
  },
  {
    name: "chat_react",
    description: `Adds (or with remove=true, removes) your emoji reaction on a chat message. Emoji: ${REACTIONS.join(" ")} (or thumbsup, heart, laugh, tada, wow, sad, eyes, check).`,
    inputSchema: {
      type: "object",
      properties: {
        messageId: I("Message id (from chat_read_messages).", 1, Number.MAX_SAFE_INTEGER),
        emoji: S("One of the supported emoji or its name.", { enum: [...REACTIONS, ...Object.keys(REACTION_NAMES)] }),
        remove: B("Remove your reaction instead."),
      },
      required: ["messageId", "emoji"],
    },
    write: true,
    async run(args) {
      if (args.messageId == null) throw new ToolError('"messageId" is required');
      const messageId = int(args, "messageId", { min: 1, max: Number.MAX_SAFE_INTEGER, def: 1 });
      const raw = str(args, "emoji", { required: true, max: 20 }).trim();
      const emoji = REACTION_NAMES[raw.toLowerCase()] ?? raw;
      if (!(REACTIONS as readonly string[]).includes(emoji)) throw new ToolError(`Unsupported emoji. Use one of: ${REACTIONS.join(" ")}`);
      const remove = bool(args, "remove");
      const { store, me } = await chatModules();
      try {
        const m = store.readableMessage(messageId, me.id);
        if (!m) throw new ToolError("Message not found");
        const mine = m.reactions.some((r) => r.emoji === emoji && r.users.includes(me.id));
        const next = mine === !remove ? m : store.toggleReaction(messageId, me.id, emoji);
        return {
          messageId,
          emoji,
          reacted: !remove,
          reactions: next.reactions.map((r) => `${r.emoji} ${r.users.length}`),
        };
      } catch (e) {
        chatError(e);
      }
    },
  },
  {
    name: "chat_share_drive_file",
    description:
      'Shares Drive files or folders in a chat as file cards. First checks who in the conversation can\'t open them: if someone lacks access and `grant` is not set, nothing is posted and the result lists them — ask the user, then call again with grant="viewer" or "editor" (grants access to those members on files you may share) or grant="none" (post anyway).',
    inputSchema: {
      type: "object",
      properties: {
        conversationId: S("Conversation id."),
        fileIds: A("Drive file or folder ids (max 10)."),
        accountId: S("Shared space / account of the files (omit for My Drive)."),
        message: S("Optional message posted with the first card."),
        grant: S('Access for members who lack it: "viewer", "editor" or "none".', { enum: ["viewer", "editor", "none"] }),
        threadRootId: I("Post in the thread of this message id.", 1, Number.MAX_SAFE_INTEGER),
      },
      required: ["conversationId", "fileIds"],
    },
    write: true,
    async run(args) {
      const convId = str(args, "conversationId", { required: true, max: 64 });
      if (!CONV_ID.test(convId)) throw new ToolError('"conversationId" is not valid');
      const accountId = id(args, "accountId") ?? null;
      const fileIds = strList(args, "fileIds", { max: 10, itemMax: 255 });
      if (!fileIds.length) throw new ToolError('"fileIds" is required');
      for (const f of fileIds) if (!/^[A-Za-z0-9_-]{1,255}$/.test(f)) throw new ToolError(`Invalid file id "${f}"`);
      const grant = args.grant == null ? null : oneOf(args, "grant", ["viewer", "editor", "none"] as const, "none");
      const body = (str(args, "message", { max: CHAT_BODY_MAX }) ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").trim();
      const threadRoot = args.threadRootId == null ? null : int(args, "threadRootId", { min: 1, max: Number.MAX_SAFE_INTEGER, def: 1 });
      const { store, drive, me } = await chatModules();
      try {
        if (!store.detail(convId, me.id).joined) throw new ToolError("You are not a member of this conversation");
        const picks: DrivePick[] = fileIds.map((fileId) => ({ accountId, fileId }));
        const checked = await drive.checkAccess(me, convId, picks);
        const files = checked.check.files.map((f) => ({
          name: f.name,
          fileId: f.fileId,
          youCanShare: f.canShare,
          missingAccess: f.missing.length ? f.missing.map((m) => m.name) : undefined,
          notInDirectory: f.unknown.length ? f.unknown.map((m) => m.name) : undefined,
        }));
        const someoneMissing = checked.check.files.some((f) => f.missing.length);
        if (someoneMissing && grant === null) {
          return {
            posted: false,
            needsAccessDecision: true,
            files,
            hint: 'Some members can\'t open these. Ask the user, then call again with grant="viewer" or "editor" to give them access, or grant="none" to post anyway.',
          };
        }
        const grantFailed = grant && grant !== "none" && someoneMissing ? await drive.grantMissing(checked, grant) : 0;
        const messages = checked.located.map((l, i) =>
          store.postMessage(convId, me.id, { body: i === 0 ? body : "", drive: [drive.refOf(l, me)], threadRoot, fromAgent: true }),
        );
        return {
          posted: true,
          messageIds: messages.map((m) => m.id),
          granted: grant && grant !== "none" && someoneMissing ? grant : undefined,
          grantFailed: grantFailed || undefined,
          files: someoneMissing ? files : undefined,
          url: chatUrl(convId),
        };
      } catch (e) {
        if (e instanceof Error && e.message === "driveNotFound") throw new ToolError("A file was not found (check fileIds and accountId)");
        chatError(e);
      }
    },
  },
];

export const MEETING_TOOLS: Tool[] = [
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
      const { text, next } = transcriptPage(segments, offset, maxChars);
      return { meeting, lines: segments.length, nextOffset: next, transcript: text };
    },
  },
  {
    name: "meet_create_room",
    description:
      "Creates a new Zentico Meet video room and returns its link (anyone in the workspace with the link can join). Share it with chat_post_message, mail or a calendar event.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const code = generateRoomCode();
      return { room: code, url: `${appUrl()}/meet/${code}` };
    },
  },
  {
    name: "meetings_get_summary_inputs",
    description:
      "Everything needed to summarize a recorded meeting in one call: title, times, duration, participants and speakers, the transcript (speaker-labelled lines), the linked Chat conversation (with its meeting-thread messages) and the linked calendar event (agenda, attendees).",
    inputSchema: {
      type: "object",
      properties: {
        meetingId: S("Meeting id (from meetings_list)."),
        maxTranscriptChars: I("Transcript budget; continue with meetings_get_transcript from nextOffset.", 1000, 500_000, 150_000),
        timeZone: S('IANA time zone for times. Default: your calendar time zone.'),
      },
      required: ["meetingId"],
    },
    async run(args, ctx) {
      const meetingId = str(args, "meetingId", { required: true, max: 128 });
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(meetingId)) throw new ToolError('"meetingId" is not valid');
      const maxChars = int(args, "maxTranscriptChars", { min: 1000, max: 500_000, def: 150_000 });
      const tzArg = str(args, "timeZone", { max: 64 });
      const tz = tzArg ?? (await userTimeZone());
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
      } catch {
        throw new ToolError(`Unknown time zone "${tz}"`);
      }
      const meetings = await loadMeetings();
      const result = (await meetings.getTranscript(meetingId, ctx.session.email)) as
        | { meeting: RecordingSummary; segments?: TranscriptSegment[]; markdown?: string }
        | null;
      if (!result?.meeting) throw new ToolError("Meeting not found");
      const m = result.meeting;
      const segments = Array.isArray(result.segments) ? result.segments : [];
      const startMs = Date.parse(m.startedAt);
      const endMs = m.endedAt ? Date.parse(m.endedAt) : null;

      let transcript: { text: string; nextOffset: number | null; lines?: number };
      if (segments.length) {
        const { text, next } = transcriptPage(segments, 0, maxChars);
        transcript = { text, nextOffset: next, lines: segments.length };
      } else {
        const md = typeof result.markdown === "string" ? result.markdown : "";
        transcript = { text: md.slice(0, maxChars), nextOffset: md.length > maxChars ? maxChars : null };
      }

      // Linked Chat meeting (the room's meeting card) and calendar event, best effort.
      let chat: Record<string, unknown> | undefined;
      let eventId: string | null = null;
      try {
        const { chatMeetingFor } = await import("@/lib/meetings/chat-link");
        const link = m.room ? chatMeetingFor(m.room) : null;
        if (link) {
          eventId = link.calendarEventId;
          const { store, me } = await chatModules();
          if (store.canReadConversation(link.conversationId, me.id)) {
            const conv = store.detail(link.conversationId, me.id);
            const thread = link.messageId ? store.listThread(link.messageId, me.id).replies.slice(-50) : [];
            chat = {
              conversationId: conv.id,
              name: conv.name,
              kind: conv.kind,
              meetingTitle: link.title || undefined,
              threadMessages: thread.length ? thread.map((x) => compactMsg(x as unknown as ChatMsg)) : undefined,
              url: chatUrl(conv.id),
            };
          }
        }
      } catch (e) {
        console.error("[mcp] summary inputs chat:", e instanceof Error ? e.message : e);
      }

      let event: Record<string, unknown> | undefined;
      try {
        let ev: CalEvent | null = null;
        if (eventId) {
          const raw = await getRawEvent(eventId).catch(() => null);
          if (raw) ev = normalizeEvent(raw, tz, ctx.session.email);
        }
        if (!ev && m.room && Number.isFinite(startMs)) {
          const { events } = await getEvents(startMs - 12 * 3600_000, (endMs ?? startMs) + 12 * 3600_000, tz, ctx.session.email);
          ev = events.find((e) => `${e.location}\n${e.description}`.includes(`/meet/${m.room}`)) ?? null;
        }
        if (ev) {
          event = {
            id: ev.baseId,
            title: ev.title,
            start: ev.allDay ? ev.startDay : localIso(ev.utcStart, tz),
            end: ev.allDay ? ev.endDay : localIso(ev.utcEnd, tz),
            description: ev.description ? truncate(ev.description, 5000) : undefined,
            attendees: ev.participants.map((p) => `${p.name ? `${p.name} <${p.email}>` : p.email} (${p.status})`),
          };
        }
      } catch (e) {
        console.error("[mcp] summary inputs event:", e instanceof Error ? e.message : e);
      }

      const speakers = [...new Set(segments.map((s) => (s.speaker || "").trim()).filter(Boolean))];
      return {
        meeting: {
          id: m.id,
          title: m.title,
          room: m.room || undefined,
          start: Number.isFinite(startMs) ? localIso(startMs, tz) : m.startedAt,
          end: endMs && Number.isFinite(endMs) ? localIso(endMs, tz) : undefined,
          timeZone: tz,
          durationMinutes: m.durationSeconds != null ? Math.round(m.durationSeconds / 60) : undefined,
          status: m.status,
          startedBy: m.startedByName || m.startedBy,
          transcriptFileId: m.driveFileId ?? undefined,
          url: m.url ? `${appUrl()}${m.url}` : undefined,
        },
        participants: (m.participants ?? []).map((p) => ({ name: personName(p.name, p.email), email: p.email })),
        speakers: speakers.length ? speakers : undefined,
        transcript,
        chat,
        event,
      };
    },
  },
];
