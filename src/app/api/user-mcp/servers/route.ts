// GET /api/user-mcp/servers: the signed-in user's enabled MCP servers with their (enabled) tools
// and input schemas, for dashboard mods. No URLs or credentials. See docs/user-mcp.md.
import { getCatalog } from "@/lib/user-mcp/manager";
import { errorResponse, ok, sessionOrThrow } from "@/lib/user-mcp/route-kit";
import { listServers, summary, toolInfo } from "@/lib/user-mcp/store";
import type { McpServerWithTools } from "@/lib/user-mcp/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await sessionOrThrow();
    const recs = listServers(session.sub).filter((r) => r.enabled);
    const servers: McpServerWithTools[] = await Promise.all(
      recs.map(async (rec) => {
        try {
          const { tools, info, stale } = await getCatalog(rec);
          return {
            ...summary(rec),
            server: info ?? rec.serverInfo,
            tools: tools.map((t) => toolInfo(rec, t)).filter((t) => t.enabled),
            ...(stale ? { stale: true } : {}),
          };
        } catch (e) {
          return { ...summary(rec), lastError: e instanceof Error ? e.message : rec.lastError, tools: [], stale: true };
        }
      }),
    );
    return ok({ servers });
  } catch (e) {
    return errorResponse(e);
  }
}
