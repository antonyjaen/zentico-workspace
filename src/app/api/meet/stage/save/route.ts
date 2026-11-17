// POST { room } → SavedStage: saves the stage to the signed-in user's Drive now (whiteboards as
// .excalidraw, cards as Markdown) and shares it read-only with the meeting's people.
import { NextResponse, type NextRequest } from "next/server";
import { NO_STORE } from "@/lib/meetings/http";
import { checkAccess, StageError, stageExists, takeRate } from "@/lib/meetings/stage";
import { saveStageNow } from "@/lib/meetings/stage-save";
import { readPost, stageErrorResponse } from "@/lib/meetings/stage-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const read = await readPost<{ room?: unknown }>(req, 1024);
  if (read instanceof NextResponse) return read;
  const { session, room } = read;
  try {
    if (!takeRate(`save:${session.email}`, 6, 60_000)) throw new StageError("rate_limited", "Too many saves");
    await checkAccess(room, session.email, "write");
    if (!stageExists(room)) throw new StageError("not_found", "Nothing on the stage yet");
    return NextResponse.json(await saveStageNow(room, session.email), { headers: NO_STORE });
  } catch (e) {
    return stageErrorResponse(e, "save");
  }
}
