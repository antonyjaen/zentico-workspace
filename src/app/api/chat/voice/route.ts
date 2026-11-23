// POST /api/chat/voice { conversationId, action: join|state|beat|sync|leave, muted?, deafened? }
// A client's report about its own voice-channel connection (lib/chat/voice.ts) → { participants }.
// A route handler rather than a server action: it must not queue behind other actions and it
// accepts navigator.sendBeacon (text/plain body) when the tab closes.
import { NextResponse, type NextRequest } from "next/server";
import { isConversationId } from "@/app/(apps)/chat/shared";
import { jsonError, sameOrigin } from "@/lib/chat/http";
import { chatUserOrNull } from "@/lib/chat/session";
import { ChatError } from "@/lib/chat/store";
import { reportVoice, type VoiceAction } from "@/lib/chat/voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACTIONS: readonly VoiceAction[] = ["join", "state", "beat", "sync", "leave"];
const STATUS: Record<string, number> = { notFound: 404, notMember: 403, forbidden: 403, rateLimited: 429 };

export async function POST(req: NextRequest) {
  const me = await chatUserOrNull();
  if (!me) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  let input: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 1000) return jsonError("invalid", 400);
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("invalid", 400);
    input = body as Record<string, unknown>;
  } catch {
    return jsonError("invalid", 400);
  }
  const { conversationId, action, muted, deafened } = input;
  if (!isConversationId(conversationId) || !ACTIONS.includes(action as VoiceAction)) return jsonError("invalid", 400);
  if ((muted != null && typeof muted !== "boolean") || (deafened != null && typeof deafened !== "boolean")) return jsonError("invalid", 400);
  try {
    const participants = reportVoice(me, conversationId, action as VoiceAction, {
      muted: muted as boolean | undefined,
      deafened: deafened as boolean | undefined,
    });
    return NextResponse.json({ participants }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof ChatError) return jsonError(e.message, STATUS[e.message] ?? 400);
    console.error("[voice]", action, e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}
