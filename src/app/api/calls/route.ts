// GET /api/calls: the live calls I'm in (ringing me, or mine still ringing / answered). Tabs load
// this on start and after the notifications stream reconnects; changes then arrive as
// call.ring / call.update events on /api/notifications/stream.
import { NextResponse } from "next/server";
import { myCalls } from "@/lib/chat/calls";
import { jsonError } from "@/lib/chat/http";
import { chatUserOrNull } from "@/lib/chat/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const me = await chatUserOrNull();
  if (!me) return jsonError("unauthorized", 401);
  return NextResponse.json({ calls: myCalls(me) }, { headers: { "Cache-Control": "no-store" } });
}
