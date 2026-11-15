// Opens a Drive item posted in Chat for whoever clicks it: their Docs editor for their own
// documents, the folder in Drive, or a Drive preview. Resolved with the viewer's own rights.
import { NextResponse, type NextRequest } from "next/server";
import { locate, openTarget } from "@/lib/chat/drive";
import { chatUserOrNull } from "@/lib/chat/session";
import { env } from "@/lib/env";
import { isDriveId } from "@/app/(apps)/chat/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const me = await chatUserOrNull();
  if (!me) return NextResponse.redirect(`${env.appUrl}/signin`);
  const q = req.nextUrl.searchParams;
  const id = q.get("id");
  const account = q.get("account") || null;
  if (!isDriveId(id) || (account !== null && !isDriveId(account))) return new Response("Invalid link", { status: 400 });
  let target = "/drive?view=shared";
  try {
    const found = await locate(account, id);
    if (found) target = await openTarget(found);
  } catch (e) {
    console.error("[chat] drive open:", e instanceof Error ? e.message : e);
  }
  return NextResponse.redirect(`${env.appUrl}${target}`, { status: 307, headers: { "Cache-Control": "private, no-store" } });
}
