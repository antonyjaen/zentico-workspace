import { NextResponse, type NextRequest } from "next/server";
import {
  ACTIVE_COOKIE,
  freeSlot,
  LEGACY_SESSION_COOKIE,
  needsRefresh,
  promote,
  readAccounts,
  refreshSession,
  sameAccount,
  sealSession,
  serializeOrder,
  slotCookie,
  SLOTS,
  unsealSession,
  type Session,
  writeCookie,
} from "@/lib/session";

/**
 * Guards every app page: requires an active account and silently refreshes its expiring access
 * token. Only the active account is refreshed; others are refreshed when switched to.
 */
export async function middleware(req: NextRequest) {
  // Cookie changes to forward to this request's server components and persist in the browser.
  const changes = new Map<string, string | null>();
  const change = (name: string, value: string | null) => {
    changes.set(name, value);
    if (value === null) req.cookies.delete(name);
    else req.cookies.set(name, value);
  };
  const finish = (res: NextResponse) => {
    for (const [name, value] of changes) writeCookie(res, name, value);
    return res;
  };
  const pass = () =>
    finish(changes.size ? NextResponse.next({ request: { headers: new Headers(req.headers) } }) : NextResponse.next());
  const toSignin = (hint?: string) => {
    const url = new URL("/signin", req.url);
    url.searchParams.set("returnTo", req.nextUrl.pathname + req.nextUrl.search);
    if (hint) url.searchParams.set("hint", hint);
    return finish(NextResponse.redirect(url));
  };

  const accounts = await readAccounts(req.cookies);
  const initialOrder = req.cookies.get(ACTIVE_COOKIE)?.value;

  // One-time migration of the single-account cookie into a slot.
  const legacyValue = req.cookies.get(LEGACY_SESSION_COOKIE)?.value;
  if (legacyValue !== undefined) {
    const legacy = await unsealSession(legacyValue);
    if (legacy) {
      const existing = accounts.order.find((slot) => sameAccount(accounts.sessions[slot]!, legacy));
      const slot = existing ?? freeSlot(accounts);
      accounts.sessions[slot] = legacy;
      accounts.order = promote(accounts.order, slot);
      change(slotCookie(slot), legacyValue);
    }
    change(LEGACY_SESSION_COOKIE, null);
  }

  if (accounts.order.length && serializeOrder(accounts.order) !== initialOrder) {
    change(ACTIVE_COOKIE, serializeOrder(accounts.order));
  }

  const slot = accounts.order[0];
  const session = slot === undefined ? null : accounts.sessions[slot];
  if (slot === undefined || !session) {
    // Drop unreadable leftovers (e.g. after a SESSION_SECRET rotation).
    for (const name of [ACTIVE_COOKIE, ...SLOTS.map(slotCookie)]) {
      if (req.cookies.has(name)) change(name, null);
    }
    return toSignin();
  }
  if (session.stale) return toSignin(session.email);
  if (!needsRefresh(session)) return pass();

  const markStale = async () => {
    const stale: Session = { ...session, stale: true };
    change(slotCookie(slot), await sealSession(stale));
    return toSignin(session.email);
  };
  try {
    change(slotCookie(slot), await sealSession(await refreshSession(session)));
    return pass();
  } catch {
    return markStale();
  }
}

export const config = {
  // Everything except sign-in, auth endpoints, WOPI (Collabora, token-authenticated), MCP (personal
  // access tokens), Next internals and static files.
  matcher: ["/((?!signin|api/auth|api/wopi|api/mcp|_next/|favicon|icon|.*\\.(?:svg|png|jpg|ico|webp|woff2?)$).*)"],
};
