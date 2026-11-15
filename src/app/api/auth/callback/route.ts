import { NextResponse, type NextRequest } from "next/server";
import { unseal } from "@/lib/crypto";
import { env } from "@/lib/env";
import { exchangeCode, fetchUserInfo, safeReturnTo, type AuthTransaction } from "@/lib/oidc";
import {
  ACTIVE_COOKIE,
  freeSlot,
  LEGACY_SESSION_COOKIE,
  promote,
  readAccounts,
  sameAccount,
  sealSession,
  serializeOrder,
  sessionFromTokens,
  slotCookie,
  TX_COOKIE,
  writeCookie,
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

    // Pick the slot: an account that is already signed in is updated in place; otherwise an
    // added account takes a free slot (or the least recently used one), and a plain sign-in
    // replaces the active account.
    const accounts = await readAccounts(req.cookies);
    const existing = accounts.order.find((slot) => sameAccount(accounts.sessions[slot]!, session));
    const slot = existing ?? (tx.add || !accounts.order.length ? freeSlot(accounts) : accounts.order[0]);
    const sealed = await sealSession(session);
    if (sealed.length > 3800) console.warn(`[auth] session cookie is ${sealed.length} bytes (limit ~4096)`);

    const res = NextResponse.redirect(`${env.appUrl}${safeReturnTo(tx.returnTo)}`);
    res.cookies.delete(TX_COOKIE);
    writeCookie(res, slotCookie(slot), sealed);
    writeCookie(res, ACTIVE_COOKIE, serializeOrder(promote(accounts.order, slot)));
    if (req.cookies.has(LEGACY_SESSION_COOKIE)) writeCookie(res, LEGACY_SESSION_COOKIE, null);
    return res;
  } catch (error) {
    console.error("[auth] callback failed:", error instanceof Error ? error.message : error);
    return fail("login_failed");
  }
}
