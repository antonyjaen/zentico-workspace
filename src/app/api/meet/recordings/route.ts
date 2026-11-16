import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { isValidRoom } from "@/lib/livekit";
import { egressConfig, isInRoom, startRoomVideo } from "@/lib/meetings/egress";
import { boot, enqueue, stopVideo } from "@/lib/meetings/jobs";
import { errorResponse, jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { setVideoFailed, setVideoStarted, startRecording } from "@/lib/meetings/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BAD_TEXT = /[\u0000-\u001f\u007f]/g;

/**
 * POST { room, title?, timeZone?, video? } → { id, startedAt, video }: starts recording a meeting.
 * With video: true (only when egress is configured) LiveKit also records the room as an MP4;
 * if that fails the audio/transcript recording still runs and `video` comes back false.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonError("unsupported_media_type", 415);
  }

  let body: { room?: unknown; title?: unknown; timeZone?: unknown; video?: unknown } | null;
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

  if (body?.video !== undefined && typeof body.video !== "boolean") return jsonError("invalid", 400);
  const wantVideo = body?.video === true;
  const egress = wantVideo ? egressConfig() : null;
  if (wantVideo && !egress) return jsonError("video_not_configured", 400);

  try {
    // Only someone actually connected to the call may have it recorded on video.
    if (egress && !(await isInRoom(egress, room, session.email))) return jsonError("not_in_room", 403);
    const { id, startedAt, replaced } = await startRecording({ room, title, timeZone, session });
    if (replaced) {
      enqueue(replaced);
      await stopVideo(replaced);
    }
    let video = false;
    if (egress) {
      try {
        const info = await startRoomVideo(egress, room, id);
        setVideoStarted(id, info.id);
        boot(); // makes sure the video poller runs in this process
        video = true;
      } catch (e) {
        console.error("[meetings] starting the video egress failed:", e instanceof Error ? e.message : e);
        setVideoFailed(id, "egress_start_failed");
      }
    }
    return NextResponse.json({ id, startedAt, video }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e, "start");
  }
}
