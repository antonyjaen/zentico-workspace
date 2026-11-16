"use server";

// "Add people" from inside a call: invites go out as Chat DMs to people who use Chat and as
// emails (from the signed-in user's own mailbox) to everyone else. The sender is always the
// session user; the client only picks the room and the invitees.
import { getTranslations } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import type { ActionResult, Person } from "../chat/shared";
import { asMaster } from "@/lib/auth";
import { get } from "@/lib/chat/db";
import { domainOf, EMAIL, foldPeople, loadDirectory } from "@/lib/chat/directory";
import { chatUser } from "@/lib/chat/session";
import * as store from "@/lib/chat/store";
import { env } from "@/lib/env";
import { isValidRoom } from "@/lib/livekit";
import { getIdentities, sendMessage as sendMail, type Identity } from "@/lib/mail-compose";
import { chatMeetingFor } from "@/lib/meetings/chat-link";
import { escapeHtml, mailDocument } from "@/lib/mcp/text";
import { meetHref } from "./shared";

export type InviteStatus = "chat" | "email" | "failed";
export type InviteOutcome = { email: string; status: InviteStatus };
export type InviteContext = { title: string | null; conversation: string | null };

const MAX_INVITEES = 50;
// Light per-user limit: at most this many invitees (and calls) per window.
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 150;
const MAX_CALLS_PER_WINDOW = 30;
const CONTROL = /[\u0000-\u001f\u007f]/g;

class InviteError extends Error {}

const g = globalThis as typeof globalThis & { __zwMeetInvites?: Map<number, { at: number; count: number }[]> };
const usage: Map<number, { at: number; count: number }[]> = (g.__zwMeetInvites ??= new Map());

function takeQuota(userId: number, count: number) {
  const now = Date.now();
  const recent = (usage.get(userId) ?? []).filter((u) => now - u.at < WINDOW_MS);
  const used = recent.reduce((n, u) => n + u.count, 0);
  if (recent.length >= MAX_CALLS_PER_WINDOW || used + count > MAX_PER_WINDOW) throw new InviteError("rateLimited");
  recent.push({ at: now, count });
  if (usage.size > 5000) usage.clear();
  usage.set(userId, recent);
}

function room(v: unknown): string {
  if (!isValidRoom(v)) throw new InviteError("invalid");
  return v;
}

/** The room's Chat meeting conversation, if I may add people to it. */
function manageableConversation(code: string, userId: number): { id: string; name: string } | null {
  const m = chatMeetingFor(code);
  if (!m) return null;
  try {
    const conv = store.detail(m.conversationId, userId);
    return conv.canManage ? { id: conv.id, name: conv.name } : null;
  } catch {
    return null;
  }
}

/** Chat user id for the first of these addresses that belongs to someone who has signed in to Chat. */
function chatUserId(emails: string[]): number | null {
  for (const email of emails) {
    const r = get("SELECT id FROM users WHERE email = ? AND sub IS NOT NULL", email);
    if (r?.id != null) return Number(r.id);
  }
  return null;
}

export async function getInviteContext(code: string): Promise<ActionResult<InviteContext>> {
  try {
    const me = await chatUser();
    const c = room(code);
    const m = chatMeetingFor(c);
    return { ok: true, data: { title: m?.title.trim() || null, conversation: manageableConversation(c, me.id)?.name ?? null } };
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, error: e instanceof InviteError ? e.message : "failed" };
  }
}

export async function inviteToMeeting(
  code: string,
  people: Person[],
  addToConversation: boolean,
): Promise<ActionResult<{ results: InviteOutcome[]; conversation: "ok" | "failed" | null }>> {
  try {
    const me = await chatUser();
    const c = room(code);
    if (!Array.isArray(people) || people.length === 0) throw new InviteError("pickPeople");
    if (people.length > MAX_INVITEES) throw new InviteError("tooMany");
    const emails = new Map<string, string>();
    for (const p of people) {
      const email = typeof p?.email === "string" ? p.email.trim().toLowerCase() : "";
      if (email.length > 254 || !EMAIL.test(email)) throw new InviteError("invalidEmail");
      if (email === me.email) continue;
      const name = typeof p.name === "string" ? p.name.replace(CONTROL, "").trim().slice(0, 200) : "";
      emails.set(email, name);
    }
    if (emails.size === 0) throw new InviteError("pickPeople");
    takeQuota(me.id, emails.size);

    const t = await getTranslations("meet");
    const link = `${env.appUrl}${meetHref(c)}`;
    const title = chatMeetingFor(c)?.title.trim() || null;
    const sender = me.name || me.email;

    // Every address of the same person (folded across the org's domains), so a typed alias still
    // reaches their Chat account.
    const aliases = new Map<string, string[]>();
    try {
      const dir = await loadDirectory(me);
      for (const entry of foldPeople(dir.people, new Set(dir.orgDomains), domainOf(me.email))) {
        if (entry.shared) continue;
        const list = [entry.chatEmail, ...entry.emails.filter((e) => e !== entry.chatEmail)];
        for (const e of entry.emails) aliases.set(e, list);
      }
    } catch (e) {
      unstable_rethrow(e);
      console.warn("[meet] invite: directory unavailable:", e instanceof Error ? e.message : e);
    }

    const chatBody = title ? t("inviteChatTitled", { title, link }) : t("inviteChat", { link });
    const chatIds: number[] = [];
    const results = new Map<string, InviteStatus>();
    const byMail: string[] = [];
    for (const email of emails.keys()) {
      const uid = chatUserId(aliases.get(email) ?? [email]);
      if (uid == null || uid === me.id) {
        if (uid !== me.id) byMail.push(email);
        continue;
      }
      try {
        store.postMessage(store.openDm(me.id, uid), me.id, { body: chatBody });
        results.set(email, "chat");
        chatIds.push(uid);
      } catch (e) {
        console.error("[meet] invite chat failed:", e instanceof Error ? e.message : e);
        byMail.push(email);
      }
    }

    if (byMail.length) {
      let identity: Identity | undefined;
      try {
        // Invites come from the person's own address, even while acting as a delegated account.
        const ids = await asMaster(getIdentities);
        identity = ids.find((i) => i.email.toLowerCase() === me.email) ?? ids[0];
      } catch (e) {
        unstable_rethrow(e);
        console.error("[meet] invite: no identities:", e instanceof Error ? e.message : e);
      }
      const subject = (title ? t("inviteMailSubjectTitled", { name: sender, title }) : t("inviteMailSubject", { name: sender })).replace(
        /[\r\n]+/g,
        " ",
      );
      const intro = title ? t("inviteMailIntroTitled", { name: sender, title }) : t("inviteMailIntro", { name: sender });
      const text = `${intro}\n\n${t("inviteMailJoin")}: ${link}\n${t("inviteMailCode", { code: c })}`;
      const html = mailDocument(
        `<p>${escapeHtml(intro)}</p>` +
          `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:8px 16px;border-radius:6px;background:#1a73e8;color:#fff;text-decoration:none">${escapeHtml(t("inviteMailJoin"))}</a></p>` +
          `<p style="color:#666;font-size:13px">${escapeHtml(link)}<br>${escapeHtml(t("inviteMailCode", { code: c }))}</p>`,
      );
      // One message per person so each result is reported on its own and nobody sees the others.
      for (const email of byMail) {
        if (!identity) {
          results.set(email, "failed");
          continue;
        }
        try {
          const r = await asMaster(() =>
            sendMail(
              { identityId: identity.id, to: [email], cc: [], bcc: [], subject, html, text, attachments: [], inReplyTo: null, references: null },
              null,
            ),
          );
          results.set(email, r.ok ? "email" : "failed");
          if (!r.ok) console.error("[meet] invite mail rejected:", r.error);
        } catch (e) {
          unstable_rethrow(e);
          console.error("[meet] invite mail failed:", e instanceof Error ? e.message : e);
          results.set(email, "failed");
        }
      }
    }

    let conversation: "ok" | "failed" | null = null;
    if (addToConversation === true && chatIds.length) {
      const conv = manageableConversation(c, me.id);
      if (conv) {
        try {
          store.addMembers(conv.id, me.id, chatIds);
          conversation = "ok";
        } catch (e) {
          console.error("[meet] invite: add to conversation failed:", e instanceof Error ? e.message : e);
          conversation = "failed";
        }
      }
    }

    return {
      ok: true,
      data: { results: [...emails.keys()].filter((e) => results.has(e)).map((email) => ({ email, status: results.get(email)! })), conversation },
    };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof InviteError) return { ok: false, error: e.message };
    console.error("[meet] invite failed:", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}
