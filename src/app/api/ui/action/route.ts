// Write actions for dashboard components and mods: POST { modId?, name, args, timeZone? } → { data }.
// With modId, the action must be covered by a permission the mod declares AND the user granted;
// the dashboard has already asked the user to confirm (or they chose "always allow"). Without
// modId the call comes from a built-in component (e.g. the chat composer, the thread reader).
import { NextResponse, type NextRequest } from "next/server";
import { cleanTimeZone } from "@/lib/meetings/claude-commands";
import { isActionName, runAction } from "@/lib/ui/actions";
import { failure, gate, jsonError, limited, modContext, NO_STORE } from "@/lib/ui/http";
import { MOD_ACTIONS } from "@/lib/ui/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const g = await gate(req, 600 * 1024);
  if ("response" in g) return g.response;
  const { session, body } = g;
  if (!isActionName(body.name)) return jsonError("unknown_action", 400);
  const user = session.email.toLowerCase();
  if (body.modId != null) {
    const ctx = modContext(session.email, body.modId);
    if ("error" in ctx) return jsonError("not_found", 404);
    const need = MOD_ACTIONS[body.name].permission;
    if (!ctx.perms.includes(need)) return NextResponse.json({ error: "forbidden", message: `Needs the "${need}" permission` }, { status: 403, headers: NO_STORE });
    if (limited(`ui-action:${user}:${ctx.mod.id}`, 30)) return jsonError("rate_limited", 429);
  }
  if (limited(`ui-action:${user}`, 120)) return jsonError("rate_limited", 429);
  try {
    const data = await runAction(session, body.name, body.args, cleanTimeZone(body.timeZone));
    return NextResponse.json({ data: data ?? null }, { headers: NO_STORE });
  } catch (e) {
    return failure(e, `action ${body.name}`);
  }
}
