// Integrations owned by other modules (Chat, Meet recordings), loaded lazily and checked
// structurally so the MCP server keeps working if they are missing or change shape.
import { ToolError } from "./args";

const fn = (m: unknown, name: string): boolean =>
  !!m && typeof m === "object" && typeof (m as Record<string, unknown>)[name] === "function";

/* -------------------------------------------------------------------- chat */

export type ChatUser = { id: number; name: string; email: string };
export type ChatSummary = {
  id: string;
  kind: string;
  name: string;
  teamId?: string | null;
  isPrivate?: boolean;
  memberCount?: number;
  joined?: boolean;
  unread?: number;
  lastMessage?: { preview: string; author: string | null; created: number } | null;
  lastActivity?: number;
};
export type ChatMsg = {
  id: number;
  author: { name: string; email: string } | null;
  body: string;
  created: number;
  edited?: number | null;
  deleted?: boolean;
  threadRoot?: number | null;
  kind: string;
  meta?: unknown;
  replyCount?: number;
};
export type ChatApi = {
  me(): Promise<ChatUser>;
  overview(user: ChatUser): { teams: { id: string; name: string; channels: ChatSummary[] }[]; chats: ChatSummary[] };
  listMessages(convId: string, userId: number, before: number | null): { messages: ChatMsg[]; hasMore: boolean };
  listThread?(rootId: number, userId: number): { root: ChatMsg; replies: ChatMsg[] };
  postMessage(convId: string, userId: number, input: { body: string; threadRoot?: number | null }): ChatMsg;
};

export async function loadChat(): Promise<ChatApi> {
  let store: unknown;
  let session: unknown;
  try {
    [store, session] = await Promise.all([import("@/lib/chat/store"), import("@/lib/chat/session")]);
  } catch {
    throw new ToolError("Chat is not available on this server.");
  }
  if (!fn(store, "overview") || !fn(store, "listMessages") || !fn(store, "postMessage") || !fn(session, "chatUser")) {
    throw new ToolError("Chat is not available on this server.");
  }
  const s = store as Omit<ChatApi, "me">;
  return {
    me: (session as { chatUser(): Promise<ChatUser> }).chatUser,
    overview: s.overview,
    listMessages: s.listMessages,
    listThread: fn(store, "listThread") ? s.listThread : undefined,
    postMessage: s.postMessage,
  };
}

/** Chat store errors carry a code (e.g. "notFound", "forbidden") as their message. */
export function chatError(e: unknown): never {
  if (e instanceof ToolError) throw e;
  const code = e instanceof Error ? e.message : "";
  if (/^[a-zA-Z]{2,40}$/.test(code)) throw new ToolError(`Chat: ${code}`);
  throw e;
}

/* ---------------------------------------------------------------- meetings */

export type MeetingSummary = {
  id: string;
  title?: string;
  startedBy?: string;
  startedByName?: string;
  startedAt?: string;
  endedAt?: string | null;
  durationSeconds?: number | null;
  status?: string;
  error?: string | null;
  participants?: { email: string; name: string }[];
  driveFileId?: string | null;
  video?: { status?: string; error?: string | null; fileId?: string | null } | null;
  url?: string;
};
export type TranscriptSegment = { start: number; end: number; speaker: string; text: string };
export type MeetingsApi = {
  listMeetings(userEmail: string, opts?: { limit?: number }): Promise<unknown> | unknown;
  getTranscript(id: string, userEmail: string): Promise<unknown> | unknown;
};

const MEETINGS_UNAVAILABLE = "Meeting recordings and transcripts are not available on this server yet.";

export async function loadMeetings(): Promise<MeetingsApi> {
  let mod: unknown;
  try {
    mod = await importMeetingsStore();
  } catch {
    throw new ToolError(MEETINGS_UNAVAILABLE);
  }
  if (!fn(mod, "listMeetings") || !fn(mod, "getTranscript")) throw new ToolError(MEETINGS_UNAVAILABLE);
  return mod as MeetingsApi;
}

// Meetings storage is provided by the Meet module (src/lib/meetings/store.ts).
const importMeetingsStore = (): Promise<unknown> => import("@/lib/meetings/store");
