import { NextResponse, type NextRequest } from "next/server";
import { getSession, getSessionForSetup } from "@/lib/auth";
import { seal } from "@/lib/crypto";
import { env } from "@/lib/env";
import { appRoot, buildAuthorizeUrl, safeLoginHint, safeReturnTo } from "@/lib/oidc";
import { cookieOptions, TX_COOKIE } from "@/lib/session";

/**
 * Starts an OIDC sign-in. `?add=1` signs in an additional account (kept alongside the others),
 * plus `&keep=1` to leave the current account active and return to `returnTo` (Mail → add account);
 * `?hint=<email>` re-authenticates a specific account; `?mcp=1` starts the one-off authorization
 * that lets Settings → Integrations create the Stalwart API key behind an MCP token;
 * `?security=check|manage` starts the security grant used by Settings → Security and the 2FA policy
 * check after sign-in (`manage` asks for a fresh sign-in).
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const security = params.get("security");
  if (security === "check" || security === "manage") {
    // Also allowed while the account is held back by the 2FA policy: it's how setup starts.
    const session = await getSessionForSetup();
    if (!session) return NextResponse.redirect(`${env.appUrl}/signin`);
    const returnTo = safeReturnTo(params.get("returnTo") ?? "/settings/security");
    const { url, tx } = await buildAuthorizeUrl(returnTo, { security, loginHint: safeLoginHint(session.email) });
    const res = NextResponse.redirect(url);
    res.cookies.set(TX_COOKIE, await seal(tx), cookieOptions(60 * 30));
    return res;
  }
  if (params.get("mcp") === "1") {
    const session = await getSession();
    if (!session) return NextResponse.redirect(`${env.appUrl}/signin`);
    // Calendar → Booking pages creates its API key through the same authorization.
    const back = params.get("returnTo") === "/calendar/booking" ? "/calendar/booking" : "/settings/integrations";
    const { url, tx } = await buildAuthorizeUrl(back, { mcp: true, loginHint: safeLoginHint(session.email) });
    const res = NextResponse.redirect(url);
    res.cookies.set(TX_COOKIE, await seal(tx), cookieOptions(60 * 30));
    return res;
  }
  const add = params.get("add") === "1";
  const keep = add && params.get("keep") === "1";
  // An added account that becomes active lands on the app root: deeper URLs hold the previous
  // account's ids. With keep the active account (and its ids) stays, so returnTo is kept.
  const returnTo = add && !keep ? appRoot(params.get("returnTo")) : safeReturnTo(params.get("returnTo"));
  const loginHint = safeLoginHint(params.get("hint"));
  const { url, tx } = await buildAuthorizeUrl(returnTo, { add, keep, loginHint });
  const res = NextResponse.redirect(url);
  res.cookies.set(TX_COOKIE, await seal(tx), cookieOptions(60 * 30));
  return res;
}
