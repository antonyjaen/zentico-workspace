// Shared bits of the /api/meet/stage route handlers. Server-only.
import { NextResponse, type NextRequest } from "next/server";
import { ROOM_PATTERN } from "@/app/(apps)/meet/shared";
import { getSession } from "../auth";
import type { Session } from "../session";
import { jsonError, NO_STORE, sameOrigin } from "./http";
import { StageError } from "./stage";

const STATUS: Record<StageError["code"], number> = {
  not_found: 404,
  forbidden: 403,
  limit: 413,
  invalid: 400,
  not_configured: 503,
  rate_limited: 429,
  no_bridge: 412,
  conflict: 409,
};

export function stageErrorResponse(e: unknown, where: string) {
  if (e instanceof StageError) return NextResponse.json({ error: e.code, message: e.message }, { status: STATUS[e.code], headers: NO_STORE });
  console.error(`[stage] ${where}:`, e instanceof Error ? e.message : e);
  return jsonError("failed", 500);
}

/** Session + JSON body of a state-changing stage request (same origin, JSON, size-capped). */
export async function readPost<T extends Record<string, unknown>>(
  req: NextRequest,
  maxBytes: number,
): Promise<{ session: Session; room: string; body: T } | NextResponse> {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return jsonError("unsupported_media_type", 415);
  if (Number(req.headers.get("content-length") ?? "0") > maxBytes) return jsonError("too_large", 413);
  let text: string;
  try {
    text = await req.text();
  } catch {
    return jsonError("invalid", 400);
  }
  if (text.length > maxBytes) return jsonError("too_large", 413);
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    return jsonError("invalid", 400);
  }
  const room = body && typeof body === "object" && typeof body.room === "string" ? body.room : "";
  if (!ROOM_PATTERN.test(room)) return jsonError("invalid", 400);
  return { session, room, body };
}
