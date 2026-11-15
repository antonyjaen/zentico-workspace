import { AsyncLocalStorage } from "node:async_hooks";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { SESSION_COOKIE, unsealSession, type Session } from "./session";

// Explicit sessions for code running outside a browser request (e.g. the MCP endpoint, which
// authenticates with a personal access token). Kept on globalThis so every module instance
// (dev hot reload, separate bundle layers) shares one store.
const g = globalThis as typeof globalThis & { __zwAuthContext?: AsyncLocalStorage<Session> };
const context = (g.__zwAuthContext ??= new AsyncLocalStorage<Session>());

/** Runs `fn` with `session` as the signed-in user for every getSession()/requireSession() inside it. */
export function runWithSession<T>(session: Session, fn: () => T): T {
  return context.run(session, fn);
}

const cookieSession = cache(async (): Promise<Session | null> => {
  const store = await cookies();
  return unsealSession(store.get(SESSION_COOKIE)?.value);
});

/** The signed-in user's session for this request (middleware keeps it fresh). */
export async function getSession(): Promise<Session | null> {
  return context.getStore() ?? cookieSession();
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/signin");
  return session;
}
