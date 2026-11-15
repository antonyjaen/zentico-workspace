import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { appRoot, getDiscovery, isSameOrigin } from "@/lib/oidc";
import {
  ACTIVE_COOKIE,
  LEGACY_SESSION_COOKIE,
  readAccounts,
  serializeOrder,
  slotCookie,
  SLOTS,
  writeCookie,
} from "@/lib/session";

/**
 * Signs out the active account (`scope=current`, default), activating the most recently used
 * remaining one, or every account (`scope=all`). When no account is left, the provider's
 * session is ended too.
 */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData().catch(() => null);
  const all = form?.get("scope") === "all";
  const returnValue = form?.get("returnTo");
  const accounts = await readAccounts(req.cookies);
  const remaining = all ? [] : accounts.order.slice(1);

  if (remaining.length) {
    const res = NextResponse.redirect(
      `${env.appUrl}${appRoot(typeof returnValue === "string" ? returnValue : null)}`,
      303,
    );
    writeCookie(res, slotCookie(accounts.order[0]), null);
    writeCookie(res, ACTIVE_COOKIE, serializeOrder(remaining));
    return res;
  }

  let target = `${env.appUrl}/signin`;
  try {
    const { end_session_endpoint } = await getDiscovery();
    if (end_session_endpoint) {
      const url = new URL(end_session_endpoint);
      url.searchParams.set("client_id", env.clientId);
      url.searchParams.set("post_logout_redirect_uri", target);
      target = url.toString();
    }
  } catch {
    // Provider unreachable: still clear the local sessions.
  }
  const res = NextResponse.redirect(target, 303);
  for (const slot of SLOTS) {
    if (req.cookies.has(slotCookie(slot))) writeCookie(res, slotCookie(slot), null);
  }
  writeCookie(res, ACTIVE_COOKIE, null);
  writeCookie(res, LEGACY_SESSION_COOKIE, null);
  return res;
}
