// GET /api/chat/claude?c=<conversation> → the signed-in user's own Claude commands in that
// conversation that are still running, and the write actions waiting for their approval (decided
// through /api/meet/voice/confirmations/<id>, cancelled through /api/meet/voice/commands/<id>).
// Fetched when the conversation opens and on "claude" chat events (no polling).
import { claudeRoom } from "@/lib/chat/claude-bot";
import { jsonError } from "@/lib/chat/http";
import { chatUserOrNull } from "@/lib/chat/session";
import { canReadConversation } from "@/lib/chat/store";
import { activeCommands, pendingConfirmations } from "@/lib/mcp/agent";
import { isConversationId, type ClaudeChatState } from "@/app/(apps)/chat/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const me = await chatUserOrNull();
  if (!me) return jsonError("unauthorized", 401);
  const c = new URL(req.url).searchParams.get("c");
  if (!isConversationId(c) || !canReadConversation(c, me.id)) return jsonError("notFound", 404);
  const room = claudeRoom(c);
  const state: ClaudeChatState = {
    commands: activeCommands(me.email, room).map((x) => ({ id: x.id, text: x.text, status: x.status, progress: x.progress })),
    confirmations: pendingConfirmations(me.email, room).map((x) => ({
      id: x.id,
      commandId: x.commandId,
      tool: x.tool,
      summary: x.summary,
      expiresAt: x.expiresAt,
    })),
  };
  return Response.json(state, { headers: { "Cache-Control": "no-store" } });
}
