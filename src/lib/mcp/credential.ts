// Dedicated Stalwart API keys behind MCP tokens. Server-only.
//
// Why not the OIDC refresh token: Stalwart issues one grant per sign-in and rotates its refresh
// token on every use; presenting a superseded refresh token ("replay") deletes the whole grant.
// A copy of the web session's refresh token therefore dies as soon as the browser and the MCP
// token refresh out of step. An API key is a separate credential of the user's account: it is
// accepted as "Authorization: Bearer API_…" on JMAP, doesn't rotate, and survives the web
// session (and password changes) until it expires or is destroyed.
import { env } from "../env";

export type StalwartKey = {
  /** The secret ("API_…"), used as a Bearer token. */
  apiKey: string;
  /** JMAP id of the x:ApiKey credential (for destroying it). */
  id: string;
  /** JMAP account id it belongs to. */
  accountId: string;
};

/**
 * - `authorize`: the token used can't manage API keys (no Stalwart "security" scope).
 * - `quota`: the account has reached Stalwart's API key limit (x:Authentication maxApiKeys).
 * - `failed`: anything else.
 */
export class CredentialError extends Error {
  constructor(readonly code: "authorize" | "quota" | "failed", detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"];

// What the key may do: authenticate plus the data permissions (JMAP mail/calendars/contacts/files,
// sending, scheduling, DAV). Nothing that manages credentials or the server — except destroying
// API keys, so revoking an MCP token can delete its own key with the key itself.
const KEEP = /^(authenticate$|jmap|email|calendar|dav)/;
const SELF_DESTROY = "sysApiKeyDestroy";

type JmapSessionInfo = { apiUrl: string; primaryAccounts: Record<string, string> };

async function jmapSession(bearer: string): Promise<JmapSessionInfo> {
  const res = await fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${bearer}` },
    cache: "no-store",
  });
  if (!res.ok) throw new CredentialError("failed", `JMAP session ${res.status}`);
  return (await res.json()) as JmapSessionInfo;
}

const accountOf = (s: JmapSessionInfo) =>
  s.primaryAccounts["urn:stalwart:jmap"] ?? s.primaryAccounts["urn:ietf:params:jmap:mail"] ?? null;

/** The effective permissions of `bearer` (Stalwart's /api/account, as used by its web admin). */
async function permissionsOf(bearer: string): Promise<string[]> {
  const res = await fetch(`${env.issuer}/api/account`, {
    headers: { Authorization: `Bearer ${bearer}` },
    cache: "no-store",
  });
  if (!res.ok) throw new CredentialError("failed", `account info ${res.status}`);
  const body = (await res.json()) as { permissions?: unknown };
  return Array.isArray(body.permissions) ? body.permissions.filter((p): p is string => typeof p === "string") : [];
}

type SetResult = {
  created?: Record<string, { id?: string; secret?: string }>;
  notCreated?: Record<string, { type?: string; description?: string }>;
  destroyed?: string[];
  notDestroyed?: Record<string, { type?: string; description?: string }>;
};

async function apiKeySet(bearer: string, apiUrl: string, args: Record<string, unknown>): Promise<SetResult> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ using: USING, methodCalls: [["x:ApiKey/set", args, "0"]] }),
    cache: "no-store",
  });
  if (!res.ok) throw new CredentialError("failed", `JMAP ${res.status}`);
  const { methodResponses } = (await res.json()) as { methodResponses?: [string, Record<string, unknown>, string][] };
  const [name, result] = methodResponses?.[0] ?? [];
  if (name === "error") {
    const type = String(result?.type ?? "");
    if (type === "forbidden" || type === "unknownMethod" || type === "accountNotFound") throw new CredentialError("authorize", type);
    throw new CredentialError("failed", type || "error");
  }
  return (result ?? {}) as SetResult;
}

/** ISO timestamp without milliseconds ("2026-11-16T10:00:00Z"). */
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Creates an API key on the user's own account, authenticated as the user with `bearer` (an OIDC
 * access token that carries Stalwart's "security" scope, or a first-party token).
 */
export async function createApiKey(bearer: string, input: { description: string; expires: number | null }): Promise<StalwartKey> {
  const [session, permissions] = await Promise.all([jmapSession(bearer), permissionsOf(bearer)]);
  const accountId = accountOf(session);
  if (!accountId) throw new CredentialError("failed", "no account");
  if (!permissions.includes("sysApiKeyCreate")) throw new CredentialError("authorize", "sysApiKeyCreate missing");

  const granted = Object.fromEntries(
    permissions.filter((p) => KEEP.test(p) || p === SELF_DESTROY).map((p) => [p, true] as const),
  );
  const create: Record<string, unknown> = {
    description: input.description.slice(0, 100),
    permissions: { "@type": "Replace", permissions: granted },
  };
  if (input.expires != null) create.expiresAt = utc(input.expires);

  const result = await apiKeySet(bearer, session.apiUrl, { accountId, create: { k: create } });
  const made = result.created?.k;
  if (made?.id && made.secret?.startsWith("API_")) return { apiKey: made.secret, id: String(made.id), accountId };

  const err = result.notCreated?.k;
  if (err?.type === "overQuota") throw new CredentialError("quota", err.description);
  if (err?.type === "forbidden") throw new CredentialError("authorize", err.description);
  throw new CredentialError("failed", err ? `${err.type}: ${err.description ?? ""}` : "no result");
}

/** Destroys the key, authenticating with the key itself. Best effort: never throws. */
export async function destroyApiKey(key: StalwartKey): Promise<boolean> {
  try {
    const session = await jmapSession(key.apiKey);
    const result = await apiKeySet(key.apiKey, session.apiUrl, { accountId: key.accountId, destroy: [key.id] });
    if (result.destroyed?.includes(key.id)) return true;
    console.warn("[mcp] API key not destroyed:", JSON.stringify(result.notDestroyed ?? {}).slice(0, 200));
  } catch (e) {
    console.warn("[mcp] destroying API key failed:", e instanceof Error ? e.message : e);
  }
  return false;
}

/** True when Stalwart still accepts the key; false when it is rejected (deleted, expired). Throws on other failures. */
export async function apiKeyWorks(apiKey: string): Promise<boolean> {
  const res = await fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) throw new Error(`JMAP session failed: ${res.status}`);
  return true;
}
