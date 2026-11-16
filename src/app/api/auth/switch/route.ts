import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { exceedsLifetime } from "@/lib/security/store";
import { appRoot, isSameOrigin } from "@/lib/oidc";
import {
  ACTIVE_COOKIE,
  isSignedOut,
  needsRefresh,
  parseSlot,
  promote,
  readAccounts,
  refreshSession,
  sealSession,
  serializeOrder,
  slotCookie,
  writeCookie,
} from "@/lib/session";

/**
 * Makes another signed-in account active (form POST: `slot`, `returnTo`). Lands on the root of
 * the current app, since deeper URLs hold the previous account's mailbox/thread/file ids. If
 * the account's refresh token no longer works, it is marked signed out and re-authenticated.
 */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData().catch(() => null);
  const slot = parseSlot(form?.get("slot"));
  const returnValue = form?.get("returnTo");
  const target = appRoot(typeof returnValue === "string" ? returnValue : null);
  const redirect = (path: string) => NextResponse.redirect(`${env.appUrl}${path}`, 303);

  const accounts = await readAccounts(req.cookies);
  const session = slot === null ? null : accounts.sessions[slot];
  if (slot === null || !session) return redirect(target);

  const reauth = () =>
    redirect(
      `/api/auth/login?add=1&hint=${encodeURIComponent(session.email)}&returnTo=${encodeURIComponent(target)}`,
    );
  // Past the workspace session lifetime counts as signed out too (fresh sign-in via the hint).
  if (isSignedOut(session) || exceedsLifetime(session.signedInAt)) return reauth();

  const res = redirect(target);
  if (needsRefresh(session)) {
    try {
      writeCookie(res, slotCookie(slot), await sealSession(await refreshSession(session)));
    } catch {
      const failed = reauth();
      writeCookie(failed, slotCookie(slot), await sealSession({ ...session, stale: true }));
      return failed;
    }
  }
  writeCookie(res, ACTIVE_COOKIE, serializeOrder(promote(accounts.order, slot)));
  return res;
}
