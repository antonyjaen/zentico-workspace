// GET /api/user-mcp/servers/<id>/tools[?refresh=1]: one server's enabled tools with input
// schemas (5-minute cache unless refresh=1). See docs/user-mcp.md.
import type { NextRequest } from "next/server";
import { UserMcpError } from "@/lib/user-mcp/errors";
import { getCatalog } from "@/lib/user-mcp/manager";
import { errorResponse, ok, sessionOrThrow } from "@/lib/user-mcp/route-kit";
import { getServer, summary, toolInfo } from "@/lib/user-mcp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await sessionOrThrow();
    const { id } = await params;
    const rec = getServer(session.sub, id);
    if (!rec) throw new UserMcpError("not_found", "MCP server not found");
    if (!rec.enabled) throw new UserMcpError("server_disabled", `"${rec.name}" is turned off`);
    const { tools, info, stale } = await getCatalog(rec, { refresh: req.nextUrl.searchParams.get("refresh") === "1" });
    return ok({
      server: { ...summary(rec), server: info ?? rec.serverInfo },
      tools: tools.map((t) => toolInfo(rec, t)).filter((t) => t.enabled),
      stale,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
