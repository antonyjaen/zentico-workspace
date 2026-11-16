"use server";

// Settings → Apps & bots: the signed-in user's HTTP apps. Secrets (signing secret, API token)
// are returned once, when created or rotated, and never again.
import { unstable_rethrow } from "next/navigation";
import {
  BOT_ID,
  BotError,
  createHttpApp,
  deleteHttpApp,
  deliveries,
  rotateSigningSecret,
  rotateToken,
  updateHttpApp,
  type Delivery,
  type HttpAppInput,
} from "@/lib/chat/bots";
import { botAvatar, botColor, botCommands, botDescription, BotInputError, botName, endpointUrl } from "@/lib/chat/bot-input";
import { chatUser } from "@/lib/chat/session";
import { conversationsChanged } from "@/lib/chat/store";
import type { ActionResult, ChatUser } from "@/app/(apps)/chat/shared";

async function act<T>(fn: (me: ChatUser) => T | Promise<T>): Promise<ActionResult<T>> {
  try {
    const me = await chatUser();
    return { ok: true, data: await fn(me) };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof BotError || e instanceof BotInputError) return { ok: false, error: e.message };
    console.error("[apps] action failed", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

function appId(v: unknown): string {
  if (typeof v !== "string" || !BOT_ID.test(v)) throw new BotInputError("invalid");
  return v;
}

export type AppForm = {
  name: unknown;
  description: unknown;
  color: unknown;
  avatar: unknown;
  endpointUrl: unknown;
  shared: unknown;
  commands: unknown;
};

function parse(f: AppForm): HttpAppInput {
  if (!f || typeof f !== "object") throw new BotInputError("invalid");
  return {
    name: botName(f.name),
    description: botDescription(f.description),
    color: botColor(f.color),
    avatar: botAvatar(f.avatar),
    endpointUrl: endpointUrl(f.endpointUrl),
    shared: f.shared === true,
    commands: botCommands(f.commands),
  };
}

export async function createApp(form: AppForm): Promise<ActionResult<{ id: string; signingSecret: string; token: string }>> {
  return act((me) => createHttpApp(me.id, parse(form)));
}

export async function updateApp(id: string, form: AppForm): Promise<ActionResult> {
  return act((me) => updateHttpApp(appId(id), me.id, parse(form)));
}

export async function deleteApp(id: string): Promise<ActionResult> {
  return act((me) => conversationsChanged(deleteHttpApp(appId(id), me.id)));
}

export async function rotateAppSecret(id: string): Promise<ActionResult<string>> {
  return act((me) => rotateSigningSecret(appId(id), me.id));
}

export async function rotateAppToken(id: string): Promise<ActionResult<string>> {
  return act((me) => rotateToken(appId(id), me.id));
}

export async function getDeliveries(id: string): Promise<ActionResult<Delivery[]>> {
  return act((me) => deliveries(appId(id), me.id));
}
