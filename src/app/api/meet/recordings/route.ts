import { NextResponse, type NextRequest } from "next/server";
import { setRecordingHint } from "@/lib/meetings/language";
import { getSession } from "@/lib/auth";
import { isValidRoom } from "@/lib/livekit";
import { enqueue } from "@/lib/meetings/jobs";
import { errorResponse, jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { startRecording } from "@/lib/meetings/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BAD_TEXT = /[\u0000-\u001f\u007f]/g;

/** POST { room, title?, timeZone? } → { id, startedAt }: starts recording a meeting. */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonError("unsupported_media_type", 415);
  }

  let body: { room?: unknown; title?: unknown; timeZone?: unknown } | null;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = null;
  }
  const room = body?.room;
  if (!isValidRoom(room)) return jsonError("invalid_room", 400);
  const title = typeof body?.title === "string" ? body.title.replace(BAD_TEXT, " ").trim().slice(0, 200) : "";
  let timeZone: string | null = typeof body?.timeZone === "string" ? body.timeZone.slice(0, 64) : null;
  if (timeZone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone });
    } catch {
      timeZone = null;
    }
  }

  const ui = (req.cookies.get("zw_locale")?.value ?? req.headers.get("accept-language") ?? "").toLowerCase().match(/^(es|en)/);
  setRecordingHint(room, ui ? ui[1] : null);
  try {
    const { id, startedAt, replaced } = await startRecording({ room, title, timeZone, session });
    if (replaced) enqueue(replaced);
    return NextResponse.json({ id, startedAt }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e, "start");
  }
}
