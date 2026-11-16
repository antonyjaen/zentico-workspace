// Validation of app/webhook settings coming from the browser. Server-only (pure functions).
import { NAME_MAX, type BotCommand } from "@/app/(apps)/chat/shared";
import { MAX_COMMANDS } from "./bots";
import { checkEndpointUrl, UnsafeUrlError } from "./safe-http";

/** Thrown with an error code the UI translates. */
export class BotInputError extends Error {}

const CONTROL = /[\u0000-\u001f\u007f]/g;

export function botName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
  if (!s) throw new BotInputError("nameRequired");
  return s;
}

export function botDescription(v: unknown): string {
  if (v == null) return "";
  if (typeof v !== "string") throw new BotInputError("invalid");
  return v.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** One emoji (modifiers and ZWJ sequences allowed), or nothing. */
export function botAvatar(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || v.length > 16 || !/^[\p{Extended_Pictographic}\p{Emoji_Component}‍️]+$/u.test(v)) {
    throw new BotInputError("invalidAvatar");
  }
  return v;
}

/** Avatar hue 0-359, or null for the default. */
export function botColor(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 359) throw new BotInputError("invalid");
  return v;
}

export function endpointUrl(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 2000) throw new BotInputError("invalidUrl");
  try {
    return checkEndpointUrl(v.trim()).toString();
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw new BotInputError("invalidUrl");
    throw e;
  }
}

const COMMAND = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function botCommands(v: unknown): BotCommand[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_COMMANDS) throw new BotInputError("invalidCommand");
  const seen = new Set<string>();
  const out: BotCommand[] = [];
  for (const c of v) {
    const name = typeof c?.name === "string" ? c.name.trim().replace(/^\//, "").toLowerCase() : "";
    if (!name) continue;
    if (!COMMAND.test(name) || seen.has(name)) throw new BotInputError("invalidCommand");
    seen.add(name);
    out.push({ name, description: botDescription(c?.description).slice(0, 100) });
  }
  return out;
}
