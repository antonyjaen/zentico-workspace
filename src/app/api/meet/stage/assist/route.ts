// POST { room, action: "start" | "pause" | "resume" | "stop", modes? } → { assist }: the proactive
// assistant that keeps the stage up to date from the meeting's speech. Resume and stop belong to the
// person who started it (their agent does the work); anyone in the call may pause it.
import { NextResponse, type NextRequest } from "next/server";
import { ASSIST_MODES, type AssistMode } from "@/app/(apps)/meet/stage-types";
import { hasWriteToken } from "@/lib/meetings/claude-commands";
import { jsonError, NO_STORE } from "@/lib/meetings/http";
import { controlAssist, startAssist, StageError, takeRate } from "@/lib/meetings/stage";
import { readPost, stageErrorResponse } from "@/lib/meetings/stage-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACTIONS = ["start", "pause", "resume", "stop"] as const;

export async function POST(req: NextRequest) {
  const read = await readPost<{ room?: unknown; action?: unknown; modes?: unknown }>(req, 4096);
  if (read instanceof NextResponse) return read;
  const { session, room, body } = read;
  const action = ACTIONS.find((a) => a === body.action);
  if (!action) return jsonError("invalid", 400);
  try {
    if (!takeRate(`assist:${session.email}`, 20, 60_000)) throw new StageError("rate_limited", "Too many requests");
    const actor = { email: session.email, name: session.name, kind: "user" as const };
    if (action === "start") {
      if (!hasWriteToken(session.sub)) return jsonError("no_token", 412);
      const modes = Array.isArray(body.modes) ? body.modes.filter((m): m is AssistMode => ASSIST_MODES.includes(m as AssistMode)) : [];
      return NextResponse.json({ assist: await startAssist(room, actor, modes) }, { headers: NO_STORE });
    }
    return NextResponse.json({ assist: await controlAssist(room, actor, action) }, { headers: NO_STORE });
  } catch (e) {
    return stageErrorResponse(e, "assist");
  }
}
