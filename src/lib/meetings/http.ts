// Helpers for the /api/meet/recordings route handlers. Server-only.
import { NextResponse, type NextRequest } from "next/server";
import { env } from "../env";
import { RecordingError } from "./store";

export const NO_STORE = { "Cache-Control": "private, no-store" };

export const jsonError = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/** Rejects cross-site state-changing requests (cookies are SameSite=Lax; this is belt and braces). */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return origin === req.nextUrl.origin || origin === new URL(env.appUrl).origin;
  } catch {
    return origin === req.nextUrl.origin;
  }
}

const STATUS: Record<RecordingError["code"], number> = {
  not_found: 404,
  forbidden: 403,
  busy: 409,
  not_recording: 410,
  too_large: 413,
  out_of_order: 409,
  invalid: 400,
};

export function errorResponse(e: unknown, where: string) {
  if (e instanceof RecordingError) return jsonError(e.code, STATUS[e.code]);
  console.error(`[meetings] ${where}:`, e instanceof Error ? e.message : e);
  return jsonError("failed", 500);
}
