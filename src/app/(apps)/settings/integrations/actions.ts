"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requireSession } from "@/lib/auth";
import { unseal } from "@/lib/crypto";
import { createToken, type KeyAuth, MAX_EXPIRY_DAYS, reauthorizeToken, revokeToken, TokenError } from "@/lib/mcp/tokens";
import { revokeGrant } from "@/lib/oidc";
import { MCP_SETUP_COOKIE, type McpSetup, type Session } from "@/lib/session";

type KeyError = "authorize" | "not_allowed" | "key_quota";
export type CreateResult =
  | { ok: true; token: string }
  | { ok: false; error: "invalid_name" | "invalid_expiry" | "too_many" | KeyError | "failed" };
export type ReauthorizeResult = { ok: boolean; error?: KeyError | "failed" };

const ID = /^[0-9a-f-]{36}$/;
const KEY_ERRORS: readonly string[] = ["authorize", "not_allowed", "key_quota"];

/**
 * How to authenticate creating the token's Stalwart API key: the MCP setup authorization when the
 * user just completed it (/api/auth/login?mcp=1), otherwise the web session's own access token —
 * which only works when it carries Stalwart's "security" scope (else the client is sent through
 * the setup authorization and retries).
 */
async function keyAuth(session: Session): Promise<{ auth: KeyAuth; done: () => Promise<void> }> {
  const jar = await cookies();
  const setup = await unseal<McpSetup>(jar.get(MCP_SETUP_COOKIE)?.value);
  if (setup && setup.sub === session.sub && setup.expiresAt > Date.now()) {
    return {
      auth: { accessToken: setup.accessToken, setup: true },
      // Single use: drop the cookie and revoke that grant once the key exists.
      done: async () => {
        jar.delete(MCP_SETUP_COOKIE);
        await revokeGrant(setup.accessToken);
      },
    };
  }
  return { auth: { accessToken: session.accessToken, setup: false }, done: async () => undefined };
}

export async function createTokenAction(input: { name: unknown; scope: unknown; expiresInDays: unknown }): Promise<CreateResult> {
  const session = await requireSession();
  const name = typeof input.name === "string" ? input.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
  if (!name) return { ok: false, error: "invalid_name" };
  const scope = input.scope === "write" ? "write" : "read";
  let expiresInDays: number | null = null;
  if (input.expiresInDays != null && input.expiresInDays !== "" && input.expiresInDays !== 0) {
    const n = Number(input.expiresInDays);
    if (!Number.isInteger(n) || n < 1 || n > MAX_EXPIRY_DAYS) return { ok: false, error: "invalid_expiry" };
    expiresInDays = n;
  }
  const { auth, done } = await keyAuth(session);
  try {
    const { token } = await createToken(session, { name, scope, expiresInDays }, auth);
    await done();
    revalidatePath("/settings/integrations");
    return { ok: true, token };
  } catch (e) {
    if (e instanceof TokenError && (e.message === "too_many" || e.message === "invalid_expiry" || KEY_ERRORS.includes(e.message))) {
      return { ok: false, error: e.message as "too_many" | "invalid_expiry" | KeyError };
    }
    console.error("[mcp] create token failed:", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

export async function revokeTokenAction(id: unknown): Promise<{ ok: boolean }> {
  const session = await requireSession();
  if (typeof id !== "string" || !ID.test(id)) return { ok: false };
  const ok = await revokeToken(id, session.sub);
  revalidatePath("/settings/integrations");
  return { ok };
}

/** Moves a token onto a fresh Stalwart API key (also migrates tokens still on a refresh token). */
export async function reauthorizeTokenAction(id: unknown): Promise<ReauthorizeResult> {
  const session = await requireSession();
  if (typeof id !== "string" || !ID.test(id)) return { ok: false };
  const { auth, done } = await keyAuth(session);
  try {
    const ok = await reauthorizeToken(id, session.sub, auth);
    if (ok) await done();
    revalidatePath("/settings/integrations");
    return { ok };
  } catch (e) {
    if (e instanceof TokenError && KEY_ERRORS.includes(e.message)) return { ok: false, error: e.message as KeyError };
    console.error("[mcp] reauthorize failed:", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}
