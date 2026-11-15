import { NextResponse, type NextRequest } from "next/server";
import { fetchUserInfo, refreshTokens } from "@/lib/oidc";
import {
  cookieOptions,
  needsRefresh,
  sealSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  sessionFromTokens,
  unsealSession,
} from "@/lib/session";

/** Guards every app page: requires a session and silently refreshes expiring access tokens. */
export async function middleware(req: NextRequest) {
  const toSignin = () => {
    const url = new URL("/signin", req.url);
    url.searchParams.set("returnTo", req.nextUrl.pathname + req.nextUrl.search);
    const res = NextResponse.redirect(url);
    res.cookies.delete(SESSION_COOKIE);
    return res;
  };

  const session = await unsealSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return toSignin();
  if (!needsRefresh(session)) return NextResponse.next();
  if (!session.refreshToken) return toSignin();

  try {
    const tokens = await refreshTokens(session.refreshToken);
    const user = await fetchUserInfo(tokens.access_token);
    const sealed = await sealSession(sessionFromTokens(tokens, user, session));

    // Forward the fresh cookie to this request's server components and persist it in the browser.
    req.cookies.set(SESSION_COOKIE, sealed);
    const res = NextResponse.next({ request: { headers: new Headers(req.headers) } });
    res.cookies.set(SESSION_COOKIE, sealed, cookieOptions(SESSION_MAX_AGE));
    return res;
  } catch {
    return toSignin();
  }
}

export const config = {
  // Everything except sign-in, auth endpoints, WOPI (Collabora, token-authenticated), MCP (personal
  // access tokens), Next internals and static files.
  matcher: ["/((?!signin|api/auth|api/wopi|api/mcp|_next/|favicon|icon|.*\\.(?:svg|png|jpg|ico|webp|woff2?)$).*)"],
};
