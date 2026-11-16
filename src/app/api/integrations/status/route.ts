// Live Claude connection status for Settings → Integrations (tokens' last use, bridge presence).
// Polled with fetch every few seconds while that page is visible — never a server action.
import { NextResponse } from "next/server";
import { claudeStatus } from "@/app/(apps)/settings/integrations/status";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(claudeStatus(session), { headers: { "Cache-Control": "no-store" } });
}
