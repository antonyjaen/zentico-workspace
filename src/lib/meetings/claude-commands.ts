// Glue between the call (push-to-talk / typed commands, meeting audio) and the per-user command queue in
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
  /** The speaker's own spoken commands in the ~10 minutes before (and including) this one. */
  transcript: { at: string; text: string }[];
  /**
   * What was said in the meeting in the ~10 minutes before the command, when the user had "Claude
   * listens to the meeting" on: everyone's microphones mixed, so speakers are unknown. Null when
   * nothing was captured.
   */
  meeting: { from: string; to: string; text: string; truncated: boolean } | null;
};

/** The meeting transcript handed to Claude keeps the newest text up to this length. */
const MEETING_CONTEXT_MAX_CHARS = 6000;

/** Utterances spoken close together are joined back into running text. */
function mergeRuns(list: { at: number; text: string }[], gapMs: number) {
  const merged: { at: number; text: string }[] = [];
  for (const u of list) {
    const last = merged[merged.length - 1];
    if (last && u.at - last.at < gapMs) {
      last.text = `${last.text} ${u.text}`;
      last.at = u.at;
    } else merged.push({ ...u });
  }
  return merged;
}

export function bridgePayload(c: CommandRow, appUrl: string): BridgeCommand {
  const recent = recentUtterances(c.userEmail, c.room, c.createdAt);
  const own = mergeRuns(
    recent.filter((u) => u.source === "command"),
    8000,
  );
  const meetingParts = recent.filter((u) => u.source === "meeting");
  let meeting: BridgeCommand["meeting"] = null;
  if (meetingParts.length) {
    const full = meetingParts.map((u) => u.text.trim()).join(" ").replace(/s+/g, " ").trim();
    const truncated = full.length > MEETING_CONTEXT_MAX_CHARS;
    // Keep the newest text, starting at a word boundary.
    const text = truncated ? `…${full.slice(-MEETING_CONTEXT_MAX_CHARS).replace(/^S*s/, "")}` : full;
    // A chunk's timestamp is when its transcript was stored (~15 s of audio before that).
    const iso = (ms: number) => new Date(ms).toISOString();
    meeting = { from: iso(meetingParts[0].at - 15_000), to: iso(meetingParts[meetingParts.length - 1].at), text, truncated };
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
    transcript: own.map((u) => ({ at: new Date(u.at).toISOString(), text: u.text.slice(0, 4000) })),
    meeting,
  };
}
