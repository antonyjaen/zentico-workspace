// Data for dashboard components and mods: POST { query, args?, timeZone?, modId? } → { data } | { error }.
// Only the read-only queries in DATA_QUERIES (src/app/(apps)/dashboard/model.ts), run with the
// signed-in user's own session. Mods and custom widgets reach this only through the page's
// postMessage bridge (their sandboxed iframes have no cookies of their own); with modId the query
// must be one mods may use (MOD_QUERIES) and its permission declared and granted.
import { NextResponse, type NextRequest } from "next/server";
import { DashError, isDataQuery } from "@/app/(apps)/dashboard/model";
import { getSession } from "@/lib/auth";
import { runQuery } from "@/lib/dashboard/data";
import { jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { modContext } from "@/lib/ui/http";
import { MOD_QUERIES } from "@/lib/ui/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Per user: a dashboard of 40 widgets refreshing every minute stays far below this.
const LIMIT = 300;
const WINDOW_MS = 60_000;
const g = globalThis as typeof globalThis & { __zwDashHits?: Map<string, number[]> };
const hits = (g.__zwDashHits ??= new Map());

function limited(key: string): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t: number) => now - t < WINDOW_MS);
  if (list.length >= LIMIT) return true;
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10_000) hits.clear();
  return false;
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  if (Number(req.headers.get("content-length") ?? "0") > 8 * 1024) return jsonError("too_large", 413);
  if (limited(session.email.toLowerCase())) return jsonError("rate_limited", 429);
  let body: { query?: unknown; args?: unknown; timeZone?: unknown; modId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError("invalid", 400);
  }
  if (!isDataQuery(body.query)) return NextResponse.json({ error: "Unknown query" }, { status: 400, headers: NO_STORE });
  if (body.modId != null) {
    const spec = MOD_QUERIES[body.query];
    if (!spec) return NextResponse.json({ error: "Unknown query" }, { status: 400, headers: NO_STORE });
    const ctx = modContext(session.email, body.modId);
    if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: 404, headers: NO_STORE });
    if (spec.permission && !ctx.perms.includes(spec.permission)) {
      return NextResponse.json({ error: `Needs the "${spec.permission}" permission` }, { status: 403, headers: NO_STORE });
    }
  }
  try {
    const data = await runQuery(session, body.query, body.args, typeof body.timeZone === "string" ? body.timeZone : null);
    return NextResponse.json({ data }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof DashError) return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE });
    console.error(`[dashboard] ${body.query}:`, e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  }
}
