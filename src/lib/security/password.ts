// Self-service password change on Stalwart's x:AccountPassword singleton: input checks, the
// /set request and how its answer maps to errors. Pure (no I/O), so the client can reuse the hints.
//
// Stalwart (crates/jmap/src/registry/mapping/account.rs, v1.1) changes the password when `secret`
// differs from the stored one, after verifying `currentSecret` together with the TOTP code
// (`otpAuth.otpCode`) when TOTP is on. `otpAuth` is merged property by property and its `otpUrl`
// starts out as the mask "****" (= keep the stored TOTP), so the TOTP survives the change; sending
// the mask explicitly keeps it that way even if `otpAuth` were ever replaced as a whole.

/** Stalwart's x:Authentication defaults (minPasswordLength / maxPasswordLength, counted in UTF-8 bytes). Hints only: Stalwart enforces its own. */
export const PASSWORD_HINT = { min: 8, max: 128 } as const;
/** Upper bound on what is forwarded at all; Stalwart rejects anything over its own maximum. */
const MAX_INPUT_BYTES = 1024;
/** Stalwart's mask for secrets (registry MASKED_PASSWORD); as `otpUrl` it means "unchanged". */
const MASKED = "****";

export const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** Constant-time equality of two strings (by UTF-8 bytes); the length difference is folded in too. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export type PasswordInput = { current: string; next: string; code: string | null };
export type PasswordInputError = "invalid" | "mismatch" | "same";

/**
 * Shape checks before anything reaches Stalwart. Length and strength are left to Stalwart (it is the
 * authority and reports its own limits); `code` must already be a parsed 6-digit code or null.
 */
export function checkPasswordInput(input: {
  current: unknown;
  next: unknown;
  confirm: unknown;
  code: string | null;
}): PasswordInput | { error: PasswordInputError } {
  const { current, next, confirm, code } = input;
  if (typeof current !== "string" || typeof next !== "string" || typeof confirm !== "string") return { error: "invalid" };
  if (!current || !next || utf8Length(current) > MAX_INPUT_BYTES || utf8Length(next) > MAX_INPUT_BYTES) return { error: "invalid" };
  // Control characters can't be typed into mail apps or the sign-in page.
  if (/[\u0000-\u001f\u007f]/.test(next)) return { error: "invalid" };
  if (!sameSecret(next, confirm)) return { error: "mismatch" };
  if (sameSecret(next, current)) return { error: "same" };
  return { current, next, code };
}

/** Arguments (besides accountId) of the x:AccountPassword/set call that changes the password. */
export function passwordSetArgs({ current, next, code }: PasswordInput) {
  return {
    update: {
      singleton: { secret: next, currentSecret: current, otpAuth: { otpUrl: MASKED, otpCode: code } },
    },
  };
}

export type PasswordChangeError =
  | "wrong_credentials"
  | "otp_required"
  | "too_short"
  | "too_long"
  | "weak"
  | "rejected"
  | "not_supported"
  | "failed";
export type PasswordChangeResult =
  | { ok: true }
  | { ok: false; error: PasswordChangeError; limit?: number; detail?: string };

/** Maps Stalwart's /set answer; its validation messages are kept as `detail` (they are in English). */
export function readPasswordSetResult(result: Record<string, unknown>): PasswordChangeResult {
  const updated = result.updated as Record<string, unknown> | null | undefined;
  if (updated && "singleton" in updated) return { ok: true };
  const err = (result.notUpdated as Record<string, { type?: string; description?: string }> | undefined)?.singleton;
  const description = String(err?.description ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
  let m: RegExpMatchArray | null;
  if ((m = description.match(/at least (\d+) characters/i))) return { ok: false, error: "too_short", limit: Number(m[1]) };
  if ((m = description.match(/at most (\d+) characters/i))) return { ok: false, error: "too_long", limit: Number(m[1]) };
  if (/too weak/i.test(description)) {
    const detail = description.replace(/^\s*Password is too weak\.\s*/i, "").trim();
    return detail ? { ok: false, error: "weak", detail } : { ok: false, error: "weak" };
  }
  if (/Current OTP code is required/i.test(description)) return { ok: false, error: "otp_required" };
  if (/incorrect/i.test(description)) return { ok: false, error: "wrong_credentials" };
  if (/not allowed|doesn't have one|does not support/i.test(description)) return { ok: false, error: "not_supported" };
  if (err?.type === "invalidProperties" && description) return { ok: false, error: "rejected", detail: description };
  return { ok: false, error: "failed" };
}

/**
 * Rough 0–4 strength estimate for the form's meter. Stalwart scores with zxcvbn (and requires its
 * configured minimum), so this only nudges: length and variety, minus obvious repeats/sequences.
 */
export function strengthEstimate(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  const len = [...pw].length;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  let score = len >= 8 ? 1 : 0;
  if (len >= 12) score++;
  if (len >= 16) score++;
  if (classes >= 3 || (len >= 20 && /\s/.test(pw))) score++;
  if (/(.)\1{2,}/.test(pw) || /(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|password|contrase)/i.test(pw)) score--;
  return Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4;
}
