// Meeting commands for the user's own Claude Code ("Claude, do X" in a call). Server-only.
// ${DATA_DIR:-./data}/agent.sqlite holds the command queue, pending write confirmations, the
// user's own recent speech (context for the prompt) and bridge heartbeats. Every function takes
// the acting user's email and scopes its queries by it: a command only ever reaches the bridge of
// the person who spoke or typed it. Single instance: one process owns the file, and the wake-up
// notifier below is in memory.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  cleanSpoken,
  CONFIRM_TIMEOUT_MS,
  type BridgeStatus,
  type CommandStatus,
  type CommandView,
  type ConfirmationView,
} from "@/app/(apps)/meet/claude";
import { meetHref } from "@/app/(apps)/meet/shared";
import { notify } from "../notifications/store";

type SQLValue = null | number | bigint | string | Uint8Array;
type Row = Record<string, SQLValue>;
type Statement = {
  run(...params: SQLValue[]): { changes: number | bigint };
  get(...params: SQLValue[]): Row | undefined;
  all(...params: SQLValue[]): Row[];
};
type Database = { exec(sql: string): void; prepare(sql: string): Statement };

// Loaded at runtime so neither webpack nor Turbopack tries to bundle the builtin.
const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule(
  "node:sqlite",
) as { DatabaseSync: new (path: string, options?: { enableForeignKeyConstraints?: boolean; timeout?: number }) => Database };

const MIGRATIONS = [
  `
  CREATE TABLE commands (
    id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    user_name TEXT NOT NULL DEFAULT '',
    room TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('voice', 'typed')),
    time_zone TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'dispatched', 'needs_confirmation', 'done', 'failed', 'cancelled')),
    progress TEXT,
    result TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    dispatched INTEGER,
    token_id TEXT
  );
  CREATE INDEX commands_user ON commands(user_email, room, created);
  CREATE INDEX commands_status ON commands(status, created);

  CREATE TABLE confirmations (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    decided INTEGER
  );
  CREATE INDEX confirmations_user ON confirmations(user_email, status, created);

  -- Transcribed speech sent from a call, for prompt context (see the "source" column below).
  CREATE TABLE utterances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    room TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX utterances_user ON utterances(user_email, room, at);

  CREATE TABLE bridges (
    user_email TEXT PRIMARY KEY,
    token_id TEXT NOT NULL,
    client TEXT NOT NULL DEFAULT '',
    connected_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  `,
  // Short spoken summary of a result, read aloud in the call.
  `ALTER TABLE commands ADD COLUMN spoken TEXT;`,
  // Where an utterance came from: the user's own push-to-talk command, or the meeting's mixed audio
  // ("Claude listens to the meeting"; every speaker, not attributed).
  `ALTER TABLE utterances ADD COLUMN source TEXT NOT NULL DEFAULT 'command';`,
  // Commands asked in Chat (@-mentioning the user's Claude bot): where to post the result, and the
  // prompt with the conversation context captured when it was asked. Stored with source 'typed'.
  `ALTER TABLE commands ADD COLUMN chat TEXT;`,
];

function open(): Database {
  const dir = resolve(process.env.DATA_DIR?.trim() || "./data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "agent.sqlite"), { enableForeignKeyConstraints: true, timeout: 5000 });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

const g = globalThis as typeof globalThis & {
  __zwAgentDb?: Database;
  __zwAgentWake?: Map<string, Set<() => void>>;
  __zwAgentStreams?: Map<string, number>;
};
const db = () => (g.__zwAgentDb ??= open());
const listeners = (g.__zwAgentWake ??= new Map());
const openStreams = (g.__zwAgentStreams ??= new Map());

const norm = (email: string) => email.trim().toLowerCase();
const s = (v: SQLValue | undefined) => (v == null ? "" : String(v));
const n = (v: SQLValue | undefined) => (v == null ? null : Number(v));

/** A queued command nobody picked up in this time fails (stale voice commands must not run later). */
export const QUEUE_TTL_MS = 10 * 60_000;
/** A dispatched command without any bridge event in this time fails. */
export const RUN_TTL_MS = 20 * 60_000;
const DEDUPE_MS = 15_000;
const UTTERANCE_KEEP_MS = 60 * 60_000;
/** A command comes with the meeting audio and the user's own commands of the last 10 minutes. */
const CONTEXT_MS = 10 * 60_000;
export const PROGRESS_MAX = 500;
export const RESULT_MAX = 8000;

/* ---------------------------------------------------------------- notifier */

/** Wakes the user's open bridge streams (new command or cancellation). */
function wake(email: string) {
  for (const fn of listeners.get(norm(email)) ?? []) {
    try {
      fn();
    } catch {
      // a closed stream: it unsubscribes itself
    }
  }
}

export function onWake(email: string, fn: () => void): () => void {
  const key = norm(email);
  const set = listeners.get(key) ?? new Set();
  set.add(fn);
  listeners.set(key, set);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(key);
  };
}

/* ---------------------------------------------------------------- commands */

/** A command asked in Chat: the conversation/thread to answer in and the prepared prompt. */
export type ChatCommandRef = {
  conversationId: string;
  conversationName: string;
  threadRoot: number | null;
  messageId: number;
  botId: string;
  prompt: string;
};

export type CommandRow = CommandView & {
  userEmail: string;
  userName: string;
  title: string;
  timeZone: string | null;
  dispatchedAt: number | null;
  chat: ChatCommandRef | null;
};

function parseChat(v: SQLValue | undefined): ChatCommandRef | null {
  if (typeof v !== "string" || !v) return null;
  try {
    return JSON.parse(v) as ChatCommandRef;
  } catch {
    return null;
  }
}

/** In-app link for a command: its meeting, or the Chat conversation it was asked in. */
const commandHref = (c: CommandRow) => (c.chat ? `/chat?c=${c.chat.conversationId}` : meetHref(c.room));

/** Chat commands: post results / refresh the owner's approval strip (loaded lazily: no import cycle). */
function chatHook(c: CommandRow | null, what: "finished" | "changed") {
  if (!c?.chat) return;
  void import("../chat/claude-bot")
    .then((m) => m.onClaudeCommand(c, what))
    .catch((e) => console.error("[agent] chat hook:", e instanceof Error ? e.message : e));
}

function toCommand(r: Row): CommandRow {
  return {
    id: s(r.id),
    userEmail: s(r.user_email),
    userName: s(r.user_name),
    room: s(r.room),
    title: s(r.title),
    text: s(r.text),
    source: r.source === "typed" ? "typed" : "voice",
    timeZone: r.time_zone == null ? null : s(r.time_zone),
    status: s(r.status) as CommandStatus,
    progress: r.progress == null ? null : s(r.progress),
    result: r.result == null ? null : s(r.result),
    spoken: r.spoken == null ? null : s(r.spoken),
    createdAt: Number(r.created),
    updatedAt: Number(r.updated),
    dispatchedAt: n(r.dispatched),
    chat: parseChat(r.chat),
  };
}

export const toView = (c: CommandRow): CommandView => ({
  id: c.id,
  room: c.room,
  text: c.text,
  source: c.source,
  status: c.status,
  progress: c.progress,
  result: c.result,
  spoken: c.spoken,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

/** Lowercase, no accents or punctuation: for duplicate detection across overlapping windows. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fails stale commands and confirmations, prunes old speech. Cheap; called from hot paths. */
function sweep(now = Date.now()) {
  const d = db();
  // Chat commands about to fail get their failure posted in the conversation.
  const failing = d
    .prepare(
      `SELECT * FROM commands WHERE chat IS NOT NULL AND ((status = 'queued' AND created < ?)
         OR (status IN ('dispatched', 'needs_confirmation') AND updated < ?))`,
    )
    .all(now - QUEUE_TTL_MS, now - RUN_TTL_MS)
    .map((r) => s(r.id));
  d.prepare(
    "UPDATE commands SET status = 'failed', result = 'Your Claude bridge was not connected.', updated = ? WHERE status = 'queued' AND created < ?",
  ).run(now, now - QUEUE_TTL_MS);
  d.prepare(
    "UPDATE commands SET status = 'failed', result = COALESCE(result, 'No answer from your Claude bridge.'), updated = ? WHERE status IN ('dispatched', 'needs_confirmation') AND updated < ?",
  ).run(now, now - RUN_TTL_MS);
  d.prepare("UPDATE confirmations SET status = 'expired', decided = ? WHERE status = 'pending' AND expires < ?").run(now, now - 5000);
  d.prepare("DELETE FROM utterances WHERE at < ?").run(now - UTTERANCE_KEEP_MS);
  for (const id of failing) {
    const r = d.prepare("SELECT * FROM commands WHERE id = ?").get(id);
    if (r) chatHook(toCommand(r), "finished");
  }
}

/**
 * Queues a command for the user's bridge. A command whose text matches (or contains / is contained
 * in) one of the user's commands from the last 15 s is a duplicate from an overlapping window: the
 * existing command is returned (and, while still queued, takes the longer text).
 */
export function enqueueCommand(input: {
  email: string;
  name: string;
  room: string;
  title: string;
  text: string;
  source: "voice" | "typed";
  timeZone: string | null;
  chat?: ChatCommandRef;
}): { command: CommandRow; duplicate: boolean } {
  const email = norm(input.email);
  const now = Date.now();
  sweep(now);
  const key = normalizeText(input.text);
  if (input.source === "voice" && key) {
    const recent = db()
      .prepare("SELECT * FROM commands WHERE user_email = ? AND source = 'voice' AND created >= ? ORDER BY created DESC")
      .all(email, now - DEDUPE_MS)
      .map(toCommand);
    for (const c of recent) {
      const other = normalizeText(c.text);
      if (other === key || other.includes(key) || key.includes(other)) {
        if (key.length > other.length && c.status === "queued") {
          db().prepare("UPDATE commands SET text = ?, updated = ? WHERE id = ? AND status = 'queued'").run(input.text, now, c.id);
          return { command: { ...c, text: input.text, updatedAt: now }, duplicate: true };
        }
        return { command: c, duplicate: true };
      }
    }
  }
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO commands (id, user_email, user_name, room, title, text, source, time_zone, status, created, updated, chat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    )
    .run(id, email, input.name, input.room, input.title, input.text, input.source, input.timeZone, now, now, input.chat ? JSON.stringify(input.chat) : null);
  wake(email);
  return { command: getCommand(id, email)!, duplicate: false };
}

export function getCommand(id: string, email: string): CommandRow | null {
  const r = db().prepare("SELECT * FROM commands WHERE id = ? AND user_email = ?").get(id, norm(email));
  return r ? toCommand(r) : null;
}

/** The user's commands in a room (newest first). */
export function listCommands(email: string, room: string, limit = 30): CommandRow[] {
  sweep();
  return db()
    .prepare("SELECT * FROM commands WHERE user_email = ? AND room = ? ORDER BY created DESC LIMIT ?")
    .all(norm(email), room, limit)
    .map(toCommand);
}

/** Atomically hands the user's queued commands (oldest first) to one bridge stream. */
export function claimQueued(email: string, tokenId: string): CommandRow[] {
  const key = norm(email);
  const now = Date.now();
  sweep(now);
  const queued = db().prepare("SELECT * FROM commands WHERE user_email = ? AND status = 'queued' ORDER BY created").all(key).map(toCommand);
  const claimed: CommandRow[] = [];
  for (const c of queued) {
    const r = db()
      .prepare("UPDATE commands SET status = 'dispatched', dispatched = ?, updated = ?, token_id = ? WHERE id = ? AND status = 'queued'")
      .run(now, now, tokenId, c.id);
    if (Number(r.changes) > 0) {
      claimed.push({ ...c, status: "dispatched", dispatchedAt: now, updatedAt: now });
      chatHook(c, "changed");
    }
  }
  return claimed;
}

/** Statuses of the given commands (only the user's). */
export function statusesOf(email: string, ids: string[]): Map<string, CommandStatus> {
  const out = new Map<string, CommandStatus>();
  if (!ids.length) return out;
  const rows = db()
    .prepare(`SELECT id, status FROM commands WHERE user_email = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .all(norm(email), ...ids);
  for (const r of rows) out.set(s(r.id), s(r.status) as CommandStatus);
  return out;
}

export type BridgeEvent =
  | { type: "started" }
  | { type: "progress"; text: string }
  | { type: "done"; result: string; spoken?: string }
  | { type: "failed"; error: string };

/**
 * Applies an event from the user's bridge. Returns the command's status afterwards (a cancelled
 * command tells the bridge to stop), or null when the command isn't the user's.
 */
export function applyBridgeEvent(id: string, email: string, ev: BridgeEvent): CommandStatus | null {
  const c = getCommand(id, email);
  if (!c) return null;
  if (c.status === "done" || c.status === "failed" || c.status === "cancelled") return c.status;
  const now = Date.now();
  const d = db();
  // A command still marked queued (e.g. a second bridge) is taken over by whoever reports on it.
  const active = "status IN ('queued', 'dispatched', 'needs_confirmation')";
  if (ev.type === "started") {
    d.prepare(`UPDATE commands SET status = CASE status WHEN 'queued' THEN 'dispatched' ELSE status END, updated = ? WHERE id = ? AND ${active}`).run(now, id);
  } else if (ev.type === "progress") {
    d.prepare(`UPDATE commands SET progress = ?, updated = ? WHERE id = ? AND ${active}`).run(ev.text.slice(0, PROGRESS_MAX), now, id);
  } else {
    const done = ev.type === "done";
    const spoken = done && ev.spoken ? cleanSpoken(ev.spoken) : "";
    d.prepare(`UPDATE commands SET status = ?, result = ?, spoken = ?, progress = NULL, updated = ? WHERE id = ? AND ${active}`).run(
      done ? "done" : "failed",
      (done ? ev.result : ev.error).slice(0, RESULT_MAX),
      spoken || null,
      now,
      id,
    );
    d.prepare("UPDATE confirmations SET status = 'expired', decided = ? WHERE command_id = ? AND status = 'pending'").run(now, id);
    const after = getCommand(id, email);
    if (after && (after.status === "done" || after.status === "failed")) {
      notify(email, {
        category: "claude",
        kind: after.status,
        title: after.text.slice(0, 160),
        body: (after.status === "done" ? after.spoken || after.result : after.result) ?? "",
        href: commandHref(after),
        ref: after.chat ? after.chat.conversationId : after.room,
        key: `command:${after.id}`,
        once: true,
      });
      chatHook(after, "finished");
    }
    return after?.status ?? null;
  }
  return getCommand(id, email)?.status ?? null;
}

/** Cancels one of the user's unfinished commands (and rejects its pending confirmations). */
export function cancelCommand(id: string, email: string): boolean {
  const now = Date.now();
  const r = db()
    .prepare(
      "UPDATE commands SET status = 'cancelled', progress = NULL, updated = ? WHERE id = ? AND user_email = ? AND status IN ('queued', 'dispatched', 'needs_confirmation')",
    )
    .run(now, id, norm(email));
  if (Number(r.changes) === 0) return false;
  db().prepare("UPDATE confirmations SET status = 'rejected', decided = ? WHERE command_id = ? AND status = 'pending'").run(now, id);
  wake(email);
  chatHook(getCommand(id, email), "changed");
  return true;
}

/** The user's most recent unfinished command in a room (for "Claude cancel"). */
export function latestActiveCommand(email: string, room: string): CommandRow | null {
  const r = db()
    .prepare(
      "SELECT * FROM commands WHERE user_email = ? AND room = ? AND status IN ('queued', 'dispatched', 'needs_confirmation') ORDER BY created DESC LIMIT 1",
    )
    .get(norm(email), room);
  return r ? toCommand(r) : null;
}

/* ----------------------------------------------------------- confirmations */

function toConfirmation(r: Row): ConfirmationView {
  return {
    id: s(r.id),
    commandId: s(r.command_id),
    tool: s(r.tool),
    summary: s(r.summary),
    createdAt: Number(r.created),
    expiresAt: Number(r.expires),
  };
}

/** Pending confirmations of the user (optionally only for commands in one room), oldest first. */
export function pendingConfirmations(email: string, room?: string): ConfirmationView[] {
  const now = Date.now();
  const rows = room
    ? db()
        .prepare(
          `SELECT f.* FROM confirmations f JOIN commands c ON c.id = f.command_id
           WHERE f.user_email = ? AND f.status = 'pending' AND f.expires > ? AND c.room = ? ORDER BY f.created`,
        )
        .all(norm(email), now, room)
    : db()
        .prepare("SELECT * FROM confirmations WHERE user_email = ? AND status = 'pending' AND expires > ? ORDER BY created")
        .all(norm(email), now);
  return rows.map(toConfirmation);
}

/** Approves or rejects one of the user's pending confirmations. */
export function decideConfirmation(id: string, email: string, approve: boolean): boolean {
  const r = db()
    .prepare("UPDATE confirmations SET status = ?, decided = ? WHERE id = ? AND user_email = ? AND status = 'pending' AND expires > ?")
    .run(approve ? "approved" : "rejected", Date.now(), id, norm(email), Date.now());
  return Number(r.changes) > 0;
}

/** Active (unfinished) commands of the user in a room, oldest first. */
export function activeCommands(email: string, room: string): CommandRow[] {
  sweep();
  return db()
    .prepare("SELECT * FROM commands WHERE user_email = ? AND room = ? AND status IN ('queued', 'dispatched', 'needs_confirmation') ORDER BY created")
    .all(norm(email), room)
    .map(toCommand);
}

/** The user's newest pending confirmation (for "Claude confirm" / "Claude cancel"). */
export function latestPendingConfirmation(email: string): ConfirmationView | null {
  const list = pendingConfirmations(email);
  return list.length ? list[list.length - 1] : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Called by the MCP server when a write tool runs on behalf of a meeting command: records a
 * pending confirmation, shows it in the speaker's call UI and waits (polling every 500 ms, up to
 * 120 s) for Approve / Reject. Fails closed: unknown, foreign or finished commands are refused.
 */
export async function awaitConfirmation(
  commandId: string,
  email: string,
  tool: string,
  summary: string,
): Promise<{ ok: true } | { ok: false; reason: "unknown_command" | "rejected" | "timeout" }> {
  const command = getCommand(commandId, email);
  if (!command || command.status === "done" || command.status === "failed" || command.status === "cancelled") {
    return { ok: false, reason: "unknown_command" };
  }
  const id = randomUUID();
  const now = Date.now();
  const d = db();
  d.prepare(
    "INSERT INTO confirmations (id, command_id, user_email, tool, summary, status, created, expires) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
  ).run(id, commandId, norm(email), tool.slice(0, 64), summary.slice(0, 600), now, now + CONFIRM_TIMEOUT_MS);
  d.prepare("UPDATE commands SET status = 'needs_confirmation', updated = ? WHERE id = ? AND status IN ('queued', 'dispatched')").run(now, commandId);
  notify(email, {
    category: "claude",
    kind: "confirm",
    title: command.text.slice(0, 160),
    body: summary,
    href: commandHref(command),
    priority: "high",
    ref: command.chat ? command.chat.conversationId : command.room,
    key: `confirm:${id}`,
    once: true,
  });
  chatHook(command, "changed");

  let outcome: "approved" | "rejected" | "timeout" = "timeout";
  while (Date.now() < now + CONFIRM_TIMEOUT_MS) {
    const r = d.prepare("SELECT status FROM confirmations WHERE id = ?").get(id);
    const st = s(r?.status);
    if (st === "approved" || st === "rejected") {
      outcome = st;
      break;
    }
    if (st !== "pending") {
      outcome = "rejected";
      break;
    }
    await sleep(500);
  }
  const end = Date.now();
  if (outcome === "timeout") d.prepare("UPDATE confirmations SET status = 'expired', decided = ? WHERE id = ? AND status = 'pending'").run(end, id);
  chatHook(command, "changed");
  // Back to running unless something else is still waiting for the user.
  d.prepare(
    `UPDATE commands SET status = 'dispatched', updated = ? WHERE id = ? AND status = 'needs_confirmation'
       AND NOT EXISTS (SELECT 1 FROM confirmations WHERE command_id = ? AND status = 'pending')`,
  ).run(end, commandId, commandId);
  return outcome === "approved" ? { ok: true } : { ok: false, reason: outcome };
}

/* -------------------------------------------------------------- utterances */

export type UtteranceSource = "command" | "meeting";
export type Utterance = { at: number; text: string; source: UtteranceSource };

/** Stores transcribed speech for prompt context: a command (own voice) or a chunk of meeting audio. */
export function addUtterance(email: string, room: string, text: string, source: UtteranceSource): void {
  if (!text.trim()) return;
  db()
    .prepare("INSERT INTO utterances (user_email, room, text, at, source) VALUES (?, ?, ?, ?, ?)")
    .run(norm(email), room, text.slice(0, 2000), Date.now(), source);
}

/** Speech the user sent from the room in the ~10 minutes before `before` (oldest first, newest kept). */
export function recentUtterances(email: string, room: string, before: number): Utterance[] {
  return db()
    .prepare("SELECT text, at, source FROM utterances WHERE user_email = ? AND room = ? AND at >= ? AND at <= ? ORDER BY at DESC LIMIT 200")
    .all(norm(email), room, before - CONTEXT_MS, before + 10_000)
    .map((r) => ({ at: Number(r.at), text: s(r.text), source: r.source === "meeting" ? ("meeting" as const) : ("command" as const) }))
    .reverse();
}

/* ----------------------------------------------------------------- bridges */

export function bridgeConnected(email: string, tokenId: string, client: string): () => void {
  const key = norm(email);
  openStreams.set(key, (openStreams.get(key) ?? 0) + 1);
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO bridges (user_email, token_id, client, connected_at, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_email) DO UPDATE SET token_id = excluded.token_id, client = excluded.client,
         connected_at = excluded.connected_at, last_seen = excluded.last_seen`,
    )
    .run(key, tokenId, client.slice(0, 120), now, now);
  return () => {
    const left = (openStreams.get(key) ?? 1) - 1;
    if (left > 0) openStreams.set(key, left);
    else openStreams.delete(key);
    db().prepare("UPDATE bridges SET last_seen = ? WHERE user_email = ?").run(Date.now(), key);
  };
}

export function bridgeSeen(email: string): void {
  db().prepare("UPDATE bridges SET last_seen = ? WHERE user_email = ?").run(Date.now(), norm(email));
}

export function bridgeStatus(email: string): BridgeStatus & { client: string | null } {
  const key = norm(email);
  const r = db().prepare("SELECT last_seen, client FROM bridges WHERE user_email = ?").get(key);
  return { connected: (openStreams.get(key) ?? 0) > 0, lastSeen: n(r?.last_seen), client: r ? s(r.client) : null };
}
