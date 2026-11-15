// MCP tools over the workspace: mail, calendar, contacts, drive/docs, chat and meetings.
// Each tool runs inside runWithSession() (see app/api/mcp/route.ts), so the regular server libs
// work exactly as they do for the signed-in browser user.
// Tools live in one module per app (mail-tools, calendar-tools, …); this file is the registry,
// the read-only filter and the in-call confirmation of write tools.
import { ToolError, type Args } from "./args";
import { awaitConfirmation } from "./agent";
import { CALENDAR_TOOLS } from "./calendar-tools";
import { CHAT_TOOLS, MEETING_TOOLS } from "./collab-tools";
import type { Scope } from "./db";
import { DRIVE_TOOLS } from "./drive-tools";
import { appUrl, iso, type Tool } from "./kit";
import { MAIL_TOOLS } from "./mail-tools";
import { PEOPLE_TOOLS } from "./people-tools";

export type { ToolContext } from "./kit";
import type { ToolContext } from "./kit";

const TOOLS: Tool[] = [
  {
    name: "whoami",
    description: "Returns the signed-in workspace user, the token's name/scope/expiry and the workspace URL.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      return {
        name: ctx.session.name,
        email: ctx.session.email,
        token: { name: ctx.tokenName, scope: ctx.scope === "write" ? "read+write" : "read", expires: ctx.tokenExpires ? iso(ctx.tokenExpires) : null },
        workspace: appUrl(),
      };
    },
  },
  ...MAIL_TOOLS,
  ...CALENDAR_TOOLS,
  ...PEOPLE_TOOLS,
  ...DRIVE_TOOLS,
  ...CHAT_TOOLS,
  ...MEETING_TOOLS,
];

/* ----------------------------------------------------------------- registry */

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Tool listing for a token: write tools are only offered to read+write tokens. */
export function listTools(scope: Scope) {
  return TOOLS.filter((t) => scope === "write" || !t.write).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: !t.write,
      destructiveHint: !!t.destructive,
      openWorldHint: !!t.openWorld,
    },
  }));
}

/* ------------------------------------------------------ write confirmations */

const clip = (v: unknown, max: number): string => {
  const text = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const people = (v: unknown, max = 5): string => {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => clip(x, 80)) : [];
  return list.length > max ? `${list.slice(0, max).join(", ")} +${list.length - max}` : list.join(", ");
};
const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** One line describing what a write tool is about to do, shown on the in-call Approve / Reject card. */
export function describeWrite(name: string, args: Args): string {
  const parts: string[] = [];
  const add = (label: string, value: string) => value && parts.push(label ? `${label} ${value}` : value);
  switch (name) {
    case "mail_send":
    case "mail_create_draft":
      add("to", people(args.to) || (args.replyToEmailId ? "(reply to the original sender)" : ""));
      add("cc", people(args.cc));
      add("bcc", people(args.bcc));
      add("", args.subject ? `"${clip(args.subject, 120)}"` : "");
      add("", clip(args.body, 200));
      break;
    case "mail_move":
      add("", args.threadId ? "a whole conversation" : `${count(args.emailIds)} message(s)`);
      add("to", clip(args.folder, 80));
      break;
    case "mail_set_keywords":
      add("", args.threadId ? "a whole conversation" : `${count(args.emailIds)} message(s)`);
      if (typeof args.read === "boolean") add("", args.read ? "mark read" : "mark unread");
      if (typeof args.flagged === "boolean") add("", args.flagged ? "star" : "unstar");
      add("add labels", people(args.addLabels));
      add("remove labels", people(args.removeLabels));
      break;
    case "calendar_create_event":
      add("", `"${clip(args.title, 120)}"`);
      add("at", `${clip(args.start, 40)}${args.timeZone ? ` (${clip(args.timeZone, 40)})` : ""}`);
      add("inviting", people(args.attendees));
      break;
    case "drive_write_text":
      add("", args.fileId ? `overwrite file ${clip(args.fileId, 60)}` : `create "${clip(args.name, 120)}"`);
      add("", clip(args.content, 160));
      break;
    case "docs_create_markdown":
      add("", `"${clip(args.title, 120)}"`);
      add("", clip(args.content, 160));
      break;
    case "chat_post_message":
      add("", `"${clip(args.body, 240)}"`);
      break;
    case "mail_reply":
      add("", args.send === true ? "send reply" : "draft reply");
      add("", args.replyAll === true ? "to all" : "");
      add("", clip(args.body, 200));
      break;
    case "mail_forward":
      add("", args.send === true ? "send forward" : "draft forward");
      add("to", people(args.to));
      add("", clip(args.body, 160));
      break;
    case "mail_mark_read":
    case "mail_label":
    case "mail_delete":
      add("", args.threadId ? "a whole conversation" : `${count(args.emailIds)} message(s)`);
      if (name === "mail_mark_read") add("", args.read === false ? "mark unread" : "mark read");
      if (name === "mail_label") add("", `${clip(args.action, 10) || "apply"} label "${clip(args.label, 60)}"`);
      if (name === "mail_delete") add("", args.permanent === true ? "DELETE PERMANENTLY" : "move to Trash");
      break;
    case "calendar_update_event":
    case "calendar_delete_event":
    case "calendar_rsvp":
      add("", `${name === "calendar_delete_event" ? "delete" : name === "calendar_rsvp" ? `RSVP ${clip(args.status, 12)}` : "update"} event ${clip(args.eventId, 60)}`);
      add("title", clip(args.title, 120));
      add("start", clip(args.start, 40));
      add("inviting", people(args.addAttendees ?? args.attendees));
      break;
    case "drive_delete":
      add("", `${args.permanent === true ? "DELETE PERMANENTLY" : "trash"} ${count(args.fileIds)} item(s)`);
      break;
    case "drive_share":
      add("share with", people(args.add));
      add("as", clip(args.role, 10) || (count(args.add) ? "viewer" : ""));
      add("remove", people(args.remove));
      break;
    case "drive_edit_text":
      add("", `edit file ${clip(args.fileId, 60)} (${count(args.edits)} change(s))`);
      break;
    case "drive_upload":
    case "drive_create_folder":
    case "drive_rename":
      add("", `${name.replace("drive_", "").replace("_", " ")} "${clip(args.name, 120)}"`);
      break;
    case "docs_create":
      add("", `create ${clip(args.kind, 20)} "${clip(args.title, 120)}"`);
      break;
    case "chat_create_conversation":
      add("chat with", people(args.people));
      break;
    case "chat_share_drive_file":
      add("", `share ${count(args.fileIds)} Drive item(s) in chat`);
      add("granting", clip(args.grant, 10));
      break;
    default:
      add("", clip(JSON.stringify(args), 300));
  }
  return parts.join(" · ").slice(0, 600);
}

export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/** Runs a tool by name. Throws only for unexpected failures; user-facing problems come back as errors. */
export async function runTool(name: string, args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, error: `Unknown tool "${name}"` };
  if (tool.write && ctx.scope !== "write") {
    return { ok: false, error: "This token is read-only; create a read+write token in Settings → Integrations." };
  }
  // Meeting commands: reads run immediately, writes wait for the speaker's confirmation in the call.
  if (tool.write && ctx.commandId != null) {
    const confirmed = await awaitConfirmation(ctx.commandId, ctx.session.email, name, describeWrite(name, args ?? {}));
    if (!confirmed.ok) {
      return {
        ok: false,
        error:
          confirmed.reason === "unknown_command"
            ? "Not confirmed by the user (this meeting command is unknown or already finished)."
            : "Not confirmed by the user",
      };
    }
  }
  try {
    return { ok: true, value: await tool.run(args ?? {}, ctx) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, error: e.message };
    throw e;
  }
}
