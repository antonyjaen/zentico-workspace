// Apps and bots in Chat: identities (a `users` row per bot), HTTP apps, incoming webhooks and each
// person's Claude. Data access only (no store import, so the store can use it). Server-only.
//
// Secrets: API tokens and webhook keys are stored as sha256 hex and shown once; signing secrets
// must be available in clear to sign deliveries, so they are sealed (AES-256-GCM, lib/crypto).
// Nothing secret is ever logged.
import { createHash, randomBytes } from "node:crypto";
import type { Row } from "node:sqlite";
import { BOT_EMAIL_DOMAIN, type BotCommand, type BotInfo, type BotKind, type BuiltinApp } from "@/app/(apps)/chat/shared";
import { isConfigured } from "../connect/providers";
import { base64url, seal } from "../crypto";
import { all, get, run, tx } from "./db";

const num = (v: unknown) => Number(v ?? 0);
const strv = (v: unknown) => (typeof v === "string" ? v : "");

export const sha256hex = (v: string) => createHash("sha256").update(v).digest("hex");
const secret = (prefix: string) => `${prefix}${base64url(new Uint8Array(randomBytes(32)))}`;

export const BOT_TOKEN = /^zwbot_[A-Za-z0-9_-]{43}$/;
export const WEBHOOK_KEY = /^zwhk_[A-Za-z0-9_-]{43}$/;
export const BOT_ID = /^[a-z0-9]{16}$/;
export const MAX_APPS_PER_USER = 25;
export const MAX_WEBHOOKS_PER_CONVERSATION = 10;
export const MAX_COMMANDS = 20;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const newBotId = () => Array.from(randomBytes(16), (b) => ALPHABET[b % ALPHABET.length]).join("");

// ---------- Identity cache ----------

/** Apps that ship with Zentico: one workspace-wide identity each, available when their provider is configured. */
const BUILTINS: Record<BuiltinApp, { name: string; handle: string; color: number; commands: BotCommand[]; available: () => boolean }> = {
  github: {
    name: "GitHub",
    handle: "github",
    color: 230,
    commands: [{ name: "github", description: "issue <owner/repo> <title> · subscribe <owner/repo> · unsubscribe <owner/repo> · list" }],
    available: () => isConfigured("github"),
  },
};
const isBuiltinApp = (v: string): v is BuiltinApp => Object.hasOwn(BUILTINS, v);

export type BotRow = BotInfo & {
  userId: number;
  name: string;
  handle: string;
  endpointUrl: string | null;
  signingSecret: string | null;
  tokenPrefix: string | null;
  shared: boolean;
  conversationId: string | null;
  created: number;
  updated: number;
};

const g = globalThis as typeof globalThis & { __zwBots?: { byUser: Map<number, BotRow>; byId: Map<string, BotRow> } };

function load() {
  const commands = new Map<string, BotCommand[]>();
  for (const r of all("SELECT * FROM bot_commands ORDER BY name")) {
    const list = commands.get(strv(r.bot_id)) ?? [];
    list.push({ name: strv(r.name), description: strv(r.description) });
    commands.set(strv(r.bot_id), list);
  }
  const byUser = new Map<number, BotRow>();
  const byId = new Map<string, BotRow>();
  for (const r of all(
    `SELECT b.*, bu.email AS bot_email, o.name AS owner_name, o.email AS owner_email
     FROM bots b JOIN users bu ON bu.id = b.user_id JOIN users o ON o.id = b.owner_id`,
  )) {
    const row = toRow(r, commands.get(strv(r.id)) ?? []);
    byUser.set(row.userId, row);
    byId.set(row.id, row);
  }
  return { byUser, byId };
}

function toRow(r: Row, commands: BotCommand[]): BotRow {
  const kind = strv(r.kind) as BotKind;
  const builtin = kind === "builtin" && isBuiltinApp(strv(r.builtin)) ? (strv(r.builtin) as BuiltinApp) : undefined;
  return {
    id: strv(r.id),
    kind,
    userId: num(r.user_id),
    name: strv(r.name),
    handle: strv(r.bot_email).split("@")[0] ?? "",
    description: strv(r.description),
    color: r.color == null ? null : num(r.color),
    avatar: r.avatar == null ? null : strv(r.avatar),
    ownerId: num(r.owner_id),
    ownerName: strv(r.owner_name) || strv(r.owner_email),
    ...(kind === "http" ? { commands } : {}),
    ...(builtin ? { app: builtin, commands: BUILTINS[builtin].commands } : {}),
    ...(num(r.deleted) ? { deleted: true } : {}),
    endpointUrl: r.endpoint_url == null ? null : strv(r.endpoint_url),
    signingSecret: r.signing_secret == null ? null : strv(r.signing_secret),
    tokenPrefix: r.token_prefix == null ? null : strv(r.token_prefix),
    shared: num(r.shared) === 1,
    conversationId: r.conversation_id == null ? null : strv(r.conversation_id),
    created: num(r.created),
    updated: num(r.updated),
  };
}

function cache() {
  g.__zwBots ??= load();
  return g.__zwBots;
}

/** Call after any change to bots (single process: the cache is in memory). */
export function invalidateBots() {
  g.__zwBots = undefined;
}

/** What clients see about a bot user (no secrets, no endpoint). */
export function publicInfo(b: BotRow): BotInfo {
  return {
    id: b.id,
    kind: b.kind,
    description: b.description,
    color: b.color,
    avatar: b.avatar,
    ownerId: b.ownerId,
    ownerName: b.ownerName,
    ...(b.commands ? { commands: b.commands } : {}),
    ...(b.app ? { app: b.app } : {}),
    ...(b.deleted ? { deleted: true } : {}),
  };
}

export const botByUserId = (userId: number): BotRow | undefined => cache().byUser.get(userId);
export const botById = (id: string): BotRow | undefined => cache().byId.get(id);
export const botInfoOf = (userId: number): BotInfo | undefined => {
  const b = cache().byUser.get(userId);
  return b ? publicInfo(b) : undefined;
};
export const isBotUser = (userId: number) => cache().byUser.has(userId);
/** A bot by its synthetic address (handle@BOT_EMAIL_DOMAIN). */
export function botByEmail(email: string): BotRow | undefined {
  const [handle, domain] = email.toLowerCase().split("@");
  if (domain !== BOT_EMAIL_DOMAIN) return undefined;
  for (const b of cache().byId.values()) if (b.handle === handle) return b;
  return undefined;
}

// ---------- Handles ----------

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * A free @handle for a bot: the slugged name, with a number if it is taken by anyone (people's
 * local parts included, so a mention of a bot never notifies a person and vice versa).
 */
function freeHandle(base: string): string {
  const slug =
    fold(base)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/, "") || "app";
  const taken = (h: string) => !!get("SELECT 1 AS x FROM users WHERE lower(substr(email, 1, instr(email, '@') - 1)) = ? LIMIT 1", h);
  if (!taken(slug)) return slug;
  for (let i = 2; i < 1000; i++) if (!taken(`${slug}-${i}`)) return `${slug}-${i}`;
  return `${slug}-${newBotId().slice(0, 6)}`;
}

// ---------- Creation ----------

type IdentityInput = {
  kind: BotKind;
  ownerId: number;
  name: string;
  handleBase: string;
  description?: string;
  color?: number | null;
  avatar?: string | null;
  conversationId?: string | null;
};

/** Creates the user row and the bot row (inside the caller's transaction). */
function insertIdentity(input: IdentityInput, extra: Record<string, string | number | null> = {}): string {
  const id = newBotId();
  const now = Date.now();
  const handle = freeHandle(input.handleBase);
  const userId = num(
    run("INSERT INTO users (email, name, bot_id) VALUES (?, ?, ?)", `${handle}@${BOT_EMAIL_DOMAIN}`, input.name, id).lastInsertRowid,
  );
  const cols = ["id", "user_id", "kind", "owner_id", "name", "description", "color", "avatar", "conversation_id", "created", "updated", ...Object.keys(extra)];
  run(
    `INSERT INTO bots (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    id,
    userId,
    input.kind,
    input.ownerId,
    input.name,
    input.description ?? "",
    input.color ?? null,
    input.avatar ?? null,
    input.conversationId ?? null,
    now,
    now,
    ...Object.values(extra),
  );
  return id;
}

/** The person's own Claude bot (created on first use; its name follows the owner's). */
export function ensureClaudeBot(owner: { id: number; name: string; email: string }): BotRow {
  const name = `Claude (${owner.name || owner.email})`;
  const existing = all("SELECT id, name FROM bots WHERE owner_id = ? AND kind = 'claude' AND deleted = 0 LIMIT 1", owner.id)[0];
  if (existing) {
    if (strv(existing.name) !== name) {
      tx(() => {
        run("UPDATE bots SET name = ?, updated = ? WHERE id = ?", name, Date.now(), strv(existing.id));
        run("UPDATE users SET name = ? WHERE bot_id = ?", name, strv(existing.id));
      });
      invalidateBots();
    }
    return botById(strv(existing.id))!;
  }
  const local = owner.email.split("@")[0] ?? "";
  const id = tx(() =>
    insertIdentity({
      kind: "claude",
      ownerId: owner.id,
      name,
      handleBase: `claude-${local}`,
      description: "",
      color: 25,
      avatar: null,
    }),
  );
  invalidateBots();
  return botById(id)!;
}

/**
 * The workspace-wide identity of a built-in app (created on first use; `creator` is recorded as
 * its owner but has no special rights over it).
 */
export function ensureBuiltinApp(app: BuiltinApp, creator: { id: number }): BotRow {
  const existing = all("SELECT id FROM bots WHERE builtin = ? LIMIT 1", app)[0];
  if (existing) return botById(strv(existing.id))!;
  const def = BUILTINS[app];
  const id = tx(() => {
    const botId = insertIdentity({ kind: "builtin", ownerId: creator.id, name: def.name, handleBase: def.handle, description: "", color: def.color, avatar: null });
    run("UPDATE bots SET builtin = ?, shared = 1 WHERE id = ?", app, botId);
    return botId;
  });
  invalidateBots();
  return botById(id)!;
}

/** A built-in app's identity if it exists (null before anyone used it). */
export function builtinBot(app: BuiltinApp): BotRow | null {
  for (const b of cache().byId.values()) if (b.kind === "builtin" && b.app === app && !b.deleted) return b;
  return null;
}

export type HttpAppInput = {
  name: string;
  description: string;
  color: number | null;
  avatar: string | null;
  endpointUrl: string;
  shared: boolean;
  commands: BotCommand[];
};

function setCommands(botId: string, commands: BotCommand[]) {
  run("DELETE FROM bot_commands WHERE bot_id = ?", botId);
  for (const c of commands) run("INSERT INTO bot_commands (bot_id, name, description) VALUES (?, ?, ?)", botId, c.name, c.description);
}

/** Creates an HTTP app; returns its id plus the signing secret and API token (shown once). */
export async function createHttpApp(ownerId: number, input: HttpAppInput): Promise<{ id: string; signingSecret: string; token: string }> {
  const count = num(get("SELECT count(*) AS n FROM bots WHERE owner_id = ? AND kind = 'http' AND deleted = 0", ownerId)?.n);
  if (count >= MAX_APPS_PER_USER) throw new BotError("tooManyApps");
  const signingSecret = secret("zwsig_");
  const token = secret("zwbot_");
  const sealed = await seal(signingSecret);
  const id = tx(() => {
    const botId = insertIdentity(
      { kind: "http", ownerId, name: input.name, handleBase: input.name, description: input.description, color: input.color, avatar: input.avatar },
      {
        endpoint_url: input.endpointUrl,
        signing_secret: sealed,
        token_hash: sha256hex(token),
        token_prefix: token.slice(0, 10),
        shared: input.shared ? 1 : 0,
      },
    );
    setCommands(botId, input.commands);
    return botId;
  });
  invalidateBots();
  return { id, signingSecret, token };
}

export class BotError extends Error {}

function ownApp(id: string, ownerId: number): BotRow {
  const b = botById(id);
  if (!b || b.deleted || b.kind !== "http" || b.ownerId !== ownerId) throw new BotError("notFound");
  return b;
}

export function updateHttpApp(id: string, ownerId: number, input: HttpAppInput): void {
  ownApp(id, ownerId);
  tx(() => {
    run(
      "UPDATE bots SET name = ?, description = ?, color = ?, avatar = ?, endpoint_url = ?, shared = ?, updated = ? WHERE id = ?",
      input.name,
      input.description,
      input.color,
      input.avatar,
      input.endpointUrl,
      input.shared ? 1 : 0,
      Date.now(),
      id,
    );
    run("UPDATE users SET name = ? WHERE bot_id = ?", input.name, id);
    setCommands(id, input.commands);
  });
  invalidateBots();
}

export async function rotateSigningSecret(id: string, ownerId: number): Promise<string> {
  ownApp(id, ownerId);
  const value = secret("zwsig_");
  run("UPDATE bots SET signing_secret = ?, updated = ? WHERE id = ?", await seal(value), Date.now(), id);
  invalidateBots();
  return value;
}

export function rotateToken(id: string, ownerId: number): string {
  ownApp(id, ownerId);
  const value = secret("zwbot_");
  run("UPDATE bots SET token_hash = ?, token_prefix = ?, updated = ? WHERE id = ?", sha256hex(value), value.slice(0, 10), Date.now(), id);
  invalidateBots();
  return value;
}

/**
 * Soft-deletes a bot: secrets and endpoint cleared, removed from every conversation; its user row
 * stays so old messages keep showing who wrote them. Returns the conversations it left.
 */
export function softDeleteBot(id: string): string[] {
  const b = botById(id);
  if (!b) return [];
  const convs = all("SELECT conversation_id FROM conversation_members WHERE user_id = ?", b.userId).map((r) => strv(r.conversation_id));
  tx(() => {
    run(
      `UPDATE bots SET deleted = 1, endpoint_url = NULL, signing_secret = NULL, token_hash = NULL, token_prefix = NULL,
         key_hash = NULL, updated = ? WHERE id = ?`,
      Date.now(),
      id,
    );
    run("DELETE FROM conversation_members WHERE user_id = ?", b.userId);
    run("DELETE FROM bot_commands WHERE bot_id = ?", id);
  });
  invalidateBots();
  return convs;
}

export function deleteHttpApp(id: string, ownerId: number): string[] {
  ownApp(id, ownerId);
  return softDeleteBot(id);
}

/** My HTTP apps (owner view). */
export function myApps(ownerId: number): BotRow[] {
  return [...cache().byId.values()].filter((b) => b.kind === "http" && b.ownerId === ownerId && !b.deleted).sort((a, b) => a.created - b.created);
}

/** Apps the user may add to a conversation or DM: their own and shared HTTP apps, and their Claude. */
export function usableBots(user: { id: number; name: string; email: string }): BotRow[] {
  ensureClaudeBot(user);
  for (const app of Object.keys(BUILTINS) as BuiltinApp[]) if (BUILTINS[app].available()) ensureBuiltinApp(app, user);
  return [...cache().byId.values()]
    .filter((b) => canUseBot(b, user.id))
    .sort((a, b) => (a.kind === "claude" ? -1 : b.kind === "claude" ? 1 : a.name.localeCompare(b.name)));
}

export function canUseBot(b: BotRow, userId: number): boolean {
  if (b.deleted) return false;
  if (b.kind === "claude") return b.ownerId === userId;
  if (b.kind === "http") return b.ownerId === userId || b.shared;
  if (b.kind === "builtin") return !!b.app && BUILTINS[b.app].available();
  return false;
}

/** HTTP app by its API token (null for anything unknown, deleted or malformed). */
export function appByToken(token: string): BotRow | null {
  if (!BOT_TOKEN.test(token)) return null;
  const r = get("SELECT id FROM bots WHERE token_hash = ? AND kind = 'http' AND deleted = 0", sha256hex(token));
  return r ? (botById(strv(r.id)) ?? null) : null;
}

// ---------- Webhooks ----------

export function webhooksOf(conversationId: string): BotRow[] {
  return [...cache().byId.values()]
    .filter((b) => b.kind === "webhook" && b.conversationId === conversationId && !b.deleted)
    .sort((a, b) => a.created - b.created);
}

/** Creates an incoming webhook for a conversation; returns its id and key (shown once). */
export function createWebhook(
  conversationId: string,
  creatorId: number,
  input: { name: string; avatar: string | null; color: number | null },
): { id: string; key: string } {
  if (webhooksOf(conversationId).length >= MAX_WEBHOOKS_PER_CONVERSATION) throw new BotError("tooManyWebhooks");
  const key = secret("zwhk_");
  const id = tx(() =>
    insertIdentity(
      { kind: "webhook", ownerId: creatorId, name: input.name, handleBase: `${input.name}-hook`, avatar: input.avatar, color: input.color, conversationId },
      { key_hash: sha256hex(key) },
    ),
  );
  invalidateBots();
  return { id, key };
}

export function regenerateWebhookKey(id: string): string {
  const key = secret("zwhk_");
  run("UPDATE bots SET key_hash = ?, updated = ? WHERE id = ? AND kind = 'webhook' AND deleted = 0", sha256hex(key), Date.now(), id);
  invalidateBots();
  return key;
}

/** A live webhook by id + key (null for anything else). */
export function webhookByKey(id: string, key: string): BotRow | null {
  if (!BOT_ID.test(id) || !WEBHOOK_KEY.test(key)) return null;
  const r = get("SELECT id FROM bots WHERE id = ? AND key_hash = ? AND kind = 'webhook' AND deleted = 0", id, sha256hex(key));
  return r ? (botById(id) ?? null) : null;
}

export function webhookThreadRoot(botId: string, key: string): number | null {
  const r = get(
    `SELECT wt.root_id FROM webhook_threads wt JOIN messages m ON m.id = wt.root_id
     WHERE wt.bot_id = ? AND wt.key = ? AND m.deleted = 0`,
    botId,
    key,
  );
  return r ? num(r.root_id) : null;
}

export function rememberWebhookThread(botId: string, key: string, rootId: number): void {
  run(
    "INSERT INTO webhook_threads (bot_id, key, root_id) VALUES (?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET root_id = excluded.root_id",
    botId,
    key,
    rootId,
  );
}

// ---------- Delivery log ----------

export type Delivery = { id: number; at: number; event: string; conversationId: string | null; status: number | null; latencyMs: number | null; error: string | null };

export function logDelivery(botId: string, d: Omit<Delivery, "id">): void {
  try {
    run(
      "INSERT INTO bot_deliveries (bot_id, at, event, conversation_id, status, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
      botId,
      d.at,
      d.event,
      d.conversationId,
      d.status,
      d.latencyMs,
      d.error ? d.error.slice(0, 300) : null,
    );
    run(
      "DELETE FROM bot_deliveries WHERE bot_id = ? AND id NOT IN (SELECT id FROM bot_deliveries WHERE bot_id = ? ORDER BY id DESC LIMIT 50)",
      botId,
      botId,
    );
  } catch (e) {
    console.error("[bots] delivery log failed:", e instanceof Error ? e.message : e);
  }
}

export function deliveries(botId: string, ownerId: number): Delivery[] {
  ownApp(botId, ownerId);
  return all("SELECT * FROM bot_deliveries WHERE bot_id = ? ORDER BY id DESC LIMIT 50", botId).map((r) => ({
    id: num(r.id),
    at: num(r.at),
    event: strv(r.event),
    conversationId: r.conversation_id == null ? null : strv(r.conversation_id),
    status: r.status == null ? null : num(r.status),
    latencyMs: r.latency_ms == null ? null : num(r.latency_ms),
    error: r.error == null ? null : strv(r.error),
  }));
}

// ---------- Membership ----------

/** Bots that are members of a conversation. */
export function botsIn(conversationId: string): BotRow[] {
  const out: BotRow[] = [];
  for (const r of all(
    "SELECT cm.user_id FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? AND u.bot_id IS NOT NULL",
    conversationId,
  )) {
    const b = botByUserId(num(r.user_id));
    if (b && !b.deleted) out.push(b);
  }
  return out;
}

/** Simple sliding-window rate limiter (in memory, per key). */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= limit) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10_000) hits.clear();
    return true;
  };
}
