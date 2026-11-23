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
 * Guards every app page: requires an active account and silently refreshes the expiring access
 * tokens of every signed-in account (the mail app reads the other accounts' mailboxes too). A slot
 * whose refresh fails is marked signed out; when that is the active one, it signs in again.
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

  // Refresh every occupied slot whose token is about to expire, in parallel.
  const results = await Promise.all(
    accounts.order.map(async (s) => {
      const current = accounts.sessions[s]!;
      if (current.stale || !needsRefresh(current)) return true;
      try {
        change(slotCookie(s), await sealSession(await refreshSession(current)));
        return true;
      } catch {
        const stale: Session = { ...current, stale: true };
        change(slotCookie(s), await sealSession(stale));
        return false;
      }
    }),
  );
  // order[0] is the active slot.
  return results[0] ? pass() : toSignin(session.email);
}

export const config = {
  // Everything except sign-in, auth endpoints, the public workspace-info probe (desktop/mobile apps),
  // WOPI (Collabora, token-authenticated), MCP (personal access tokens), the Claude bridge endpoints
  // (/api/agent, same tokens), Chat incoming webhooks and the app API (/api/chat/hooks, /api/chat/bots:
  // their own keys/tokens), public booking pages and their API (/book, /api/book: guests have no
  // account), Next internals and static files.
  matcher: ["/((?!signin|download(?:/|$)|bridge\\.mjs$|api/auth|api/wopi|api/workspace-info$|api/mcp|api/agent/|api/chat/hooks/|api/chat/bots/|book/|api/book/|_next/|favicon|icon|.*\\.(?:svg|png|jpg|ico|webp|woff2?)$).*)"],
};
