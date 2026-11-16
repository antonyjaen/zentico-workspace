// Shared bits of the public app endpoints (/api/chat/hooks, /api/chat/bots): bounded JSON bodies,
// JSON errors and the message summary they return. Server-only.
import type { ChatMessage } from "@/app/(apps)/chat/shared";

export const MAX_BODY_BYTES = 32 * 1024;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** Reads a JSON body of at most MAX_BODY_BYTES (null + response on failure). */
export async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return { ok: false, res: json({ error: "too_large" }, 413) };
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, res: json({ error: "invalid" }, 400) };
  }
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return { ok: false, res: json({ error: "too_large" }, 413) };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, res: json({ error: "invalid_json" }, 400) };
  }
}

export const messageSummary = (m: ChatMessage) => ({
  id: m.id,
  conversationId: m.conversationId,
  threadRoot: m.threadRoot,
  createdAt: new Date(m.created).toISOString(),
});
