import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { seal } from "@/lib/crypto";
import { env } from "@/lib/env";
import { appRoot, buildAuthorizeUrl, safeLoginHint, safeReturnTo } from "@/lib/oidc";
import { cookieOptions, TX_COOKIE } from "@/lib/session";

/**
 * Starts an OIDC sign-in. `?add=1` signs in an additional account (kept alongside the others);
 * `?hint=<email>` re-authenticates a specific account; `?mcp=1` starts the one-off authorization
 * that lets Settings → Integrations create the Stalwart API key behind an MCP token.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get("mcp") === "1") {
    const session = await getSession();
    if (!session) return NextResponse.redirect(`${env.appUrl}/signin`);
    const { url, tx } = await buildAuthorizeUrl("/settings/integrations", { mcp: true, loginHint: safeLoginHint(session.email) });
    const res = NextResponse.redirect(url);
    res.cookies.set(TX_COOKIE, await seal(tx), cookieOptions(60 * 30));
    return res;
  }
  const add = params.get("add") === "1";
  // An added account lands on the app root: deeper URLs hold the previous account's ids.
  const returnTo = add ? appRoot(params.get("returnTo")) : safeReturnTo(params.get("returnTo"));
  const loginHint = safeLoginHint(params.get("hint"));
  const { url, tx } = await buildAuthorizeUrl(returnTo, { add, loginHint });
  const res = NextResponse.redirect(url);
  res.cookies.set(TX_COOKIE, await seal(tx), cookieOptions(60 * 30));
  return res;
}
