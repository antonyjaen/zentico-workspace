// Mod permissions of the signed-in user.
// POST { modId, op: "grant" }              approve everything its manifest requests (permissions + MCP scopes)
//      { modId, op: "revoke" }             disable it again
//      { modId, op: "always", action }     "always allow" an action ("mail.archive"…, "claude", "mcp:<server>/<tool>")
import { NextResponse, type NextRequest } from "next/server";
import { gate, jsonError, modContext, NO_STORE } from "@/lib/ui/http";
import { isMcpScopeKey, MOD_ACTIONS, requestedGrants } from "@/lib/ui/schema";
import { viewOf } from "@/lib/ui/service";
import { listGrants, revokeGrant, setGrant } from "@/lib/ui/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const g = await gate(req, 4096);
  if ("response" in g) return g.response;
  const { session, body } = g;
  const ctx = modContext(session.email, body.modId);
  if ("error" in ctx) return jsonError("not_found", 404);
  const id = ctx.mod.id;
  const current = listGrants(session.email)[id];
  switch (body.op) {
    case "grant":
      setGrant(session.email, id, { perms: requestedGrants(ctx.mod), always: current?.always ?? [] });
      break;
    case "revoke":
      revokeGrant(session.email, id);
      break;
    case "always": {
      const a = body.action;
      const ok =
        typeof a === "string" &&
        !!current &&
        (a === "claude"
          ? ctx.perms.includes("claude")
          : a in MOD_ACTIONS
            ? ctx.perms.includes(MOD_ACTIONS[a].permission)
            : /^mcp:/.test(a) && a.length <= 140 && ctx.perms.includes("mcp") && isMcpScopeKey(a.replace(/^mcp:([^/]+)\/.*$/, "mcp:$1/x")));
      if (!ok || !current) return jsonError("invalid", 400);
      setGrant(session.email, id, { perms: current.perms, always: [...current.always, a as string] });
      break;
    }
    default:
      return jsonError("invalid", 400);
  }
  return NextResponse.json(viewOf(session.email), { headers: NO_STORE });
}
