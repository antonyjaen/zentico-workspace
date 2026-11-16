// Write actions for dashboard components and mods (zentico.action), run as the signed-in user.
// Each maps to a workspace operation with a strict argument whitelist; the MCP tools behind them
// validate again. Mods additionally need the manifest permission, the user's grant (checked by
// the route) and the user's in-app confirmation (the dashboard asks before calling the route).
// Server-only.
import { sendMessage } from "@/app/(apps)/chat/actions";
import { DashError } from "@/app/(apps)/dashboard/model";
import { runTool } from "../mcp/tools";
import type { Session } from "../session";
import { MOD_ACTIONS } from "./schema";

type Raw = Record<string, unknown>;

function pick(args: Raw, allowed: string[]): Raw {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new DashError(`Unknown argument "${k}" (allowed: ${allowed.join(", ")})`);
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

function need(args: Raw, key: string, max = 255): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new DashError(`"${key}" is required (a string of at most ${max} characters)`);
  return v;
}

async function tool(session: Session, name: string, args: Raw): Promise<unknown> {
  const out = await runTool(name, args, { session, scope: "write", tokenName: "dashboard", tokenExpires: null, commandId: null });
  if (!out.ok) throw new DashError(out.error);
  return out.value;
}

export const isActionName = (v: unknown): v is keyof typeof MOD_ACTIONS => typeof v === "string" && Object.prototype.hasOwnProperty.call(MOD_ACTIONS, v);

/** Runs a write action. Throws DashError for invalid input or a failing operation. */
export async function runAction(session: Session, name: string, raw: unknown, timeZone: string | null): Promise<unknown> {
  if (!isActionName(name)) throw new DashError("Unknown action");
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) throw new DashError("Arguments must be an object");
  const args = (raw ?? {}) as Raw;
  switch (name) {
    case "mail.markRead": {
      const a = pick(args, ["threadId", "read"]);
      need(a, "threadId");
      return tool(session, "mail_mark_read", { threadId: a.threadId, read: a.read !== false });
    }
    case "mail.flag": {
      const a = pick(args, ["threadId", "flagged"]);
      need(a, "threadId");
      if (typeof a.flagged !== "boolean") throw new DashError('"flagged" must be true or false');
      return tool(session, "mail_set_keywords", { threadId: a.threadId, flagged: a.flagged });
    }
    case "mail.archive": {
      const a = pick(args, ["threadId"]);
      need(a, "threadId");
      return tool(session, "mail_move", { threadId: a.threadId, folder: "archive" });
    }
    case "mail.draft": {
      const a = pick(args, ["to", "subject", "body", "replyToEmailId"]);
      need(a, "body", 50_000);
      if (a.to != null && (!Array.isArray(a.to) || a.to.length > 20 || a.to.some((x) => typeof x !== "string"))) throw new DashError('"to" must be a list of addresses');
      return tool(session, "mail_create_draft", a);
    }
    case "chat.send": {
      const a = pick(args, ["conversationId", "body"]);
      const id = need(a, "conversationId", 64);
      const body = need(a, "body", 4000);
      const r = await sendMessage(id, body, null);
      if (!r.ok) throw new DashError(r.error === "invalid" ? "Invalid conversation or message" : r.error);
      return { posted: true, id: r.data.id };
    }
    case "calendar.create": {
      const a = pick(args, ["title", "start", "end", "durationMinutes", "location", "description", "attendees"]);
      need(a, "title", 300);
      need(a, "start", 40);
      return tool(session, "calendar_create_event", { ...a, ...(timeZone ? { timeZone } : {}) });
    }
    case "drive.writeText": {
      const a = pick(args, ["fileId", "name", "folderId", "content"]);
      if (typeof a.content !== "string" || a.content.length > 512 * 1024) throw new DashError('"content" must be a string (max 512 KB)');
      return tool(session, "drive_write_text", a);
    }
  }
}
