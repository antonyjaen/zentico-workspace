"use server";

// Apps in conversations (add / remove / DM) and incoming webhooks of a conversation. Every action
// resolves the signed-in user; the store authorizes by membership and bots.ts by ownership/sharing.
import { unstable_rethrow } from "next/navigation";
import {
  botByUserId,
  BOT_ID,
  BotError,
  canUseBot,
  createWebhook as createHook,
  publicInfo,
  regenerateWebhookKey,
  softDeleteBot,
  usableBots,
  webhooksOf,
} from "@/lib/chat/bots";
import { botAvatar, botColor, BotInputError, botName } from "@/lib/chat/bot-input";
import * as store from "@/lib/chat/store";
import { ChatError } from "@/lib/chat/store";
import { chatUser } from "@/lib/chat/session";
import { env } from "@/lib/env";
import { BOT_EMAIL_DOMAIN, isConversationId, type ActionResult, type ChatUser } from "./shared";

class InputError extends Error {}

async function act<T>(fn: (me: ChatUser) => T | Promise<T>): Promise<ActionResult<T>> {
  try {
    const me = await chatUser();
    return { ok: true, data: await fn(me) };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof ChatError || e instanceof InputError || e instanceof BotError || e instanceof BotInputError) return { ok: false, error: e.message };
    console.error("[chat] app action failed", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

function convId(v: unknown): string {
  if (!isConversationId(v)) throw new InputError("invalid");
  return v;
}
function userIds(v: unknown, max = 20): number[] {
  if (!Array.isArray(v) || v.length > max) throw new InputError("invalid");
  for (const x of v) if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0) throw new InputError("invalid");
  return [...new Set(v as number[])];
}
const botUser = (b: ReturnType<typeof usableBots>[number]): ChatUser => ({
  id: b.userId,
  name: b.name,
  email: `${b.handle}@${BOT_EMAIL_DOMAIN}`,
  bot: publicInfo(b),
});

/** Apps I may add to conversations or DM (my Claude first, then my and shared apps). */
export async function listUsableApps(): Promise<ActionResult<ChatUser[]>> {
  return act((me) => usableBots(me).map(botUser));
}

function membership(added: number[], conversationId: string, me: ChatUser, isAdded: boolean) {
  if (!added.length) return;
  void import("@/lib/chat/bot-events")
    .then((m) => m.onBotMembership(added, conversationId, me, isAdded))
    .catch((e) => console.error("[bots] membership event failed:", e instanceof Error ? e.message : e));
}

export async function addApps(conversationId: string, botUserIds: number[]): Promise<ActionResult> {
  return act((me) => {
    const id = convId(conversationId);
    const added = store.addBots(id, me.id, userIds(botUserIds));
    membership(added, id, me, true);
  });
}

export async function removeApp(conversationId: string, botUserId: number): Promise<ActionResult> {
  return act((me) => {
    const id = convId(conversationId);
    const [bot] = userIds([botUserId]);
    if (store.removeBot(id, me.id, bot)) membership([bot], id, me, false);
  });
}

/** Opens (or creates) my DM with an app I may use. */
export async function openAppDm(botUserId: number): Promise<ActionResult<string>> {
  return act((me) => {
    const [id] = userIds([botUserId]);
    const b = botByUserId(id);
    if (!b || !canUseBot(b, me.id)) throw new ChatError("forbidden");
    return store.openDm(me.id, id);
  });
}

// ---------- Webhooks ----------

export type WebhookView = { id: string; name: string; avatar: string | null; color: number | null; created: number; createdBy: string };

const hookUrl = (id: string, key: string) => `${env.appUrl}/api/chat/hooks/${id}?key=${key}`;

function postable(conversationId: string, me: ChatUser): string {
  const id = convId(conversationId);
  if (!store.isConversationMember(id, me.id) || botByUserId(me.id)) throw new ChatError("notMember");
  return id;
}

function ownHook(conversationId: string, hookId: unknown) {
  if (typeof hookId !== "string" || !BOT_ID.test(hookId)) throw new InputError("invalid");
  const hook = webhooksOf(conversationId).find((h) => h.id === hookId);
  if (!hook) throw new ChatError("notFound");
  return hook;
}

export async function listWebhooks(conversationId: string): Promise<ActionResult<WebhookView[]>> {
  return act((me) =>
    webhooksOf(postable(conversationId, me)).map((h) => ({
      id: h.id,
      name: h.name,
      avatar: h.avatar,
      color: h.color,
      created: h.created,
      createdBy: h.ownerName,
    })),
  );
}

/** Creates a webhook; the URL (with its secret key) is returned once. */
export async function createWebhook(
  conversationId: string,
  input: { name: unknown; avatar: unknown; color: unknown },
): Promise<ActionResult<{ id: string; url: string }>> {
  return act((me) => {
    const id = postable(conversationId, me);
    const { id: hookId, key } = createHook(id, me.id, { name: botName(input?.name), avatar: botAvatar(input?.avatar), color: botColor(input?.color) });
    return { id: hookId, url: hookUrl(hookId, key) };
  });
}

/** New key: the old URL stops working. */
export async function regenerateWebhook(conversationId: string, hookId: string): Promise<ActionResult<string>> {
  return act((me) => {
    const hook = ownHook(postable(conversationId, me), hookId);
    return hookUrl(hook.id, regenerateWebhookKey(hook.id));
  });
}

export async function deleteWebhook(conversationId: string, hookId: string): Promise<ActionResult> {
  return act((me) => {
    const hook = ownHook(postable(conversationId, me), hookId);
    softDeleteBot(hook.id);
  });
}
