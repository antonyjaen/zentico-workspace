// The Dashboard's Claude chat for the signed-in user.
// GET → ChatState. POST { text, timeZone? } → { turn } (queued for the user's own bridge).
// DELETE → clears the chat history (commands already sent keep running).
// Cancel / Approve / Reject reuse /api/meet/voice/commands/[id] and /confirmations/[id].
import { NextResponse, type NextRequest } from "next/server";
import { CHAT_TEXT_MAX } from "@/app/(apps)/dashboard/model";
import { getSession } from "@/lib/auth";
import { chatState } from "@/lib/dashboard/chat";
import { cleanChatText, sendDashboardMessage } from "@/lib/dashboard/commands";
import { clearTurns } from "@/lib/dashboard/store";
import { cleanTimeZone, hasWriteToken } from "@/lib/meetings/claude-commands";
import { jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  return NextResponse.json(chatState(session), { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  if (Number(req.headers.get("content-length") ?? "0") > 16 * 1024) return jsonError("too_large", 413);
  let body: { text?: unknown; timeZone?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError("invalid", 400);
  }
  const raw = typeof body.text === "string" ? body.text : "";
  if (raw.length > CHAT_TEXT_MAX + 100) return jsonError("invalid", 400);
  const text = cleanChatText(raw);
  if (!text) return jsonError("invalid", 400);
  if (!hasWriteToken(session.sub)) return jsonError("no_token", 412);
  try {
    const turn = sendDashboardMessage(session, text, cleanTimeZone(body.timeZone));
    return NextResponse.json({ turn }, { headers: NO_STORE });
  } catch (e) {
    console.error("[dashboard] chat:", e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  clearTurns(session.email);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
