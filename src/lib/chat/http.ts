// Small helpers for the Chat route handlers. Server-only.
import { NextResponse, type NextRequest } from "next/server";
import { env } from "../env";

/** Rejects cross-site state-changing requests (cookies are SameSite=Lax, this is belt and braces). */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return origin === req.nextUrl.origin || origin === new URL(env.appUrl).origin;
  } catch {
    return origin === req.nextUrl.origin;
  }
}

export const jsonError = (error: string, status: number) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
