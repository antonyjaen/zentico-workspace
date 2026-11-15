// Glue between the call (voice windows / typed commands) and the per-user command queue in
// src/lib/mcp/agent.ts. Server-only.
import { isTimeZone } from "@/app/(apps)/calendar/time";
import { COMMAND_MAX_CHARS } from "@/app/(apps)/meet/claude";
import { enqueueCommand, recentUtterances, type CommandRow } from "../mcp/agent";
import { userTokens } from "../mcp/db";
import type { Session } from "../session";
import { chatMeetingTitle } from "./chat-link";

const BAD_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export const cleanCommandText = (text: string) => text.replace(BAD_TEXT, " ").trim().slice(0, COMMAND_MAX_CHARS);

export const cleanTimeZone = (tz: unknown): string | null => (typeof tz === "string" && tz.length <= 64 && isTimeZone(tz) ? tz : null);

/** Meeting commands need an active read+write access token (the bridge runs with one). */
export function hasWriteToken(userSub: string): boolean {
  const now = Date.now();
  return userTokens(userSub).some((t) => t.scope === "write" && !t.needsReauth && (t.expires == null || t.expires > now));
}

export function createCommand(
  session: Session,
  input: { room: string; text: string; source: "voice" | "typed"; timeZone: string | null },
): { command: CommandRow; duplicate: boolean } {
  return enqueueCommand({
    email: session.email,
    name: session.name,
    room: input.room,
    title: chatMeetingTitle(input.room) ?? "",
    text: cleanCommandText(input.text),
    source: input.source,
    timeZone: input.timeZone,
  });
}

/** What the bridge receives for one command (see docs/PLAN.md → "Claude in meetings"). */
export type BridgeCommand = {
  id: string;
  text: string;
  source: "voice" | "typed";
  room: string;
  title: string;
  meetingUrl: string;
  speaker: { name: string; email: string };
  createdAt: string;
  timeZone: string | null;
  /** The speaker's own words in the ~2 minutes before the command (their microphone only). */
  transcript: { at: string; text: string }[];
};

export function bridgePayload(c: CommandRow, appUrl: string): BridgeCommand {
  // Utterances spoken close together are joined back into running text.
  const merged: { at: number; text: string }[] = [];
  for (const u of recentUtterances(c.userEmail, c.room, c.createdAt)) {
    const last = merged[merged.length - 1];
    if (last && u.at - last.at < 8000) {
      last.text = `${last.text} ${u.text}`;
      last.at = u.at;
    } else merged.push({ ...u });
  }
  return {
    id: c.id,
    text: c.text,
    source: c.source,
    room: c.room,
    title: c.title || c.room,
    meetingUrl: `${appUrl}/meet/${c.room}`,
    speaker: { name: c.userName || c.userEmail, email: c.userEmail },
    createdAt: new Date(c.createdAt).toISOString(),
    timeZone: c.timeZone,
    transcript: merged.map((u) => ({ at: new Date(u.at).toISOString(), text: u.text.slice(0, 4000) })),
  };
}
