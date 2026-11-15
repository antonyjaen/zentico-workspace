import { AsyncLocalStorage } from "node:async_hooks";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import {
  isSignedOut,
  LEGACY_SESSION_COOKIE,
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

const cookieAccounts = cache(async () => readAccounts(await cookies()));

const cookieSession = cache(async (): Promise<Session | null> => {
  const { sessions, order } = await cookieAccounts();
  const active = order.length ? sessions[order[0]] : null;
  if (active) return isSignedOut(active) ? null : active;
  // Not migrated yet (routes the middleware skips): fall back to the legacy single-account cookie.
  const legacy = await unsealSession((await cookies()).get(LEGACY_SESSION_COOKIE)?.value);
  return legacy && !isSignedOut(legacy) ? legacy : null;
});

/** The active account's session for this request (middleware keeps it fresh). */
export async function getSession(): Promise<Session | null> {
  return context.getStore() ?? cookieSession();
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/signin");
  return session;
}

/** Safe-to-render summary of a signed-in account (never includes tokens). */
export type AccountSummary = {
  slot: number;
  email: string;
  name: string;
  active: boolean;
  /** Needs a fresh sign-in before it can be used. */
  expired: boolean;
};

/** Every account signed in on this browser, active first, then most recently used. */
export async function listAccounts(): Promise<AccountSummary[]> {
  const { sessions, order } = await cookieAccounts();
  return order.map((slot, i) => {
    const s = sessions[slot]!;
    return { slot, email: s.email, name: s.name, active: i === 0, expired: isSignedOut(s) };
  });
}
