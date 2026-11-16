// Ringing calls (lib/chat/calls.ts). Route handlers rather than server actions: they are called
// while other requests are in flight (server actions run one at a time per tab) and from
// navigator.sendBeacon when a calling tab closes.
//   POST /api/calls/start    { conversationId } | { with: { email, name } }, media, ringAll?
//   POST /api/calls/answer   { id }
//   POST /api/calls/decline  { id, reply? }
//   POST /api/calls/cancel   { id }
//   POST /api/calls/end      { id, last? }
import { NextResponse, type NextRequest } from "next/server";
import { startChat } from "@/app/(apps)/chat/actions";
import { isCallId, isConversationId, type CallMedia } from "@/app/(apps)/chat/shared";
import { answerCall, cancelCall, declineCall, hangUp, startCall, type StartResult } from "@/lib/chat/calls";
import { jsonError, sameOrigin } from "@/lib/chat/http";
import { chatUserOrNull } from "@/lib/chat/session";
import { ChatError } from "@/lib/chat/store";
import { livekitConfig } from "@/lib/livekit";
import { egressConfig } from "@/lib/meetings/egress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/;
// Control characters except newline.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const REPLY_MAX = 200;

const STATUS: Record<string, number> = { notFound: 404, notMember: 403, forbidden: 403, callEnded: 409, rateLimited: 429 };

const joinInfo = (r: StartResult) =>
  NextResponse.json({ ...r, videoRecording: !!egressConfig() }, { headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const me = await chatUserOrNull();
  if (!me) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  let input: Record<string, unknown>;
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("invalid", 400);
    input = body as Record<string, unknown>;
  } catch {
    return jsonError("invalid", 400);
  }

  try {
    if (action === "start") {
      if (!livekitConfig()) return jsonError("notConfigured", 503);
      const media: CallMedia = input.media === "audio" ? "audio" : "video";
      let conv = input.conversationId;
      if (conv == null && input.with && typeof input.with === "object") {
        const w = input.with as Record<string, unknown>;
        if (typeof w.email !== "string" || !EMAIL.test(w.email)) return jsonError("invalid", 400);
        const name = (typeof w.name === "string" ? w.name : "").replace(CONTROL, "").slice(0, 200);
        const dm = await startChat([{ email: w.email, name }], null);
        if (!dm.ok) return jsonError(dm.error, STATUS[dm.error] ?? 400);
        conv = dm.data;
      }
      if (!isConversationId(conv)) return jsonError("invalid", 400);
      return joinInfo(startCall(me, conv, media, input.ringAll === true));
    }

    if (!isCallId(input.id)) return jsonError("invalid", 400);
    const id = input.id;
    switch (action) {
      case "answer":
        if (!livekitConfig()) return jsonError("notConfigured", 503);
        return joinInfo(answerCall(me, id));
      case "decline": {
        let reply: string | null = null;
        if (input.reply != null) {
          if (typeof input.reply !== "string") return jsonError("invalid", 400);
          reply = input.reply.replace(CONTROL, "").trim().slice(0, REPLY_MAX) || null;
        }
        declineCall(me, id, reply);
        break;
      }
      case "cancel":
        cancelCall(me, id);
        break;
      case "end":
        hangUp(me, id, input.last === true);
        break;
      default:
        return jsonError("notFound", 404);
    }
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    if (e instanceof ChatError) return jsonError(e.message, STATUS[e.message] ?? 400);
    console.error("[calls]", action, e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}
