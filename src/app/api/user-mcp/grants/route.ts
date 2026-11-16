// GET /api/user-mcp/grants[?modId=]: the user's stored mod grants.
// DELETE /api/user-mcp/grants { modId, serverId?, tool? }: revokes them. See docs/user-mcp.md.
import type { NextRequest } from "next/server";
import { UserMcpError } from "@/lib/user-mcp/errors";
import { listGrants, MOD_ID, revokeGrants } from "@/lib/user-mcp/grants";
import { checkWriteRequest, errorResponse, ok, readJson, sessionOrThrow } from "@/lib/user-mcp/route-kit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await sessionOrThrow();
    const modId = req.nextUrl.searchParams.get("modId") ?? undefined;
    if (modId !== undefined && !MOD_ID.test(modId)) throw new UserMcpError("invalid_request", "invalid modId");
    return ok({ grants: listGrants(session.sub, modId) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  try {
    checkWriteRequest(req);
    const session = await sessionOrThrow();
    const body = await readJson(req);
    const modId = typeof body.modId === "string" ? body.modId : "";
    if (!MOD_ID.test(modId)) throw new UserMcpError("invalid_request", "invalid modId");
    const serverId = typeof body.serverId === "string" && body.serverId ? body.serverId : undefined;
    const tool = typeof body.tool === "string" && body.tool ? body.tool : undefined;
    if (tool && !serverId) throw new UserMcpError("invalid_request", "tool needs serverId");
    return ok({ revoked: revokeGrants(session.sub, modId, serverId, tool) });
  } catch (e) {
    return errorResponse(e);
  }
}
