// Stops a recording (starter only) and queues transcription. Also called with
// navigator.sendBeacon when the recorder's tab goes away, so any content type is accepted.
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { enqueue } from "@/lib/meetings/jobs";
import { errorResponse, jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { stopRecording } from "@/lib/meetings/store";
import { MEETING_ID } from "@/app/(apps)/meet/recording";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  const { id } = await params;
  if (!MEETING_ID.test(id)) return jsonError("not_found", 404);
  try {
    const { stopped } = await stopRecording(id, session);
    if (stopped) enqueue(id);
    return NextResponse.json({ ok: true, stopped }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e, "stop");
  }
}
