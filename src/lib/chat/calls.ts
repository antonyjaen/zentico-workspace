// Ringing calls ("Call" in Chat): a call rings the other people of a DM or group (or, on request,
// a small channel) and lives in the conversation's meeting room. Server-only.
//
// State is in the chat database (calls + call_members, one row per person being called) so every
// tab and device of every participant sees the same thing: each change is pushed as a
// call.ring / call.update event over the notifications stream (lib/notifications/store.ts), which
// every page of the app listens to. Unanswered ringing stops after CALL_RING_MS on a timer here;
// timers don't survive a restart, so sweepCalls() (server start, and every list) finishes any
// overdue ones and re-arms the rest.
import {
  CALL_RING_CHANNEL_MAX,
  CALL_RING_MAX,
  CALL_RING_MS,
  type CallMedia,
  type CallMemberState,
  type CallState,
  type CallView,
  type ChatUser,
  type ConversationKind,
} from "@/app/(apps)/chat/shared";
import { generateRoomCode } from "@/app/(apps)/meet/shared";
import { notify, pushEvent } from "../notifications/store";
import { all, get, run, tx } from "./db";
import * as store from "./store";
import { ChatError } from "./store";

const num = (v: unknown) => Number(v ?? 0);
const strv = (v: unknown) => (typeof v === "string" ? v : "");

type CallRow = {
  id: string;
  conversationId: string;
  meetingId: number | null;
  room: string;
  callerId: number;
  media: CallMedia;
  state: CallState;
  created: number;
  answeredAt: number | null;
  endedAt: number | null;
};

function loadCall(id: string): CallRow | null {
  const r = get("SELECT * FROM calls WHERE id = ?", id);
  if (!r) return null;
  return {
    id: strv(r.id),
    conversationId: strv(r.conversation_id),
    meetingId: r.meeting_id == null ? null : num(r.meeting_id),
    room: strv(r.room),
    callerId: num(r.caller_id),
    media: strv(r.media) as CallMedia,
    state: strv(r.state) as CallState,
    created: num(r.created),
    answeredAt: r.answered_at == null ? null : num(r.answered_at),
    endedAt: r.ended_at == null ? null : num(r.ended_at),
  };
}

function view(call: CallRow): CallView | null {
  const conv = get("SELECT kind, name FROM conversations WHERE id = ?", call.conversationId);
  const caller = get("SELECT id, name, email FROM users WHERE id = ?", call.callerId);
  if (!conv || !caller) return null;
  const kind = strv(conv.kind) as ConversationKind;
  return {
    id: call.id,
    conversationId: call.conversationId,
    conversationKind: kind,
    conversationName: kind === "dm" ? null : strv(conv.name) || null,
    room: call.room,
    media: call.media,
    state: call.state,
    caller: { id: num(caller.id), name: strv(caller.name) || strv(caller.email), email: strv(caller.email) },
    callees: all(
      `SELECT u.id, u.name, u.email, cm.state FROM call_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.call_id = ? ORDER BY u.name COLLATE NOCASE`,
      call.id,
    ).map((r) => ({ id: num(r.id), name: strv(r.name) || strv(r.email), email: strv(r.email), state: strv(r.state) as CallMemberState })),
    created: call.created,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    ringUntil: call.created + CALL_RING_MS,
  };
}

/** Sends the call's current state to the caller and everyone called (all their tabs and devices). */
function broadcast(callId: string, ringIds: number[] = []) {
  const call = loadCall(callId);
  const v = call && view(call);
  if (!v) return;
  const ring = new Set(ringIds);
  pushEvent(v.caller.email, { type: "call.update", call: v });
  for (const c of v.callees) pushEvent(c.email, ring.has(c.id) ? { type: "call.ring", call: v } : { type: "call.update", call: v });
}

/* --------------------------------------------------------------- limits */

const g = globalThis as typeof globalThis & {
  __zwCallTimers?: Map<string, ReturnType<typeof setTimeout>>;
  __zwCallHits?: Map<string, number[]>;
};
const timers = (g.__zwCallTimers ??= new Map());
const hits = (g.__zwCallHits ??= new Map());

/** Sliding-window rate limit per user and action (in-process, like the rest of Chat). */
function limit(userId: number, action: string, max: number, windowMs: number) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t: number) => now - t < windowMs);
  if (list.length >= max) throw new ChatError("rateLimited");
  list.push(now);
  if (hits.size > 10_000) hits.clear();
  hits.set(key, list);
}

function arm(callId: string, at: number) {
  clearTimeout(timers.get(callId));
  timers.set(
    callId,
    setTimeout(() => {
      timers.delete(callId);
      try {
        expire(callId);
      } catch (e) {
        console.error("[calls] timeout:", e instanceof Error ? e.message : e);
      }
    }, Math.max(0, at - Date.now())),
  );
}

function disarm(callId: string) {
  clearTimeout(timers.get(callId));
  timers.delete(callId);
}

/* ------------------------------------------------------------- outcomes */

function setMembers(callId: string, from: CallMemberState, to: CallMemberState): number[] {
  const ids = all("SELECT user_id FROM call_members WHERE call_id = ? AND state = ?", callId, from).map((r) => num(r.user_id));
  if (ids.length) run("UPDATE call_members SET state = ?, updated = ? WHERE call_id = ? AND state = ?", to, Date.now(), callId, from);
  return ids;
}

/** "Missed call" in the bell of each person who didn't pick up. */
function notifyMissed(call: CallRow, userIds: number[]) {
  if (!userIds.length) return;
  const caller = get("SELECT name, email FROM users WHERE id = ?", call.callerId);
  const conv = get("SELECT kind, name FROM conversations WHERE id = ?", call.conversationId);
  const callerName = strv(caller?.name) || strv(caller?.email);
  const where = strv(conv?.kind) === "channel" ? `#${strv(conv?.name)}` : strv(conv?.name);
  for (const id of userIds) {
    const email = strv(get("SELECT email FROM users WHERE id = ?", id)?.email);
    if (!email) continue;
    notify(email, {
      category: "meet",
      kind: "missedCall",
      title: callerName,
      body: where,
      href: `/chat?c=${call.conversationId}`,
      priority: "normal",
      ref: call.conversationId,
      key: `call:${call.id}`,
      once: true,
    });
  }
}

/** Ends an unanswered call: everyone still ringing stops, the card and the conversation say so. */
function finishUnanswered(call: CallRow, state: "cancelled" | "missed" | "declined") {
  const now = Date.now();
  const missed = tx(() => {
    const fresh = loadCall(call.id);
    if (!fresh || fresh.state !== "ringing") return null;
    run("UPDATE calls SET state = ?, ended_at = ? WHERE id = ?", state, now, call.id);
    return setMembers(call.id, "ringing", state === "cancelled" ? "cancelled" : "missed");
  });
  if (missed === null) return;
  disarm(call.id);
  if (call.meetingId != null) store.patchMeetingCall(call.meetingId, { state, endedAt: now }, true);
  store.callSystemMessage(call.conversationId, call.callerId, {
    action: "call",
    outcome: state === "declined" ? "declined" : "missed",
    media: call.media,
  });
  notifyMissed(call, missed);
  broadcast(call.id);
}

/** Ringing ran out: unanswered → missed; answered (group) → the people still ringing missed it. */
function expire(callId: string) {
  const call = loadCall(callId);
  if (!call) return;
  if (call.state === "ringing") return finishUnanswered(call, "missed");
  if (call.state !== "answered") return;
  const missed = tx(() => setMembers(callId, "ringing", "missed"));
  if (!missed.length) return;
  notifyMissed(call, missed);
  broadcast(callId);
}

function endAnswered(call: CallRow) {
  const now = Date.now();
  const changed = tx(() => {
    if (loadCall(call.id)?.state !== "answered") return false;
    run("UPDATE calls SET state = 'ended', ended_at = ? WHERE id = ?", now, call.id);
    setMembers(call.id, "ringing", "missed");
    return true;
  });
  if (!changed) return;
  disarm(call.id);
  if (call.meetingId != null) store.patchMeetingCall(call.meetingId, { state: "ended", endedAt: now }, true);
  broadcast(call.id);
}

/* ------------------------------------------------------------------ API */

const ACTIVE = "state IN ('ringing', 'answered')";

function memberState(callId: string, userId: number): CallMemberState | null {
  const r = get("SELECT state FROM call_members WHERE call_id = ? AND user_id = ?", callId, userId);
  return r ? (strv(r.state) as CallMemberState) : null;
}

/** A call I'm the caller of or one of the people called; otherwise "notFound". */
function mine(callId: string, userId: number): { call: CallRow; role: "caller" | "callee"; state: CallMemberState | null } {
  const call = loadCall(callId);
  if (!call) throw new ChatError("notFound");
  if (call.callerId === userId) return { call, role: "caller", state: null };
  const state = memberState(callId, userId);
  if (state === null) throw new ChatError("notFound");
  return { call, role: "callee", state };
}

function accept(call: CallRow, userId: number) {
  const now = Date.now();
  const answered = tx(() => {
    const fresh = loadCall(call.id);
    if (!fresh || (fresh.state !== "ringing" && fresh.state !== "answered")) throw new ChatError("callEnded");
    run("UPDATE call_members SET state = 'accepted', updated = ? WHERE call_id = ? AND user_id = ?", now, call.id, userId);
    if (fresh.state === "ringing") {
      run("UPDATE calls SET state = 'answered', answered_at = ? WHERE id = ?", now, call.id);
      return true;
    }
    return false;
  });
  if (!get("SELECT 1 AS x FROM call_members WHERE call_id = ? AND state = 'ringing'", call.id)) disarm(call.id);
  if (answered && call.meetingId != null) store.patchMeetingCall(call.meetingId, { state: "answered", answeredAt: now }, false);
  broadcast(call.id);
}

export type StartResult = { call: CallView | null; conversationId: string; room: string; media: CallMedia };

/**
 * "Call" in a conversation. Joins the conversation's live call if there is one (answering it if
 * it was ringing me). Otherwise starts one in the ongoing meeting (or a new meeting whose card
 * shows the call) and rings the others: DMs and groups always; channels only with `ringAll` and
 * at most CALL_RING_CHANNEL_MAX people, else it is a plain meeting (the card notifies as before).
 */
export function startCall(me: ChatUser, convId: string, media: CallMedia, ringAll: boolean): StartResult {
  const target = store.callTarget(convId, me.id);

  const live = get(`SELECT id FROM calls WHERE conversation_id = ? AND ${ACTIVE} ORDER BY created DESC LIMIT 1`, convId);
  if (live) {
    const call = loadCall(strv(live.id))!;
    if (memberState(call.id, me.id) === "ringing") accept(call, me.id);
    return { call: view(loadCall(call.id)!), conversationId: convId, room: call.room, media: call.media };
  }

  limit(me.id, "start", 10, 60_000);
  const ring =
    target.others.length > 0 &&
    (target.kind !== "channel" || (ringAll && target.others.length + 1 <= CALL_RING_CHANNEL_MAX));
  const ongoing = store.conversationMeetings(convId, me.id).ongoing;

  if (!ring) {
    if (ongoing) return { call: null, conversationId: convId, room: ongoing.code, media };
    const code = generateRoomCode();
    store.startInstantMeeting(convId, me.id, code, target.title);
    return { call: null, conversationId: convId, room: code, media };
  }

  const callees = target.others.slice(0, CALL_RING_MAX);
  const id = store.newId();
  const now = Date.now();
  let room: string;
  let meetingId: number | null = null;
  if (ongoing) {
    room = ongoing.code;
  } else {
    room = generateRoomCode();
    const card = store.startInstantMeeting(convId, me.id, room, target.title, { id, media, state: "ringing" });
    meetingId = card.meta?.meeting?.meetingId ?? null;
  }
  tx(() => {
    run(
      "INSERT INTO calls (id, conversation_id, meeting_id, room, caller_id, media, state, created) VALUES (?, ?, ?, ?, ?, ?, 'ringing', ?)",
      id,
      convId,
      meetingId,
      room,
      me.id,
      media,
      now,
    );
    for (const uid of callees) run("INSERT INTO call_members (call_id, user_id, state, updated) VALUES (?, ?, 'ringing', ?)", id, uid, now);
  });
  arm(id, now + CALL_RING_MS);
  broadcast(id, callees);
  return { call: view(loadCall(id)!), conversationId: convId, room, media };
}

/** I picked up (from any tab or device): the others stop ringing for me. */
export function answerCall(me: ChatUser, callId: string): StartResult {
  limit(me.id, "act", 60, 60_000);
  const { call, role, state } = mine(callId, me.id);
  if (call.state !== "ringing" && call.state !== "answered") throw new ChatError("callEnded");
  if (role === "callee" && state !== "accepted") accept(call, me.id);
  return { call: view(loadCall(callId)!), conversationId: call.conversationId, room: call.room, media: call.media };
}

/** I said no (optionally with a quick reply posted to the conversation). Everyone declining ends the call. */
export function declineCall(me: ChatUser, callId: string, reply: string | null): void {
  limit(me.id, "act", 60, 60_000);
  const { call, role, state } = mine(callId, me.id);
  if (role !== "callee") throw new ChatError("forbidden");
  if (state === "ringing") {
    run("UPDATE call_members SET state = 'declined', updated = ?, reply = ? WHERE call_id = ? AND user_id = ?", Date.now(), reply, callId, me.id);
  }
  if (reply) store.postMessage(call.conversationId, me.id, { body: reply });
  if (state !== "ringing") return;
  const open = get("SELECT count(*) AS n FROM call_members WHERE call_id = ? AND state IN ('ringing', 'accepted')", callId);
  if (call.state === "ringing" && num(open?.n) === 0) return finishUnanswered(call, "declined");
  broadcast(callId);
}

/** The caller hung up before anyone answered. */
export function cancelCall(me: ChatUser, callId: string): void {
  limit(me.id, "act", 60, 60_000);
  const { call, role } = mine(callId, me.id);
  if (role !== "caller") throw new ChatError("forbidden");
  if (call.state === "ringing") finishUnanswered(call, "cancelled");
}

/**
 * Someone left an answered call. A DM call ends when either person hangs up; a group call when
 * the last person leaves (`last`: the leaving tab saw nobody else in the room). Before anyone
 * answered, the caller leaving cancels it.
 */
export function hangUp(me: ChatUser, callId: string, last: boolean): void {
  limit(me.id, "act", 60, 60_000);
  const { call, role, state } = mine(callId, me.id);
  if (call.state === "ringing") {
    if (role === "caller") finishUnanswered(call, "cancelled");
    return;
  }
  if (call.state !== "answered" || (role === "callee" && state !== "accepted")) return;
  const conv = get("SELECT kind FROM conversations WHERE id = ?", call.conversationId);
  if (strv(conv?.kind) === "dm" || last) endAnswered(call);
}

/** Calls I'm in that are still live (for a tab that just loaded or reconnected). */
export function myCalls(me: ChatUser): CallView[] {
  sweepCalls();
  const since = Date.now() - 6 * 3_600_000;
  return all(
    `SELECT DISTINCT c.id FROM calls c LEFT JOIN call_members cm ON cm.call_id = c.id AND cm.user_id = ?
     WHERE c.${ACTIVE} AND c.created > ? AND (c.caller_id = ? OR cm.user_id IS NOT NULL) ORDER BY c.created DESC LIMIT 20`,
    me.id,
    since,
    me.id,
  )
    .map((r) => loadCall(strv(r.id)))
    .map((c) => (c ? view(c) : null))
    .filter((v): v is CallView => !!v);
}

/** The meeting was marked ended in Chat: its call stops ringing / ends too. */
export function onMeetingEnded(meetingId: number): void {
  for (const r of all(`SELECT id FROM calls WHERE meeting_id = ? AND ${ACTIVE}`, meetingId)) {
    const call = loadCall(strv(r.id));
    if (!call) continue;
    if (call.state === "ringing") finishUnanswered(call, "cancelled");
    else endAnswered(call);
  }
}

/**
 * Finishes ringing that ran out while no timer was armed (server restart) and re-arms the rest.
 * Answered calls nobody ended (everyone's tab closed) are closed after 12 hours.
 */
export function sweepCalls(): void {
  try {
    const now = Date.now();
    for (const r of all("SELECT id, created FROM calls WHERE state = 'ringing'")) {
      const id = strv(r.id);
      const due = num(r.created) + CALL_RING_MS;
      if (due <= now) expire(id);
      else if (!timers.has(id)) arm(id, due);
    }
    for (const r of all("SELECT id, created FROM calls WHERE state = 'answered'")) {
      const id = strv(r.id);
      if (num(r.created) + 12 * 3_600_000 < now) {
        const call = loadCall(id);
        if (call) endAnswered(call);
      } else if (!timers.has(id) && get("SELECT 1 AS x FROM call_members WHERE call_id = ? AND state = 'ringing'", id)) {
        arm(id, num(r.created) + CALL_RING_MS);
      }
    }
  } catch (e) {
    console.error("[calls] sweep:", e instanceof Error ? e.message : e);
  }
}
