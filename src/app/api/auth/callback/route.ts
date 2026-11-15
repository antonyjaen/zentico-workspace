import { NextResponse, type NextRequest } from "next/server";
import { unseal } from "@/lib/crypto";
import { env } from "@/lib/env";
import { exchangeCode, fetchUserInfo, safeReturnTo, type AuthTransaction } from "@/lib/oidc";
import {
  cookieOptions,
  sealSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  sessionFromTokens,
  TX_COOKIE,
} from "@/lib/session";

function fail(reason: string) {
  const res = NextResponse.redirect(`${env.appUrl}/signin?error=${encodeURIComponent(reason)}`);
  res.cookies.delete(TX_COOKIE);
  return res;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail(params.get("error") ?? "denied");

  const tx = await unseal<AuthTransaction>(req.cookies.get(TX_COOKIE)?.value);
  const code = params.get("code");
  if (!tx || !code || params.get("state") !== tx.state) return fail("invalid_state");

  try {
    const tokens = await exchangeCode(code, tx.verifier);
    const user = await fetchUserInfo(tokens.access_token);
    const session = sessionFromTokens(tokens, user);

    const res = NextResponse.redirect(`${env.appUrl}${safeReturnTo(tx.returnTo)}`);
    res.cookies.delete(TX_COOKIE);
    res.cookies.set(SESSION_COOKIE, await sealSession(session), cookieOptions(SESSION_MAX_AGE));
    return res;
  } catch (error) {
    console.error("[auth] callback failed:", error instanceof Error ? error.message : error);
    return fail("login_failed");
  }
}
