// What a dashboard mod may call on the user's MCP servers.
//
//  - Tools annotated readOnlyHint=true ("read") are callable by any of the user's mods.
//  - Every other tool ("write": may have side effects, including unannotated ones) needs a grant:
//    for that tool, or server-wide (tool '*'). Without one the call is refused with
//    consent_required and a short-lived, single-use confirmToken bound to user × mod × server × tool.
//    The dashboard host (not the sandboxed mod) asks the user and, on approval, retries the call
//    with the token; `remember` turns the approval into a stored grant.
// Server-only.
import { randomToken, seal, unseal } from "../crypto";
import { all, run } from "./db";
import { UserMcpError } from "./errors";
import { getCatalog } from "./manager";
import { getServer, toolInfo, type ServerRecord } from "./store";
import type { McpConsentRequest, McpGrant, ToolAccess } from "./types";

export const MOD_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const CONFIRM_TTL_MS = 5 * 60_000;

type ConfirmClaims = { k: "mcp-consent"; sub: string; modId: string; serverId: string; tool: string; exp: number; n: string };

const g = globalThis as typeof globalThis & { __zwUserMcpUsedConfirm?: Map<string, number> };
const used = (g.__zwUserMcpUsedConfirm ??= new Map());

export type Remember = "once" | "tool" | "server";

export type Authorization =
  | { allowed: true; access: ToolAccess; server: ServerRecord; via: "read" | "grant" | "confirmed" }
  | { allowed: false; error: UserMcpError; consent?: McpConsentRequest };

function hasGrant(sub: string, modId: string, serverId: string, tool: string, access: ToolAccess): boolean {
  const rows = all(
    "SELECT access FROM mod_grants WHERE user_sub = ? AND mod_id = ? AND server_id = ? AND (tool = ? OR tool = '*')",
    sub,
    modId,
    serverId,
    tool,
  );
  return rows.some((r) => r.access === "write" || r.access === access);
}

export function addGrant(sub: string, modId: string, serverId: string, tool: string, access: ToolAccess): void {
  run(
    `INSERT INTO mod_grants (user_sub, mod_id, server_id, tool, access, created) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_sub, mod_id, server_id, tool) DO UPDATE SET
       access = CASE WHEN mod_grants.access = 'write' THEN 'write' ELSE excluded.access END`,
    sub,
    modId,
    serverId,
    tool,
    access,
    Date.now(),
  );
}

export function listGrants(sub: string, modId?: string): McpGrant[] {
  const rows = modId
    ? all("SELECT * FROM mod_grants WHERE user_sub = ? AND mod_id = ? ORDER BY created", sub, modId)
    : all("SELECT * FROM mod_grants WHERE user_sub = ? ORDER BY mod_id, created", sub);
  return rows.map((r) => ({
    modId: String(r.mod_id),
    serverId: String(r.server_id),
    tool: String(r.tool),
    access: r.access === "write" ? "write" : "read",
    created: Number(r.created),
  }));
}

/** Revokes grants: one tool, a whole server, or (no serverId) everything for the mod. Returns the count. */
export function revokeGrants(sub: string, modId: string, serverId?: string, tool?: string): number {
  if (serverId && tool) return Number(run("DELETE FROM mod_grants WHERE user_sub = ? AND mod_id = ? AND server_id = ? AND tool = ?", sub, modId, serverId, tool).changes);
  if (serverId) return Number(run("DELETE FROM mod_grants WHERE user_sub = ? AND mod_id = ? AND server_id = ?", sub, modId, serverId).changes);
  return Number(run("DELETE FROM mod_grants WHERE user_sub = ? AND mod_id = ?", sub, modId).changes);
}

async function readConfirm(token: string): Promise<ConfirmClaims | null> {
  if (typeof token !== "string" || token.length > 2000) return null;
  const c = await unseal<ConfirmClaims>(token);
  return c && c.k === "mcp-consent" ? c : null;
}

/**
 * Decides whether `modId` may call `tool` on the user's server. With a confirmToken (from the
 * host UI after the user approved), the token is checked and consumed; `remember` stores a grant.
 */
export async function authorizeModMcpCall(
  user: { sub: string },
  modId: string,
  serverId: string,
  tool: string,
  opts: { confirmToken?: string; remember?: Remember } = {},
): Promise<Authorization> {
  if (!MOD_ID.test(modId)) return { allowed: false, error: new UserMcpError("invalid_request", "invalid modId") };
  if (typeof tool !== "string" || !tool || tool.length > 128) return { allowed: false, error: new UserMcpError("invalid_request", "invalid tool") };
  const server = getServer(user.sub, serverId);
  if (!server) return { allowed: false, error: new UserMcpError("not_found", "MCP server not found") };
  if (!server.enabled) return { allowed: false, error: new UserMcpError("server_disabled", `"${server.name}" is turned off`) };
  if (server.disabledTools.has(tool)) return { allowed: false, error: new UserMcpError("tool_disabled", `the tool "${tool}" is turned off`) };

  let raw;
  try {
    raw = (await getCatalog(server)).tools.find((t) => t.name === tool);
  } catch (e) {
    return { allowed: false, error: e instanceof UserMcpError ? e : new UserMcpError("failed", "could not load the tool list") };
  }
  if (!raw) return { allowed: false, error: new UserMcpError("not_found", `"${server.name}" has no tool "${tool}"`) };
  const info = toolInfo(server, raw);
  if (info.access === "read") return { allowed: true, access: "read", server, via: "read" };
  if (hasGrant(user.sub, modId, serverId, tool, "write")) return { allowed: true, access: "write", server, via: "grant" };

  if (opts.confirmToken) {
    const c = await readConfirm(opts.confirmToken);
    const now = Date.now();
    for (const [n, exp] of used) if (exp < now) used.delete(n);
    if (!c || c.exp < now || c.sub !== user.sub || c.modId !== modId || c.serverId !== serverId || c.tool !== tool || used.has(c.n)) {
      return { allowed: false, error: new UserMcpError("forbidden", "the confirmation is invalid, expired or was already used") };
    }
    used.set(c.n, c.exp);
    if (opts.remember === "tool") addGrant(user.sub, modId, serverId, tool, "write");
    if (opts.remember === "server") addGrant(user.sub, modId, serverId, "*", "write");
    return { allowed: true, access: "write", server, via: "confirmed" };
  }

  const exp = Date.now() + CONFIRM_TTL_MS;
  const claims: ConfirmClaims = { k: "mcp-consent", sub: user.sub, modId, serverId, tool, exp, n: randomToken(12) };
  return {
    allowed: false,
    error: new UserMcpError("consent_required", `the user must approve "${info.annotations?.title || info.title || tool}" on "${server.name}" for this mod`),
    consent: {
      confirmToken: await seal(claims),
      modId,
      serverId,
      serverName: server.name,
      tool,
      toolTitle: info.annotations?.title || info.title || null,
      toolDescription: info.description ? info.description.slice(0, 500) : null,
      access: "write",
      destructive: info.annotations?.destructiveHint !== false,
      openWorld: info.annotations?.openWorldHint !== false,
      expires: exp,
    },
  };
}
