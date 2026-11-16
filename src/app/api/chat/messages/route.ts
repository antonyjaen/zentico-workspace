// Posts a text message. A route handler rather than a server action: a tab left open across a
// deploy keeps working (old server action ids no longer exist after a deploy, so sends failed).
import { NextResponse, type NextRequest } from "next/server";
import { BODY_MAX, isConversationId } from "@/app/(apps)/chat/shared";
import { jsonError, sameOrigin } from "@/lib/chat/http";
import { chatUserOrNull } from "@/lib/chat/session";
import { ChatError, postMessage } from "@/lib/chat/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const MAX_REQUEST_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const me = await chatUserOrNull();
  if (!me) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);

  let input: { conversationId?: unknown; text?: unknown; threadRoot?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > MAX_REQUEST_BYTES) return jsonError("tooLong", 413);
    input = JSON.parse(raw) as typeof input;
  } catch {
    return jsonError("invalid", 400);
  }
  const { conversationId, text, threadRoot } = input ?? {};
  if (!isConversationId(conversationId) || typeof text !== "string") return jsonError("invalid", 400);
  if (threadRoot != null && !(Number.isSafeInteger(threadRoot) && (threadRoot as number) > 0)) return jsonError("invalid", 400);
  const body = text.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();
  if (!body) return jsonError("empty", 400);
  if (body.length > BODY_MAX) return jsonError("tooLong", 400);

  try {
    const message = postMessage(conversationId, me.id, { body, threadRoot: (threadRoot as number | null | undefined) ?? null });
    return NextResponse.json({ message }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof ChatError) return jsonError(e.message, e.message === "notFound" ? 404 : 403);
    console.error("[chat] send failed", e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}
