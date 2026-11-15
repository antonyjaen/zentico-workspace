// Remote MCP server (Streamable HTTP, stateless, JSON responses) for automating the workspace from
// Claude and other MCP clients. Authenticated with personal access tokens created in
// Settings → Integrations; each tool runs as the token's user via runWithSession().
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runWithSession } from "@/lib/auth";
import { DriveError } from "@/lib/drive";
import { JmapError } from "@/lib/jmap";
import { ComposeError } from "@/lib/mail-compose";
import { writeAudit, type TokenRow } from "@/lib/mcp/db";
import { noteUse, RATE_LIMIT, rateLimit, ReauthError, sessionForToken, verifyToken } from "@/lib/mcp/tokens";
import { listTools, runTool } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const INSTRUCTIONS = `Zentico Workspace: the user's mail, calendar, contacts, Drive/Docs, chat and meeting transcripts.
Read tools are safe to call freely. Before sending mail, posting chat messages or inviting people, confirm the content with the user unless they explicitly asked you to act directly; prefer mail_create_draft when unsure.
Typical flow for a meeting: meetings_list → meetings_get_transcript → summarize / extract action items → docs_create_markdown for notes, mail_create_draft or mail_send for follow-ups, calendar_find_free_time + calendar_create_event for next meetings.`;

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}) {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status, headers });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m ? m[1] : null;
}

const unauthorized = () =>
  jsonRpcError(401, -32001, "Missing or invalid access token. Create one in Settings → Integrations.", {
    "WWW-Authenticate": 'Bearer realm="zentico-mcp"',
  });

/** Turns a failure into the text shown to the MCP client (internal details stay in the logs). */
function describeError(e: unknown, tool: string): string {
  if (e instanceof ReauthError) return e.message;
  if (e instanceof DriveError || e instanceof ComposeError || e instanceof JmapError) return e.message;
  console.error(`[mcp] ${tool} failed:`, e instanceof Error ? (e.stack ?? e.message) : e);
  return "Unexpected server error";
}

function buildServer(row: TokenRow): Server {
  const server = new Server(
    { name: "zentico-workspace", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools(row.scope) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    let text: string;
    let ok = false;
    try {
      const session = await sessionForToken(row);
      const outcome = await runWithSession(session, () =>
        runTool(name, args, { session, scope: row.scope, tokenName: row.name, tokenExpires: row.expires }),
      );
      ok = outcome.ok;
      text = outcome.ok ? JSON.stringify(outcome.value ?? null) : outcome.error;
    } catch (e) {
      text = describeError(e, name);
    }
    try {
      writeAudit({ tokenId: row.id, userSub: row.userSub, tool: name, ok, error: ok ? null : text });
    } catch (e) {
      console.error("[mcp] audit write failed:", e instanceof Error ? e.message : e);
    }
    return { content: [{ type: "text" as const, text }], ...(ok ? {} : { isError: true }) };
  });

  return server;
}

export async function POST(req: Request) {
  const row = verifyToken(bearer(req));
  if (!row) return unauthorized();

  const wait = rateLimit(row.id);
  if (wait) {
    return jsonRpcError(429, -32002, `Rate limit exceeded (${RATE_LIMIT} requests per minute). Retry in ${wait}s.`, {
      "Retry-After": String(wait),
    });
  }
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return jsonRpcError(413, -32600, "Request too large");
  noteUse(row.id);

  const server = buildServer(row);
  // Stateless: a fresh transport per request, JSON responses instead of SSE streams.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close().catch(() => undefined);
  }
}

// Stateless server: no standalone SSE stream and no sessions to delete.
const notAllowed = (req: Request) => {
  if (!verifyToken(bearer(req))) return unauthorized();
  return jsonRpcError(405, -32000, "Method not allowed.", { Allow: "POST" });
};

export const GET = notAllowed;
export const DELETE = notAllowed;
