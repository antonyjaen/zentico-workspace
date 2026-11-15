// "Someone is typing" pings (fire-and-forget from the composer, throttled client-side).
import { NextResponse, type NextRequest } from "next/server";
import { isConversationId } from "@/app/(apps)/chat/shared";
import { jsonError, sameOrigin } from "@/lib/chat/http";
import { chatUserOrNull } from "@/lib/chat/session";
import { ChatError, typing } from "@/lib/chat/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const me = await chatUserOrNull();
  if (!me) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  let input: { conversationId?: unknown; threadRoot?: unknown };
  try {
    input = await req.json();
  } catch {
    return jsonError("invalid", 400);
  }
  const { conversationId, threadRoot } = input ?? {};
  if (!isConversationId(conversationId)) return jsonError("invalid", 400);
  if (threadRoot != null && !(typeof threadRoot === "number" && Number.isSafeInteger(threadRoot) && threadRoot > 0))
    return jsonError("invalid", 400);
  try {
    typing(conversationId, me, (threadRoot as number | null | undefined) ?? null);
  } catch (e) {
    if (e instanceof ChatError) return jsonError(e.message, 404);
    throw e;
  }
  return new NextResponse(null, { status: 204 });
}
