// Acting for a booking-page owner without their browser: the public pages read free/busy and
// write events with a dedicated Stalwart API key on the owner's account. Server-only.
//
// Same reasoning as MCP tokens (lib/mcp/credential.ts): never a copy of the browser session's
// refresh token (Stalwart rotates it and revokes the whole grant when a superseded one is
// replayed). The key is created once, when the owner enables booking pages, from an access token
// that carries Stalwart's "security" scope (the one-off MCP setup authorization). It only keeps
// mail/calendar/scheduling permissions: contacts, files, sieve and DAV are dropped.
import { runWithSession } from "../auth";
import { seal, unseal } from "../crypto";
import { apiKeyWorks, createApiKey, CredentialError, destroyApiKey, type StalwartKey } from "../mcp/credential";
import type { Session } from "../session";
import { markHostNeedsReauth, setHostCredential, type Host } from "./db";

/** Permissions a booking key never needs (on top of credential.ts's own allow-list). */
const EXCLUDE = /^(dav|jmap(AddressBook|ContactCard|FileNode|Sieve|VacationResponse|Quota|PushSubscription|Principal(Set|Destroy))|sieve)/i;

export class HostKeyError extends Error {
  constructor(readonly code: "authorize" | "not_allowed" | "key_quota" | "failed") {
    super(code);
  }
}

/** Creates the owner's booking API key with `accessToken` (setup = the MCP setup authorization). */
export async function createHostKey(sub: string, auth: { accessToken: string; setup: boolean }): Promise<void> {
  let key: StalwartKey;
  try {
    key = await createApiKey(auth.accessToken, { description: "Zentico booking pages", expires: null, exclude: EXCLUDE });
  } catch (e) {
    if (e instanceof CredentialError) {
      if (e.code === "authorize") throw new HostKeyError(auth.setup ? "not_allowed" : "authorize");
      if (e.code === "quota") throw new HostKeyError("key_quota");
    }
    console.error("[booking] creating API key failed:", e instanceof Error ? e.message : e);
    throw new HostKeyError("failed");
  }
  setHostCredential(sub, await seal(key));
  cache.delete(sub);
}

/** Destroys a sealed key that is no longer used (best effort). */
export async function destroySealedKey(sealed: string): Promise<void> {
  const key = await unseal<StalwartKey>(sealed || undefined);
  if (key) await destroyApiKey(key);
}

/** Destroys the owner's key (best effort) and forgets it: public pages stop taking bookings. */
export async function removeHostKey(host: Host): Promise<void> {
  const key = await unseal<StalwartKey>(host.credentialSealed || undefined);
  setHostCredential(host.sub, "");
  cache.delete(host.sub);
  if (key) await destroyApiKey(key);
}

type Cached = { session: Session; until: number };
const g = globalThis as typeof globalThis & { __zwBookingKeys?: Map<string, Cached> };
const cache = (g.__zwBookingKeys ??= new Map());
const RECHECK_MS = 10 * 60_000;

/** The owner's offline session, or null when booking pages aren't usable (disabled / key revoked). */
export async function hostSession(host: Host): Promise<Session | null> {
  if (!host.credentialSealed || host.needsReauth) return null;
  const hit = cache.get(host.sub);
  if (hit && hit.until > Date.now()) return hit.session;
  const key = await unseal<StalwartKey>(host.credentialSealed);
  if (!key) return null;
  if (!(await apiKeyWorks(key.apiKey))) {
    markHostNeedsReauth(host.sub);
    cache.delete(host.sub);
    return null;
  }
  const session: Session = { sub: host.sub, email: host.email, name: host.name || host.email, accessToken: key.apiKey, expiresAt: Date.now() + RECHECK_MS };
  if (cache.size > 2000) cache.clear();
  cache.set(host.sub, { session, until: Date.now() + RECHECK_MS });
  return session;
}

export class HostUnavailable extends Error {}

/** Runs `fn` as the owner (every jmap()/calendar helper inside uses the owner's API key). */
export async function asHost<T>(host: Host, fn: () => Promise<T>): Promise<T> {
  const session = await hostSession(host);
  if (!session) throw new HostUnavailable("booking host unavailable");
  return runWithSession(session, fn);
}
