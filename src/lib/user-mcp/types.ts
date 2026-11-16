// Shapes shared by the user-MCP server code, the route handlers and the browser client
// (client-api.ts). Nothing here may import server code: it is bundled into the browser.

/** Stable error codes returned by /api/user-mcp/* (see docs/user-mcp.md). */
export type UserMcpErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "invalid_args"
  | "not_found"
  | "server_disabled"
  | "tool_disabled"
  | "consent_required"
  | "auth_required"
  | "unsafe_url"
  | "rate_limited"
  | "too_many_sessions"
  | "timeout"
  | "unreachable"
  | "upstream_error"
  | "failed";

export type ToolAccess = "read" | "write";

export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolInfo = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  /** "read" only when the server annotates the tool readOnlyHint=true; anything else may have side effects. */
  access: ToolAccess;
  /** False when the user switched the tool off in Settings (it can't be called). */
  enabled: boolean;
};

export type McpNamedItem = { name: string; title?: string; description?: string; uri?: string; mimeType?: string; arguments?: unknown };

export type McpServerInfo = { name: string; version: string; title?: string; instructions?: string; protocolVersion?: string };

export type McpServerSummary = {
  id: string;
  name: string;
  /** Short id used in Claude tool names: ext_<slug>__<tool>. */
  slug: string;
  /** Hostname only: full URLs can embed secrets and stay on the server. */
  host: string;
  authType: "none" | "bearer" | "header" | "oauth";
  status: "ok" | "pending" | "reauth";
  enabled: boolean;
  server: McpServerInfo | null;
  /** When the tool catalog below was fetched (epoch ms), null if never. */
  catalogAt: number | null;
  lastError: string | null;
};

export type McpServerWithTools = McpServerSummary & { tools: McpToolInfo[]; stale?: boolean };

/** Result of tools/call as returned by the remote server (content blocks are passed through). */
export type McpCallResult = {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type McpCallResponse = { ok: true; result: McpCallResult; truncated: boolean; ms: number };

/** Sent with consent_required: what the host UI should ask the user before retrying the call. */
export type McpConsentRequest = {
  confirmToken: string;
  modId: string;
  serverId: string;
  serverName: string;
  tool: string;
  toolTitle: string | null;
  toolDescription: string | null;
  access: ToolAccess;
  destructive: boolean;
  openWorld: boolean;
  /** Epoch ms after which the token is refused. */
  expires: number;
};

export type McpErrorBody = {
  ok: false;
  error: { code: UserMcpErrorCode; message: string; retryAfter?: number };
  consent?: McpConsentRequest;
};

export type McpGrant = { modId: string; serverId: string; tool: string; access: ToolAccess; created: number };
