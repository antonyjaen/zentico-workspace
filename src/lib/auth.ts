import { AsyncLocalStorage } from "node:async_hooks";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { exceedsLifetime, isGated } from "./security/store";
import {
  ACTING_COOKIE,
  isSignedOut,
  LEGACY_SESSION_COOKIE,
  needsRefresh,
  parseActing,
  readAccounts,
  unsealSession,
  type Session,
} from "./session";

// Explicit sessions for code running outside a browser request (e.g. the MCP endpoint, which
// authenticates with a personal access token). Kept on globalThis so every module instance
// (dev hot reload, separate bundle layers) shares one store.
const g = globalThis as typeof globalThis & { __zwAuthContext?: AsyncLocalStorage<Session> };
const context = (g.__zwAuthContext ??= new AsyncLocalStorage<Session>());

/** Runs `fn` with `session` as the signed-in user for every getSession()/requireSession() inside it. */
export function runWithSession<T>(session: Session, fn: () => T): T {
  return context.run(session, fn);
}

/** Every account cookie of this browser (sealed sessions per slot), memoized per request. */
export const cookieAccounts = cache(async () => readAccounts(await cookies()));

// Code that must use the person's own (master) account even while the browser acts as a delegated
// one: chat, meetings. Same globalThis pattern as the session context above.
const gm = globalThis as typeof globalThis & { __zwMasterOnly?: AsyncLocalStorage<true> };
const masterOnly = (gm.__zwMasterOnly ??= new AsyncLocalStorage<true>());

/** Runs `fn` ignoring the acting (delegated) account: JMAP calls inside use the master account. */
export function asMaster<T>(fn: () => T): T {
  return masterOnly.run(true, fn);
}

/**
 * The delegated JMAP account id the active browser account acts as (unverified: callers check it
 * against the JMAP session with lib/delegation). Never set for explicit sessions (MCP tokens).
 */
export async function actingAccountId(): Promise<string | null> {
  if (context.getStore() || masterOnly.getStore()) return null;
  const { order } = await cookieAccounts();
  return parseActing((await cookies()).get(ACTING_COOKIE)?.value, order[0]);
}

/**
 * Signed out for the workspace: a failed refresh, or older than the admin's session lifetime
 * (measured from sign-in). The Edge middleware can't read the policy, so it is applied here, where
 * every page, server action and API reads its session; the middleware keeps refreshing tokens only.
 */
export const isExpired = (s: Session) => isSignedOut(s) || exceedsLifetime(s.signedInAt);

const cookieSession = cache(async (): Promise<Session | null> => {
  const { sessions, order } = await cookieAccounts();
  const active = order.length ? sessions[order[0]] : null;
  if (active) return isExpired(active) ? null : active;
  // Not migrated yet (routes the middleware skips): fall back to the legacy single-account cookie.
  const legacy = await unsealSession((await cookies()).get(LEGACY_SESSION_COOKIE)?.value);
  return legacy && !isExpired(legacy) ? legacy : null;
});

// A browser session whose user must still set up two-step verification (workspace policy) is
// treated as signed out by every page, server action and API; only the setup flow sees it.
const gatedCookieSession = cache(async (): Promise<Session | null> => {
  const session = await cookieSession();
  return session && isGated(session.sub) ? null : session;
});

/** The active account's session for this request (middleware keeps it fresh). */
export async function getSession(): Promise<Session | null> {
  return context.getStore() ?? gatedCookieSession();
}

/**
 * The active account even while it is held back by the two-step verification policy. Only for the
 * auth routes and the Security setup flow (/signin/security, Settings → Security).
 */
export async function getSessionForSetup(): Promise<Session | null> {
  return context.getStore() ?? cookieSession();
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (session) return session;
  if (await cookieSession()) redirect("/signin/security");
  // Expired by the session lifetime: sign that account in again (the hint forces a fresh login
  // instead of reusing the provider's single sign-on session).
  const { sessions, order } = await cookieAccounts();
  const active = order.length ? sessions[order[0]] : null;
  redirect(active?.email ? `/signin?hint=${encodeURIComponent(active.email)}` : "/signin");
}

/**
 * Every signed-in slot of this browser usable for data right now (fresh access token, not signed
 * out, past the lifetime or held back by the 2FA policy), most recently used first. Empty inside
 * runWithSession (MCP): an explicit session never borrows browser cookies.
 */
export async function usableSlotSessions(): Promise<{ slot: number; session: Session }[]> {
  if (context.getStore()) return [];
  const { sessions, order } = await cookieAccounts();
  return order.flatMap((slot) => {
    const s = sessions[slot];
    return s && !isExpired(s) && !isGated(s.sub) && !needsRefresh(s) ? [{ slot, session: s }] : [];
  });
}

/** Safe-to-render summary of a signed-in account (never includes tokens). */
export type AccountSummary = {
  slot: number;
  email: string;
  name: string;
  active: boolean;
  /** Needs a fresh sign-in before it can be used. */
  expired: boolean;
  /** Delegated account reached through the slot's sign-in (JMAP account id); absent for the slot's own. */
  account?: string;
  /** Email of the signed-in (master) account a delegated entry goes through. */
  via?: string;
};

/** Every account signed in on this browser, active first, then most recently used. */
export async function listAccounts(): Promise<AccountSummary[]> {
  const { sessions, order } = await cookieAccounts();
  return order.map((slot, i) => {
    const s = sessions[slot]!;
    return { slot, email: s.email, name: s.name, active: i === 0, expired: isExpired(s) };
  });
}
