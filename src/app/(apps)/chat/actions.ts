"use server";

// Chat server actions. Every action resolves the signed-in user, validates its inputs and lets
// the store authorize by conversation/team membership.
import { unstable_rethrow } from "next/navigation";
import { asMaster } from "@/lib/auth";
import { createMeetingEvent, getAvailability, getCalendarSession } from "@/lib/calendar";
import { botByEmail, canUseBot } from "@/lib/chat/bots";
import { directory, domainOf, errText, foldPeople, loadDirectory } from "@/lib/chat/directory";
import * as store from "@/lib/chat/store";
import { ChatError } from "@/lib/chat/store";
import { removeFiles } from "@/lib/chat/files";
import { chatUser } from "@/lib/chat/session";
import { env } from "@/lib/env";
import { isDayKey, isTimeZone, zonedToUtc } from "../calendar/time";
import { generateRoomCode } from "../meet/shared";
import {
  BODY_MAX,
  isBotEmail,
  isConversationId,
  NAME_MAX,
  REACTIONS,
  type ActionResult,
  type BusyBlock,
  type ChatMessage,
  type ChatOverview,
  type ChatUser,
  type ConversationDetail,
  type DirectoryDiagnostics,
  type MeetingInfo,
  type PeopleData,
  type Person,
} from "./shared";

class InputError extends Error {}

const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const TEAM_ID = /^[a-z0-9]{16}$/;
// Control characters except tab and newline.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

async function act<T>(fn: (me: ChatUser) => T | Promise<T>): Promise<ActionResult<T>> {
  try {
    const me = await chatUser();
    return { ok: true, data: await fn(me) };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof ChatError || e instanceof InputError) return { ok: false, error: e.message };
    console.error("[chat] action failed", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

function convId(v: unknown): string {
  if (!isConversationId(v)) throw new InputError("invalid");
  return v;
}
function teamId(v: unknown): string {
  if (typeof v !== "string" || !TEAM_ID.test(v)) throw new InputError("invalid");
  return v;
}
function msgId(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new InputError("invalid");
  return v;
}
function optMsgId(v: unknown): number | null {
  return v == null ? null : msgId(v);
}
function body(v: unknown, allowEmpty = false): string {
  if (typeof v !== "string") throw new InputError("invalid");
  const s = v.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();
  if (!s && !allowEmpty) throw new InputError("empty");
  if (s.length > BODY_MAX) throw new InputError("tooLong");
  return s;
}
function name(v: unknown, required: boolean, max = NAME_MAX): string | null {
  if (v == null || v === "") {
    if (required) throw new InputError("nameRequired");
    return null;
  }
  if (typeof v !== "string") throw new InputError("invalid");
  const s = v.replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, max);
  if (!s && required) throw new InputError("nameRequired");
  return s || null;
}
function ids(v: unknown, max = 200): number[] {
  if (!Array.isArray(v) || v.length > max) throw new InputError("invalid");
  return [...new Set(v.map(msgId))];
}

// ---------- Directory (lib/chat/directory) ----------

/** Validates picked people against the directory and returns their user ids. */
async function resolvePeople(me: ChatUser, v: unknown, max = 100): Promise<number[]> {
  if (!Array.isArray(v) || v.length > max) throw new InputError("invalid");
  const emails = new Set<string>();
  for (const p of v) {
    const email = typeof p?.email === "string" ? p.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email)) throw new InputError("invalidPerson");
    if (email !== me.email) emails.add(email);
  }
  if (emails.size === 0) return [];
  const known = new Map((await directory(me)).map((p) => [p.email, p]));
  const people: Person[] = [];
  for (const email of emails) {
    const p = known.get(email);
    if (!p) throw new InputError("invalidPerson");
    people.push(p);
  }
  return store.ensureUsers(people);
}

/** Picked apps (their synthetic addresses) → bot user ids, if I may use them. */
function resolveApps(me: ChatUser, v: unknown): number[] {
  if (!Array.isArray(v) || v.length > 100) throw new InputError("invalid");
  const out = new Set<number>();
  for (const p of v) {
    const email = typeof p?.email === "string" ? p.email.trim().toLowerCase() : "";
    if (!isBotEmail(email)) continue;
    const b = botByEmail(email);
    if (!b || !canUseBot(b, me.id)) throw new InputError("invalidPerson");
    out.add(b.userId);
  }
  return [...out];
}

/** Tells HTTP apps they were added (async; never blocks the action). */
function appsAdded(ids: number[], conversationId: string, me: ChatUser) {
  if (!ids.length) return;
  void import("@/lib/chat/bot-events")
    .then((m) => m.onBotMembership(ids, conversationId, me, true))
    .catch((e) => console.error("[bots] membership event failed:", e instanceof Error ? e.message : e));
}

// ---------- Reads ----------

export async function getOverview(): Promise<ActionResult<ChatOverview>> {
  return act((me) => store.overview(me));
}

export async function getConversation(id: string): Promise<ActionResult<ConversationDetail>> {
  return act((me) => store.detail(convId(id), me.id));
}

export async function getMessages(id: string, before: number | null): Promise<ActionResult<{ messages: ChatMessage[]; hasMore: boolean }>> {
  return act((me) => store.listMessages(convId(id), me.id, optMsgId(before)));
}

export async function getThread(rootId: number): Promise<ActionResult<{ root: ChatMessage; replies: ChatMessage[] }>> {
  return act((me) => store.listThread(msgId(rootId), me.id));
}

/** People for the pickers: one entry per person (their Chat address), shared mailboxes left out. */
export async function listPeople(): Promise<ActionResult<Person[]>> {
  return act(async (me) => {
    const r = await loadDirectory(me);
    return foldPeople(r.people, new Set(r.orgDomains), domainOf(me.email))
      .filter((p) => !p.shared)
      .map((p) => ({ email: p.chatEmail, name: p.name }));
  });
}

/** People tab: the folded organization directory plus my address-book contacts. */
export async function getPeopleDirectory(fresh = false): Promise<ActionResult<PeopleData>> {
  return act(async (me) => {
    const r = await loadDirectory(me, fresh === true);
    const myDomain = domainOf(me.email);
    return {
      people: foldPeople(r.people, new Set(r.orgDomains), myDomain),
      partial: r.partial,
      contacts: r.contacts,
      books: r.books,
      myDomain,
      orgDomains: r.orgDomains,
    };
  });
}

/** What a fresh directory lookup sees (principals, fallbacks, errors), for troubleshooting. */
export async function getDirectoryDiagnostics(): Promise<ActionResult<DirectoryDiagnostics>> {
  return act(async (me) => (await loadDirectory(me, true)).diagnostics);
}

const PRINCIPAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Busy blocks of a directory person in [from, to) (at most 2 days); unsupported → supported=false. */
export async function getPersonAvailability(
  principalId: string,
  from: number,
  to: number,
): Promise<ActionResult<{ supported: boolean; busy: BusyBlock[] }>> {
  return act(async (me) => {
    if (typeof principalId !== "string" || !PRINCIPAL_ID.test(principalId)) throw new InputError("invalid");
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from || to - from > 2 * 86_400_000)
      throw new InputError("invalid");
    // Only principals of my own directory.
    if (!(await loadDirectory(me)).people.some((p) => p.principalId === principalId)) throw new InputError("invalidPerson");
    const { availability } = await getCalendarSession();
    if (!availability) return { supported: false, busy: [] };
    try {
      return { supported: true, busy: await getAvailability(principalId, from, to) };
    } catch (e) {
      unstable_rethrow(e);
      console.warn("[chat] availability unavailable:", errText(e));
      return { supported: false, busy: [] };
    }
  });
}

export async function getTeamMembers(id: string): Promise<ActionResult<(ChatUser & { role: "owner" | "member" })[]>> {
  return act((me) => store.teamMembers(teamId(id), me.id));
}

export async function getMeetings(id: string): Promise<ActionResult<{ ongoing: MeetingInfo | null; upcoming: MeetingInfo[] }>> {
  return act((me) => store.conversationMeetings(convId(id), me.id));
}

// ---------- Messages ----------

export async function sendMessage(id: string, text: string, threadRoot: number | null): Promise<ActionResult<ChatMessage>> {
  return act((me) => store.postMessage(convId(id), me.id, { body: body(text), threadRoot: optMsgId(threadRoot) }));
}

export async function editMessage(id: number, text: string): Promise<ActionResult<ChatMessage>> {
  return act((me) => store.editMessage(msgId(id), me.id, body(text, true)));
}

export async function deleteMessage(id: number): Promise<ActionResult> {
  return act(async (me) => {
    const files = store.deleteMessage(msgId(id), me.id);
    await removeFiles(files);
  });
}

export async function react(id: number, emoji: string): Promise<ActionResult<ChatMessage>> {
  return act((me) => {
    if (!(REACTIONS as readonly string[]).includes(emoji)) throw new InputError("invalid");
    return store.toggleReaction(msgId(id), me.id, emoji);
  });
}

export async function markRead(id: string, messageId: number): Promise<ActionResult> {
  return act((me) => store.markRead(convId(id), me.id, msgId(messageId)));
}

// ---------- Conversations ----------

/** One person → their DM; several → a new group (optionally named). */
export async function startChat(people: Person[], groupName: string | null): Promise<ActionResult<string>> {
  return act(async (me) => {
    const apps = resolveApps(me, people);
    const others = await resolvePeople(me, Array.isArray(people) ? people.filter((p) => !isBotEmail(String(p?.email ?? ""))) : people);
    if (others.length === 0 && apps.length === 0) throw new InputError("pickPeople");
    // Just one app: a DM with it.
    if (others.length === 0 && apps.length === 1 && !groupName) return store.openDm(me.id, apps[0]);
    const id = others.length === 1 && !groupName ? store.openDm(me.id, others[0]) : store.createGroup(me.id, others, name(groupName, false));
    if (apps.length) appsAdded(store.addBots(id, me.id, apps), id, me);
    return id;
  });
}

export async function addPeople(id: string, people: Person[]): Promise<ActionResult> {
  return act(async (me) => store.addMembers(convId(id), me.id, await resolvePeople(me, people)));
}

/** Adds existing team members (by user id) to a private channel. */
export async function addChannelMembers(id: string, userIds: number[]): Promise<ActionResult> {
  return act((me) => store.addMembers(convId(id), me.id, ids(userIds)));
}

export async function leaveConversation(id: string): Promise<ActionResult> {
  return act((me) => store.leaveConversation(convId(id), me.id));
}

export async function joinChannel(id: string): Promise<ActionResult> {
  return act((me) => store.joinChannel(convId(id), me.id));
}

export async function renameConversation(id: string, newName: string | null, description: string): Promise<ActionResult> {
  return act((me) => store.renameConversation(convId(id), me.id, name(newName, false), name(description, false, 500) ?? ""));
}

// ---------- Teams ----------

export async function createTeam(teamName: string, description: string, people: Person[], general: string): Promise<ActionResult<string>> {
  return act(async (me) => {
    const n = name(teamName, true)!;
    const members = await resolvePeople(me, people, 500);
    const { channelId } = store.createTeam(me.id, {
      name: n,
      description: name(description, false, 500) ?? "",
      members,
      general: name(general, false) ?? "General",
    });
    return channelId;
  });
}

export async function addTeamPeople(id: string, people: Person[]): Promise<ActionResult> {
  return act(async (me) => store.addTeamMembers(teamId(id), me.id, await resolvePeople(me, people, 500)));
}

export async function createChannel(
  team: string,
  channelName: string,
  description: string,
  isPrivate: boolean,
  memberIds: number[],
): Promise<ActionResult<string>> {
  return act((me) =>
    store.createChannel(teamId(team), me.id, {
      name: name(channelName, true)!,
      description: name(description, false, 500) ?? "",
      isPrivate: isPrivate === true,
      members: ids(memberIds, 1000),
    }),
  );
}

// ---------- Meetings ----------

export async function startMeeting(id: string): Promise<ActionResult<{ code: string }>> {
  return act((me) => {
    const c = convId(id);
    const conv = store.detail(c, me.id);
    const code = generateRoomCode();
    store.startInstantMeeting(c, me.id, code, conv.name);
    return { code };
  });
}

export async function endMeeting(meetingId: number): Promise<ActionResult> {
  return act((me) => store.endMeeting(msgId(meetingId), me.id));
}

export type ScheduleInput = {
  title: string;
  date: string;
  time: string;
  durationMin: number;
  description: string;
  timeZone: string;
  attendees: Person[];
};

/** Creates the calendar event (with invitations) and posts a meeting card in the conversation. */
export async function scheduleMeeting(id: string, input: ScheduleInput): Promise<ActionResult<ChatMessage>> {
  return act(async (me) => {
    const c = convId(id);
    if (!input || typeof input !== "object") throw new InputError("invalid");
    const title = name(input.title, true, 200)!;
    if (!isDayKey(input.date) || !TIME.test(input.time)) throw new InputError("invalidDate");
    if (!isTimeZone(input.timeZone)) throw new InputError("invalidDate");
    const duration = input.durationMin;
    if (!Number.isInteger(duration) || duration < 5 || duration > 12 * 60) throw new InputError("invalidDuration");
    const description = body(input.description ?? "", true).slice(0, 5000);
    if (!Array.isArray(input.attendees) || input.attendees.length > 100) throw new InputError("invalid");
    const attendees = new Map<string, string | undefined>();
    for (const p of input.attendees) {
      const email = typeof p?.email === "string" ? p.email.trim().toLowerCase() : "";
      if (!EMAIL.test(email)) throw new InputError("invalidPerson");
      attendees.set(email, typeof p.name === "string" ? (name(p.name, false, 200) ?? undefined) : undefined);
    }
    // Make sure I can post here before touching the calendar.
    const conv = store.detail(c, me.id);
    if (!conv.joined) throw new ChatError("notMember");

    const startLocal = `${input.date}T${input.time}:00`;
    const start = zonedToUtc(startLocal, input.timeZone);
    if (start < Date.now() - 15 * 60_000) throw new InputError("inPast");
    const end = start + duration * 60_000;
    const code = generateRoomCode();
    const link = `${env.appUrl}/meet/${code}`;

    // Chat is the person's own identity: the meeting goes to the master account's calendar.
    const event = await asMaster(() => createMeetingEvent({
      title,
      description: description ? `${description}\n\n${link}` : link,
      start: startLocal,
      timeZone: input.timeZone,
      durationMs: duration * 60_000,
      location: link,
      attendees: [...attendees].map(([email, n]) => ({ email, name: n })),
    })).catch((e) => {
      unstable_rethrow(e);
      console.error("[chat] calendar event failed", e instanceof Error ? e.message : e);
      throw new InputError("calendarFailed");
    });

    return store.scheduleMeeting(c, me.id, { code, title, description, start, end, timeZone: input.timeZone, eventId: event.id || null });
  });
}
