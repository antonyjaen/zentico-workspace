// POST /api/user-mcp/call { modId, serverId, tool, args, confirmToken?, remember? }: calls a tool
// on one of the signed-in user's MCP servers on behalf of a dashboard mod. Read-only tools run
// directly; others need a stored grant or a confirmToken from the host UI (consent_required
// otherwise). See docs/user-mcp.md.
import { UserMcpError } from "@/lib/user-mcp/errors";
import { authorizeModMcpCall, type Remember } from "@/lib/user-mcp/grants";
import { callTool } from "@/lib/user-mcp/manager";
import { checkWriteRequest, errorResponse, ok, readJson, sessionOrThrow } from "@/lib/user-mcp/route-kit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const s = (v: unknown) => (typeof v === "string" ? v : "");

export async function POST(req: Request) {
  try {
    checkWriteRequest(req);
    const session = await sessionOrThrow();
    const body = await readJson(req);
    const modId = s(body.modId);
    const serverId = s(body.serverId);
    const tool = s(body.tool);
    if (!modId || !serverId || !tool) throw new UserMcpError("invalid_request", "modId, serverId and tool are required");
    const remember: Remember = body.remember === "tool" || body.remember === "server" ? body.remember : "once";
    const confirmToken = typeof body.confirmToken === "string" ? body.confirmToken : undefined;

    const auth = await authorizeModMcpCall(session, modId, serverId, tool, { confirmToken, remember });
    if (!auth.allowed) return errorResponse(auth.error, auth.consent);
    const out = await callTool(auth.server, tool, body.args ?? {});
    return ok(out);
  } catch (e) {
    return errorResponse(e);
  }
}
