# Connected MCP servers: API for dashboard mods

Users add remote MCP servers in **Settings → Apps & bots → MCP servers** (Streamable HTTP with
HTTP+SSE fallback; auth: none, bearer token, custom header or OAuth 2.1). This is the contract the
dashboard host uses to back `zentico.mcp.*` in mods.

- Server code: `src/lib/user-mcp/**` (store, manager, OAuth, grants). Data: `$DATA_DIR/user-mcp.sqlite`.
- Browser helper: `src/lib/user-mcp/client-api.ts` (typed fetch wrappers; types in `types.ts`).
- All routes need the user's session cookie. Mods run in sandboxed iframes without it, so the
  **host** page calls these routes on the mod's behalf (postMessage bridge) and passes the mod's id.
- Credentials and full server URLs never reach the browser (only `host`).

## SDK mapping

| Mod SDK | client-api.ts | Route |
| --- | --- | --- |
| `zentico.mcp.listServers()` | `listServers()` | `GET /api/user-mcp/servers` |
| `zentico.mcp.listTools(serverId)` | `listTools(serverId, { refresh? })` | `GET /api/user-mcp/servers/:id/tools[?refresh=1]` |
| `zentico.mcp.call(serverId, tool, args)` | `callTool(modId, serverId, tool, args, { confirmToken?, remember? })` | `POST /api/user-mcp/call` |
| (host settings UI) | `listGrants(modId?)`, `revokeGrants(modId, serverId?, tool?)` | `GET` / `DELETE /api/user-mcp/grants` |

## Responses

Success: `{ "ok": true, ... }`. Failure: HTTP status per code and

```json
{ "ok": false, "error": { "code": "rate_limited", "message": "…", "retryAfter": 12 }, "consent": { … } }
```

`consent` is present only with `consent_required`. `client-api.ts` throws `UserMcpClientError`
(`code`, `status`, `retryAfter`, `consent`).

### GET /api/user-mcp/servers

Enabled servers with their **enabled** tools (5-minute cache; last known catalog with `stale: true`
when the server is unreachable).

```ts
{ ok: true, servers: Array<{
  id: string; name: string; slug: string; host: string;
  authType: "none" | "bearer" | "header" | "oauth";
  status: "ok" | "pending" | "reauth";      // pending/reauth: calls fail with auth_required
  enabled: true;
  server: { name: string; version: string; title?: string; instructions?: string } | null;
  catalogAt: number | null; lastError: string | null; stale?: boolean;
  tools: Array<{
    name: string; title?: string; description?: string;
    inputSchema: JSONSchema; outputSchema?: JSONSchema;
    annotations?: { title?; readOnlyHint?; destructiveHint?; idempotentHint?; openWorldHint? };
    access: "read" | "write";                // read only when readOnlyHint === true
    enabled: true;
  }>;
}> }
```

### GET /api/user-mcp/servers/:id/tools

`{ ok: true, server: <summary as above without tools>, tools: [...], stale: boolean }`.

### POST /api/user-mcp/call

Request (JSON, `Content-Type: application/json`, same origin):

```ts
{ modId: string;            // /^[A-Za-z0-9_.:-]{1,100}$/, the calling mod
  serverId: string; tool: string; args?: object;
  confirmToken?: string;    // from a consent_required response, after the user approved
  remember?: "once" | "tool" | "server" }  // with confirmToken; default "once"
```

Response: `{ ok: true, result: { content: ContentBlock[], structuredContent?: object, isError?: true }, truncated: boolean, ms: number }`.
`content` blocks are the remote server's MCP content (`text`, `image`, `audio`, `resource`,
`resource_link`). `isError: true` is the tool's own failure (still HTTP 200). Results over 256 KB
are cut, with a trailing text block `[Result truncated …]` and `truncated: true`. `resultText(r)`
joins the text blocks.

## Grant flow (per mod)

1. Tools with `access: "read"` (annotated `readOnlyHint: true`) run for any of the user's mods.
2. Any other tool needs a grant for that mod: per tool, or server-wide (`tool: "*"`).
3. Without one, `/call` answers **403 `consent_required`** with:
   ```ts
   consent: { confirmToken, modId, serverId, serverName, tool, toolTitle, toolDescription,
              access: "write", destructive: boolean, openWorld: boolean, expires: number }
   ```
4. The **host** shows its own prompt ("<mod> wants to use <tool> on <server>", flag destructive /
   open-world) — **never pass `confirmToken` into the mod iframe**.
5. On approve, the host repeats the same call with `confirmToken` and `remember`:
   `"once"` (this call only), `"tool"` (store a grant for this tool) or `"server"` (all tools of
   the server). Tokens are single-use, bound to user × mod × server × tool, valid 5 minutes.
   On reject, return an error to the mod (e.g. `consent_denied` of your own).
6. Grants: `GET /api/user-mcp/grants?modId=` → `{ ok, grants: [{ modId, serverId, tool, access, created }] }`;
   `DELETE /api/user-mcp/grants` `{ modId, serverId?, tool? }` → `{ ok, revoked: number }`.
   Removing a server deletes its grants. Call `revokeGrants(modId)` when a mod is deleted.

Server-side, the same check is `authorizeModMcpCall(user, modId, serverId, tool, { confirmToken?, remember? })`
in `src/lib/user-mcp/grants.ts`.

## Error codes

| code | HTTP | meaning |
| --- | --- | --- |
| `unauthorized` | 401 | no session |
| `forbidden` | 403 | cross-site request, or invalid / expired / reused `confirmToken` |
| `invalid_request` | 400 | malformed body or ids |
| `invalid_args` | 400 | args fail the tool's input-schema shape check (types, required, enum, additionalProperties:false, sizes; max 64 KB) |
| `not_found` | 404 | unknown server or tool |
| `server_disabled` / `tool_disabled` | 403 | the user switched it off in Settings |
| `consent_required` | 403 | see grant flow |
| `auth_required` | 409 | server needs (re)authorization in Settings |
| `unsafe_url` | 400 | URL not https / resolves to a private address |
| `rate_limited` | 429 | 60 calls/min per user, 30/min per server, 4 concurrent per user; `retryAfter` seconds |
| `too_many_sessions` | 503 | session pool full (5 per user, 200 total) |
| `timeout` | 504 | no answer within 30 s |
| `unreachable` / `upstream_error` | 502 | network failure / protocol or server error |
| `failed` | 500 | unexpected |

## Any agent (Claude Code, Codex, OpenCode, Gemini CLI, editors, API keys)

The same servers are exposed through the workspace MCP (`/api/mcp`) as `ext_<slug>__<tool>`
(≤ 64 chars; long or non `[A-Za-z0-9_-]` tool names get a hash suffix). Read-only tools are listed
for every token; other tools only for read+write tokens and, inside meeting/dashboard commands, they
wait for the user's in-call confirmation like built-in write tools.

`/api/mcp` is a standard MCP **Streamable HTTP** server (stateless, JSON responses) with a static
`Authorization: Bearer zwmcp_…` token from Settings → Integrations, so any MCP client works:
Claude Code (`claude mcp add --transport http`), Codex (`[mcp_servers.zentico]` with `url`,
`bearer_token_env_var`, `tool_timeout_sec = 180`), OpenCode (`mcp.zentico` with `type: "remote"`),
Gemini CLI (`mcpServers.zentico.httpUrl`), Cursor (`.cursor/mcp.json`) and VS Code
(`.vscode/mcp.json`, `type: "http"`). The integrations page generates each snippet. claude.ai and
ChatGPT connectors need OAuth, which the server doesn't offer yet.

Meetings, Chat mentions and the dashboard reach the user's agent through `tools/zentico-bridge.mjs`
(served at `/bridge.mjs`), which runs on their computer: `--agent claude|codex|opencode|gemini|custom`
drives that CLI, and `--agent openai|anthropic` runs a small tool loop against an OpenAI-compatible
or Anthropic API with the user's key (no CLI). Every run sends `X-Zentico-Command: <id>`, which turns
on the in-call write confirmation. The bridge reports its agent in `X-Zentico-Bridge`
(`zentico-bridge/1.3.0 codex (host)`); that names the assistant ("Codex") until the user picks a
name and wake words (`GET/PUT /api/agent/profile`).

## Live meeting stage (bridge 1.4.0)

During a call, agents can show things to everyone in it through the `meeting_*` tools: `meeting_stage_open`,
`meeting_whiteboard_add` / `_update` / `_remove` / `_read` (drawn progressively, 4 elements every 120 ms),
`meeting_pin_card` / `meeting_update_card` / `meeting_unpin` (notes, decisions, actions, agenda, checklist,
table), `meeting_stage_focus`, `meeting_current`, `meeting_list_participants`, `meeting_get_live_context`
and `meeting_stage_save`. They act on the call the token's owner is in (or `room`), only while the owner is
in it. Stage edits need no Approve (everyone sees them; any participant can "Undo agent changes");
`meeting_stage_save` (Drive + sharing) is confirmed like other writes.

The state lives in `meetings.sqlite` (`stages`, `stage_items`, `stage_elements`, `stage_log`) and reaches the
room via LiveKit `RoomService/SendData` on topic `zw-stage` (clients poll `GET /api/meet/stage?since=` when
that fails). A stage is saved to Drive and closed after its room has been empty for 30 min
(`STAGE_EMPTY_CLOSE_MS` overrides).

Proactive mode ("let my agent keep the stage up to date"): the owner's bridge receives quiet commands with
`source: "assist"` (prompt built by the server) at most every 45 s, after 500+ characters or 120 s of new
meeting speech; anyone can pause it, it stops when the owner leaves, after 3 h or 150 runs.
