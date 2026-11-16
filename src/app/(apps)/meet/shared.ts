// Client-safe helpers for Meet (no secrets here — token minting lives in src/lib/livekit.ts).

export const ROOM_PATTERN = /^[a-z0-9-]{3,64}$/;

const LETTERS = "abcdefghijkmnopqrstuvwxyz"; // no "l": easy to confuse with "1"/"i" when read aloud

/** Readable random meeting code like "abc-defg-hij". */
export function generateRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const chars = Array.from(bytes, (b) => LETTERS[b % LETTERS.length]);
  return `${chars.slice(0, 3).join("")}-${chars.slice(3, 7).join("")}-${chars.slice(7).join("")}`;
}

/** Accepts a bare code ("abc-defg-hij", "ABC DEFG HIJ") or a link ending in /meet/<code>. */
export function parseRoomInput(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  const fromLink = value.match(/\/meet\/([^/?#\s]+)/i);
  if (fromLink) value = decodeURIComponent(fromLink[1]);
  value = value.toLowerCase().replace(/\s+/g, "-");
  return ROOM_PATTERN.test(value) ? value : null;
}

/**
 * Pseudo-room of the commands typed in the Dashboard's Claude chat: they share the per-user
 * command queue with meeting commands (src/lib/mcp/agent.ts). Never a valid ROOM_PATTERN.
 */
export const DASHBOARD_ROOM = "~dashboard";

export const meetHref = (room: string) => (room === DASHBOARD_ROOM ? "/dashboard" : `/meet/${room}`);

/** Chat payloads travel over the reliable data channel under this topic. */
export const CHAT_TOPIC = "zw-chat";
export const CHAT_MAX_LENGTH = 2000;

export type ChatMessage = { id: string; from: string; name: string; text: string; at: number; mine: boolean };
