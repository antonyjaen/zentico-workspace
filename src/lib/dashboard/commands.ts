// The Dashboard's Claude chat: each message becomes a command for the user's own bridge
// (tools/zentico-bridge.mjs) in the per-user queue of src/lib/mcp/agent.ts, under the pseudo-room
// DASHBOARD_ROOM. Server-only.
import { CHAT_TEXT_MAX } from "@/app/(apps)/dashboard/model";
import { DASHBOARD_ROOM } from "@/app/(apps)/meet/shared";
import { enqueueCommand, type CommandRow } from "../mcp/agent";
import type { Session } from "../session";
import { formatErrors, summarizeUi, UI_FOLDER } from "../ui/schema";
import { chatWhereOf, getUiState, modAskOf, recordChatWhere } from "../ui/store";
import { addTurn, listTurns } from "./store";

const BAD_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
export const cleanChatText = (text: string) => text.replace(BAD_TEXT, " ").trim().slice(0, CHAT_TEXT_MAX);

/** Where in the workspace a message was typed (the "Customize with Claude" overlay). */
export type ChatWhere = { app: string; path: string };
const WHERE_APP = /^[a-z0-9][a-z0-9:-]{0,40}$/;
const UNSAFE_PATH = /[\s\\\u0000-\u001f\u007f]/;
export function cleanWhere(v: unknown): ChatWhere | null {
  if (!v || typeof v !== "object") return null;
  const { app, path } = v as Record<string, unknown>;
  if (typeof app !== "string" || !WHERE_APP.test(app) || typeof path !== "string") return null;
  if (path.length > 300 || !path.startsWith("/") || path.startsWith("//") || UNSAFE_PATH.test(path)) return null;
  return { app, path };
}

/** Queues a chat message for the user's bridge and records it as a turn. */
export function sendDashboardMessage(session: Session, text: string, timeZone: string | null, where: ChatWhere | null = null) {
  const { command } = enqueueCommand({
    email: session.email,
    name: session.name,
    room: DASHBOARD_ROOM,
    title: "Dashboard",
    text,
    source: "typed",
    timeZone,
  });
  if (where) recordChatWhere(session.email, command.id, where.app, where.path);
  return addTurn(session.email, text, command.id, command.status);
}

/** Recent chat turns handed to Claude as context (the newest is the request itself). */
const CONTEXT_TURNS = 8;

/** What the bridge receives for a Dashboard command (`source: "dashboard"`). */
export type DashboardBridgeCommand = {
  id: string;
  text: string;
  source: "dashboard";
  room: string;
  title: string;
  /** Same as dashboardUrl (kept for bridges that only know meeting commands). */
  meetingUrl: string;
  dashboardUrl: string;
  speaker: { name: string; email: string };
  createdAt: string;
  timeZone: string | null;
  transcript: { at: string; text: string }[];
  meeting: null;
  /** The user's Zentico UI when the command was handed to the bridge (summary; files are in Drive). */
  dashboard: ReturnType<typeof summarizeUi>;
  /** Where the UI files live and their current problems (the guide is ui_get_guide / AGENTS.md). */
  ui: { folder: string; folderUrl: string | null; errors: string | null };
  /** Set when a mod on the dashboard sent this request (zentico.claude.ask), not the user. */
  mod: { id: string; name: string } | null;
  /** The app the user was in when they asked (null = the Dashboard itself). */
  where: ChatWhere | null;
  /** Earlier turns of the Dashboard chat, oldest first. */
  conversation: { at: string; user: string; claude: string | null; status: string }[];
};

export function dashboardPayload(c: CommandRow, appUrl: string): DashboardBridgeCommand {
  const state = getUiState(c.userEmail);
  const ask = modAskOf(c.userEmail, c.id);
  const where = chatWhereOf(c.userEmail, c.id);
  const earlier = listTurns(c.userEmail, CONTEXT_TURNS + 1).filter((t) => t.commandId !== c.id).slice(-CONTEXT_TURNS);
  return {
    id: c.id,
    // The context travels in the text too, so bridges that don't know `where` still get it.
    text: where ? `[Sent from the ${where.app} app (${where.path}) via "Customize with Claude"; this is about customizing the workspace UI there]\n${c.text}` : c.text,
    source: "dashboard",
    room: c.room,
    title: "Dashboard",
    meetingUrl: `${appUrl}/dashboard`,
    dashboardUrl: `${appUrl}/dashboard`,
    speaker: { name: c.userName || c.userEmail, email: c.userEmail },
    createdAt: new Date(c.createdAt).toISOString(),
    timeZone: c.timeZone,
    transcript: [],
    meeting: null,
    dashboard: summarizeUi(state?.compiled ?? null),
    ui: {
      folder: `${UI_FOLDER}/`,
      folderUrl: state?.folderId ? `${appUrl}/drive?folder=${encodeURIComponent(state.folderId)}` : null,
      errors: state?.errors.length ? formatErrors(state.errors.slice(0, 20)) : null,
    },
    mod: ask ? { id: ask.modId, name: ask.modName } : null,
    where,
    conversation: earlier.map((t) => ({
      at: new Date(t.createdAt).toISOString(),
      user: t.text.slice(0, 1000),
      claude: t.result ? t.result.slice(0, 1500) : null,
      status: t.status,
    })),
  };
}
