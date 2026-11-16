#!/usr/bin/env node
// Zentico bridge: runs the commands you say in Zentico Meet ("Claude, …") with YOUR OWN Claude Code.
// Plain Node 18+, no dependencies.
//
//   node zentico-bridge.mjs --url https://team.zentico.dev --token <MCP token> --cwd <dir> [--claude claude]
//
// Options
//   --url <url>            Workspace URL (required)
//   --token <token>        Personal access token from Settings → Integrations (read+write).
//                          Or set ZENTICO_TOKEN (keeps it out of your shell history).
//   --cwd <dir>            Working directory for Claude Code (default: current directory)
//   --claude <cmd>         Claude Code executable (default: claude)
//   --allowed-tools <list> Tools Claude may use without asking (default: mcp__zentico,Read,Glob,Grep)
//   --keep-mcp             Also load your other MCP servers (default: only the zentico server, so no other
//                          configured "zentico" server can bypass the in-meeting write confirmation)
//   --timeout <minutes>    Max run time per command (default: 10)
//
// How it works: it keeps a Server-Sent Events stream open to <url>/api/agent/stream (only your own
// commands arrive), runs them one at a time with `claude -p --output-format stream-json --verbose`
// and an MCP config pointing at <url>/api/mcp with your token plus "X-Zentico-Command: <id>" (write
// tools then wait for your Approve / Reject in the call), and reports progress and the final answer to
// <url>/api/agent/commands/<id>/events. Claude is asked to end with a "SAY: …" line: that short summary
// is stripped from the shown answer and sent as "spoken" (read aloud in the call). A cancelled command
// (Cancel in the call, seen on the stream or in any report) kills the claude process tree. It
// reconnects with backoff. Stop it with Ctrl+C.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VERSION = "1.1.0";

/* ----------------------------------------------------------------- options */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === "keep-mcp" || key === "help") out[key] = true;
    else {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value for --${key}`);
      out[key] = v;
    }
  }
  return out;
}

function fail(msg) {
  console.error(`zentico-bridge: ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node zentico-bridge.mjs --url https://team.zentico.dev --token <token> --cwd <dir> [--claude claude]");
  process.exit(0);
}
let baseUrl;
try {
  const u = new URL(args.url ?? "");
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) fail("--url must use https:// (http:// only for localhost)");
  baseUrl = u.origin;
} catch {
  fail("--url is required, e.g. --url https://team.zentico.dev");
}
const token = (args.token ?? process.env.ZENTICO_TOKEN ?? "").trim();
if (!/^zwmcp_[A-Za-z0-9_-]{43}$/.test(token)) fail("--token (or ZENTICO_TOKEN) must be a Zentico access token (zwmcp_…)");
const cwd = resolve(args.cwd ?? process.cwd());
try {
  if (!statSync(cwd).isDirectory()) throw new Error();
} catch {
  fail(`--cwd is not a directory: ${cwd}`);
}
const claudeCmd = args.claude ?? "claude";
const allowedTools = args["allowed-tools"] ?? "mcp__zentico,Read,Glob,Grep";
if (!/^[\w.,:*()\- ]{1,500}$/.test(allowedTools)) fail("--allowed-tools has unexpected characters");
const timeoutMs = Math.max(1, Math.min(120, Number(args.timeout ?? 10) || 10)) * 60_000;

const auth = { Authorization: `Bearer ${token}` };
const log = (...m) => console.log(new Date().toLocaleTimeString(), ...m);

/* ---------------------------------------------------------------- reporting */

async function report(id, event) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/api/agent/commands/${encodeURIComponent(id)}/events`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return await res.json().catch(() => ({}));
      if (res.status === 404 || res.status === 401) return { cancelled: true };
    } catch {
      // network hiccup: retry
    }
    await sleep(1000 * 2 ** attempt);
  }
  return {};
}

/* ------------------------------------------------------------------ prompt */

function buildPrompt(c) {
  const tz = c.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fmt = (iso) => {
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
    } catch {
      return iso;
    }
  };
  let now;
  try {
    now = new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(new Date());
  } catch {
    now = new Date().toISOString();
  }
  const spoken = c.source === "voice";
  const lines = [
    `${c.speaker.name} <${c.speaker.email}> asked you this ${spoken ? "out loud" : "in writing"} during a video meeting in Zentico Workspace.`,
    "",
    `Request${spoken ? " (transcribed from speech, may contain recognition errors)" : ""}:`,
    `"""${c.text}"""`,
    "",
    "Context:",
    `- Meeting: ${c.title} (room ${c.room}, ${c.meetingUrl})`,
    `- Now: ${now} (time zone ${tz})`,
  ];
  if (c.transcript?.length) {
    lines.push(`- What ${c.speaker.name} said in the last ~2 minutes (their own microphone only; other people are not included):`);
    for (const t of c.transcript) lines.push(`  [${fmt(t.at)}] ${t.text}`);
  }
  lines.push(
    "",
    "Guidance:",
    "- Use the zentico MCP tools for workspace actions (mail, calendar, contacts, Drive/Docs, chat, meeting transcripts). Look things up (e.g. contacts_search for email addresses) instead of guessing.",
    "- Write actions (sending mail, creating events, posting messages, writing files) are confirmed by the user in the meeting window automatically: just call the tool, don't ask for confirmation in text. If a tool answers \"Not confirmed by the user\", don't retry; say the action was not done.",
    "- If the request is unclear or something essential is missing, do only the safe read-only part and say what is missing.",
    "- Finish with a short answer (at most 5 sentences) for a small panel in the call, in the language of the request.",
    "- Then end with the SAY line described in your system prompt.",
  );
  return lines.join("\n");
}

/* ----------------------------------------------------------- spoken reply */

// Single line, no quotes or cmd.exe metacharacters (it goes on the command line; see spawnClaude).
const SAY_PROMPT =
  "This request comes from a live video meeting and your answer will also be read aloud to everyone in the call. " +
  "After your normal answer, end with one last line that starts with SAY: followed by one or two very short sentences, " +
  "at most about 20 words, to be spoken aloud. Write it for listeners with ADHD: the key answer or outcome first, " +
  "plain everyday words, no symbols, file paths, links, email addresses, code, emojis, lists or markdown. " +
  "Use the same language the request was spoken in. Nothing may follow the SAY line.";
if (!/^[\w .,:;'-]+$/.test(SAY_PROMPT)) throw new Error("SAY_PROMPT must stay cmd.exe-safe");

const SPOKEN_MAX = 300;
const SAY_LINE = /^\s*[*_]*\s*SAY\s*[*_]*\s*:\s*[*_]*\s*(.*)$/i;
// Added by a global CLAUDE.md voice rule: "**🔊 Speaker:** …".
const SPEAKER_LINE = /^\s*[*_]*\s*(?:🔊\s*)?Speaker\s*:?\s*[*_]*\s*:?\s*(.*)$/u;

const plain = (t) =>
  t
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[*_`#~|<>[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SPOKEN_MAX);

/** Splits Claude's final text into what the panel shows and the short line read aloud. */
function splitSpoken(result) {
  const lines = result.split(/\r?\n/);
  let say = "";
  let speaker = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = SAY_LINE.exec(lines[i]);
    if (m) {
      say = m[1];
      lines.splice(i, 1);
      break;
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const m = /Speaker/.test(lines[i]) ? SPEAKER_LINE.exec(lines[i]) : null;
    if (!m) break;
    speaker ||= m[1];
    lines.splice(i, 1);
  }
  // Trailing blank lines and a dangling horizontal rule.
  while (lines.length && /^\s*(?:-{3,}|\*{3,})?\s*$/.test(lines[lines.length - 1])) lines.pop();
  const shown = lines.join("\n").trim();
  return { result: shown || result.trim(), spoken: plain(say) || plain(speaker) };
}

/* ------------------------------------------------------------------ runner */

const queue = [];
let running = null; // { id, child, cancelled }

function quoteWin(arg) {
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function spawnClaude(argv) {
  const opts = {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Write tools wait up to 2 minutes for your confirmation.
    env: { ...process.env, MCP_TOOL_TIMEOUT: "180000", ZENTICO_TOKEN: undefined },
  };
  if (process.platform === "win32") {
    // claude is usually a .cmd shim: go through cmd.exe. Nothing user-spoken is on the command line
    // (the prompt goes through stdin).
    const line = [claudeCmd, ...argv].map(quoteWin).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  }
  // Own process group, so a cancel can kill claude and everything it started.
  return spawn(claudeCmd, argv, { ...opts, detached: true });
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  // Still alive after a grace period: force it.
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 3000).unref();
}

/** Stops the running command if the server says it was cancelled. */
function stopIfCancelled(state, ack) {
  if (ack?.cancelled && !state.cancelled) {
    state.cancelled = true;
    log("  ■ cancel requested — stopping Claude");
    killTree(state.child);
  }
}

function describeTool(name, input) {
  const short = String(name).replace(/^mcp__zentico__/, "");
  const hint = input && typeof input === "object" ? (input.query ?? input.subject ?? input.title ?? input.name ?? "") : "";
  return `Using ${short}${hint ? `: ${String(hint).slice(0, 80)}` : ""}`;
}

async function runCommand(c) {
  log(`▶ ${c.source === "voice" ? "said" : "typed"}: ${c.text.slice(0, 120)}`);
  const state = { id: c.id, child: null, cancelled: false };
  running = state;
  const ack = await report(c.id, { type: "started" });
  if (ack.cancelled) {
    log("  cancelled before start");
    running = null;
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "zentico-bridge-"));
  const configPath = join(dir, "mcp.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        zentico: { type: "http", url: `${baseUrl}/api/mcp`, headers: { ...auth, "X-Zentico-Command": c.id } },
      },
    }),
    { mode: 0o600 },
  );

  const argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    configPath,
    "--allowedTools",
    allowedTools,
    "--append-system-prompt",
    SAY_PROMPT,
  ];
  if (!args["keep-mcp"]) argv.push("--strict-mcp-config");

  let result = null;
  let isError = false;
  let lastText = "";
  let stderr = "";
  let lastProgress = 0;
  let pendingProgress = null;
  let progressTimer = null;

  const progress = (text) => {
    pendingProgress = text.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!pendingProgress) return;
    const flush = async () => {
      progressTimer = null;
      if (!pendingProgress) return;
      const t = pendingProgress;
      pendingProgress = null;
      lastProgress = Date.now();
      stopIfCancelled(state, await report(c.id, { type: "progress", text: t }));
    };
    if (!progressTimer) progressTimer = setTimeout(flush, Math.max(0, 1000 - (Date.now() - lastProgress)));
  };

  const exit = await new Promise((done) => {
    let child;
    try {
      child = spawnClaude(argv);
    } catch (e) {
      stderr = String(e?.message ?? e);
      return done(-1);
    }
    state.child = child;
    if (state.cancelled) killTree(child);
    const timer = setTimeout(() => {
      stderr += "\nTimed out.";
      killTree(child);
    }, timeoutMs);
    // Backup for a cancel missed on the stream (e.g. it reconnected): ask the server every 10 s.
    const watch = setInterval(() => {
      void report(c.id, { type: "started" }).then((ack) => stopIfCancelled(state, ack));
    }, 10_000);
    child.on("error", (e) => {
      stderr += `\n${e.message}`;
    });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
          for (const part of msg.message.content) {
            if (part.type === "tool_use") progress(describeTool(part.name, part.input));
            else if (part.type === "text" && part.text?.trim()) {
              lastText = part.text.trim();
              progress(lastText);
            }
          }
        } else if (msg.type === "result") {
          result = typeof msg.result === "string" ? msg.result : null;
          isError = !!msg.is_error || (msg.subtype && msg.subtype !== "success");
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      done(code ?? -1);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(buildPrompt(c));
  });

  if (progressTimer) clearTimeout(progressTimer);
  rmSync(dir, { recursive: true, force: true });
  running = null;

  if (state.cancelled) {
    log("  ■ cancelled");
    return;
  }
  if (result && !isError) {
    const out = splitSpoken(result);
    log(`  ✓ ${out.result.replace(/\s+/g, " ").slice(0, 160)}`);
    if (out.spoken) log(`  🔊 ${out.spoken}`);
    await report(c.id, { type: "done", result: out.result, ...(out.spoken ? { spoken: out.spoken } : {}) });
  } else {
    const error =
      result ||
      (exit === -1 || /not recognized|ENOENT|not found/i.test(stderr)
        ? `Couldn't start Claude Code ("${claudeCmd}"). Is it installed and on PATH?`
        : stderr.trim().split("\n").slice(-3).join(" ") || lastText || `Claude Code exited with code ${exit}.`);
    log(`  ✗ ${error.slice(0, 200)}`);
    await report(c.id, { type: "failed", error: error.slice(0, 2000) });
  }
}

async function drain() {
  if (running) return;
  while (queue.length) {
    const next = queue.shift();
    try {
      await runCommand(next);
    } catch (e) {
      running = null;
      log(`  ✗ ${e?.message ?? e}`);
      await report(next.id, { type: "failed", error: "The bridge hit an unexpected error." });
    }
  }
}

function onCancel(id) {
  const i = queue.findIndex((c) => c.id === id);
  if (i >= 0) {
    queue.splice(i, 1);
    log("■ cancelled (queued)");
  } else if (running?.id === id && !running.cancelled) {
    running.cancelled = true;
    log("■ cancel requested — stopping Claude");
    killTree(running.child);
  }
}

/* --------------------------------------------------------------- SSE stream */

async function connect() {
  const res = await fetch(`${baseUrl}/api/agent/stream`, {
    headers: { ...auth, Accept: "text/event-stream", "X-Zentico-Bridge": `zentico-bridge/${VERSION} (${hostname()})` },
  });
  if (res.status === 401) fail("The token was rejected (revoked or expired). Create a new one in Settings → Integrations.");
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const decoder = new TextDecoder();
  let buf = "";
  connectedOnce = false;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let name = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      let payload;
      try {
        payload = JSON.parse(data.join("\n"));
      } catch {
        continue;
      }
      if (name === "hello") {
        connectedOnce = true;
        log(`Connected as ${payload.user?.email} — waiting for "Claude, …" in your meetings.`);
        if (payload.scope !== "write") log("! This token is read-only: Claude can look things up but not send, create or post.");
        // A cancel sent while the stream was down: check the command still running.
        const r = running;
        if (r) void report(r.id, { type: "started" }).then((ack) => stopIfCancelled(r, ack));
      } else if (name === "command" && payload?.id) {
        queue.push(payload);
        void drain();
      } else if (name === "cancel" && payload?.id) {
        onCancel(payload.id);
      }
    }
  }
  return connectedOnce;
}

// Set by connect(): a stream that connected and later dropped retries quickly, not with backoff.
let connectedOnce = false;

async function main() {
  log(`zentico-bridge ${VERSION} → ${baseUrl} (cwd ${cwd})`);
  let delay = 1000;
  for (;;) {
    try {
      const ok = await connect();
      if (ok) delay = 1000;
      log("Stream closed; reconnecting…");
    } catch (e) {
      if (connectedOnce) delay = 1000;
      log(`Connection failed (${e?.message ?? e}); retrying in ${Math.round(delay / 1000)}s`);
    }
    await sleep(delay);
    delay = Math.min(30_000, delay * 2);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

process.on("SIGINT", () => {
  if (running) killTree(running.child);
  process.exit(0);
});

void main();
