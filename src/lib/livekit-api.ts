// LiveKit server APIs over Twirp (plain HTTP + a short-lived admin JWT; no server SDK): room
// membership and server-sent data messages. Recording egress (lib/meetings/egress.ts) uses the same
// helper. Server-only.
import { livekitConfig, livekitHttpUrl, mintServerToken, type LiveKitConfig } from "./livekit";

export class TwirpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

export async function twirp<T>(config: LiveKitConfig, service: string, method: string, grant: Record<string, unknown>, body: unknown): Promise<T> {
  const token = await mintServerToken(config, grant);
  const res = await fetch(`${livekitHttpUrl(config)}/twirp/livekit.${service}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error page (proxy): handled below
  }
  if (!res.ok) {
    const err = (json ?? {}) as { code?: unknown; msg?: unknown };
    const code = typeof err.code === "string" ? err.code : "unknown";
    const msg = typeof err.msg === "string" ? err.msg.slice(0, 200) : `HTTP ${res.status}`;
    throw new TwirpError(res.status, code, `${service}/${method}: ${code}: ${msg}`);
  }
  return (json ?? {}) as T;
}

const notFound = (e: unknown) => e instanceof TwirpError && (e.status === 404 || e.code === "not_found");

/** True when `identity` is currently connected to `room`. */
export async function isInRoom(config: LiveKitConfig, room: string, identity: string): Promise<boolean> {
  try {
    await twirp(config, "RoomService", "GetParticipant", { room, roomAdmin: true }, { room, identity });
    return true;
  } catch (e) {
    if (notFound(e)) return false;
    throw e;
  }
}

export type RoomParticipant = { identity: string; name: string };

/**
 * Seams for tests (scripts/meeting-stage.test.ts): replace LiveKit with in-memory fakes. Never set in
 * the app.
 */
type Fake = {
  listParticipants?: (room: string) => Promise<RoomParticipant[]>;
  sendRoomData?: (room: string, topic: string, data: unknown) => Promise<void>;
};
const g = globalThis as typeof globalThis & { __zwLiveKitFake?: Fake; __zwParticipantsCache?: Map<string, { at: number; list: RoomParticipant[] }> };
export function setLiveKitFake(fake: Fake | undefined): void {
  g.__zwLiveKitFake = fake;
  g.__zwParticipantsCache?.clear();
}
const cache = (g.__zwParticipantsCache ??= new Map());

/** True when LiveKit is configured (or faked in tests). */
export const livekitAvailable = () => !!g.__zwLiveKitFake || !!livekitConfig();

const PARTICIPANTS_TTL_MS = 10_000;

/**
 * Who is in a room right now (identity = the user's email, as minted by /api/meet/token). Cached
 * for 10 s per room unless `fresh`. An unknown room (nobody joined yet / everyone left) is empty.
 */
export async function listParticipants(room: string, { fresh = false } = {}): Promise<RoomParticipant[]> {
  const hit = cache.get(room);
  if (!fresh && hit && Date.now() - hit.at < PARTICIPANTS_TTL_MS) return hit.list;
  let list: RoomParticipant[];
  const fake = g.__zwLiveKitFake?.listParticipants;
  if (fake) list = await fake(room);
  else {
    const config = livekitConfig();
    if (!config) return [];
    try {
      const res = await twirp<{ participants?: { identity?: string; name?: string }[] }>(
        config,
        "RoomService",
        "ListParticipants",
        { room, roomAdmin: true },
        { room },
      );
      list = (res.participants ?? [])
        .filter((p) => typeof p.identity === "string" && p.identity)
        .map((p) => ({ identity: String(p.identity), name: typeof p.name === "string" && p.name ? p.name : String(p.identity) }));
    } catch (e) {
      if (!notFound(e)) throw e;
      list = [];
    }
  }
  cache.set(room, { at: Date.now(), list });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return list;
}

/** Forgets the cached participant list of a room (after a join/leave the caller knows about). */
export const forgetParticipants = (room: string) => cache.delete(room);

/**
 * Sends a JSON message to everyone in the room over LiveKit's reliable data channel (RoomService
 * SendData). Clients receive it with no sending participant, so it can't be confused with a peer's.
 */
export async function sendRoomData(room: string, topic: string, data: unknown): Promise<void> {
  const fake = g.__zwLiveKitFake?.sendRoomData;
  if (fake) return fake(room, topic, data);
  const config = livekitConfig();
  if (!config) throw new Error("LiveKit is not configured");
  const bytes = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  await twirp(config, "RoomService", "SendData", { room, roomAdmin: true }, { room, data: bytes, kind: "RELIABLE", topic });
}
