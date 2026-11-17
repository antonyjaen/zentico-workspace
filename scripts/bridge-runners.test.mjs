// Tests for tools/zentico-bridge.mjs: each runner's parse of its agent's JSON output (synthetic
// fixtures that follow each CLI's documented event shapes, not captured recordings), the spoken-reply
// protocol, the per-agent MCP config files, and the API-mode tool loop against local mock servers.
// Run: node scripts/bridge-runners.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ZENTICO_BRIDGE_NO_MAIN = "1";
const bridge = await import("../tools/zentico-bridge.mjs");
const { RUNNERS, splitSpoken, describeTool, loadConfig, writeMcpConfig, makeContext, mcpClient, openAiLoop, anthropicLoop, pickTools } = bridge;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const TOKEN = `zwmcp_${"A".repeat(43)}`;
const cfgFor = (agent, extra = {}) => loadConfig({ url: "https://team.example.com", token: TOKEN, agent, model: "m1", ...extra }, {});
const sample = {
  id: "11111111-2222-4333-8444-555555555555",
  text: "What's next on my calendar?",
  source: "voice",
  room: "abc-defg-hij",
  title: "Standup",
  meetingUrl: "https://team.example.com/meet/abc-defg-hij",
  speaker: { name: "Ana", email: "ana@example.com" },
  createdAt: new Date().toISOString(),
  timeZone: "Europe/Madrid",
  transcript: [],
  meeting: null,
};

/** Feeds lines to a runner the way the bridge does and returns the outcome. */
function feed(runner, lines, exit = 0) {
  const st = { lastText: "", final: null, error: null };
  const progress = [];
  for (const line of lines) {
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = null;
    }
    for (const ev of runner.parse(line, msg, st) ?? []) {
      if (ev.toolName != null) progress.push(describeTool(ev.toolName, ev.input));
      else if (ev.text != null) {
        st.lastText = String(ev.text).trim();
        progress.push(st.lastText);
      } else if ("final" in ev) st.final = ev.final ?? st.lastText;
      else if (ev.error) st.error = ev.error;
    }
  }
  if (runner.finish && st.final == null && !st.error) {
    const ev = runner.finish(st, exit);
    if (ev && "final" in ev) st.final = ev.final;
  }
  return { st, progress };
}
const j = (o) => JSON.stringify(o);

/* ----------------------------------------------------------------- parsing */

await test("claude: tool progress, final result", () => {
  const { st, progress } = feed(RUNNERS.claude, [
    j({ type: "system", subtype: "init" }),
    j({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__zentico__calendar_list_events", input: { query: "today" } }] } }),
    j({ type: "assistant", message: { content: [{ type: "text", text: "Your next event is Standup at 10:00." }] } }),
    j({ type: "result", subtype: "success", result: "Your next event is Standup at 10:00.\nSAY: Standup at ten." }),
  ]);
  assert.deepEqual(progress[0], "Using calendar_list_events: today");
  assert.equal(st.final, "Your next event is Standup at 10:00.\nSAY: Standup at ten.");
});

await test("claude: error result", () => {
  const { st } = feed(RUNNERS.claude, [j({ type: "result", subtype: "error_max_turns", is_error: true, result: "" })]);
  assert.match(st.error, /error_max_turns/);
});

await test("codex: mcp tool call, agent message, turn completed", () => {
  const { st, progress } = feed(RUNNERS.codex, [
    j({ type: "thread.started", thread_id: "t1" }),
    j({ type: "turn.started" }),
    j({ type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "zentico", tool: "mail_search", arguments: { query: "from:ana" }, status: "in_progress" } }),
    j({ type: "item.completed", item: { id: "i1", type: "mcp_tool_call", server: "zentico", tool: "mail_search", status: "completed" } }),
    j({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "Ana wrote twice.\nSAY: Two mails from Ana." } }),
    j({ type: "turn.completed", usage: { input_tokens: 1 } }),
  ]);
  assert.equal(progress[0], "Using mail_search: from:ana");
  assert.equal(st.final, "Ana wrote twice.\nSAY: Two mails from Ana.");
});

await test("codex: older item_type shape and a failed turn", () => {
  const ok = feed(RUNNERS.codex, [j({ type: "item.completed", item: { item_type: "assistant_message", text: "hi" } }), j({ type: "turn.completed" })]);
  assert.equal(ok.st.final, "hi");
  const bad = feed(RUNNERS.codex, [j({ type: "turn.failed", error: { message: "quota exceeded" } })]);
  assert.equal(bad.st.error, "quota exceeded");
});

await test("opencode: tool_use, text, error", () => {
  const { st, progress } = feed(RUNNERS.opencode, [
    j({ type: "step_start", part: { type: "step-start" } }),
    j({ type: "tool_use", part: { type: "tool", tool: "zentico_drive_search", state: { status: "completed", input: { query: "budget" } } } }),
    j({ type: "text", part: { type: "text", text: "Found budget.xlsx.\nSAY: Found the budget." } }),
    j({ type: "step_finish", part: { type: "step-finish", reason: "stop" } }),
  ]);
  assert.equal(progress[0], "Using drive_search: budget");
  // No explicit final event: the bridge takes the last text on a clean exit.
  assert.equal(st.final, null);
  assert.equal(st.lastText, "Found budget.xlsx.\nSAY: Found the budget.");
  const bad = feed(RUNNERS.opencode, [j({ type: "error", error: { name: "ProviderAuthError", data: { message: "no API key" } } })]);
  assert.equal(bad.st.error, "no API key");
});

await test("gemini: assistant deltas, tool_use resets, result", () => {
  const { st, progress } = feed(RUNNERS.gemini, [
    j({ type: "init", session_id: "s", model: "gemini" }),
    j({ type: "message", role: "user", content: "hi" }),
    j({ type: "message", role: "assistant", content: "Let me check.", delta: true }),
    j({ type: "tool_use", tool_name: "calendar_list_events", tool_id: "t1", parameters: { title: "x" } }),
    j({ type: "tool_result", tool_id: "t1", status: "success", output: "[]" }),
    j({ type: "message", role: "assistant", content: "Nothing today.", delta: true }),
    j({ type: "message", role: "assistant", content: "\nSAY: Your day is free.", delta: true }),
    j({ type: "result", status: "success", stats: {} }),
  ]);
  assert.ok(progress.includes("Using calendar_list_events: x"));
  assert.equal(st.final, "Nothing today.\nSAY: Your day is free.");
  const bad = feed(RUNNERS.gemini, [j({ type: "result", status: "error", error: { message: "auth" } })]);
  assert.equal(bad.st.error, "auth");
});

await test("custom: whole stdout is the answer on exit 0", () => {
  const { st } = feed(RUNNERS.custom, ["Here you go.", "SAY: Done."], 0);
  assert.equal(st.final, "Here you go.\nSAY: Done.");
  const bad = feed(RUNNERS.custom, ["partial"], 2);
  assert.equal(bad.st.final, null);
});

/* ------------------------------------------------------------ spoken reply */

await test("splitSpoken: JSON line, SAY, Speaker, fallback", () => {
  assert.deepEqual(splitSpoken('Long answer.\n{"say":"Short one.","result":"Shown text."}'), { result: "Shown text.", spoken: "Short one." });
  assert.deepEqual(splitSpoken("Body here.\nSAY: Spoken **line**."), { result: "Body here.", spoken: "Spoken line." });
  assert.deepEqual(splitSpoken("Body.\n\n**🔊 Speaker:** Hello there."), { result: "Body.", spoken: "Hello there." });
  assert.deepEqual(splitSpoken("You have three meetings today. The first is at 9."), { result: "You have three meetings today. The first is at 9.", spoken: "" });
  assert.equal(splitSpoken("You have three meetings today. The first is at 9.", { fallback: true }).spoken, "You have three meetings today.");
  const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  assert.equal(splitSpoken(long, { fallback: true }).spoken.split(" ").length, 25);
  // A JSON line without "say" is plain text.
  assert.equal(splitSpoken('Result:\n{"a":1}').result, 'Result:\n{"a":1}');
});

/* ----------------------------------------------------- configs and argv */

await test("configs: both headers, token only in Claude's file, never on argv", () => {
  for (const agent of ["claude", "codex", "opencode", "gemini"]) {
    const dir = mkdtempSync(join(tmpdir(), "zb-test-"));
    try {
      const ctx = makeContext(sample, dir, cfgFor(agent));
      const prep = RUNNERS[agent].prepare(ctx);
      assert.ok(!prep.argv.some((a) => a.includes(TOKEN)), `${agent}: token on argv`);
      assert.equal(prep.env.ZW_AUTH, `Bearer ${TOKEN}`);
      assert.equal(prep.env.ZW_CMD, sample.id);
      const file = readFileSync(prep.env.ZW_MCP_CONFIG, "utf8");
      assert.match(file, /X-Zentico-Command/, `${agent}: no command header`);
      assert.match(file, /Authorization/, `${agent}: no auth header`);
      if (agent === "claude") assert.ok(file.includes(TOKEN));
      else assert.ok(!file.includes(TOKEN), `${agent}: token in config file`);
      if (agent !== "claude") assert.match(prep.stdin, /^## Output rules\n/);
      else assert.ok(prep.argv.includes("--append-system-prompt"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

await test("no web or local file tools for agents steered by meeting speech; assist runs get only stage tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "zb-test-"));
  try {
    const gem = JSON.parse(readFileSync(RUNNERS.gemini.prepare(makeContext(sample, dir, cfgFor("gemini"))).env.ZW_MCP_CONFIG, "utf8"));
    for (const t of ["web_fetch", "google_web_search", "read_file", "read_many_files", "run_shell_command"]) assert.ok(gem.tools.exclude.includes(t), `gemini: ${t}`);
    const oc = JSON.parse(readFileSync(RUNNERS.opencode.prepare(makeContext(sample, dir, cfgFor("opencode"))).env.ZW_MCP_CONFIG, "utf8"));
    assert.equal(oc.permission.webfetch, "deny");
    assert.equal(oc.tools.read, false);
    const plain = RUNNERS.claude.prepare(makeContext(sample, dir, cfgFor("claude"))).argv;
    assert.ok(!plain.includes("--disallowedTools"));
    const assist = RUNNERS.claude.prepare(makeContext({ ...sample, source: "assist", prompt: "Keep the stage" }, dir, cfgFor("claude"))).argv;
    const allowed = assist[assist.indexOf("--allowedTools") + 1];
    assert.match(allowed, /mcp__zentico__meeting_pin_card/);
    assert.doesNotMatch(allowed, /Read|meeting_stage_save|mcp__zentico,/);
    assert.match(assist[assist.indexOf("--disallowedTools") + 1], /Read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("codex: env_http_headers and timeout passed with -c", () => {
  const dir = mkdtempSync(join(tmpdir(), "zb-test-"));
  try {
    const prep = RUNNERS.codex.prepare(makeContext(sample, dir, cfgFor("codex", { "tool-timeout": "240" })));
    assert.ok(prep.argv.includes("mcp_servers.zentico.env_http_headers={Authorization='ZW_AUTH',X-Zentico-Command='ZW_CMD'}"));
    assert.ok(prep.argv.includes("mcp_servers.zentico.tool_timeout_sec=240"));
    assert.equal(prep.argv.at(-1), "-");
    assert.ok(!prep.argv.some((a) => a.includes('"')), "double quotes would break the cmd.exe line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("custom: placeholders, {prompt} limit and direct spawn", () => {
  const dir = mkdtempSync(join(tmpdir(), "zb-test-"));
  try {
    const cfg = cfgFor("custom", { custom: 'tool run "--in={promptFile}" {mcpConfig}', "mcp-format": "gemini" });
    const prep = RUNNERS.custom.prepare(makeContext(sample, dir, cfg));
    assert.equal(cfg.program, "tool");
    assert.match(prep.argv[1], /^--in=.*prompt\.md$/);
    assert.match(prep.argv[2], /gemini-settings\.json$/);
    assert.ok(!prep.direct);
    const direct = RUNNERS.custom.prepare(makeContext(sample, dir, cfgFor("custom", { custom: "tool {prompt}" })));
    assert.ok(direct.direct);
    const huge = { ...sample, meeting: { from: sample.createdAt, to: sample.createdAt, text: "x".repeat(7000), truncated: false } };
    assert.throws(() => RUNNERS.custom.prepare(makeContext(huge, dir, cfgFor("custom", { custom: "tool {prompt}" }))), /too long/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("config: validation", () => {
  assert.throws(() => cfgFor("nope"), /--agent/);
  assert.throws(() => cfgFor("openai", { model: undefined }), /needs --model/);
  assert.throws(() => cfgFor("claude", { "tool-timeout": "60" }), /tool-timeout/);
  assert.equal(cfgFor("claude", { timeout: "600s" }).timeoutMs, 600_000);
  assert.equal(cfgFor("claude", { timeout: "5" }).timeoutMs, 300_000);
  assert.equal(cfgFor("claude", { claude: "/opt/claude" }).program, "/opt/claude");
  assert.equal(cfgFor("codex").program, "codex");
});

/* ---------------------------------------------------------------- API mode */

function listen(handler) {
  return new Promise((done) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
const readBody = (req) =>
  new Promise((done) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => done(b ? JSON.parse(b) : null));
  });

const seenHeaders = [];
const toolCalls = [];
let toolDelayMs = 0;
const mcpServer = await listen(async (req, res) => {
  const body = await readBody(req);
  seenHeaders.push({ auth: req.headers.authorization, cmd: req.headers["x-zentico-command"] });
  let result;
  if (body.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock" } };
  else if (body.method === "tools/list")
    result = {
      tools: [
        { name: "calendar_list_events", description: "List events", inputSchema: { type: "object", properties: {} } },
        { name: "ui_read_file", description: "UI", inputSchema: { type: "object" } },
        { name: "ext_bad.name", description: "x", inputSchema: { type: "object" } },
      ],
    };
  else if (body.method === "tools/call") {
    toolCalls.push(body.params);
    if (toolDelayMs) await new Promise((r) => setTimeout(r, toolDelayMs));
    result = { content: [{ type: "text", text: "x".repeat(25_000) }] };
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
});

let modelCalls = [];
let alwaysTools = false;
const openai = await listen(async (req, res) => {
  const body = await readBody(req);
  modelCalls.push({ body, auth: req.headers.authorization });
  const n = modelCalls.length;
  const callTool = alwaysTools ? body.tool_choice !== "none" : n === 1;
  const message = callTool
    ? { role: "assistant", content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "calendar_list_events", arguments: "{}" } }] }
    : { role: "assistant", content: "You're free.\nSAY: Free all day." };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message }] }));
});

const anthropic = await listen(async (req, res) => {
  const body = await readBody(req);
  modelCalls.push({ body, key: req.headers["x-api-key"] });
  const first = body.messages.length === 1;
  const content = first
    ? [{ type: "tool_use", id: "tu1", name: "calendar_list_events", input: {} }]
    : [{ type: "text", text: "Done.\nSAY: All set." }];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ content, stop_reason: first ? "tool_use" : "end_turn" }));
});

const mcpFor = (id = "cmd-1") => mcpClient({ url: mcpServer.url, auth: `Bearer ${TOKEN}`, commandId: id });

await test("api: tool filter by prefix and valid names", async () => {
  const mcp = mcpFor();
  await mcp.init(new AbortController().signal);
  const tools = await mcp.listTools(new AbortController().signal);
  assert.deepEqual(pickTools(tools, ["calendar_"]).map((t) => t.name), ["calendar_list_events"]);
  assert.deepEqual(pickTools(tools, ["ext_"]).map((t) => t.name), []);
});

await test("api: openai loop calls the tool, forwards both headers, caps output", async () => {
  seenHeaders.length = 0;
  toolCalls.length = 0;
  modelCalls = [];
  const mcp = mcpFor("cmd-42");
  const signal = new AbortController().signal;
  await mcp.init(signal);
  const tools = pickTools(await mcp.listTools(signal), ["calendar_"]);
  const progress = [];
  const text = await openAiLoop({ base: openai.url, key: "sk-test", model: "m", system: "S", prompt: "P", tools, mcp, maxSteps: 5, toolTimeoutMs: 5000, signal, progress: (t) => progress.push(t) });
  assert.equal(text, "You're free.\nSAY: Free all day.");
  assert.equal(toolCalls.length, 1);
  assert.ok(seenHeaders.every((h) => h.cmd === "cmd-42" && h.auth === `Bearer ${TOKEN}`));
  assert.equal(modelCalls[0].auth, "Bearer sk-test");
  const toolMsg = modelCalls[1].body.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg.content.length < 20_100 && toolMsg.content.includes("cut at 20000"));
  assert.ok(progress.includes("Using calendar_list_events"));
});

await test("api: max steps, the last step may not call tools", async () => {
  modelCalls = [];
  alwaysTools = true;
  const mcp = mcpFor();
  const signal = new AbortController().signal;
  const tools = pickTools(await mcp.listTools(signal), ["calendar_"]);
  const text = await openAiLoop({ base: openai.url, key: "", model: "m", system: "S", prompt: "P", tools, mcp, maxSteps: 3, toolTimeoutMs: 5000, signal, progress: () => {} });
  alwaysTools = false;
  assert.equal(modelCalls.length, 3);
  assert.equal(modelCalls[2].body.tool_choice, "none");
  assert.equal(text, "You're free.\nSAY: Free all day.");
});

await test("api: tool timeout becomes a tool error, cancel aborts the loop", async () => {
  modelCalls = [];
  toolDelayMs = 400;
  const mcp = mcpFor();
  const tools = pickTools(await mcp.listTools(new AbortController().signal), ["calendar_"]);
  const text = await openAiLoop({ base: openai.url, key: "k", model: "m", system: "S", prompt: "P", tools, mcp, maxSteps: 5, toolTimeoutMs: 100, signal: new AbortController().signal, progress: () => {} });
  assert.match(modelCalls[1].body.messages.find((m) => m.role === "tool").content, /Tool failed: .*timed out/);
  assert.ok(text);
  modelCalls = [];
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("cancelled")), 100);
  await assert.rejects(openAiLoop({ base: openai.url, key: "k", model: "m", system: "S", prompt: "P", tools, mcp, maxSteps: 5, toolTimeoutMs: 5000, signal: ac.signal, progress: () => {} }));
  toolDelayMs = 0;
});

await test("api: anthropic loop", async () => {
  modelCalls = [];
  const mcp = mcpFor();
  const signal = new AbortController().signal;
  const tools = pickTools(await mcp.listTools(signal), ["calendar_"]);
  const text = await anthropicLoop({ base: anthropic.url, key: "ak", model: "m", system: "S", prompt: "P", tools, mcp, maxSteps: 4, toolTimeoutMs: 5000, signal, progress: () => {} });
  assert.equal(text, "Done.\nSAY: All set.");
  assert.equal(modelCalls[0].key, "ak");
  assert.equal(modelCalls[0].body.tools[0].input_schema.type, "object");
  assert.equal(modelCalls[1].body.messages[2].content[0].type, "tool_result");
});

for (const s of [mcpServer, openai, anthropic]) s.server.close();

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
