// Progress and results from tools/zentico-bridge.mjs for one of the token user's own commands.
// POST (Authorization: Bearer <MCP token>) with JSON:
//   {"type":"started"} | {"type":"progress","text"} | {"type":"done","result","spoken"?} | {"type":"failed","error"}
// ("spoken": one or two short sentences read aloud in the call, ≤ SPOKEN_MAX chars.)
// → {"ok":true,"status":<command status>,"cancelled":boolean}  (cancelled = stop the run)
import { applyBridgeEvent, PROGRESS_MAX, RESULT_MAX, type BridgeEvent } from "@/lib/mcp/agent";
import { bearerOf, verifyToken } from "@/lib/mcp/tokens";
import { cleanSpoken, COMMAND_ID, SPOKEN_MAX } from "@/app/(apps)/meet/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 120;
const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function limited(tokenId: string): boolean {
  const now = Date.now();
  const list = (hits.get(tokenId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= LIMIT) return true;
  list.push(now);
  hits.set(tokenId, list);
  if (hits.size > 10_000) hits.clear();
  return false;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\u0000/g, "").slice(0, max) : "");

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const row = verifyToken(bearerOf(req));
  if (!row) return json({ error: "unauthorized" }, 401);
  if (limited(row.id)) return json({ error: "rate_limited" }, 429);
  const { id } = await params;
  if (!COMMAND_ID.test(id)) return json({ error: "not_found" }, 404);
  if (Number(req.headers.get("content-length") ?? "0") > 64 * 1024) return json({ error: "too_large" }, 413);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid" }, 400);
  }
  let ev: BridgeEvent;
  switch (body?.type) {
    case "started":
      ev = { type: "started" };
      break;
    case "progress":
      ev = { type: "progress", text: text(body.text, PROGRESS_MAX) };
      break;
    case "done":
      ev = { type: "done", result: text(body.result, RESULT_MAX) || "Done.", spoken: cleanSpoken(text(body.spoken, SPOKEN_MAX * 2)) || undefined };
      break;
    case "failed":
      ev = { type: "failed", error: text(body.error, RESULT_MAX) || "Failed." };
      break;
    default:
      return json({ error: "invalid" }, 400);
  }
  const status = applyBridgeEvent(id, row.userEmail, ev);
  if (!status) return json({ error: "not_found" }, 404);
  return json({ ok: true, status, cancelled: status === "cancelled" });
}
