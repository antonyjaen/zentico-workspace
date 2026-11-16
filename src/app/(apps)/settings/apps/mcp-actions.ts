"use server";

// Settings → Apps & bots → MCP servers: add, edit, test and remove the signed-in user's remote MCP
// servers. Credentials go in once and are stored sealed; nothing secret is ever returned.
import { unstable_rethrow } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { UserMcpError } from "@/lib/user-mcp/errors";
import { dropServer, testServer } from "@/lib/user-mcp/manager";
import { prepareOAuth } from "@/lib/user-mcp/oauth";
import {
  cleanName,
  cleanStaticAuth,
  createServer,
  deleteServer,
  getServer,
  renameServer,
  serverUrl,
  setEnabled,
  setOAuthConfig,
  setStaticAuth,
  setToolEnabled,
  type AuthType,
} from "@/lib/user-mcp/store";
import type { McpNamedItem, McpServerInfo, McpToolInfo, UserMcpErrorCode } from "@/lib/user-mcp/types";
import { toolInfo } from "@/lib/user-mcp/store";

export type McpActionResult<T = void> = { ok: true; data: T } | { ok: false; code: UserMcpErrorCode; error: string };

async function act<T>(fn: (sub: string) => Promise<T> | T): Promise<McpActionResult<T>> {
  try {
    const session = await requireSession();
    return { ok: true, data: await fn(session.sub) };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof UserMcpError) return { ok: false, code: e.code, error: e.message };
    console.error("[user-mcp] settings action failed:", e instanceof Error ? e.message : "unknown error");
    return { ok: false, code: "failed", error: "failed" };
  }
}

function mine(sub: string, id: unknown) {
  const rec = typeof id === "string" ? getServer(sub, id) : null;
  if (!rec) throw new UserMcpError("not_found", "MCP server not found");
  return rec;
}

const authTypeOf = (v: unknown): AuthType => (v === "bearer" || v === "header" || v === "oauth" ? v : "none");
const optional = (v: unknown, max: number) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length > max || /[\r\n\0]/.test(s)) throw new UserMcpError("invalid_request", "a field is too long or invalid");
  return s || undefined;
};

export type McpServerForm = {
  name: unknown;
  url: unknown;
  authType: unknown;
  token?: unknown;
  headerName?: unknown;
  headerValue?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  scope?: unknown;
};

/**
 * Adds a server. For OAuth, discovery and client registration happen now (errors come back to
 * the form) and the browser then goes to `authorizeUrl` to sign in at the server's provider.
 */
export async function addMcpServer(form: McpServerForm): Promise<McpActionResult<{ id: string; authorizeUrl: string | null }>> {
  return act(async (sub) => {
    if (!form || typeof form !== "object") throw new UserMcpError("invalid_request", "invalid form");
    const name = cleanName(form.name);
    const url = typeof form.url === "string" ? form.url.trim() : "";
    const authType = authTypeOf(form.authType);
    const auth = cleanStaticAuth(authType, form);
    const manual = authType === "oauth" ? { clientId: optional(form.clientId, 500), clientSecret: optional(form.clientSecret, 2000), scope: optional(form.scope, 1000) } : null;
    const rec = await createServer(sub, { name, url, authType, auth });
    if (!manual) return { id: rec.id, authorizeUrl: null };
    try {
      await setOAuthConfig(rec.id, await prepareOAuth((await serverUrl(rec.id)).toString(), manual));
    } catch (e) {
      await deleteServer(sub, rec.id);
      throw e;
    }
    return { id: rec.id, authorizeUrl: `/api/user-mcp/oauth/start?server=${encodeURIComponent(rec.id)}` };
  });
}

export async function renameMcpServer(id: string, name: string): Promise<McpActionResult> {
  return act((sub) => {
    renameServer(sub, mine(sub, id).id, cleanName(name));
    dropServer(id);
  });
}

export async function setMcpServerEnabled(id: string, enabled: boolean): Promise<McpActionResult> {
  return act((sub) => {
    setEnabled(sub, mine(sub, id).id, enabled === true);
    dropServer(id);
  });
}

export async function setMcpToolEnabled(id: string, tool: string, enabled: boolean): Promise<McpActionResult> {
  return act((sub) => {
    if (typeof tool !== "string" || !tool || tool.length > 128) throw new UserMcpError("invalid_request", "invalid tool");
    setToolEnabled(mine(sub, id), tool, enabled === true);
  });
}

/** Replaces a bearer token / custom header (the old one is forgotten). */
export async function updateMcpCredentials(id: string, form: { token?: unknown; headerName?: unknown; headerValue?: unknown }): Promise<McpActionResult> {
  return act(async (sub) => {
    const rec = mine(sub, id);
    if (rec.authType !== "bearer" && rec.authType !== "header") throw new UserMcpError("invalid_request", "this server does not use a token or header");
    await setStaticAuth(sub, rec.id, rec.authType, cleanStaticAuth(rec.authType, form ?? {}));
    dropServer(rec.id);
  });
}

export type McpTestView = {
  server: McpServerInfo | null;
  transport: string;
  tools: McpToolInfo[];
  resources: McpNamedItem[];
  prompts: McpNamedItem[];
  ms: number;
};

export async function testMcpServer(id: string): Promise<McpActionResult<McpTestView>> {
  return act(async (sub) => {
    const rec = mine(sub, id);
    const r = await testServer(rec);
    const fresh = getServer(sub, rec.id) ?? rec;
    return { ...r, transport: fresh.transport, tools: r.tools.map((t) => toolInfo(fresh, t)) };
  });
}

/** Removes the server and its mod grants, revoking OAuth tokens where the server supports it. */
export async function removeMcpServer(id: string): Promise<McpActionResult<{ revoked: boolean }>> {
  return act(async (sub) => {
    const rec = mine(sub, id);
    dropServer(rec.id);
    const r = await deleteServer(sub, rec.id);
    return { revoked: !!r?.revoked };
  });
}
