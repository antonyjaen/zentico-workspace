"use server";

// Drive files in Chat: the picker, the access step, posting Drive cards, resolving cards/links
// for the viewer and asking the sender for access. Inputs are untrusted and validated here;
// Drive enforces the user's own rights and the chat store enforces membership.
import { getTranslations } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { DriveError } from "@/lib/drive";
import { browse, checkAccess, DriveAccessError, grantMissing, parseDriveLink, refOf, resolveCards } from "@/lib/chat/drive";
import { chatUser } from "@/lib/chat/session";
import * as store from "@/lib/chat/store";
import { ChatError } from "@/lib/chat/store";
import { env } from "@/lib/env";
import {
  BODY_MAX,
  driveOpenHref,
  isConversationId,
  isDriveId,
  MAX_DRIVE_PICKS,
  type ActionResult,
  type ChatMessage,
  type ChatUser,
  type DriveAccessCheck,
  type DriveBrowse,
  type DriveCardData,
  type DriveGrant,
  type DrivePick,
} from "./shared";

class InputError extends Error {}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

async function act<T>(fn: (me: ChatUser) => T | Promise<T>): Promise<ActionResult<T>> {
  try {
    const me = await chatUser();
    return { ok: true, data: await fn(me) };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof ChatError || e instanceof InputError || e instanceof DriveAccessError) return { ok: false, error: e.message };
    if (e instanceof DriveError) return { ok: false, error: e.code === "unavailable" ? "driveUnavailable" : e.code === "not_found" ? "driveNotFound" : "failed" };
    console.error("[chat] drive action failed", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

function convId(v: unknown): string {
  if (!isConversationId(v)) throw new InputError("invalid");
  return v;
}

function optId(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (!isDriveId(v)) throw new InputError("invalid");
  return v;
}

function picks(v: unknown): DrivePick[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_DRIVE_PICKS) throw new InputError("invalid");
  return v.map((p) => {
    if (!p || typeof p !== "object" || !isDriveId(p.fileId)) throw new InputError("invalid");
    return { accountId: optId(p.accountId), fileId: p.fileId as string };
  });
}

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v !== "string") throw new InputError("invalid");
  const s = v.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();
  if (s.length > BODY_MAX) throw new InputError("tooLong");
  return s;
}

function threadRoot(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new InputError("invalid");
  return v;
}

/** Picker listing: "recent", "my" (a folder of My Drive) or "shared" (account roots, or a folder in one). */
export async function browseDrive(view: string, accountId: string | null, folderId: string | null): Promise<ActionResult<DriveBrowse>> {
  return act(() => {
    if (view !== "recent" && view !== "my" && view !== "shared") throw new InputError("invalid");
    return browse(view, optId(accountId), optId(folderId));
  });
}

/** Who in the conversation couldn't open the picked files. */
export async function checkDriveAccess(conversationId: string, picked: DrivePick[]): Promise<ActionResult<DriveAccessCheck>> {
  return act(async (me) => (await checkAccess(me, convId(conversationId), picks(picked))).check);
}

/**
 * Optionally grants view/edit access to the members who lack it (only on files I may share),
 * then posts one Drive card per file. The message text goes with the first card.
 */
export async function sendDriveFiles(
  conversationId: string,
  picked: DrivePick[],
  grant: DriveGrant,
  message: string,
  root: number | null,
): Promise<ActionResult<{ messages: ChatMessage[]; grantFailed: number }>> {
  return act(async (me) => {
    const c = convId(conversationId);
    const list = picks(picked);
    if (grant !== "viewer" && grant !== "editor" && grant !== "none") throw new InputError("invalid");
    const body = text(message);
    const tr = threadRoot(root);
    // Check I can post here before touching any grants.
    if (!store.detail(c, me.id).joined) throw new ChatError("notMember");
    const checked = await checkAccess(me, c, list);
    const grantFailed = grant === "none" ? 0 : await grantMissing(checked, grant);
    const messages = checked.located.map((l, i) =>
      store.postMessage(c, me.id, { body: i === 0 ? body : "", drive: [refOf(l, me)], threadRoot: tr }),
    );
    return { messages, grantFailed };
  });
}

type CardTarget = { url: string } | { accountId: string | null; fileId: string };

/** Drive cards for posted refs and pasted links, resolved with the viewer's own rights. */
export async function resolveDriveCards(targets: CardTarget[]): Promise<ActionResult<(DriveCardData | null)[]>> {
  return act(async (me) => {
    if (!Array.isArray(targets) || targets.length > 40) throw new InputError("invalid");
    const parsed = targets.map((t) => {
      if (!t || typeof t !== "object") return null;
      if ("url" in t) return typeof t.url === "string" && t.url.length <= 2000 ? parseDriveLink(t.url) : null;
      return isDriveId(t.fileId) && (t.accountId == null || isDriveId(t.accountId)) ? { accountId: t.accountId ?? null, fileId: t.fileId } : null;
    });
    const valid = parsed.filter((p): p is NonNullable<typeof p> => !!p);
    const cards = await resolveCards(me, valid);
    let i = 0;
    return parsed.map((p) => (p ? cards[i++] : null));
  });
}

/** Asks the sender of a message for access to a Drive item it links to (a mention in the same place). */
export async function requestDriveAccess(messageId: number, target: CardTarget): Promise<ActionResult<ChatMessage>> {
  return act(async (me) => {
    if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId <= 0) throw new InputError("invalid");
    const m = store.readableMessage(messageId, me.id);
    if (!m || !m.author || m.author.id === me.id) throw new ChatError("notFound");
    let link: string | null = null;
    if (target && typeof target === "object" && "url" in target) {
      const p = typeof target.url === "string" ? parseDriveLink(target.url) : null;
      // Only links that are actually in the message.
      if (p && m.body.includes(target.url)) link = target.url;
    } else if (target && typeof target === "object" && isDriveId(target.fileId)) {
      const ref = m.meta?.drive?.find((d) => d.fileId === target.fileId && (target.accountId == null || d.accountId === target.accountId));
      if (ref) link = `${env.appUrl}${driveOpenHref(ref)}`;
    }
    if (!link) throw new InputError("invalid");
    const t = await getTranslations("chat");
    const handle = m.author.email.split("@")[0].toLowerCase();
    return store.postMessage(m.conversationId, me.id, {
      body: `@${handle} ${t("drive.requestAccessBody", { link })}`,
      threadRoot: m.threadRoot,
    });
  });
}
