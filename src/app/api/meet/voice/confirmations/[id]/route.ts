// Approve / Reject a write action that the signed-in user's own Claude wants to run:
// { decision: "approve" | "reject" }. Only the user's own pending confirmations can be decided.
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { decideConfirmation } from "@/lib/mcp/agent";
import { COMMAND_ID } from "@/app/(apps)/meet/claude";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  const { id } = await params;
  if (!COMMAND_ID.test(id)) return jsonError("not_found", 404);
  let body: { decision?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError("invalid", 400);
  }
  if (body.decision !== "approve" && body.decision !== "reject") return jsonError("invalid", 400);
  const ok = decideConfirmation(id, session.email, body.decision === "approve");
  if (!ok) return jsonError("gone", 410);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
