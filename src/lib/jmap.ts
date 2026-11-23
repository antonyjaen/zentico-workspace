// Server-side JMAP client (RFC 8620/8621) talking to Stalwart with the user's OAuth token.
import { cache } from "react";
import {
  actingAccountId,
  cookieAccounts,
  listAccounts,
  requireSession,
  usableSlotSessions,
  type AccountSummary,
} from "./auth";
import { actAs, delegatedAccounts, findDelegated, type DelegatedAccount, type RawJmapSession } from "./delegation";
import { env } from "./env";
import { needsRefresh } from "./session";

export const CAP = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
  calendars: "urn:ietf:params:jmap:calendars",
  contacts: "urn:ietf:params:jmap:contacts",
} as const;

type JmapSession = RawJmapSession & {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
  username: string;
};

export type Invocation = [name: string, args: Record<string, unknown>, callId: string];

export class JmapError extends Error {}

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,255}$/;

// React's cache() only memoizes inside a server render; outside one (route handlers such as the
// MCP endpoint) every jmap() call would refetch the session. Keep it per access token briefly.
const SESSION_TTL_MS = 60_000;
const sessions = new Map<string, { at: number; value: Promise<JmapSession> }>();

/** The raw JMAP session resource for a token (briefly cached per token). */
export function fetchJmapSession(accessToken: string): Promise<JmapSession> {
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

// Keyed by the token too, so one request can never be served another account's session.
// The acting account is part of the key so asMaster() inside the same request gets the master's view.
const jmapSessionFor = cache(
  async (token: string, acting: string | null): Promise<JmapSession & { token: string }> => ({
    ...actAs(await fetchJmapSession(token), acting),
    token,
  }),
);

const getJmapSession = async () => {
  const [{ accessToken }, acting] = await Promise.all([requireSession(), actingAccountId()]);
  return jmapSessionFor(accessToken, acting);
};

/** A signed-in slot with a live token and its JMAP session (the active one as acted, if acting). */
type SlotJmap = { slot: number; email: string; name: string; active: boolean; token: string; jmap: JmapSession };

/**
 * The active session plus every other usable signed-in slot of this browser (MRU order), each with
 * its JMAP session. Only the request's own cookies are read; inside runWithSession (MCP) it is
 * just the explicit session. Slots whose JMAP session can't be read are left out.
 */
const slotSessions = async () => {
  const [{ accessToken }, acting] = await Promise.all([requireSession(), actingAccountId()]);
  return slotSessionsFor(accessToken, acting);
};

// Keyed like jmapSessionFor: the active token and acting account.
const slotSessionsFor = cache(async (token: string, actingId: string | null): Promise<SlotJmap[]> => {
  const [me, active, slots] = await Promise.all([requireSession(), jmapSessionFor(token, actingId), usableSlotSessions()]);
  const acting = findDelegated(active, actingId);
  const activeSlot = slots.find((s) => s.session.accessToken === token)?.slot;
  const others = await Promise.all(
    slots
      .filter((s) => s.session.accessToken !== token)
      .map(async ({ slot, session }): Promise<SlotJmap | null> => {
        const jmap = await fetchJmapSession(session.accessToken).catch(() => null);
        return jmap && { slot, email: session.email, name: session.name, active: false, token: session.accessToken, jmap };
      }),
  );
  return [
    // -1: the active token isn't one of this browser's usable cookie slots (MCP, or refreshing).
    { slot: activeSlot ?? -1, email: acting?.email ?? me.email, name: me.name, active: true, token: active.token, jmap: active },
    ...others.filter((s): s is SlotJmap => !!s),
  ];
});

/** Every usable signed-in slot with its JMAP session, active first (for lib/mail account lists). */
export async function signedInJmapSessions(): Promise<
  { slot: number; email: string; name: string; active: boolean; session: RawJmapSession }[]
> {
  return (await slotSessions()).map(({ slot, email, name, active, jmap }) => ({ slot, email, name, active, session: jmap }));
}

/**
 * The signed-in slot an account belongs to: the one whose personal account it is, else the first
 * (active, then most recently used) whose JMAP session lists it; null when none reaches it.
 */
export async function sessionForAccount(accountId: string): Promise<{ slot: number; email: string; name: string } | null> {
  const pick = await slotForAccount(accountId);
  return pick ? { slot: pick.slot, email: pick.email, name: pick.name } : null;
}

async function slotForAccount(accountId: string): Promise<SlotJmap | null> {
  if (!ACCOUNT_ID.test(accountId)) return null;
  const all = await slotSessions();
  return all.find((s) => s.jmap.accounts?.[accountId]?.isPersonal === true) ?? all.find((s) => s.jmap.accounts?.[accountId]) ?? null;
}

/** Token + JMAP session of the slot sessionForAccount() picks (never re-read from a cookie by number). */
export async function tokenForAccount(
  accountId: string,
): Promise<{ token: string; session: RawJmapSession & { uploadUrl?: string; downloadUrl?: string } } | null> {
  const pick = await slotForAccount(accountId);
  return pick ? { token: pick.token, session: pick.jmap } : null;
}

/** Account ids a batch touches, and whether each call needs submission (owner-only in Stalwart). */
function accountsIn(calls: Invocation[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [name, args] of calls) {
    const submission = name.startsWith("EmailSubmission/") || name.startsWith("Identity/");
    for (const key of ["accountId", "fromAccountId"]) {
      const id = args[key];
      if (typeof id === "string") out.set(id, (out.get(id) ?? false) || submission);
    }
  }
  return out;
}

/** True when this JMAP session lists every account (with submission where the call needs it). */
function reaches(s: RawJmapSession, ids: Map<string, boolean>, needSubmission = true): boolean {
  for (const [id, submission] of ids) {
    const account = s.accounts?.[id];
    if (!account || (needSubmission && submission && account.accountCapabilities?.[CAP.submission] === undefined)) return false;
  }
  return true;
}

/** The delegated account this request acts as, verified against the JMAP session; else null. */
export async function actingAccount(): Promise<DelegatedAccount | null> {
  const acting = await actingAccountId();
  if (!acting) return null;
  const { accessToken } = await requireSession();
  return findDelegated(await fetchJmapSession(accessToken), acting);
}

/** Who mail/calendar act for: the delegated account's address while acting, else the user's. */
export async function selfIdentity(): Promise<{ email: string; name: string }> {
  const [session, acting] = await Promise.all([requireSession(), actingAccount()]);
  return { email: acting?.email ?? session.email, name: session.name };
}

/**
 * Signed-in accounts plus, under each, the delegated accounts its sign-in reaches (for the account
 * switcher). Only slots with a live access token are asked (others are refreshed on switch).
 */
export async function listAccountsWithDelegated(): Promise<AccountSummary[]> {
  const [base, { sessions }, acting] = await Promise.all([listAccounts(), cookieAccounts(), actingAccountId()]);
  const signedIn = new Set(base.map((a) => a.email.toLowerCase()));
  const groups = await Promise.all(
    base.map(async (a): Promise<AccountSummary[]> => {
      const s = sessions[a.slot];
      const delegated =
        s && !a.expired && !needsRefresh(s)
          ? delegatedAccounts(await fetchJmapSession(s.accessToken).catch(() => ({}) as RawJmapSession))
          : [];
      const current = a.active ? delegated.find((d) => d.id === acting) : undefined;
      return [
        { ...a, active: a.active && !current },
        ...delegated
          .filter((d) => d === current || !signedIn.has(d.email))
          .map((d) => ({ slot: a.slot, email: d.email, name: a.name, active: d === current, expired: false, account: d.id, via: a.email })),
      ];
    }),
  );
  return groups.flat().sort((x, y) => Number(y.active) - Number(x.active));
}

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
  // The active account (as today) when it reaches every account in the batch; otherwise another
  // signed-in slot of this browser whose own JMAP session lists them all. A client-supplied id can
  // never pick a token whose session doesn't list it.
  const active = await getJmapSession();
  let session: { apiUrl: string; token: string } = active;
  const ids = accountsIn(calls);
  if (!reaches(active, ids)) {
    const other = (await slotSessions()).find((s) => !s.active && reaches(s.jmap, ids));
    if (other) session = { apiUrl: other.jmap.apiUrl, token: other.token };
    // Listed but without submission and no slot owns it: let the server answer, as before.
    else if (!reaches(active, ids, false)) throw new JmapError("No signed-in account can reach this JMAP account");
  }
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
