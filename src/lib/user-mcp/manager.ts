// Server-side MCP client manager for the user's connected servers. Connects lazily per
// user+server (Streamable HTTP, falling back to the legacy HTTP+SSE transport), keeps a small pool
// of live sessions (idle ones closed after 5 min, capped per user and in total), caches each tool
// catalog for 5 minutes, and calls tools with a 30 s timeout, per-user / per-server rate limits,
// a per-user concurrency cap, argument shape checks and a 256 KB result cap. Credentials are added
// to requests here (same origin as the server URL only) and never leave the server. Server-only.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { oneLine, UserMcpError } from "./errors";
import { safeFetch, type FetchLike } from "./net";
import { validateArgs } from "./schema";
import {
  authHeaders,
  markReauth,
  noteUsed,
  saveCatalog,
  serverUrl,
  setLastError,
  setTransport,
  type RawTool,
  type ServerRecord,
} from "./store";
import type { McpCallResult, McpNamedItem, McpServerInfo } from "./types";

export const CATALOG_TTL_MS = 5 * 60_000;
export const CALL_TIMEOUT_MS = 30_000;
export const RESULT_MAX_BYTES = 256 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 15_000;
const IDLE_MS = 5 * 60_000;
const MAX_SESSIONS_PER_USER = 5;
const MAX_SESSIONS_TOTAL = 200;
export const USER_CALLS_PER_MIN = 60;
export const SERVER_CALLS_PER_MIN = 30;
const MAX_CONCURRENT_CALLS_PER_USER = 4;
const MAX_TOOLS = 500;

/* ---------------------------------------------------------------- sessions */

type Session = {
  key: string;
  sub: string;
  serverId: string;
  client: Client;
  busy: number;
  lastUsed: number;
  closed: boolean;
};

type State = {
  sessions: Map<string, Session>;
  connecting: Map<string, Promise<Session>>;
  catalogs: Map<string, { at: number; tools: RawTool[]; info: McpServerInfo | null }>;
  hits: Map<string, number[]>;
  inflight: Map<string, number>;
};
const g = globalThis as typeof globalThis & { __zwUserMcp?: State };
const S: State = (g.__zwUserMcp ??= { sessions: new Map(), connecting: new Map(), catalogs: new Map(), hits: new Map(), inflight: new Map() });

const keyOf = (sub: string, serverId: string) => `${sub}\u0000${serverId}`;

// Remote schemas are untrusted: don't compile them (the SDK would, to check structured output).
const noValidator: jsonSchemaValidator = {
  getValidator: (() => (input: unknown) => ({ valid: true as const, data: input, errorMessage: undefined })) as jsonSchemaValidator["getValidator"],
};

function closeSession(s: Session) {
  if (s.closed) return;
  s.closed = true;
  if (S.sessions.get(s.key) === s) S.sessions.delete(s.key);
  void s.client.close().catch(() => undefined);
}

function sweep(now = Date.now()) {
  for (const s of S.sessions.values()) if (!s.busy && now - s.lastUsed > IDLE_MS) closeSession(s);
}

/** Frees a slot for a new session (closing the least recently used idle one) or refuses. */
function makeRoom(sub: string) {
  sweep();
  const mine = [...S.sessions.values()].filter((s) => s.sub === sub);
  const evict = (list: Session[]) => {
    const idle = list.filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) throw new UserMcpError("too_many_sessions", "too many MCP server sessions are open right now; try again shortly");
    closeSession(idle);
  };
  if (mine.length >= MAX_SESSIONS_PER_USER) evict(mine);
  if (S.sessions.size >= MAX_SESSIONS_TOTAL) evict([...S.sessions.values()]);
}

/** Adds credentials (same origin only) and turns a 401 into one OAuth refresh + retry, or auth_required. */
function authedFetch(rec: ServerRecord, origin: string): FetchLike {
  return async (url, init = {}) => {
    const sameOrigin = new URL(url.toString()).origin === origin;
    const send = async (force: boolean) => {
      const headers = new Headers(init.headers);
      if (sameOrigin) for (const [k, v] of Object.entries(await authHeaders(rec, force))) headers.set(k, v);
      return safeFetch(url, { ...init, headers });
    };
    const res = await send(false);
    if (res.status !== 401 || !sameOrigin) return res;
    void res.body?.cancel().catch(() => undefined);
    if (rec.authType === "none") throw new UserMcpError("auth_required", "the MCP server requires authorization; set up a token or OAuth in Settings → Apps & bots");
    // Static credentials: authHeaders(force) marks the server and throws. OAuth: refresh once.
    const retry = await send(true);
    if (retry.status === 401) {
      void retry.body?.cancel().catch(() => undefined);
      markReauth(rec.id);
      throw new UserMcpError("auth_required", "the MCP server refused the authorization; reconnect it in Settings → Apps & bots");
    }
    return retry;
  };
}

function newClient() {
  return new Client({ name: "zentico-workspace", version: "1.0.0" }, { capabilities: {}, jsonSchemaValidator: noValidator });
}

async function openClient(rec: ServerRecord): Promise<Client> {
  const url = await serverUrl(rec.id);
  const fetchFn = authedFetch(rec, url.origin);
  const streamable = async () => {
    const c = newClient();
    await c.connect(new StreamableHTTPClientTransport(url, { fetch: fetchFn }), { timeout: CONNECT_TIMEOUT_MS });
    return c;
  };
  const sse = async () => {
    const c = newClient();
    await c.connect(new SSEClientTransport(url, { fetch: fetchFn }), { timeout: CONNECT_TIMEOUT_MS });
    return c;
  };
  if (rec.transport === "sse") return sse();
  if (rec.transport === "streamable") return streamable();
  try {
    const c = await streamable();
    setTransport(rec.id, "streamable");
    return c;
  } catch (e) {
    if (e instanceof UserMcpError && (e.code === "auth_required" || e.code === "unsafe_url")) throw e;
    try {
      const c = await sse();
      setTransport(rec.id, "sse");
      return c;
    } catch {
      throw e;
    }
  }
}

async function acquire(rec: ServerRecord): Promise<Session> {
  const key = keyOf(rec.userSub, rec.id);
  const live = S.sessions.get(key);
  if (live && !live.closed) {
    live.busy++;
    live.lastUsed = Date.now();
    return live;
  }
  let p = S.connecting.get(key);
  if (!p) {
    p = (async () => {
      makeRoom(rec.userSub);
      const client = await openClient(rec);
      const s: Session = { key, sub: rec.userSub, serverId: rec.id, client, busy: 0, lastUsed: Date.now(), closed: false };
      client.onclose = () => {
        s.closed = true;
        if (S.sessions.get(key) === s) S.sessions.delete(key);
      };
      S.sessions.set(key, s);
      return s;
    })().finally(() => S.connecting.delete(key));
    S.connecting.set(key, p);
  }
  const s = await p;
  s.busy++;
  s.lastUsed = Date.now();
  return s;
}

function release(s: Session) {
  s.busy = Math.max(0, s.busy - 1);
  s.lastUsed = Date.now();
}

async function withSession<T>(rec: ServerRecord, fn: (c: Client) => Promise<T>): Promise<T> {
  const s = await acquire(rec);
  try {
    return await fn(s.client);
  } catch (e) {
    // Transport-level failures leave the session unusable: start fresh next time.
    if (!(e instanceof McpError) || e.code === ErrorCode.ConnectionClosed || e.code === ErrorCode.RequestTimeout) closeSession(s);
    throw e;
  } finally {
    release(s);
  }
}

/** Closes live sessions and forgets the cached catalog (after edits, credential changes or removal). */
export function dropServer(serverId: string) {
  for (const s of [...S.sessions.values()]) if (s.serverId === serverId) closeSession(s);
  S.catalogs.delete(serverId);
}

/* ----------------------------------------------------------------- errors */

export function mapError(e: unknown): UserMcpError {
  if (e instanceof UserMcpError) return e;
  if (e instanceof McpError) {
    if (e.code === ErrorCode.RequestTimeout) return new UserMcpError("timeout", "the MCP server did not answer in time");
    if (e.code === ErrorCode.ConnectionClosed) return new UserMcpError("unreachable", "the MCP server closed the connection");
    if (e.code === ErrorCode.InvalidParams) return new UserMcpError("invalid_args", oneLine(e.message) || "invalid arguments");
    if (e.code === ErrorCode.MethodNotFound) return new UserMcpError("not_found", "the MCP server does not support this request");
    return new UserMcpError("upstream_error", oneLine(e.message) || "the MCP server returned an error");
  }
  if (e instanceof UnauthorizedError) return new UserMcpError("auth_required", "the MCP server requires authorization");
  if (e instanceof StreamableHTTPError || e instanceof SseError) {
    if (e.code === 401) return new UserMcpError("auth_required", "the MCP server requires authorization");
    return new UserMcpError("upstream_error", `the MCP server answered${e.code ? ` HTTP ${e.code}` : " with an error"}`);
  }
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return new UserMcpError("timeout", "the MCP server did not answer in time");
  return new UserMcpError("upstream_error", "could not talk to the MCP server");
}

/* ---------------------------------------------------------------- catalog */

function cleanTool(t: Record<string, unknown>): RawTool | null {
  if (typeof t.name !== "string" || !t.name || t.name.length > 128) return null;
  const schema = t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema) ? (t.inputSchema as Record<string, unknown>) : { type: "object" };
  const ann = t.annotations && typeof t.annotations === "object" ? (t.annotations as Record<string, unknown>) : null;
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  return {
    name: t.name,
    ...(typeof t.title === "string" ? { title: t.title.slice(0, 200) } : {}),
    ...(typeof t.description === "string" ? { description: t.description.slice(0, 4000) } : {}),
    inputSchema: { ...schema, type: "object" },
    ...(t.outputSchema && typeof t.outputSchema === "object" ? { outputSchema: t.outputSchema as Record<string, unknown> } : {}),
    ...(ann
      ? {
          annotations: {
            ...(typeof ann.title === "string" ? { title: ann.title.slice(0, 200) } : {}),
            readOnlyHint: bool(ann.readOnlyHint),
            destructiveHint: bool(ann.destructiveHint),
            idempotentHint: bool(ann.idempotentHint),
            openWorldHint: bool(ann.openWorldHint),
          },
        }
      : {}),
  };
}

function serverInfo(c: Client): McpServerInfo | null {
  const v = c.getServerVersion();
  if (!v) return null;
  const instructions = c.getInstructions();
  return {
    name: oneLine(v.name, 120),
    version: oneLine(v.version, 60),
    ...(typeof v.title === "string" ? { title: oneLine(v.title, 120) } : {}),
    ...(instructions ? { instructions: instructions.slice(0, 2000) } : {}),
  };
}

async function fetchTools(c: Client): Promise<RawTool[]> {
  const out: RawTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await c.listTools(cursor ? { cursor } : undefined, { timeout: LIST_TIMEOUT_MS });
    for (const t of r.tools) {
      const clean = cleanTool(t as unknown as Record<string, unknown>);
      if (clean && out.length < MAX_TOOLS && !out.some((x) => x.name === clean.name)) out.push(clean);
    }
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

function assertUsable(rec: ServerRecord) {
  if (!rec.enabled) throw new UserMcpError("server_disabled", `"${rec.name}" is turned off`);
  if (rec.status !== "ok") throw new UserMcpError("auth_required", `"${rec.name}" needs to be ${rec.status === "pending" ? "authorized" : "reconnected"} in Settings → Apps & bots`);
}

/**
 * The server's tools: the 5-minute cache, else a fresh tools/list (persisted). When the server
 * can't be reached the last stored catalog is returned with stale=true.
 */
export async function getCatalog(rec: ServerRecord, { refresh = false }: { refresh?: boolean } = {}): Promise<{ tools: RawTool[]; info: McpServerInfo | null; stale: boolean }> {
  const hit = S.catalogs.get(rec.id);
  if (!refresh && hit && Date.now() - hit.at < CATALOG_TTL_MS) return { tools: hit.tools, info: hit.info, stale: false };
  try {
    assertUsable(rec);
    const { tools, info } = await withSession(rec, async (c) => ({ tools: await fetchTools(c), info: serverInfo(c) }));
    S.catalogs.set(rec.id, { at: Date.now(), tools, info });
    saveCatalog(rec.id, info, tools);
    return { tools, info, stale: false };
  } catch (e) {
    const err = mapError(e);
    if (err.code !== "server_disabled") setLastError(rec.id, err.message);
    if (rec.catalog && err.code !== "server_disabled") return { tools: rec.catalog, info: rec.serverInfo, stale: true };
    throw err;
  }
}

/** Settings → Test connection: a fresh session, then tools, resources and prompts. */
export async function testServer(rec: ServerRecord): Promise<{
  server: McpServerInfo | null;
  transport: string;
  tools: RawTool[];
  resources: McpNamedItem[];
  prompts: McpNamedItem[];
  ms: number;
}> {
  const started = Date.now();
  dropServer(rec.id);
  if (rec.status !== "ok") throw new UserMcpError("auth_required", rec.status === "pending" ? "authorize the server first" : "reconnect the server first");
  try {
    return await withSession(rec, async (c) => {
      const caps = c.getServerCapabilities() ?? {};
      const tools = caps.tools ? await fetchTools(c) : [];
      const pick = (x: Record<string, unknown>): McpNamedItem => ({
        name: oneLine(x.name, 200),
        ...(typeof x.title === "string" ? { title: oneLine(x.title, 200) } : {}),
        ...(typeof x.description === "string" ? { description: oneLine(x.description, 500) } : {}),
        ...(typeof x.uri === "string" ? { uri: oneLine(x.uri, 500) } : {}),
        ...(typeof x.mimeType === "string" ? { mimeType: oneLine(x.mimeType, 100) } : {}),
        ...(Array.isArray(x.arguments) ? { arguments: x.arguments.slice(0, 30) } : {}),
      });
      const resources = caps.resources
        ? (await c.listResources(undefined, { timeout: LIST_TIMEOUT_MS }).catch(() => ({ resources: [] }))).resources.slice(0, 200).map((r) => pick(r as unknown as Record<string, unknown>))
        : [];
      const prompts = caps.prompts
        ? (await c.listPrompts(undefined, { timeout: LIST_TIMEOUT_MS }).catch(() => ({ prompts: [] }))).prompts.slice(0, 200).map((p) => pick(p as unknown as Record<string, unknown>))
        : [];
      const info = serverInfo(c);
      S.catalogs.set(rec.id, { at: Date.now(), tools, info });
      saveCatalog(rec.id, info, tools);
      return { server: info, transport: rec.transport, tools, resources, prompts, ms: Date.now() - started };
    });
  } catch (e) {
    const err = mapError(e);
    setLastError(rec.id, err.message);
    throw err;
  }
}

/* ------------------------------------------------------------------ calls */

function rateHit(key: string, limit: number): number {
  const now = Date.now();
  const hits = (S.hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= limit) {
    S.hits.set(key, hits);
    return Math.max(1, Math.ceil((hits[0] + 60_000 - now) / 1000));
  }
  hits.push(now);
  S.hits.set(key, hits);
  if (S.hits.size > 20_000) S.hits.clear();
  return 0;
}

function capResult(raw: Record<string, unknown>): { result: McpCallResult; truncated: boolean } {
  let content = Array.isArray(raw.content) ? (raw.content as Array<Record<string, unknown>>).filter((b) => b && typeof b === "object") : [];
  // Legacy servers answer { toolResult } instead of content blocks.
  if (!content.length && "toolResult" in raw) content = [{ type: "text", text: JSON.stringify(raw.toolResult) ?? "null" }];
  const structured = raw.structuredContent && typeof raw.structuredContent === "object" && !Array.isArray(raw.structuredContent) ? (raw.structuredContent as Record<string, unknown>) : undefined;
  const result: McpCallResult = { content, ...(structured ? { structuredContent: structured } : {}), ...(raw.isError === true ? { isError: true } : {}) };
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? "");
  if (size(result) <= RESULT_MAX_BYTES) return { result, truncated: false };

  const budget = RESULT_MAX_BYTES - 1024;
  let used = 0;
  const out: Array<Record<string, unknown>> = [];
  for (const block of content) {
    const left = budget - used;
    if (left <= 0) break;
    const n = size(block);
    if (n <= left) {
      out.push(block);
      used += n;
    } else if (block.type === "text" && typeof block.text === "string") {
      // Approximate: cut by characters, then shrink until it fits.
      let text = block.text.slice(0, Math.max(0, left - 64));
      while (text && size({ ...block, text }) > left) text = text.slice(0, Math.floor(text.length * 0.9));
      out.push({ ...block, text });
      used = budget;
    } else {
      const note = { type: "text", text: `[${typeof block.type === "string" ? block.type : "content"} omitted: too large]` };
      out.push(note);
      used += size(note);
    }
  }
  const keepStructured = structured && used + size(structured) <= budget;
  out.push({ type: "text", text: `[Result truncated: it exceeded ${RESULT_MAX_BYTES / 1024} KB${structured && !keepStructured ? "; structured content dropped" : ""}]` });
  return {
    result: { content: out, ...(keepStructured ? { structuredContent: structured } : {}), ...(raw.isError === true ? { isError: true } : {}) },
    truncated: true,
  };
}

/**
 * Calls a tool on the user's server. The caller has already checked who may call it (session for
 * the routes, mod grants, the MCP confirmation gate); this checks the server state, the user's
 * tool allowlist, limits and argument shape.
 */
export async function callTool(
  rec: ServerRecord,
  toolName: string,
  args: unknown,
): Promise<{ result: McpCallResult; truncated: boolean; ms: number }> {
  assertUsable(rec);
  if (rec.disabledTools.has(toolName)) throw new UserMcpError("tool_disabled", `the tool "${toolName}" is turned off for "${rec.name}"`);
  const { tools } = await getCatalog(rec);
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) throw new UserMcpError("not_found", `"${rec.name}" has no tool "${toolName}"`);
  const clean = validateArgs(args, tool.inputSchema);

  const userWait = rateHit(`u:${rec.userSub}`, USER_CALLS_PER_MIN);
  if (userWait) throw new UserMcpError("rate_limited", `too many MCP calls (max ${USER_CALLS_PER_MIN} per minute)`, userWait);
  const serverWait = rateHit(`s:${rec.id}`, SERVER_CALLS_PER_MIN);
  if (serverWait) throw new UserMcpError("rate_limited", `too many calls to "${rec.name}" (max ${SERVER_CALLS_PER_MIN} per minute)`, serverWait);
  const running = S.inflight.get(rec.userSub) ?? 0;
  if (running >= MAX_CONCURRENT_CALLS_PER_USER) throw new UserMcpError("rate_limited", "too many MCP calls running at once; wait for one to finish", 1);
  S.inflight.set(rec.userSub, running + 1);

  const started = Date.now();
  try {
    noteUsed(rec.id);
    const raw = await withSession(rec, (c) =>
      c.callTool({ name: toolName, arguments: clean }, undefined, { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS }),
    );
    return { ...capResult(raw as Record<string, unknown>), ms: Date.now() - started };
  } catch (e) {
    throw mapError(e);
  } finally {
    const n = (S.inflight.get(rec.userSub) ?? 1) - 1;
    if (n <= 0) S.inflight.delete(rec.userSub);
    else S.inflight.set(rec.userSub, n);
  }
}
