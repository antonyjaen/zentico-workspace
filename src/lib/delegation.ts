// Delegated ("master") accounts: a person's sign-in on the main domain reaches the same
// person's mailboxes on the organisation's other domains through Stalwart ACL sharing (see
// scripts/stalwart-master-accounts.mjs). Those accounts show up in the JMAP session with
// isPersonal: false; the workspace can "act as" one of them, which makes it the primary account
// for every capability it offers. Pure functions, no Next.js imports (unit-testable).

const MAIL = "urn:ietf:params:jmap:mail";
const ID = /^[A-Za-z0-9_-]{1,255}$/;

type RawAccount = { name?: string; isPersonal?: boolean; isReadOnly?: boolean; accountCapabilities?: Record<string, unknown> };
export type RawJmapSession = { primaryAccounts?: Record<string, string>; accounts?: Record<string, RawAccount> };

export type DelegatedAccount = { id: string; email: string };

const localPart = (email: string) => email.slice(0, email.lastIndexOf("@")).toLowerCase();
const isEmail = (v: unknown): v is string => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

/** The token owner's own account id (isPersonal), falling back to the primary mail account. */
export function personalAccountId(s: RawJmapSession): string | null {
  const own = Object.entries(s.accounts ?? {}).find(([, a]) => a.isPersonal === true)?.[0];
  return own ?? s.primaryAccounts?.[MAIL] ?? null;
}

/**
 * Accounts this token can act as: shared (non-personal), writable mail accounts of the same person
 * on another domain, i.e. the same local part as the personal account ("ana.torres@example.com"
 * → "ana.torres@example.org"). Access itself is enforced by Stalwart; the local-part rule only
 * keeps a colleague's shared calendar or mailbox out of the account switcher.
 */
export function delegatedAccounts(s: RawJmapSession): DelegatedAccount[] {
  const own = personalAccountId(s);
  const ownName = own ? s.accounts?.[own]?.name : undefined;
  if (!own || !isEmail(ownName)) return [];
  const local = localPart(ownName);
  return Object.entries(s.accounts ?? {})
    .filter(
      ([id, a]) =>
        id !== own &&
        ID.test(id) &&
        a.isPersonal !== true &&
        a.isReadOnly !== true &&
        a.accountCapabilities?.[MAIL] !== undefined &&
        isEmail(a.name) &&
        localPart(a.name) === local &&
        a.name.toLowerCase() !== ownName.toLowerCase(),
    )
    .map(([id, a]) => ({ id, email: a.name!.toLowerCase() }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** The delegated account `accountId` when this session may act as it, else null. */
export function findDelegated(s: RawJmapSession, accountId: string | null | undefined): DelegatedAccount | null {
  if (!accountId) return null;
  return delegatedAccounts(s).find((a) => a.id === accountId) ?? null;
}

/**
 * The session as seen while acting as `accountId`: it becomes the primary account for every
 * capability it offers, and capabilities it doesn't (submission, sieve, vacation, quota: owner-only
 * in Stalwart) lose their primary account, so nothing silently falls back to the master's own
 * mailbox. Unchanged when `accountId` isn't a valid delegated account. Never mutates `s`.
 */
export function actAs<T extends RawJmapSession>(s: T, accountId: string | null | undefined): T {
  const target = findDelegated(s, accountId);
  if (!target) return s;
  const caps = s.accounts?.[target.id]?.accountCapabilities ?? {};
  const primaryAccounts: Record<string, string> = {};
  for (const cap of Object.keys(s.primaryAccounts ?? {})) if (cap in caps) primaryAccounts[cap] = target.id;
  return { ...s, primaryAccounts };
}
