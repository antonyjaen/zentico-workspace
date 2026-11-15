import { NextResponse, type NextRequest } from "next/server";
import { seal } from "@/lib/crypto";
import { appRoot, buildAuthorizeUrl, safeLoginHint, safeReturnTo } from "@/lib/oidc";
import { cookieOptions, TX_COOKIE } from "@/lib/session";

/**
 * Starts an OIDC sign-in. `?add=1` signs in an additional account (kept alongside the others);
 * `?hint=<email>` re-authenticates a specific account.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const add = params.get("add") === "1";
  // An added account lands on the app root: deeper URLs hold the previous account's ids.
  const returnTo = add ? appRoot(params.get("returnTo")) : safeReturnTo(params.get("returnTo"));
  const loginHint = safeLoginHint(params.get("hint"));
  const { url, tx } = await buildAuthorizeUrl(returnTo, { add, loginHint });
  const res = NextResponse.redirect(url);
  res.cookies.set(TX_COOKIE, await seal(tx), cookieOptions(60 * 30));
  return res;
}
