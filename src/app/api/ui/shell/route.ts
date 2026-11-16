// Pages pinned to the app rail, keyboard bindings, shell prefs and workspace theme of the signed-in
// user (from the stored UI, no Drive call; defaults in safe mode): GET → UiShell.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { jsonError, NO_STORE } from "@/lib/ui/http";
import { shellOf } from "@/lib/ui/service";
import { SAFE_COOKIE } from "@/lib/ui/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  const safe = (await cookies()).get(SAFE_COOKIE)?.value === "1";
  return NextResponse.json(shellOf(session.email, safe), { headers: NO_STORE });
}
