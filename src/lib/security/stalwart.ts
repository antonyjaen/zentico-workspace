// The user's own Stalwart credentials over JMAP (urn:stalwart:jmap): TOTP on the password
// credential (x:AccountPassword, a singleton) and app passwords (x:AppPassword). Server-only.
// Every call authenticates as the user with a short-lived grant carrying Stalwart's "security"
// scope (the only scope that maps to sysAccountPassword* / sysAppPassword*).
import { accountOf, jmapSession } from "../mcp/credential";

const USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"];

type Invocation = [string, Record<string, unknown>, string];
type SetError = { type?: string; description?: string };

export class StalwartError extends Error {
  constructor(readonly code: "authorize" | "rate_limited" | "failed", detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

async function call(bearer: string, method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = await jmapSession(bearer).catch(() => {
    throw new StalwartError("authorize", "session");
  });
  const accountId = accountOf(session);
  if (!accountId) throw new StalwartError("failed", "no account");
  const res = await fetch(session.apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ using: USING, methodCalls: [[method, { accountId, ...args }, "0"]] }),
    cache: "no-store",
  });
  if (res.status === 401) throw new StalwartError("authorize", "401");
  // Stalwart answers a fail2ban'd credential change with a request-level error.
  if (res.status === 403 || res.status === 429) throw new StalwartError("rate_limited", String(res.status));
  if (!res.ok) throw new StalwartError("failed", `JMAP ${res.status}`);
  const { methodResponses } = (await res.json()) as { methodResponses?: Invocation[] };
  const [name, result] = methodResponses?.[0] ?? [];
  if (name === "error") {
    const type = String(result?.type ?? "");
    if (type === "forbidden" || type === "unknownMethod" || type === "accountNotFound") throw new StalwartError("authorize", type);
    throw new StalwartError("failed", type || "error");
  }
  return result ?? {};
}

/** Whether TOTP is set on the user's password credential (otpAuth.otpUrl is null when off). */
export async function otpEnabled(bearer: string): Promise<boolean> {
  const result = await call(bearer, "x:AccountPassword/get", { ids: ["singleton"], properties: ["otpAuth"] });
  const list = Array.isArray(result.list) ? (result.list as Record<string, unknown>[]) : [];
  if (!list.length) throw new StalwartError("failed", "no password credential");
  const otp = list[0].otpAuth as { otpUrl?: unknown } | null | undefined;
  return typeof otp?.otpUrl === "string" && otp.otpUrl.length > 0;
}

export type OtpChangeError = "wrong_credentials" | "not_supported" | "rate_limited" | "authorize" | "failed";

/**
 * Turns TOTP on (`otpUrl`) or off (null). Stalwart requires the account password (`currentSecret`)
 * for either, plus a current code when TOTP is already on; it verifies both itself.
 */
export async function setOtp(
  bearer: string,
  input: { password: string; code?: string; otpUrl: string | null },
): Promise<{ ok: true } | { ok: false; error: OtpChangeError }> {
  let result: Record<string, unknown>;
  try {
    result = await call(bearer, "x:AccountPassword/set", {
      update: { singleton: { currentSecret: input.password, otpAuth: { otpUrl: input.otpUrl, otpCode: input.code ?? null } } },
    });
  } catch (e) {
    if (e instanceof StalwartError && (e.code === "authorize" || e.code === "rate_limited")) return { ok: false, error: e.code };
    throw e;
  }
  const updated = result.updated as Record<string, unknown> | null | undefined;
  if (updated && "singleton" in updated) return { ok: true };
  const err = (result.notUpdated as Record<string, SetError> | undefined)?.singleton;
  const description = err?.description ?? "";
  if (/incorrect|OTP code is required/i.test(description)) return { ok: false, error: "wrong_credentials" };
  if (/not allowed|doesn't have one|does not support/i.test(description)) return { ok: false, error: "not_supported" };
  console.warn("[security] AccountPassword/set refused:", err?.type ?? "unknown");
  return { ok: false, error: "failed" };
}

export type AppPassword = { id: string; description: string; createdAt: string | null; expiresAt: string | null };

export async function listAppPasswords(bearer: string): Promise<AppPassword[]> {
  const result = await call(bearer, "x:AppPassword/get", { ids: null, properties: ["description", "createdAt", "expiresAt"] });
  const list = Array.isArray(result.list) ? (result.list as Record<string, unknown>[]) : [];
  return list.map((p) => ({
    id: String(p.id),
    description: typeof p.description === "string" ? p.description : "",
    createdAt: typeof p.createdAt === "string" ? p.createdAt : null,
    expiresAt: typeof p.expiresAt === "string" ? p.expiresAt : null,
  }));
}

/** Creates an app password; its secret is only ever returned here. */
export async function createAppPassword(
  bearer: string,
  description: string,
): Promise<{ ok: true; id: string; secret: string } | { ok: false; error: "quota" | "failed" }> {
  const result = await call(bearer, "x:AppPassword/set", {
    create: { k: { description, permissions: { "@type": "Inherit" } } },
  });
  const made = (result.created as Record<string, { id?: unknown; secret?: unknown }> | undefined)?.k;
  if (made?.id != null && typeof made.secret === "string") return { ok: true, id: String(made.id), secret: made.secret };
  const err = (result.notCreated as Record<string, SetError> | undefined)?.k;
  if (err?.type === "overQuota") return { ok: false, error: "quota" };
  console.warn("[security] AppPassword create refused:", err?.type ?? "unknown");
  return { ok: false, error: "failed" };
}

export async function destroyAppPassword(bearer: string, id: string): Promise<boolean> {
  const result = await call(bearer, "x:AppPassword/set", { destroy: [id] });
  return Array.isArray(result.destroyed) && result.destroyed.map(String).includes(id);
}
