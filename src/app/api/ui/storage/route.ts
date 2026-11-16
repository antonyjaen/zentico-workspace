// Per-mod key/value storage of the signed-in user (zentico.storage):
// POST { modId, op: "get" | "set" | "remove" | "keys", key?, value? } → { value } | { keys } | { ok }
import { NextResponse, type NextRequest } from "next/server";
import { failure, gate, jsonError, limited, modContext, NO_STORE } from "@/lib/ui/http";
import { STORAGE_KEY_MAX, STORAGE_VALUE_MAX, storageGet, storageKeys, storageRemove, storageSet } from "@/lib/ui/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KEY = /^[\w.:\-/ ]+$/;

export async function POST(req: NextRequest) {
  const g = await gate(req, STORAGE_VALUE_MAX + 4096);
  if ("response" in g) return g.response;
  const { session, body } = g;
  const ctx = modContext(session.email, body.modId);
  if ("error" in ctx) return jsonError("not_found", 404);
  if (limited(`ui-storage:${session.email.toLowerCase()}:${ctx.mod.id}`, 240)) return jsonError("rate_limited", 429);
  const id = ctx.mod.id;
  try {
    if (body.op === "keys") return NextResponse.json({ keys: storageKeys(session.email, id) }, { headers: NO_STORE });
    const key = body.key;
    if (typeof key !== "string" || !key || key.length > STORAGE_KEY_MAX || !KEY.test(key)) {
      return NextResponse.json(
        { error: "invalid", message: `Keys are 1-${STORAGE_KEY_MAX} characters: letters, digits, _ . : - / and spaces` },
        { status: 400, headers: NO_STORE },
      );
    }
    switch (body.op) {
      case "get":
        return NextResponse.json({ value: storageGet(session.email, id, key) }, { headers: NO_STORE });
      case "set":
        storageSet(session.email, id, key, body.value === undefined ? null : body.value);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      case "remove":
        storageRemove(session.email, id, key);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      default:
        return jsonError("invalid", 400);
    }
  } catch (e) {
    return failure(e, "storage");
  }
}
