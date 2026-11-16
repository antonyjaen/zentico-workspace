import { NextResponse, type NextRequest } from "next/server";
import { findDelegated } from "@/lib/delegation";
import { env } from "@/lib/env";
import { fetchJmapSession } from "@/lib/jmap";
import { exceedsLifetime } from "@/lib/security/store";
import { appRoot, isSameOrigin } from "@/lib/oidc";
import {
  ACTING_COOKIE,
  ACTIVE_COOKIE,
  isSignedOut,
  needsRefresh,
  parseSlot,
  promote,
  readAccounts,
  refreshSession,
  sealSession,
  serializeActing,
  serializeOrder,
  slotCookie,
  writeCookie,
} from "@/lib/session";

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * Makes another signed-in account active (form POST: `slot`, `returnTo`). Lands on the root of
 * the current app, since deeper URLs hold the previous account's mailbox/thread/file ids. If
 * the account's refresh token no longer works, it is marked signed out and re-authenticated.
 * With `account`, the slot's sign-in acts as that delegated JMAP account, but only when the
 * slot's own JMAP session lists it (lib/delegation); otherwise nothing changes.
 */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData().catch(() => null);
  const slot = parseSlot(form?.get("slot"));
  const accountValue = form?.get("account");
  const account = typeof accountValue === "string" && ACCOUNT_ID.test(accountValue) ? accountValue : null;
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
  let current = session;
  if (needsRefresh(session)) {
    try {
      current = await refreshSession(session);
      writeCookie(res, slotCookie(slot), await sealSession(current));
    } catch {
      const failed = reauth();
      writeCookie(failed, slotCookie(slot), await sealSession({ ...session, stale: true }));
      return failed;
    }
  }
  if (account) {
    const jmap = await fetchJmapSession(current.accessToken).catch(() => null);
    if (!jmap || !findDelegated(jmap, account)) return res;
  }
  writeCookie(res, ACTIVE_COOKIE, serializeOrder(promote(accounts.order, slot)));
  writeCookie(res, ACTING_COOKIE, account && serializeActing(slot, account));
  return res;
}
