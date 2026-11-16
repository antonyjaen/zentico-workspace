import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { seal, unseal } from "@/lib/crypto";
import { env } from "@/lib/env";
import { exchangeCode, fetchUserInfo, revokeGrant, safeReturnTo, type AuthTransaction } from "@/lib/oidc";
import {
  ACTIVE_COOKIE,
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

/** Back to Settings → Integrations after the MCP setup authorization (`mcp=ok` or `mcp_error=…`). */
function integrations(result: { ok: true } | { error: string }) {
  const q = "ok" in result ? "mcp=ok" : `mcp_error=${encodeURIComponent(result.error.slice(0, 40))}`;
  const res = NextResponse.redirect(`${env.appUrl}/settings/integrations?${q}`);
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
      return integrations({ error: "account_mismatch" });
    }
    const setup: McpSetup = {
      sub: active.sub,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + Math.min(tokens.expires_in ?? 3600, MCP_SETUP_MAX_AGE) * 1000,
    };
    const res = integrations({ ok: true });
    res.cookies.set(MCP_SETUP_COOKIE, await seal(setup), cookieOptions(MCP_SETUP_MAX_AGE));
    return res;
  } catch (error) {
    console.error("[auth] MCP setup callback failed:", error instanceof Error ? error.message : error);
    return integrations({ error: "failed" });
  }
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const tx = await unseal<AuthTransaction>(req.cookies.get(TX_COOKIE)?.value);
  if (params.get("error")) {
    const error = params.get("error") ?? "denied";
    return tx?.mcp ? integrations({ error }) : fail(error);
  }

  const code = params.get("code");
  if (!tx || !code || params.get("state") !== tx.state) return fail("invalid_state");
  if (tx.mcp) return mcpCallback(tx, code);

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
