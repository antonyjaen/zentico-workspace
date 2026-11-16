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

export type LiveKitConfig = { url: string; apiKey: string; apiSecret: string };

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

/** Signs an HS256 LiveKit JWT (iss = API key) with the given claims and lifetime. */
async function signToken(config: LiveKitConfig, claims: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson({ iss: config.apiKey, nbf: now - 10, exp: now + ttlSeconds, ...claims });
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

/** Signs a room-join token for one participant (identity = the user's email). */
export async function mintAccessToken(
  config: LiveKitConfig,
  { identity, name, room }: { identity: string; name: string; room: string },
): Promise<string> {
  return signToken(
    config,
    { sub: identity, name, video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true } },
    TOKEN_TTL_SECONDS,
  );
}

/** A short-lived token for server-to-LiveKit API calls (Twirp), with the given video grant. */
export async function mintServerToken(config: LiveKitConfig, video: Record<string, unknown>): Promise<string> {
  return signToken(config, { video }, 5 * 60);
}

/** The LiveKit HTTP base URL (wss:// → https://) for the Twirp server APIs. */
export const livekitHttpUrl = (config: LiveKitConfig) => config.url.replace(/^ws(s?):\/\//, "http$1://");
