// POST { room, ops: StageOp[] } → { rev, ids }: changes the stage as the signed-in user (who must be
// in the call). Rate-limited per user and room; the change reaches the room over LiveKit.
import { NextResponse, type NextRequest } from "next/server";
import type { StageOp } from "@/app/(apps)/meet/stage-types";
import { seal } from "@/lib/crypto";
import { NO_STORE } from "@/lib/meetings/http";
import { boot } from "@/lib/meetings/jobs";
import { applyOps, checkAccess, keepSession, OPS_RATE, StageError, takeRate } from "@/lib/meetings/stage";
import { readPost, stageErrorResponse } from "@/lib/meetings/stage-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A big paste of drawing elements fits; anything larger is refused before parsing. */
const MAX_BODY = 2 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const read = await readPost<{ room?: unknown; ops?: unknown }>(req, MAX_BODY);
  if (read instanceof NextResponse) return read;
  const { session, room, body } = read;
  boot(); // the stage sweep (auto-save + close) runs in this process
  try {
    if (!Array.isArray(body.ops)) throw new StageError("invalid", "ops must be a list");
    if (!takeRate(`ops:${session.email}:${room}`, OPS_RATE.max, OPS_RATE.windowMs)) throw new StageError("rate_limited", "Too many changes; slow down");
    await checkAccess(room, session.email, "write");
    const out = applyOps(room, { email: session.email, name: session.name, kind: "user" }, body.ops as StageOp[]);
    // Kept (sealed) so the stage can still be saved to Drive automatically after the call.
    if (out.changed) await keepSession(room, session, seal);
    return NextResponse.json({ rev: out.rev, ids: out.ids }, { headers: NO_STORE });
  } catch (e) {
    return stageErrorResponse(e, "ops");
  }
}
