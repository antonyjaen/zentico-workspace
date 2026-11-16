// The fixed escape hatch of Zentico UI, used by the /ui-safe page (plain HTML forms, so it works
// even when the workspace UI itself is unusable). POST (form) with:
//   op=restore  → "Restore default UI" (current files backed up first; undoable), leaves safe mode
//   op=on | off → safe mode in this browser: the workspace renders without theme / shell customization
import { getLocale } from "next-intl/server";
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { jsonError, sameOrigin } from "@/lib/meetings/http";
import { restoreDefaultUi } from "@/lib/ui/service";
import { SAFE_COOKIE, SAFE_PATH } from "@/lib/ui/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  let op = "";
  try {
    op = String((await req.formData()).get("op") ?? "");
  } catch {
    return jsonError("invalid", 400);
  }
  if (op !== "restore" && op !== "on" && op !== "off") return jsonError("invalid", 400);
  if (op === "restore") await restoreDefaultUi(session, await getLocale());
  const res = NextResponse.redirect(`${env.appUrl}${op === "on" ? "/" : op === "off" ? "/" : `${SAFE_PATH}?restored=1`}`, 303);
  if (op === "on") res.cookies.set(SAFE_COOKIE, "1", { path: "/", httpOnly: true, sameSite: "lax", secure: env.appUrl.startsWith("https:"), maxAge: 7 * 24 * 3600 });
  else res.cookies.delete(SAFE_COOKIE);
  return res;
}
