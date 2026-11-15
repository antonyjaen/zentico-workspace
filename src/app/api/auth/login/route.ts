import { NextResponse, type NextRequest } from "next/server";
import { seal } from "@/lib/crypto";
import { buildAuthorizeUrl, safeReturnTo } from "@/lib/oidc";
import { cookieOptions, TX_COOKIE } from "@/lib/session";

export async function GET(req: NextRequest) {
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get("returnTo"));
  const { url, tx } = await buildAuthorizeUrl(returnTo);
  const res = NextResponse.redirect(url);
  res.cookies.set(TX_COOKIE, await seal(tx), cookieOptions(60 * 10));
  return res;
}
