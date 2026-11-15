// PUT → heartbeat from the recorder; POST → retry a failed transcription / Drive upload;
// DELETE → remove the recording (starter only).
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { enqueue } from "@/lib/meetings/jobs";
import { errorResponse, jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { deleteMeeting, retryMeeting, touchRecording } from "@/lib/meetings/store";
import { MEETING_ID } from "@/app/(apps)/meet/recording";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  const { id } = await params;
  try {
    touchRecording(id, session.email);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e, "heartbeat");
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  const { id } = await params;
  if (!MEETING_ID.test(id)) return jsonError("not_found", 404);
  try {
    await retryMeeting(id, session.email, session);
    enqueue(id);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e, "retry");
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  const { id } = await params;
  if (!MEETING_ID.test(id)) return jsonError("not_found", 404);
  try {
    await deleteMeeting(id, session.email);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e, "delete");
  }
}
