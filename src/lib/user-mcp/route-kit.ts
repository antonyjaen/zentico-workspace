// Shared bits for the /api/user-mcp/* route handlers: session check, same-origin check for
// writes, JSON error bodies (never with credentials or internal details). Server-only.
import { getSession } from "../auth";
import type { Session } from "../session";
import { UserMcpError } from "./errors";
import type { McpConsentRequest, McpErrorBody } from "./types";

export function errorResponse(e: unknown, consent?: McpConsentRequest): Response {
  const err = e instanceof UserMcpError ? e : new UserMcpError("failed", "unexpected server error");
  if (!(e instanceof UserMcpError)) console.error("[user-mcp] request failed:", e instanceof Error ? e.message : "unknown error");
  const body: McpErrorBody = {
    ok: false,
    error: { code: err.code, message: err.message, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}) },
    ...(consent ? { consent } : {}),
  };
  return Response.json(body, {
    status: err.status,
    headers: { "Cache-Control": "no-store", ...(err.retryAfter ? { "Retry-After": String(err.retryAfter) } : {}) },
  });
}

export const ok = (data: object) => Response.json({ ok: true, ...data }, { headers: { "Cache-Control": "no-store" } });

export async function sessionOrThrow(): Promise<Session> {
  const s = await getSession();
  if (!s) throw new UserMcpError("unauthorized", "sign in first");
  return s;
}

/** Writes must come from our own pages as JSON (blocks cross-site form posts and simple requests). */
export function checkWriteRequest(req: Request): void {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new UserMcpError("forbidden", "cross-site request refused");
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin && origin !== process.env.APP_URL?.replace(/\/$/, "")) {
    throw new UserMcpError("forbidden", "cross-origin request refused");
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new UserMcpError("invalid_request", "send application/json");
  }
}

const MAX_BODY = 128 * 1024;

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) throw new UserMcpError("invalid_request", "request too large");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new UserMcpError("invalid_request", "request too large");
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new UserMcpError("invalid_request", "body must be a JSON object");
  }
}
