// POST { token } — called every few minutes by an open Collabora editor page: hands the browser
// session's current access token to that editing session's WOPI calls (lib/wopi.ts
// renewWopiCreds), so long sessions keep saving without the server ever refreshing a copy of the
// user's refresh token (Stalwart revokes the whole grant when a superseded copy is presented).
import { NextResponse, type NextRequest } from "next/server";
import { isSameOrigin } from "@/lib/oidc";
import { readAccounts, refreshSession, sealSession, slotCookie, writeCookie } from "@/lib/session";
import { renewWopiCreds } from "@/lib/wopi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The renewed token must outlive the next ping (the editor pings every 10 minutes). */
const MIN_VALIDITY_MS = 15 * 60_000;

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ ok: false }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof body?.token !== "string") return NextResponse.json({ ok: false }, { status: 400 });

  const { sessions, order } = await readAccounts(req.cookies);
  const slot = order[0];
  let session = slot === undefined ? null : sessions[slot];
  if (slot === undefined || !session || session.stale) return NextResponse.json({ ok: false }, { status: 401 });

  // Too close to expiry: refresh the browser session itself (its rotated refresh token goes back
  // into its cookie, exactly as the middleware does).
  let sealed: string | null = null;
  if (session.expiresAt - Date.now() < MIN_VALIDITY_MS && session.refreshToken) {
    try {
      session = await refreshSession(session);
      sealed = await sealSession(session);
    } catch {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  }

  const ok = await renewWopiCreds(body.token, {
    email: session.email,
    creds: { accessToken: session.accessToken, accessExpiresAt: session.expiresAt },
  });
  const res = NextResponse.json({ ok }, { status: ok ? 200 : 400, headers: { "Cache-Control": "no-store" } });
  if (sealed) writeCookie(res, slotCookie(slot), sealed);
  return res;
}
