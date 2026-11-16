// The user's own connected MCP servers (Settings → Apps & bots → MCP servers, lib/user-mcp),
// proxied through the workspace MCP as `ext_<serverSlug>__<tool>`. Only enabled servers/tools are
// listed; tools the remote server annotates readOnlyHint=true run directly, every other one is a
// write tool: offered to read+write tokens only and, for meeting / dashboard commands, confirmed
// by the user in-call like the built-in write tools.
import { createHash } from "node:crypto";
import { UserMcpError } from "../user-mcp/errors";
import { callTool, getCatalog } from "../user-mcp/manager";
import { listServers, serverBySlug, toolInfo, type RawTool, type ServerRecord } from "../user-mcp/store";
import { awaitConfirmation } from "./agent";
import type { Args } from "./args";
import type { Scope } from "./db";
import type { ToolContext } from "./kit";
import type { ToolOutcome } from "./tools";

const PREFIX = "ext_";
const SEP = "__";
const MAX_NAME = 64;
const LIST_WAIT_MS = 8_000;

export const isExtToolName = (name: string) => name.startsWith(PREFIX) && name.indexOf(SEP, PREFIX.length) > PREFIX.length;

/** ext_<slug>__<tool>, kept within MCP clients' name rules ([A-Za-z0-9_-], ≤ 64 chars). */
export function extToolName(slug: string, tool: string): string {
  const head = `${PREFIX}${slug}${SEP}`;
  const safe = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  if (head.length + safe.length <= MAX_NAME && safe === tool) return head + safe;
  const hash = createHash("sha256").update(tool).digest("hex").slice(0, 6);
  return `${head}${safe.slice(0, MAX_NAME - head.length - 7)}_${hash}`;
}

/** Catalog for listing: cached / fresh, else the last stored one, never waiting more than a few seconds. */
async function catalogFor(rec: ServerRecord): Promise<RawTool[]> {
  const fallback = rec.catalog ?? [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getCatalog(rec).then((c) => c.tools),
      new Promise<RawTool[]>((resolve) => {
        timer = setTimeout(() => resolve(fallback), LIST_WAIT_MS);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** Tools for tools/list, in the same shape as listTools() in ./tools. */
export async function listExtTools(sub: string, scope: Scope) {
  const recs = listServers(sub).filter((r) => r.enabled && r.status === "ok");
  const lists = await Promise.all(
    recs.map(async (rec) =>
      (await catalogFor(rec))
        .map((t) => toolInfo(rec, t))
        .filter((t) => t.enabled && (scope === "write" || t.access === "read"))
        .map((t) => ({
          name: extToolName(rec.slug, t.name),
          description: `[${rec.name} — the user's connected MCP server] ${t.description ?? t.title ?? t.name}`.slice(0, 4000),
          inputSchema: t.inputSchema,
          annotations: {
            ...(t.annotations?.title ? { title: t.annotations.title } : {}),
            readOnlyHint: t.access === "read",
            destructiveHint: t.access === "write" && t.annotations?.destructiveHint !== false,
            openWorldHint: t.annotations?.openWorldHint !== false,
          },
        })),
    ),
  );
  return lists.flat();
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Runs ext_<slug>__<tool> for the token's user. */
export async function runExtTool(name: string, args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const slug = name.slice(PREFIX.length, name.indexOf(SEP, PREFIX.length));
  const rec = serverBySlug(ctx.session.sub, slug);
  if (!rec) return { ok: false, error: `Unknown tool "${name}"` };
  try {
    const tools = (await getCatalog(rec)).tools;
    const raw = tools.find((t) => extToolName(rec.slug, t.name) === name);
    if (!raw) return { ok: false, error: `Unknown tool "${name}"` };
    const tool = toolInfo(rec, raw);
    if (!tool.enabled) return { ok: false, error: `The tool "${tool.name}" is turned off in Settings → Apps & bots → MCP servers.` };
    if (tool.access === "write") {
      if (ctx.scope !== "write") return { ok: false, error: "This token is read-only; create a read+write token in Settings → Integrations." };
      if (ctx.commandId != null) {
        const summary = clip(`${rec.name}: ${tool.annotations?.title || tool.title || tool.name} ${clip(JSON.stringify(args ?? {}), 400)}`, 600);
        const confirmed = await awaitConfirmation(ctx.commandId, ctx.session.email, name, summary);
        if (!confirmed.ok) return { ok: false, error: "Not confirmed by the user" };
      }
    }
    const out = await callTool(rec, tool.name, args ?? {});
    const value = { ...out.result, ...(out.truncated ? { truncated: true } : {}) };
    if (out.result.isError) {
      const text = out.result.content.map((b) => (typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n");
      return { ok: false, error: clip(text || `${rec.name} reported an error`, 4000) };
    }
    return { ok: true, value };
  } catch (e) {
    if (e instanceof UserMcpError) return { ok: false, error: `${rec.name}: ${e.message}` };
    throw e;
  }
}
