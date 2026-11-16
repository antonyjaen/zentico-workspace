// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s steps) on node:crypto. Server-only.
// Used to check that a user's authenticator app produces the right codes before the secret is
// handed to Stalwart, which enforces it at sign-in (Stalwart doesn't verify a newly set secret).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
export const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Decodes unpadded base32 (case-insensitive, spaces ignored); null when malformed. */
export function base32Decode(value: string): Buffer | null {
  const clean = value.replace(/[\s=]/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(clean)) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of clean) {
    buffer = ((buffer << 5) | ALPHABET.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret (the RFC 4226 recommended length), base32-encoded. */
export const generateSecret = () => base32Encode(randomBytes(20));

/** RFC 4226 HOTP value for `counter`, zero-padded to `digits`. */
export function hotp(key: Uint8Array, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, "0");
}

/** The TOTP code of a base32 secret at `timeMs`. */
export function totp(secret: string, timeMs = Date.now(), digits = DIGITS): string {
  const key = base32Decode(secret);
  if (!key) throw new Error("Invalid TOTP secret");
  return hotp(key, Math.floor(timeMs / 1000 / STEP_SECONDS), digits);
}

/** Validates an untrusted code: exactly six digits (spaces stripped), else null. */
export function parseCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.replace(/\s/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

/**
 * True when `code` matches the current step or one step either side (clock drift). Every window is
 * compared in constant time, so timing doesn't reveal which one matched.
 */
export function verifyTotp(secret: string, code: string, timeMs = Date.now()): boolean {
  const key = base32Decode(secret);
  if (!key || !/^\d{6}$/.test(code)) return false;
  const step = Math.floor(timeMs / 1000 / STEP_SECONDS);
  const given = Buffer.from(code);
  let ok = false;
  for (const delta of [-1, 0, 1]) {
    if (timingSafeEqual(Buffer.from(hotp(key, step + delta)), given)) ok = true;
  }
  return ok;
}

/** otpauth:// URL for authenticator apps (and for Stalwart, which parses it with totp-rs). */
export function otpauthUrl(secret: string, account: string, issuer = "Zentico"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
