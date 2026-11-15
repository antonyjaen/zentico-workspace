// Actions on one of the signed-in user's own commands: { action: "cancel" } or { action: "share" }
// (posts the result to the room's Chat meeting thread, if the room has one; never automatic).
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { postToMeetingChat } from "@/lib/meetings/chat-link";
import { jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { cancelCommand, getCommand } from "@/lib/mcp/agent";
import { COMMAND_ID } from "@/app/(apps)/meet/claude";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  const { id } = await params;
  if (!COMMAND_ID.test(id)) return jsonError("not_found", 404);
  let body: { action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError("invalid", 400);
  }
  const command = getCommand(id, session.email);
  if (!command) return jsonError("not_found", 404);

  if (body.action === "cancel") {
    return NextResponse.json({ ok: cancelCommand(id, session.email) }, { headers: NO_STORE });
  }
  if (body.action === "share") {
    if (command.status !== "done" || !command.result) return jsonError("invalid", 400);
    const text = `🤖 ${command.text}\n\n${command.result}`.slice(0, 7900);
    const r = postToMeetingChat(command.room, session.email, text);
    if (r === "no_chat") return jsonError("no_chat", 404);
    if (r === "failed") return jsonError("failed", 500);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }
  return jsonError("invalid", 400);
}
