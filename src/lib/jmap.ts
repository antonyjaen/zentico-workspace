// Server-side JMAP client (RFC 8620/8621) talking to Stalwart with the user's OAuth token.
import { cache } from "react";
import { requireSession } from "./auth";
import { env } from "./env";

export const CAP = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
  calendars: "urn:ietf:params:jmap:calendars",
  contacts: "urn:ietf:params:jmap:contacts",
} as const;

type JmapSession = {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
  username: string;
};

export type Invocation = [name: string, args: Record<string, unknown>, callId: string];

export class JmapError extends Error {}

// React's cache() only memoizes inside a server render; outside one (route handlers such as the
// MCP endpoint) every jmap() call would refetch the session. Keep it per access token briefly.
const SESSION_TTL_MS = 60_000;
const sessions = new Map<string, { at: number; value: Promise<JmapSession> }>();

function fetchJmapSession(accessToken: string): Promise<JmapSession> {
  const now = Date.now();
  const hit = sessions.get(accessToken);
  if (hit && now - hit.at < SESSION_TTL_MS) return hit.value;
  if (sessions.size > 500) for (const [k, v] of sessions) if (now - v.at >= SESSION_TTL_MS) sessions.delete(k);
  const value = fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  }).then(async (res) => {
    if (!res.ok) throw new JmapError(`JMAP session failed: ${res.status}`);
    return (await res.json()) as JmapSession;
  });
  value.catch(() => {
    if (sessions.get(accessToken)?.value === value) sessions.delete(accessToken);
  });
  sessions.set(accessToken, { at: now, value });
  return value;
}

const getJmapSession = cache(async (): Promise<JmapSession & { token: string }> => {
  const { accessToken } = await requireSession();
  return { ...(await fetchJmapSession(accessToken)), token: accessToken };
});

export async function primaryAccount(capability: string): Promise<string> {
  const session = await getJmapSession();
  const id = session.primaryAccounts[capability];
  if (!id) throw new JmapError(`No account for ${capability}`);
  return id;
}

/** Runs a batch of JMAP method calls and returns responses keyed by call id. */
export async function jmap(
  calls: Invocation[],
  using: string[] = [CAP.core, CAP.mail],
): Promise<Record<string, Record<string, unknown>>> {
  const session = await getJmapSession();
  const res = await fetch(session.apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ using, methodCalls: calls }),
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`JMAP request failed: ${res.status}`);
  const { methodResponses } = (await res.json()) as { methodResponses: Invocation[] };
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, args, id] of methodResponses) {
    if (name === "error") throw new JmapError(`JMAP ${id}: ${String(args.type)}`);
    // Implicit responses (e.g. the Email/set from onSuccessUpdateEmail) reuse the call id;
    // keep the explicit method's response.
    out[id] ??= args;
  }
  return out;
}
