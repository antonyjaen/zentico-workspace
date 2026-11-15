import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { SESSION_COOKIE, unsealSession, type Session } from "./session";

/** The signed-in user's session for this request (middleware keeps it fresh). */
export const getSession = cache(async (): Promise<Session | null> => {
  const store = await cookies();
  return unsealSession(store.get(SESSION_COOKIE)?.value);
});

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/signin");
  return session;
}
