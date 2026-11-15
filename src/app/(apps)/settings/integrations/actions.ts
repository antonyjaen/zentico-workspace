"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { createToken, MAX_EXPIRY_DAYS, revokeToken, TokenError } from "@/lib/mcp/tokens";

export type CreateResult = { ok: true; token: string } | { ok: false; error: "invalid_name" | "invalid_expiry" | "no_refresh" | "too_many" | "failed" };

const ID = /^[0-9a-f-]{36}$/;

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
  try {
    const { token } = await createToken(session, { name, scope, expiresInDays });
    revalidatePath("/settings/integrations");
    return { ok: true, token };
  } catch (e) {
    if (e instanceof TokenError && (e.message === "no_refresh" || e.message === "too_many" || e.message === "invalid_expiry")) {
      return { ok: false, error: e.message };
    }
    console.error("[mcp] create token failed:", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

export async function revokeTokenAction(id: unknown): Promise<{ ok: boolean }> {
  const session = await requireSession();
  if (typeof id !== "string" || !ID.test(id)) return { ok: false };
  const ok = revokeToken(id, session.sub);
  revalidatePath("/settings/integrations");
  return { ok };
}
