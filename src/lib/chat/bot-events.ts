// Events from Chat to apps: a person's message that @mentions an app, a DM with an app, a slash
// command, an app added to / removed from a conversation. HTTP apps get a signed JSON POST (10 s
// timeout) and may answer synchronously with { text, cards }; each person's Claude bot queues a
// command for its owner's bridge (claude-bot.ts). Only messages written by people are dispatched,
// so apps can't trigger each other in loops. Server-only.
import { createHmac, randomUUID } from "node:crypto";
import type { ChatMessage, ChatUser } from "@/app/(apps)/chat/shared";
import { unseal } from "../crypto";
import { botByUserId, botsIn, logDelivery, rateLimiter, type BotRow } from "./bots";
import { CardError, parseBotMessage } from "./cards";
import { safePost } from "./safe-http";
import { ChatError, conversationBrief, postBotMessage, type ConversationBrief } from "./store";

export type BotEventType = "message" | "slash_command" | "added_to_space" | "removed_from_space";

/** What an HTTP app receives (also documented in Settings → Apps & bots). */
export type BotEvent = {
  type: BotEventType;
  eventTime: string;
  deliveryId: string;
  bot: { id: string; name: string; handle: string };
  user: { email: string; name: string };
  conversation: { id: string; kind: string; name: string | null };
  thread: { root: number | null };
  message?: { id: number; text: string; argumentText: string; createdAt: string; threadRoot: number | null };
  command?: { name: string; args: string };
};

const SLASH = /^\/([a-z0-9][a-z0-9_-]{0,31})(?:\s+([\s\S]*))?$/i;
/** Deliveries per app per minute (beyond that events are dropped and logged). */
const deliveryAllowed = rateLimiter(120, 60_000);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionRe = (handle: string) => new RegExp(`(^|[^\\w@])@${escapeRe(handle)}(?![\\w.-]*[a-z0-9])`, "i");

export const mentions = (body: string, handle: string) => !!handle && mentionRe(handle).test(body);
/** The message text without the app's @mention (what the app is asked). */
export const withoutMention = (body: string, handle: string) =>
  body.replace(new RegExp(`(^|[^\\w@])@${escapeRe(handle)}(?![\\w.-]*[a-z0-9])`, "gi"), "$1").replace(/\s+/g, " ").trim();

/** A DM between one person and the app (not an app added to a DM between two people). */
const isDirect = (conv: ConversationBrief) => conv.kind === "dm" && conv.memberCount === 2;

/** Entry point from the store: a person posted a message. */
export async function onHumanMessage(m: ChatMessage): Promise<void> {
  if (m.ephemeral || m.deleted || !m.author || m.author.bot || (m.kind !== "text" && m.kind !== "file")) return;
  const bots = botsIn(m.conversationId);
  if (!bots.length) return;
  const conv = conversationBrief(m.conversationId);
  if (!conv) return;

  const slash = SLASH.exec(m.body.trim());
  if (slash) {
    const name = slash[1].toLowerCase();
    const target = bots.find((b) => b.kind === "http" && b.commands?.some((c) => c.name === name));
    if (target) {
      await deliver(target, conv, m.author, "slash_command", m, { name, args: (slash[2] ?? "").trim() });
      return;
    }
  }

  const direct = isDirect(conv);
  await Promise.all(
    bots.map(async (b) => {
      const addressed = direct || mentions(m.body, b.handle);
      if (!addressed) return;
      if (b.kind === "http") await deliver(b, conv, m.author!, "message", m);
      else if (b.kind === "claude") {
        const { onClaudeAddressed } = await import("./claude-bot");
        await onClaudeAddressed(b, conv, m);
      }
    }),
  );
}

/** An app was added to or removed from a conversation (HTTP apps only). */
export async function onBotMembership(botUserIds: number[], convId: string, actor: ChatUser, added: boolean): Promise<void> {
  const conv = conversationBrief(convId);
  if (!conv) return;
  await Promise.all(
    botUserIds.map((id) => {
      const b = botByUserId(id);
      return b && b.kind === "http" && !b.deleted ? deliver(b, conv, actor, added ? "added_to_space" : "removed_from_space") : undefined;
    }),
  );
}

function buildEvent(b: BotRow, conv: ConversationBrief, user: ChatUser, type: BotEventType, m?: ChatMessage, command?: { name: string; args: string }): BotEvent {
  return {
    type,
    eventTime: new Date().toISOString(),
    deliveryId: randomUUID(),
    bot: { id: b.id, name: b.name, handle: b.handle },
    user: { email: user.email, name: user.name },
    conversation: { id: conv.id, kind: conv.kind, name: conv.kind === "dm" ? null : conv.name },
    thread: { root: m?.threadRoot ?? null },
    ...(m
      ? {
          message: {
            id: m.id,
            text: m.body,
            argumentText: command ? command.args : withoutMention(m.body, b.handle),
            createdAt: new Date(m.created).toISOString(),
            threadRoot: m.threadRoot,
          },
        }
      : {}),
    ...(command ? { command } : {}),
  };
}

/** Signature header value: t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>. */
export function sign(secret: string, body: string, ts = Math.floor(Date.now() / 1000)): string {
  return `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
}

async function deliver(b: BotRow, conv: ConversationBrief, user: ChatUser, type: BotEventType, m?: ChatMessage, command?: { name: string; args: string }) {
  const at = Date.now();
  const log = (status: number | null, error: string | null) =>
    logDelivery(b.id, { at, event: type, conversationId: conv.id, status, latencyMs: Date.now() - at, error });
  if (!b.endpointUrl || !b.signingSecret) return;
  if (!deliveryAllowed(b.id)) return log(null, "rate limited (120 events/min)");
  const secret = await unseal<string>(b.signingSecret);
  if (!secret) return log(null, "signing secret unavailable");

  const event = buildEvent(b, conv, user, type, m, command);
  const body = JSON.stringify(event);
  let res;
  try {
    res = await safePost(b.endpointUrl, body, {
      "Content-Type": "application/json",
      "User-Agent": "Zentico-Chat-Apps/1.0",
      "X-Zentico-Event": type,
      "X-Zentico-Delivery": event.deliveryId,
      "X-Zentico-Signature": sign(secret, body),
    });
  } catch (e) {
    return log(null, e instanceof Error ? e.message : "request failed");
  }
  if (res.status < 200 || res.status >= 300) return log(res.status, `HTTP ${res.status}`);
  if (type === "removed_from_space" || !res.body.trim()) return log(res.status, null);

  // Synchronous reply: { text, cards | cardsV2 } posted as the app (in the thread of the trigger).
  let reply;
  try {
    if (!/json/i.test(res.contentType)) return log(res.status, null);
    const parsed = JSON.parse(res.body) as unknown;
    if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length === 0) return log(res.status, null);
    reply = parseBotMessage(parsed);
  } catch (e) {
    if (e instanceof CardError && e.message === "empty") return log(res.status, null);
    return log(res.status, `invalid reply: ${e instanceof CardError ? e.message : "not JSON"}`);
  }
  try {
    postBotMessage(conv.id, b.userId, { ...reply, threadRoot: m?.threadRoot ?? null });
    log(res.status, null);
  } catch (e) {
    log(res.status, `reply not posted: ${e instanceof ChatError ? e.message : "failed"}`);
  }
}
