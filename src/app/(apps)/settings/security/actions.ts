"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getSession, getSessionForSetup } from "@/lib/auth";
import { seal, unseal } from "@/lib/crypto";
import { qrSvgPath } from "@/lib/security/qr";
import {
  createAppPassword,
  destroyAppPassword,
  type OtpChangeError,
  setOtp,
  StalwartError,
} from "@/lib/security/stalwart";
import {
  allowAttempt,
  GRACE_DAYS,
  getPolicy,
  HOUR_MS,
  isAdmin,
  recordStatus,
  resetAttempts,
  SESSION_MAX_LIMIT_MS,
  setRequire2fa,
  setSessionMax,
} from "@/lib/security/store";
import { generateSecret, otpauthUrl, parseCode, verifyTotp } from "@/lib/security/totp";
import {
  cookieOptions,
  SECURITY_COOKIE,
  type SecurityGrant,
  type Session,
  TOTP_PENDING_COOKIE,
  type TotpPending,
} from "@/lib/session";

export type SecurityError =
  | OtpChangeError
  | "wrong_code"
  | "invalid"
  | "reauth"
  | "expired"
  | "required"
  | "signed_out"
  | "forbidden"
  | "quota";
type Result<T = object> = ({ ok: true } & T) | { ok: false; error: SecurityError };

const PENDING_MAX_AGE = 10 * 60;

/** The security grant from /api/auth/login?security=…, if it is this user's and still valid. */
async function grantFor(session: Session, stepUp = false): Promise<SecurityGrant | null> {
  const grant = await unseal<SecurityGrant>((await cookies()).get(SECURITY_COOKIE)?.value);
  if (!grant || grant.sub !== session.sub || grant.expiresAt <= Date.now() + 15_000) return null;
  return stepUp && !grant.stepUp ? null : grant;
}

/** Account passwords are passed straight to Stalwart; only their shape is checked here. */
function parsePassword(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function stalwartFailure(e: unknown, what: string): { ok: false; error: SecurityError } {
  if (e instanceof StalwartError && e.code === "authorize") return { ok: false, error: "reauth" };
  if (e instanceof StalwartError && e.code === "rate_limited") return { ok: false, error: "rate_limited" };
  console.error(`[security] ${what} failed:`, e instanceof Error ? e.message : e);
  return { ok: false, error: "failed" };
}

/* ------------------------------------------------------------- two-step verification */

export type Enrollment = { secret: string; qr: { size: number; path: string } };

/** Starts enrollment: a new secret, kept sealed in a cookie until a code from the app confirms it. */
export async function startEnrollAction(): Promise<Result<Enrollment>> {
  const session = await getSessionForSetup();
  if (!session) return { ok: false, error: "signed_out" };
  if (!(await grantFor(session))) return { ok: false, error: "reauth" };
  const secret = generateSecret();
  const pending: TotpPending = { sub: session.sub, secret, expiresAt: Date.now() + PENDING_MAX_AGE * 1000 };
  (await cookies()).set(TOTP_PENDING_COOKIE, await seal(pending), cookieOptions(PENDING_MAX_AGE));
  return { ok: true, secret, qr: qrSvgPath(otpauthUrl(secret, session.email)) };
}

/** Checks a code against the pending secret, then turns TOTP on in Stalwart (needs the password). */
export async function confirmEnrollAction(input: { code: unknown; password: unknown }): Promise<Result> {
  const session = await getSessionForSetup();
  if (!session) return { ok: false, error: "signed_out" };
  const code = parseCode(input.code);
  const password = parsePassword(input.password);
  if (!code || !password) return { ok: false, error: "invalid" };
  const grant = await grantFor(session);
  if (!grant) return { ok: false, error: "reauth" };
  const jar = await cookies();
  const pending = await unseal<TotpPending>(jar.get(TOTP_PENDING_COOKIE)?.value);
  if (!pending || pending.sub !== session.sub || pending.expiresAt <= Date.now()) return { ok: false, error: "expired" };
  if (!allowAttempt(session.sub)) return { ok: false, error: "rate_limited" };
  if (!verifyTotp(pending.secret, code)) return { ok: false, error: "wrong_code" };

  try {
    const result = await setOtp(grant.accessToken, { password, otpUrl: otpauthUrl(pending.secret, session.email) });
    if (!result.ok) return result;
  } catch (e) {
    return stalwartFailure(e, "enable TOTP");
  }
  jar.delete(TOTP_PENDING_COOKIE);
  resetAttempts(session.sub);
  recordStatus(session.sub, session.email, true);
  revalidatePath("/settings/security");
  return { ok: true };
}

/** Turns TOTP off; Stalwart verifies the password and a current code. Not while the policy requires it. */
export async function disableAction(input: { code: unknown; password: unknown }): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "signed_out" };
  if (getPolicy().required) return { ok: false, error: "required" };
  const code = parseCode(input.code);
  const password = parsePassword(input.password);
  if (!code || !password) return { ok: false, error: "invalid" };
  const grant = await grantFor(session);
  if (!grant) return { ok: false, error: "reauth" };
  if (!allowAttempt(session.sub)) return { ok: false, error: "rate_limited" };
  try {
    const result = await setOtp(grant.accessToken, { password, code, otpUrl: null });
    if (!result.ok) return result;
  } catch (e) {
    return stalwartFailure(e, "disable TOTP");
  }
  resetAttempts(session.sub);
  recordStatus(session.sub, session.email, false);
  revalidatePath("/settings/security");
  return { ok: true };
}

/* ---------------------------------------------------------------- app passwords */

const APP_PASSWORD_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** Creates an app password for a mail client; the secret is returned once. Needs a fresh sign-in. */
export async function createAppPasswordAction(name: unknown): Promise<Result<{ secret: string }>> {
  const session = await getSession();
  if (!session) return { ok: false, error: "signed_out" };
  const description = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) : "";
  if (!description) return { ok: false, error: "invalid" };
  const grant = await grantFor(session, true);
  if (!grant) return { ok: false, error: "reauth" };
  try {
    const result = await createAppPassword(grant.accessToken, description);
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath("/settings/security");
    return { ok: true, secret: result.secret };
  } catch (e) {
    return stalwartFailure(e, "create app password");
  }
}

export async function deleteAppPasswordAction(id: unknown): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "signed_out" };
  if (typeof id !== "string" || !APP_PASSWORD_ID.test(id)) return { ok: false, error: "invalid" };
  const grant = await grantFor(session, true);
  if (!grant) return { ok: false, error: "reauth" };
  try {
    if (!(await destroyAppPassword(grant.accessToken, id))) return { ok: false, error: "failed" };
    revalidatePath("/settings/security");
    return { ok: true };
  } catch (e) {
    return stalwartFailure(e, "delete app password");
  }
}

/* --------------------------------------------------------------- workspace policy */

async function requireAdmin(): Promise<Session | null> {
  const session = await getSession();
  return session && isAdmin(session.email) ? session : null;
}

export async function setRequire2faAction(input: { required: unknown; graceDays: unknown }): Promise<Result> {
  const admin = await requireAdmin();
  if (!admin) return { ok: false, error: "forbidden" };
  const graceDays = Number(input.graceDays);
  if (typeof input.required !== "boolean" || !(GRACE_DAYS as readonly number[]).includes(graceDays)) return { ok: false, error: "invalid" };
  setRequire2fa(input.required, graceDays, admin.email);
  console.info(`[security] 2FA policy set to ${input.required ? `required (grace ${graceDays}d)` : "optional"} by ${admin.email}`);
  revalidatePath("/settings/security");
  return { ok: true };
}

/** `hours`: 0 = no limit, else 1 hour to 365 days. */
export async function setSessionLifetimeAction(hours: unknown): Promise<Result> {
  const admin = await requireAdmin();
  if (!admin) return { ok: false, error: "forbidden" };
  const h = Number(hours);
  if (!Number.isInteger(h) || h < 0 || h * HOUR_MS > SESSION_MAX_LIMIT_MS) return { ok: false, error: "invalid" };
  setSessionMax(h * HOUR_MS, admin.email);
  console.info(`[security] session lifetime set to ${h ? `${h}h` : "no limit"} by ${admin.email}`);
  revalidatePath("/settings/security");
  return { ok: true };
}
