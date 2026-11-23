// Live presence of voice channels (who is connected, muted, deafened). Server-only.
// LiveKit is the source of truth for who is in a room ("vc-<conversationId>"); clients report
// joins, leaves and their mute/deafen flags (POST /api/chat/voice) so the roster updates at once.
// Changes go to the channel's audience as `voice` events on the chat bus. Like events.ts this is
// in-process state: one app instance.
import { voiceRoom, type ChatUser, type VoiceParticipant } from "@/app/(apps)/chat/shared";
import { forgetParticipants, listParticipants, livekitAvailable } from "../livekit-api";
import { get } from "./db";
import { publish } from "./events";
import { ChatError, voiceAudience, voiceChannel } from "./store";

type Entry = Omit<VoiceParticipant, "userId"> & { beat: number };
export type VoiceAction = "join" | "state" | "leave" | "sync" | "beat";

/** A heartbeat older than this means the tab is gone (crash, lost network). */
const BEAT_TTL_MS = 75_000;
const SWEEP_MS = 30_000;
/** A fresh join may not be listed by LiveKit yet: don't drop it for this long. */
const JOIN_GRACE_MS = 15_000;

const g = globalThis as typeof globalThis & {
  __zwVoice?: Map<string, Map<number, Entry>>;
  __zwVoiceSent?: Map<string, string>;
  __zwVoiceHits?: Map<number, number[]>;
  __zwVoiceSweep?: ReturnType<typeof setInterval>;
  __zwVoiceSoon?: Map<string, ReturnType<typeof setTimeout>>;
};
const rooms = (g.__zwVoice ??= new Map());
const sent = (g.__zwVoiceSent ??= new Map());
const hits = (g.__zwVoiceHits ??= new Map());
const soon = (g.__zwVoiceSoon ??= new Map());

/** Who is connected to a voice channel, in join order (synchronous: used by the overview). */
export function voicePresence(convId: string): VoiceParticipant[] {
  const list = rooms.get(convId);
  if (!list) return [];
  return [...list.entries()]
    .map(([userId, e]) => ({ userId, name: e.name, email: e.email, muted: e.muted, deafened: e.deafened, since: e.since }))
    .sort((a, b) => a.since - b.since);
}

function publishIfChanged(convId: string) {
  const participants = voicePresence(convId);
  const json = JSON.stringify(participants);
  if ((sent.get(convId) ?? "[]") === json) return;
  if (participants.length) sent.set(convId, json);
  else sent.delete(convId);
  if (!rooms.get(convId)?.size) rooms.delete(convId);
  publish(voiceAudience(convId), { type: "voice", conversationId: convId, participants });
}

function limit(userId: number) {
  const now = Date.now();
  const list = (hits.get(userId) ?? []).filter((t: number) => now - t < 10_000);
  if (list.length >= 20) throw new ChatError("rateLimited");
  list.push(now);
  if (hits.size > 10_000) hits.clear();
  hits.set(userId, list);
}

/** Matches the registry with LiveKit's participant list, then publishes any change. */
async function reconcile(convId: string): Promise<void> {
  if (livekitAvailable()) {
    const room = voiceRoom(convId);
    forgetParticipants(room);
    let live: { identity: string; name: string }[];
    try {
      live = await listParticipants(room, { fresh: true });
    } catch (e) {
      console.error("[voice] participants:", e instanceof Error ? e.message : e);
      return publishIfChanged(convId);
    }
    const now = Date.now();
    const list = rooms.get(convId) ?? new Map<number, Entry>();
    const emails = new Set(live.map((p) => p.identity.toLowerCase()));
    for (const [id, e] of list) if (!emails.has(e.email.toLowerCase()) && now - e.since > JOIN_GRACE_MS) list.delete(id);
    const known = new Set([...list.values()].map((e) => e.email.toLowerCase()));
    for (const p of live) {
      if (known.has(p.identity.toLowerCase())) continue;
      // Connected without a report reaching us (lost request, server restart).
      const u = get("SELECT id, email, name FROM users WHERE email = ? COLLATE NOCASE", p.identity);
      if (!u) continue;
      const id = Number(u.id);
      for (const [other, m] of rooms) if (other !== convId && m.delete(id)) publishIfChanged(other);
      list.set(id, { name: String(u.name || p.name), email: String(u.email), muted: false, deafened: false, since: now, beat: now });
    }
    if (list.size) rooms.set(convId, list);
  }
  publishIfChanged(convId);
}

/** Coalesces bursts (every client syncs when someone joins) into one LiveKit query per room. */
function reconcileSoon(convId: string) {
  if (soon.has(convId)) return;
  soon.set(
    convId,
    setTimeout(() => {
      soon.delete(convId);
      void reconcile(convId).catch((e) => console.error("[voice] reconcile:", e instanceof Error ? e.message : e));
    }, 500),
  );
}

/** Drops crashed tabs (stale heartbeat) and re-checks every room someone is in. Idle when nobody talks. */
function ensureSweep() {
  if (g.__zwVoiceSweep) return;
  g.__zwVoiceSweep = setInterval(() => {
    const now = Date.now();
    for (const [convId, list] of rooms) {
      for (const [id, e] of list) if (now - e.beat > BEAT_TTL_MS) list.delete(id);
      reconcileSoon(convId);
    }
  }, SWEEP_MS);
  g.__zwVoiceSweep.unref?.();
}

/** A client's report about its own voice connection. Returns the channel's roster (empty for a leave). */
export function reportVoice(
  user: ChatUser,
  convId: string,
  action: VoiceAction,
  flags: { muted?: boolean; deafened?: boolean } = {},
): VoiceParticipant[] {
  ensureSweep();
  if (action === "leave") {
    // Removing yourself needs no access check (it may just have been revoked) and no rate limit
    // (cheap, idempotent). It returns no roster: the caller may not be allowed to read it.
    if (rooms.get(convId)?.delete(user.id)) publishIfChanged(convId);
    return [];
  }
  limit(user.id);
  const now = Date.now();
  voiceChannel(convId, user.id);
  const list = rooms.get(convId) ?? new Map<number, Entry>();
  rooms.set(convId, list);
  const mine = list.get(user.id);
  const muted = typeof flags.muted === "boolean" ? flags.muted : (mine?.muted ?? false);
  const deafened = typeof flags.deafened === "boolean" ? flags.deafened : (mine?.deafened ?? false);
  const added = action === "join" || !mine;
  if (added) {
    if (action === "sync" && !mine) {
      // Not connected here: only reconcile.
      if (!list.size) rooms.delete(convId);
      reconcileSoon(convId);
      return voicePresence(convId);
    }
    // One voice channel at a time: joining here moves me out of any other.
    for (const [other, m] of rooms) if (other !== convId && m.delete(user.id)) publishIfChanged(other);
    list.set(user.id, { name: user.name, email: user.email, muted, deafened, since: mine?.since ?? now, beat: now });
  } else {
    mine.muted = muted;
    mine.deafened = deafened;
    mine.beat = now;
  }
  if (action !== "beat" || added) {
    publishIfChanged(convId);
    if (action !== "state") reconcileSoon(convId);
  }
  return voicePresence(convId);
}
