// Total unread Chat messages for the rail badge.
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/chat/http";
import { chatUserOrNull } from "@/lib/chat/session";
import { unreadTotal } from "@/lib/chat/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const me = await chatUserOrNull();
  if (!me) return jsonError("unauthorized", 401);
  return NextResponse.json({ total: unreadTotal(me.id) }, { headers: { "Cache-Control": "no-store" } });
}
