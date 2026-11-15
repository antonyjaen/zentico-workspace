// LiveKit access tokens, minted locally as HS256 JWTs with Web Crypto (no server SDK needed).
// Server-only: reads LIVEKIT_API_SECRET. Never import from client components.
import { base64url } from "./crypto";

export const ROOM_PATTERN = /^[a-z0-9-]{3,64}$/;
export const isValidRoom = (room: unknown): room is string => typeof room === "string" && ROOM_PATTERN.test(room);

/** Cookie holding the user's most recently joined rooms (codes only, newest first). */
export const RECENT_ROOMS_COOKIE = "zw_meet_recent";
export const RECENT_ROOMS_MAX = 5;

export function parseRecentRooms(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const list: unknown = JSON.parse(value);
    return Array.isArray(list) ? list.filter(isValidRoom).slice(0, RECENT_ROOMS_MAX) : [];
  } catch {
    return [];
  }
}

type LiveKitConfig = { url: string; apiKey: string; apiSecret: string };

/** LiveKit settings, or null when Meet isn't configured on this deployment. */
export function livekitConfig(): LiveKitConfig | null {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret || !/^wss?:\/\//.test(url)) return null;
  return { url: url.replace(/\/$/, ""), apiKey, apiSecret };
}

const encoder = new TextEncoder();
const TOKEN_TTL_SECONDS = 6 * 60 * 60;

const encodeJson = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));

/** Signs a room-join token for one participant (identity = the user's email). */
export async function mintAccessToken(
  config: LiveKitConfig,
  { identity, name, room }: { identity: string; name: string; room: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson({
    iss: config.apiKey,
    sub: identity,
    name,
    nbf: now - 10,
    exp: now + TOKEN_TTL_SECONDS,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  });
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(config.apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}
