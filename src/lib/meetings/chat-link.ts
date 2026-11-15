// Optional Chat integration for recordings. Server-only, best effort: any failure is logged and
// ignored, so recordings never depend on Chat.
import { get } from "../chat/db";
import { postMessage } from "../chat/store";

export type ChatMeeting = { conversationId: string; messageId: number | null; title: string; calendarEventId: string | null };

function chatMeeting(room: string): ChatMeeting | null {
  try {
    const r = get(
      "SELECT conversation_id, message_id, title, calendar_event_id FROM meetings WHERE code = ? ORDER BY starts_at DESC LIMIT 1",
      room,
    );
    if (!r || typeof r.conversation_id !== "string") return null;
    return {
      conversationId: r.conversation_id,
      messageId: typeof r.message_id === "number" ? r.message_id : r.message_id == null ? null : Number(r.message_id),
      title: typeof r.title === "string" ? r.title : "",
      calendarEventId: typeof r.calendar_event_id === "string" && r.calendar_event_id ? r.calendar_event_id : null,
    };
  } catch (e) {
    console.error("[meetings] chat lookup:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** The Chat meeting (conversation, card message, calendar event) that uses this room code, if any. */
export const chatMeetingFor = (room: string): ChatMeeting | null => chatMeeting(room);

/** Title of the Chat meeting card that uses this room code, if any. */
export const chatMeetingTitle = (room: string): string | null => chatMeeting(room)?.title.trim() || null;

/**
 * Posts a reply as `email` in the thread of the room's Chat meeting card (Chat checks that the
 * user may write there). Used when someone shares their Claude result with the meeting.
 */
export function postToMeetingChat(room: string, email: string, body: string): "ok" | "no_chat" | "failed" {
  const m = chatMeeting(room);
  if (!m) return "no_chat";
  try {
    const user = get("SELECT id FROM users WHERE lower(email) = lower(?)", email);
    if (!user || user.id == null) return "failed";
    postMessage(m.conversationId, Number(user.id), { body, threadRoot: m.messageId });
    return "ok";
  } catch (e) {
    console.error("[meetings] chat share:", e instanceof Error ? e.message : e);
    return "failed";
  }
}

/** Replies "Transcript ready" (as the starter) in the thread of the room's Chat meeting card. */
export function postTranscriptReady(room: string, starterEmail: string, title: string, link: string): void {
  const m = chatMeeting(room);
  if (!m) return;
  try {
    const user = get("SELECT id FROM users WHERE lower(email) = lower(?)", starterEmail);
    if (!user || user.id == null) return;
    postMessage(m.conversationId, Number(user.id), {
      body: `Transcript ready: ${title}\n${link}`,
      threadRoot: m.messageId,
    });
  } catch (e) {
    console.error("[meetings] chat notify:", e instanceof Error ? e.message : e);
  }
}
