"use server";

import { randomBytes, randomUUID } from "node:crypto";
import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requireSession } from "@/lib/auth";
import { unseal } from "@/lib/crypto";
import {
  countTypes,
  deleteType,
  handleTaken,
  hostByHandle,
  hostBySub,
  saveType,
  setTypeActive,
  upsertHost,
} from "@/lib/booking/db";
import { createHostKey, destroySealedKey, HostKeyError, removeHostKey } from "@/lib/booking/host";
import { HANDLE, parseSettings, RESERVED_HANDLES, SettingsError, slugify, type BookingType } from "@/lib/booking/types";
import { revokeGrant } from "@/lib/oidc";
import { MCP_SETUP_COOKIE, type McpSetup } from "@/lib/session";

const PATH = "/calendar/booking";
const ID = /^[0-9a-f-]{36}$/;
const MAX_TYPES = 30;

/** A free handle derived from the user's name (never from the e-mail address). */
function freeHandle(name: string, sub: string): string {
  const base = slugify(name, 28) || `u-${randomBytes(4).toString("hex")}`;
  const root = base.length < 3 ? `${base}-zw` : base;
  for (let i = 0; i < 50; i++) {
    const h = i === 0 ? root : `${root}-${i + 1}`;
    if (HANDLE.test(h) && !RESERVED_HANDLES.has(h) && !handleTaken(h, sub)) return h;
  }
  return `u-${randomBytes(6).toString("hex")}`;
}

export type EnableResult = { ok: true } | { ok: false; error: "authorize" | "not_allowed" | "key_quota" | "failed" };

/**
 * Turns booking pages on: creates the owner's booking API key. Authenticated with the one-off MCP
 * setup authorization when the user just completed it (/api/auth/login?mcp=1&returnTo=/calendar/booking),
 * else the session's own token, which works only if it carries Stalwart's "security" scope;
 * `authorize` tells the client to go through the setup authorization and come back.
 */
export async function enableBookingAction(): Promise<EnableResult> {
  const session = await requireSession();
  const locale = (await getLocale()) === "en" ? "en" : "es";
  const existing = hostBySub(session.sub);
  upsertHost({
    sub: session.sub,
    email: session.email,
    name: session.name || session.email,
    handle: existing?.handle ?? freeHandle(session.name, session.sub),
    showEmail: existing?.showEmail ?? false,
    locale,
  });

  const jar = await cookies();
  const setup = await unseal<McpSetup>(jar.get(MCP_SETUP_COOKIE)?.value);
  const useSetup = !!setup && setup.sub === session.sub && setup.expiresAt > Date.now();
  try {
    const previous = hostBySub(session.sub)?.credentialSealed ?? "";
    await createHostKey(session.sub, useSetup ? { accessToken: setup!.accessToken, setup: true } : { accessToken: session.accessToken, setup: false });
    if (useSetup) {
      // Single use: drop the cookie and revoke that grant once the key exists.
      jar.delete(MCP_SETUP_COOKIE);
      await revokeGrant(setup!.accessToken);
    }
    // Reconnecting replaces the old key: destroy it only once the new one exists.
    if (previous) await destroySealedKey(previous);
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    if (e instanceof HostKeyError) return { ok: false, error: e.code };
    console.error("[booking] enable failed:", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

/** Turns booking pages off: destroys the key (public pages stop working); pages are kept. */
export async function disableBookingAction(): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const host = hostBySub(session.sub);
  if (host) await removeHostKey(host);
  revalidatePath(PATH);
  return { ok: true };
}

export async function saveProfileAction(input: { handle: unknown; showEmail: unknown }): Promise<{ ok: true } | { ok: false; error: "invalid_handle" | "handle_taken" }> {
  const session = await requireSession();
  const host = hostBySub(session.sub);
  if (!host) return { ok: false, error: "invalid_handle" };
  const handle = typeof input.handle === "string" ? input.handle.trim().toLowerCase() : "";
  if (!HANDLE.test(handle) || RESERVED_HANDLES.has(handle)) return { ok: false, error: "invalid_handle" };
  const other = hostByHandle(handle);
  if (other && other.sub !== session.sub) return { ok: false, error: "handle_taken" };
  upsertHost({ ...host, email: session.email, name: session.name || session.email, handle, showEmail: input.showEmail === true });
  revalidatePath(PATH);
  return { ok: true };
}

export type SaveTypeResult = { ok: true; type: BookingType } | { ok: false; error: string };

export async function saveTypeAction(id: unknown, raw: unknown): Promise<SaveTypeResult> {
  const session = await requireSession();
  if (!hostBySub(session.sub)) return { ok: false, error: "disabled" };
  if (id != null && (typeof id !== "string" || !ID.test(id))) return { ok: false, error: "invalid" };
  if (id == null && countTypes(session.sub) >= MAX_TYPES) return { ok: false, error: "too_many" };
  try {
    const settings = parseSettings(raw);
    const type = saveType(session.sub, (id as string | null) ?? null, settings, randomUUID);
    if (!type) return { ok: false, error: "slug_taken" };
    revalidatePath(PATH);
    return { ok: true, type };
  } catch (e) {
    if (e instanceof SettingsError) return { ok: false, error: `invalid_${e.field}` };
    throw e;
  }
}

export async function setTypeActiveAction(id: unknown, active: unknown): Promise<{ ok: boolean }> {
  const session = await requireSession();
  if (typeof id !== "string" || !ID.test(id)) return { ok: false };
  const ok = setTypeActive(session.sub, id, active === true);
  revalidatePath(PATH);
  return { ok };
}

export async function deleteTypeAction(id: unknown): Promise<{ ok: boolean }> {
  const session = await requireSession();
  if (typeof id !== "string" || !ID.test(id)) return { ok: false };
  const ok = deleteType(session.sub, id);
  revalidatePath(PATH);
  return { ok };
}
