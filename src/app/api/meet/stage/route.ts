// The live meeting stage of a call (see src/lib/meetings/stage.ts).
// GET ?room=<code>&since=<rev> → StageState: everything (since missing / unknown) or the changes after
// `since`. People in the call, and people of the room's recorded meeting, may read it.
import { NextResponse, type NextRequest } from "next/server";
import { ROOM_PATTERN } from "@/app/(apps)/meet/shared";
import { getSession } from "@/lib/auth";
import { jsonError, NO_STORE } from "@/lib/meetings/http";
import { boot } from "@/lib/meetings/jobs";
import { checkAccess, stageState } from "@/lib/meetings/stage";
import { stageErrorResponse } from "@/lib/meetings/stage-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  const room = req.nextUrl.searchParams.get("room") ?? "";
  if (!ROOM_PATTERN.test(room)) return jsonError("invalid", 400);
  const since = Math.max(0, Math.trunc(Number(req.nextUrl.searchParams.get("since") ?? "0")) || 0);
  boot(); // the stage sweep (auto-save + close) runs in this process
  try {
    await checkAccess(room, session.email, "read");
    return NextResponse.json(stageState(room, since), { headers: NO_STORE });
  } catch (e) {
    return stageErrorResponse(e, "get");
  }
}
