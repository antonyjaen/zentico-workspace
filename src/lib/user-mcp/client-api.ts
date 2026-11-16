// Browser-side fetch wrappers for /api/user-mcp/* (contract: docs/user-mcp.md). For the dashboard
// host page: it runs with the user's session cookie, so mods in sandboxed iframes must go through
// the host (postMessage) rather than calling these themselves. Never relay a consent's
// confirmToken to a mod: the host asks the user and retries the call itself.
import type {
  McpCallResponse,
  McpConsentRequest,
  McpErrorBody,
  McpGrant,
  McpServerWithTools,
  McpToolInfo,
  UserMcpErrorCode,
} from "./types";

export type {
  McpCallResponse,
  McpCallResult,
  McpConsentRequest,
  McpGrant,
  McpServerWithTools,
  McpToolInfo,
  UserMcpErrorCode,
} from "./types";

/** A failed /api/user-mcp request. `consent` is set for consent_required. */
export class UserMcpClientError extends Error {
  code: UserMcpErrorCode;
  status: number;
  retryAfter?: number;
  consent?: McpConsentRequest;
  constructor(code: UserMcpErrorCode, message: string, status: number, extra: { retryAfter?: number; consent?: McpConsentRequest } = {}) {
    super(message);
    this.name = "UserMcpClientError";
    this.code = code;
    this.status = status;
    this.retryAfter = extra.retryAfter;
    this.consent = extra.consent;
  }
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
      credentials: "same-origin",
      cache: "no-store",
      signal: init?.signal,
      headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  } catch {
    throw new UserMcpClientError("unreachable", "network error", 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON answer (e.g. a proxy error page)
  }
  const b = body as (McpErrorBody & { ok: false }) | ({ ok: true } & T) | null;
  if (!res.ok || !b || b.ok !== true) {
    const err = b && b.ok === false ? b : null;
    throw new UserMcpClientError(err?.error.code ?? "failed", err?.error.message ?? `HTTP ${res.status}`, res.status, {
      retryAfter: err?.error.retryAfter,
      consent: err?.consent,
    });
  }
  return b as T;
}

/** zentico.mcp.listServers(): enabled servers with their enabled tools. */
export async function listServers(opts: { signal?: AbortSignal } = {}): Promise<McpServerWithTools[]> {
  return (await request<{ servers: McpServerWithTools[] }>("/api/user-mcp/servers", { signal: opts.signal })).servers;
}

/** zentico.mcp.listTools(serverId): one server's enabled tools (refresh=true bypasses the 5-min cache). */
export async function listTools(serverId: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<{ tools: McpToolInfo[]; stale: boolean }> {
  const r = await request<{ tools: McpToolInfo[]; stale: boolean }>(
    `/api/user-mcp/servers/${encodeURIComponent(serverId)}/tools${opts.refresh ? "?refresh=1" : ""}`,
    { signal: opts.signal },
  );
  return { tools: r.tools, stale: r.stale };
}

export type CallOptions = {
  /** From a consent_required error, after the user approved. Single use, 5 minutes. */
  confirmToken?: string;
  /** With confirmToken: also store the approval for this tool, or for every tool of the server. */
  remember?: "once" | "tool" | "server";
  signal?: AbortSignal;
};

/** zentico.mcp.call(serverId, tool, args) on behalf of a mod. Throws UserMcpClientError (code consent_required → ask the user). */
export async function callTool(modId: string, serverId: string, tool: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<McpCallResponse> {
  return request<McpCallResponse>("/api/user-mcp/call", {
    signal: opts.signal,
    json: { modId, serverId, tool, args, ...(opts.confirmToken ? { confirmToken: opts.confirmToken, remember: opts.remember ?? "once" } : {}) },
  });
}

export async function listGrants(modId?: string): Promise<McpGrant[]> {
  return (await request<{ grants: McpGrant[] }>(`/api/user-mcp/grants${modId ? `?modId=${encodeURIComponent(modId)}` : ""}`)).grants;
}

/** Revokes a mod's grants: one tool, a whole server, or everything (no serverId). */
export async function revokeGrants(modId: string, serverId?: string, tool?: string): Promise<number> {
  return (await request<{ revoked: number }>("/api/user-mcp/grants", { method: "DELETE", json: { modId, serverId, tool } })).revoked;
}

/** Text of a call result's text blocks (convenience for mods that just want a string). */
export function resultText(r: McpCallResponse): string {
  return r.result.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}
