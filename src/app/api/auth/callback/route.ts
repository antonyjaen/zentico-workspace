import { NextResponse, type NextRequest } from "next/server";
import { getSession, getSessionForSetup } from "@/lib/auth";
import { seal, unseal } from "@/lib/crypto";
import { env } from "@/lib/env";
import { exchangeCode, fetchUserInfo, revokeGrant, safeReturnTo, type AuthTransaction } from "@/lib/oidc";
import { otpEnabled } from "@/lib/security/stalwart";
import { getPolicy, isGated, recordStatus } from "@/lib/security/store";
import {
  ACTING_COOKIE,
  ACTIVE_COOKIE,
  SECURITY_COOKIE,
  SECURITY_MAX_AGE,
  type SecurityGrant,
  freeSlot,
  LEGACY_SESSION_COOKIE,
  MCP_SETUP_COOKIE,
  MCP_SETUP_MAX_AGE,
  cookieOptions,
  type McpSetup,
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

/**
 * Back to Settings → Integrations after the MCP setup authorization (`mcp=ok` or `mcp_error=…`), or
 * to Calendar → Booking pages when that is where it was started (its API key is made the same way).
 */
function integrations(result: { ok: true } | { error: string }, returnTo?: string) {
  const q = "ok" in result ? "mcp=ok" : `mcp_error=${encodeURIComponent(result.error.slice(0, 40))}`;
  const page = returnTo === "/calendar/booking" ? returnTo : "/settings/integrations";
  const res = NextResponse.redirect(`${env.appUrl}${page}?${q}`);
  res.cookies.delete(TX_COOKIE);
  return res;
}

/**
 * Completes the MCP setup authorization: keeps its access token in a short-lived sealed cookie for
 * the Integrations page to create the API key with. The account cookies are left untouched.
 */
async function mcpCallback(tx: AuthTransaction, code: string) {
  try {
    const tokens = await exchangeCode(code, tx.verifier);
    const [user, active] = await Promise.all([fetchUserInfo(tokens.access_token), getSession()]);
    if (!active || !sameAccount(active, { sub: user.sub, email: user.email ?? "" })) {
      await revokeGrant(tokens.access_token);
      return integrations({ error: "account_mismatch" }, tx.returnTo);
    }
    const setup: McpSetup = {
      sub: active.sub,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + Math.min(tokens.expires_in ?? 3600, MCP_SETUP_MAX_AGE) * 1000,
    };
    const res = integrations({ ok: true }, tx.returnTo);
    res.cookies.set(MCP_SETUP_COOKIE, await seal(setup), cookieOptions(MCP_SETUP_MAX_AGE));
    return res;
  } catch (error) {
    console.error("[auth] MCP setup callback failed:", error instanceof Error ? error.message : error);
    return integrations({ error: "failed" }, tx.returnTo);
  }
}

/**
 * Where a failed security grant lands: the page that asked for it, or (for the check after
 * sign-in) the setup page when the policy holds the account back, else the original destination.
 */
async function securityFailed(tx: AuthTransaction, error: string) {
  const returnTo = safeReturnTo(tx.returnTo);
  const q = `error=${encodeURIComponent(error.slice(0, 40))}`;
  const active = await getSessionForSetup();
  let target = returnTo;
  if (returnTo.startsWith("/settings/security") || returnTo.startsWith("/signin/security")) target = `${returnTo.split("?")[0]}?${q}`;
  else if (active && isGated(active.sub)) target = `/signin/security?${q}`;
  const res = NextResponse.redirect(`${env.appUrl}${target}`);
  res.cookies.delete(TX_COOKIE);
  return res;
}

/**
 * Completes the security grant: reads whether TOTP is on in Stalwart (recorded for the workspace
 * 2FA policy) and keeps the token for 10 minutes for Settings → Security. Account cookies untouched.
 */
async function securityCallback(tx: AuthTransaction, code: string) {
  try {
    const tokens = await exchangeCode(code, tx.verifier);
    const [user, active] = await Promise.all([fetchUserInfo(tokens.access_token), getSessionForSetup()]);
    if (!active || !sameAccount(active, { sub: user.sub, email: user.email ?? "" })) {
      await revokeGrant(tokens.access_token);
      return securityFailed(tx, "account_mismatch");
    }
    recordStatus(active.sub, active.email, await otpEnabled(tokens.access_token));
    const grant: SecurityGrant = {
      sub: active.sub,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + Math.min(tokens.expires_in ?? 3600, SECURITY_MAX_AGE) * 1000,
      stepUp: tx.security === "manage",
    };
    const target = isGated(active.sub) ? "/signin/security" : safeReturnTo(tx.returnTo);
    const res = NextResponse.redirect(`${env.appUrl}${target}`);
    res.cookies.delete(TX_COOKIE);
    res.cookies.set(SECURITY_COOKIE, await seal(grant), cookieOptions(SECURITY_MAX_AGE));
    return res;
  } catch (error) {
    console.error("[auth] security callback failed:", error instanceof Error ? error.message : error);
    return securityFailed(tx, "failed");
  }
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const tx = await unseal<AuthTransaction>(req.cookies.get(TX_COOKIE)?.value);
  if (params.get("error")) {
    const error = params.get("error") ?? "denied";
    if (tx?.security) return securityFailed(tx, error);
    return tx?.mcp ? integrations({ error }, tx.returnTo) : fail(error);
  }

  const code = params.get("code");
  if (!tx || !code || params.get("state") !== tx.state) return fail("invalid_state");
  if (tx.mcp) return mcpCallback(tx, code);
  if (tx.security) return securityCallback(tx, code);

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

    // With the workspace 2FA policy on, read the account's TOTP status fresh at every sign-in (a
    // silent security grant on the provider's single sign-on session) before letting it in.
    const returnTo = safeReturnTo(tx.returnTo);
    const res = NextResponse.redirect(
      getPolicy().required
        ? `${env.appUrl}/api/auth/login?security=check&returnTo=${encodeURIComponent(returnTo)}`
        : `${env.appUrl}${returnTo}`,
    );
    res.cookies.delete(TX_COOKIE);
    res.cookies.delete(SECURITY_COOKIE);
    writeCookie(res, slotCookie(slot), sealed);
    writeCookie(res, ACTIVE_COOKIE, serializeOrder(promote(accounts.order, slot)));
    // A fresh sign-in lands on the account itself, not on a delegated account it can act as.
    if (req.cookies.has(ACTING_COOKIE)) writeCookie(res, ACTING_COOKIE, null);
    if (req.cookies.has(LEGACY_SESSION_COOKIE)) writeCookie(res, LEGACY_SESSION_COOKIE, null);
    return res;
  } catch (error) {
    console.error("[auth] callback failed:", error instanceof Error ? error.message : error);
    return fail("login_failed");
  }
}
