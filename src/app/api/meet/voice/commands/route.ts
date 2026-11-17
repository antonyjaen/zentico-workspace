// The signed-in user's own assistant commands in a call.
// GET ?room=<code> → CommandsResponse (their commands, pending confirmations, bridge status).
// POST { room, text, timeZone? } → typed command ("Ask my <assistant>").
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { chatMeetingTitle } from "@/lib/meetings/chat-link";
import { cleanCommandText, cleanTimeZone, createCommand, hasWriteToken } from "@/lib/meetings/claude-commands";
import { jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { bridgeStatus, listCommands, pendingConfirmations, toView, wakeRegexFor } from "@/lib/mcp/agent";
import { stripWake } from "@/lib/meetings/wake";
import { COMMAND_MAX_CHARS, type CommandsResponse } from "@/app/(apps)/meet/claude";
import { ROOM_PATTERN } from "@/app/(apps)/meet/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  const room = req.nextUrl.searchParams.get("room") ?? "";
  if (!ROOM_PATTERN.test(room)) return jsonError("invalid", 400);
  const bridge = bridgeStatus(session.email);
  const body: CommandsResponse = {
    commands: listCommands(session.email, room).map(toView),
    confirmations: pendingConfirmations(session.email, room),
    bridge: { connected: bridge.connected, lastSeen: bridge.lastSeen },
    hasWriteToken: hasWriteToken(session.sub),
    chat: chatMeetingTitle(room) != null,
  };
  return NextResponse.json(body, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  if (Number(req.headers.get("content-length") ?? "0") > 16 * 1024) return jsonError("too_large", 413);
  let body: { room?: unknown; text?: unknown; timeZone?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError("invalid", 400);
  }
  const room = typeof body.room === "string" ? body.room : "";
  const raw = typeof body.text === "string" ? body.text : "";
  if (!ROOM_PATTERN.test(room) || raw.length > COMMAND_MAX_CHARS + 100) return jsonError("invalid", 400);
  const text = cleanCommandText(stripWake(raw.trimStart(), wakeRegexFor(session.email)));
  if (!text) return jsonError("invalid", 400);
  if (!hasWriteToken(session.sub)) return jsonError("no_token", 412);
  try {
    const { command } = createCommand(session, { room, text, source: "typed", timeZone: cleanTimeZone(body.timeZone) });
    return NextResponse.json({ command: toView(command) }, { headers: NO_STORE });
  } catch (e) {
    console.error("[voice] typed command:", e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}
