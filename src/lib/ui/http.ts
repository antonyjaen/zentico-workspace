// Shared plumbing for the /api/ui/* route handlers: session + same-origin + size checks, a simple
// per-user rate limiter, error mapping, and the mod context (declared ∩ granted permissions).
// Server-only.
import { NextResponse, type NextRequest } from "next/server";
import { DashError } from "@/app/(apps)/dashboard/model";
import { getSession } from "../auth";
import { DriveError } from "../drive";
import { jsonError, NO_STORE, sameOrigin } from "../meetings/http";
import type { Session } from "../session";
import { effectivePerms, MOD_ID, type ModView, type Permission } from "./schema";
import { UiServiceError } from "./service";
import { getUiState, listGrants, StorageError } from "./store";

export { jsonError, NO_STORE };

type Gate = { session: Session; body: Record<string, unknown> } | { response: NextResponse };

/** Signed-in, same-origin JSON POST under `maxBytes`. */
export async function gate(req: NextRequest, maxBytes: number): Promise<Gate> {
  const session = await getSession();
  if (!session) return { response: jsonError("unauthorized", 401) };
  if (!sameOrigin(req)) return { response: jsonError("forbidden", 403) };
  if (Number(req.headers.get("content-length") ?? "0") > maxBytes) return { response: jsonError("too_large", 413) };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { response: jsonError("invalid", 400) };
  }
  if (Buffer.byteLength(text) > maxBytes) return { response: jsonError("too_large", 413) };
  try {
    const body = JSON.parse(text || "{}") as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return { response: jsonError("invalid", 400) };
    return { session, body: body as Record<string, unknown> };
  } catch {
    return { response: jsonError("invalid", 400) };
  }
}

const g = globalThis as typeof globalThis & { __zwUiHits?: Map<string, number[]> };
const hits = (g.__zwUiHits ??= new Map());

/** True when `key` made `limit` calls within `windowMs` (the call is not counted then). */
export function limited(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t: number) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(key, list);
    return true;
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 20_000) hits.clear();
  return false;
}

export function failure(e: unknown, where: string): NextResponse {
  if (e instanceof UiServiceError) {
    const status = e.code === "conflict" || e.code === "has_errors" ? 409 : e.code === "not_found" ? 404 : e.code === "unavailable" ? 503 : 400;
    return NextResponse.json({ error: e.code, message: e.message, errors: e.errors }, { status, headers: NO_STORE });
  }
  if (e instanceof DashError || e instanceof StorageError) return NextResponse.json({ error: "invalid", message: e.message }, { status: 400, headers: NO_STORE });
  if (e instanceof DriveError) return NextResponse.json({ error: "drive", message: e.message }, { status: 502, headers: NO_STORE });
  console.error(`[ui] ${where}:`, e instanceof Error ? e.message : e);
  return jsonError("failed", 500);
}

/** A mod of the user's current UI and the permissions it may use, or an error message. */
export function modContext(email: string, modId: unknown): { mod: ModView; perms: Permission[] } | { error: string } {
  if (typeof modId !== "string" || !MOD_ID.test(modId)) return { error: "Unknown mod" };
  const mod = getUiState(email)?.compiled?.mods[modId];
  if (!mod) return { error: "Unknown mod" };
  return { mod, perms: effectivePerms(mod, listGrants(email)[modId]) };
}
