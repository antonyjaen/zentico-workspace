// The signed-in user's dashboard.
// GET → { doc, undo }   (undo = steps available)
// POST { ops: DashOp[] } | { action: "undo" | "reset" } → { doc, undo, added? }
// Edits are validated strictly (src/app/(apps)/dashboard/model.ts) and published to the user's
// open dashboards (SSE, /api/dashboard/events).
import { getLocale } from "next-intl/server";
import { NextResponse, type NextRequest } from "next/server";
import { DashError } from "@/app/(apps)/dashboard/model";
import { getSession } from "@/lib/auth";
import { editDashboard, getDashboard, resetDashboard, undoCount, undoDashboard } from "@/lib/dashboard/store";
import { parseOp } from "@/app/(apps)/dashboard/model";
import { jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 1024 * 1024;

export async function GET() {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  const doc = getDashboard(session.email, await getLocale());
  return NextResponse.json({ doc, undo: undoCount(session.email) }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) return jsonError("too_large", 413);
  let body: { ops?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError("invalid", 400);
  }
  const locale = await getLocale();
  try {
    if (body.action === "undo") {
      const doc = undoDashboard(session.email, locale);
      if (!doc) return jsonError("nothing_to_undo", 409);
      return NextResponse.json({ doc, undo: undoCount(session.email) }, { headers: NO_STORE });
    }
    if (body.action === "reset") {
      const doc = resetDashboard(session.email, locale);
      return NextResponse.json({ doc, undo: undoCount(session.email) }, { headers: NO_STORE });
    }
    if (!Array.isArray(body.ops) || !body.ops.length || body.ops.length > 50) return jsonError("invalid", 400);
    const { doc, added } = editDashboard(session.email, body.ops.map(parseOp), locale);
    return NextResponse.json({ doc, added, undo: undoCount(session.email) }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof DashError) return NextResponse.json({ error: "invalid", message: e.message }, { status: 400, headers: NO_STORE });
    console.error("[dashboard] edit:", e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}
