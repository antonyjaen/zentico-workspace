// Pages pinned to the app rail and keyboard bindings of the signed-in user (from the stored UI,
// no Drive call): GET → UiShell.
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { jsonError, NO_STORE } from "@/lib/ui/http";
import { shellOf } from "@/lib/ui/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  return NextResponse.json(shellOf(session.email), { headers: NO_STORE });
}
