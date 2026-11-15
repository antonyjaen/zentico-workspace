// The signed-in Chat user: the OIDC session upserted into the users table. Server-only.
import { getSession, requireSession } from "../auth";
import type { Session } from "../session";
import type { ChatUser } from "@/app/(apps)/chat/shared";
import { upsertUser } from "./store";

// Avoid a write on every request: re-upsert at most once a minute per session identity.
const g = globalThis as typeof globalThis & { __zwChatUsers?: Map<string, { user: ChatUser; at: number }> };
const recent = (g.__zwChatUsers ??= new Map());

function fromSession(s: Session): ChatUser {
  const key = `${s.sub}\n${s.email}\n${s.name}`;
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.user;
  const user = upsertUser({ sub: s.sub, email: s.email, name: s.name });
  if (recent.size > 5000) recent.clear();
  recent.set(key, { user, at: Date.now() });
  return user;
}

/** For server components and actions (redirects to sign-in without a session). */
export async function chatUser(): Promise<ChatUser> {
  return fromSession(await requireSession());
}

/** For route handlers (null → respond 401). */
export async function chatUserOrNull(): Promise<ChatUser | null> {
  const s = await getSession();
  return s ? fromSession(s) : null;
}
