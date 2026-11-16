// The Dashboard's Claude chat: each message becomes a command for the user's own bridge
// (tools/zentico-bridge.mjs) in the per-user queue of src/lib/mcp/agent.ts, under the pseudo-room
// DASHBOARD_ROOM. Server-only.
import { CHAT_TEXT_MAX, summarizeDoc } from "@/app/(apps)/dashboard/model";
import { DASHBOARD_ROOM } from "@/app/(apps)/meet/shared";
import { enqueueCommand, type CommandRow } from "../mcp/agent";
import type { Session } from "../session";
import { addTurn, getDashboard, listTurns } from "./store";

const BAD_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
export const cleanChatText = (text: string) => text.replace(BAD_TEXT, " ").trim().slice(0, CHAT_TEXT_MAX);

/** Queues a chat message for the user's bridge and records it as a turn. */
export function sendDashboardMessage(session: Session, text: string, timeZone: string | null) {
  const { command } = enqueueCommand({
    email: session.email,
    name: session.name,
    room: DASHBOARD_ROOM,
    title: "Dashboard",
    text,
    source: "typed",
    timeZone,
  });
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
  /** The user's dashboard when the command was handed to the bridge (custom HTML summarized). */
  dashboard: ReturnType<typeof summarizeDoc>;
  /** Earlier turns of the Dashboard chat, oldest first. */
  conversation: { at: string; user: string; claude: string | null; status: string }[];
};

export function dashboardPayload(c: CommandRow, appUrl: string): DashboardBridgeCommand {
  const earlier = listTurns(c.userEmail, CONTEXT_TURNS + 1).filter((t) => t.commandId !== c.id).slice(-CONTEXT_TURNS);
  return {
    id: c.id,
    text: c.text,
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
    dashboard: summarizeDoc(getDashboard(c.userEmail)),
    conversation: earlier.map((t) => ({
      at: new Date(t.createdAt).toISOString(),
      user: t.text.slice(0, 1000),
      claude: t.result ? t.result.slice(0, 1500) : null,
      status: t.status,
    })),
  };
}
