import { CAP, jmap, primaryAccount } from "./jmap";
import { labelsOf } from "./mail-labels";
import { getFullSession } from "./mail-settings";

export type MailboxRole = "inbox" | "drafts" | "sent" | "junk" | "trash" | "archive" | null;

export type Mailbox = {
  id: string;
  name: string;
  role: MailboxRole;
  parentId: string | null;
  sortOrder: number;
  unreadEmails: number;
  totalEmails: number;
};

export type EmailSummary = {
  id: string;
  threadId: string;
  from: { name: string | null; email: string }[];
  subject: string;
  preview: string;
  receivedAt: string;
  hasAttachment: boolean;
  keywords: Record<string, boolean>;
};

/** A conversation row in a list: the newest message plus thread-wide state. */
export type ThreadSummary = EmailSummary & {
  /** JMAP account the conversation lives in. */
  accountId: string;
  mailboxIds: Record<string, boolean>;
  /** Ids of the thread's messages that list actions apply to (those in the listed mailbox). */
  emailIds: string[];
  threadSize: number;
  /** True when any message in scope is unread. */
  unread: boolean;
  /** True when any message in scope is starred. */
  flagged: boolean;
  /** Label ids on any message in scope. */
  labels: string[];
};

/** A JMAP Email/query filter: a FilterCondition or a FilterOperator (RFC 8621 §4.4.1). */
export type EmailFilter = Record<string, unknown>;

export type MailAccount = { id: string; name: string; isPrimary: boolean; isReadOnly: boolean };

const ID = /^[A-Za-z0-9_-]{1,255}$/;
const ROLE_ORDER: Record<string, number> = { inbox: 0, drafts: 2, sent: 3, archive: 4, junk: 5, trash: 6 };

/** Every session account with mail: the user's own first, then mailboxes shared with them. */
export async function getMailAccounts(): Promise<MailAccount[]> {
  const s = await getFullSession();
  const primary = s.primaryAccounts?.[CAP.mail];
  return Object.entries(s.accounts ?? {})
    .filter(([, a]) => a?.accountCapabilities?.[CAP.mail])
    .map(([id, a]) => ({ id, name: a.name || id, isPrimary: id === primary, isReadOnly: Boolean(a.isReadOnly) }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name));
}

/** Validates an account id from a URL/client against the session; falls back to the primary. */
export async function resolveAccount(account?: string | null): Promise<string> {
  if (account && ID.test(account)) {
    const found = (await getMailAccounts()).find((a) => a.id === account);
    if (found) return found.id;
  }
  return primaryAccount(CAP.mail);
}

export async function getMailboxes(accountId?: string): Promise<Mailbox[]> {
  const account = accountId ?? (await primaryAccount(CAP.mail));
  const r = await jmap([
    [
      "Mailbox/get",
      {
        accountId: account,
        properties: ["name", "role", "parentId", "sortOrder", "unreadEmails", "totalEmails"],
      },
      "m",
    ],
  ]);
  const list = ((r.m.list as Mailbox[]) ?? []).map((m) => ({ ...m, parentId: m.parentId ?? null }));
  return list.sort(
    (a, b) =>
      (ROLE_ORDER[a.role ?? ""] ?? 10) - (ROLE_ORDER[b.role ?? ""] ?? 10) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name),
  );
}

export async function getEmails(
  filter: EmailFilter,
  {
    limit = 50,
    position = 0,
    accountId,
    scope,
  }: {
    limit?: number;
    position?: number;
    accountId?: string;
    /** Mailbox whose messages list actions apply to (defaults to `filter.inMailbox`). */
    scope?: string;
  } = {},
): Promise<{ emails: ThreadSummary[]; total: number }> {
  const account = accountId ?? (await primaryAccount(CAP.mail));
  const r = await jmap([
    [
      "Email/query",
      {
        accountId: account,
        filter,
        sort: [{ property: "receivedAt", isAscending: false }],
        collapseThreads: true,
        position,
        limit,
        calculateTotal: true,
      },
      "q",
    ],
    [
      "Email/get",
      {
        accountId: account,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["threadId", "mailboxIds", "from", "subject", "preview", "receivedAt", "hasAttachment", "keywords"],
      },
      "g",
    ],
    [
      "Thread/get",
      { accountId: account, "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" } },
      "t",
    ],
    [
      "Email/get",
      {
        accountId: account,
        "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
        properties: ["mailboxIds", "keywords"],
      },
      "m",
    ],
  ]);

  type Member = { id: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> };
  const members = new Map(((r.m.list as Member[]) ?? []).map((e) => [e.id, e]));
  const threads = new Map(
    ((r.t.list as { id: string; emailIds: string[] }[]) ?? []).map((th) => [th.id, th.emailIds]),
  );
  const heads = (r.g.list as (EmailSummary & { mailboxIds: Record<string, boolean> })[]) ?? [];
  const scopeBox = scope ?? (typeof filter.inMailbox === "string" ? filter.inMailbox : undefined);

  const emails = heads.map((head): ThreadSummary => {
    // Scope: the listed mailbox, or (for search/labels) any mailbox the newest message is in.
    const boxes = scopeBox ? [scopeBox] : Object.keys(head.mailboxIds ?? {});
    const inScope = (threads.get(head.threadId) ?? [head.id])
      .map((id) => members.get(id))
      .filter((e): e is Member => !!e && boxes.some((m) => e.mailboxIds?.[m]));
    const scoped = inScope.length ? inScope : [{ id: head.id, mailboxIds: head.mailboxIds, keywords: head.keywords }];
    return {
      ...head,
      accountId: account,
      mailboxIds: head.mailboxIds ?? {},
      emailIds: scoped.map((e) => e.id),
      threadSize: threads.get(head.threadId)?.length ?? 1,
      unread: scoped.some((e) => !e.keywords?.["$seen"]),
      flagged: scoped.some((e) => !!e.keywords?.["$flagged"]),
      labels: [...new Set(scoped.flatMap((e) => labelsOf(e.keywords)))],
    };
  });

  return { emails, total: (r.q.total as number) ?? 0 };
}

/** Inbox id per mail account (accounts without a readable inbox are skipped). */
async function inboxes(accounts: MailAccount[]): Promise<{ account: MailAccount; inboxId: string }[]> {
  const out = await Promise.all(
    accounts.map(async (account) => {
      try {
        const inboxId = (await getMailboxes(account.id)).find((m) => m.role === "inbox")?.id;
        return inboxId ? { account, inboxId } : null;
      } catch {
        return null;
      }
    }),
  );
  return out.filter((x): x is { account: MailAccount; inboxId: string } => !!x);
}

/**
 * Unified inbox: the newest conversations across the user's inbox and every shared inbox.
 * Each account is queried for the first (page+1)*limit rows and the results merged by date.
 */
export async function getUnifiedInbox({ limit = 50, page = 0 } = {}): Promise<{
  emails: ThreadSummary[];
  total: number;
  accounts: MailAccount[];
}> {
  const accounts = await getMailAccounts();
  const boxes = await inboxes(accounts);
  const results = await Promise.all(
    boxes.map(({ account, inboxId }) =>
      getEmails({ inMailbox: inboxId }, { accountId: account.id, limit: (page + 1) * limit }).catch(() => ({
        emails: [] as ThreadSummary[],
        total: 0,
      })),
    ),
  );
  const merged = results
    .flatMap((r) => r.emails)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(page * limit, (page + 1) * limit);
  return { emails: merged, total: results.reduce((n, r) => n + r.total, 0), accounts };
}

/** Mailboxes of every shared (non-primary) mail account, for the sidebar. */
export async function getSharedMailboxes(): Promise<{ account: MailAccount; mailboxes: Mailbox[] }[]> {
  const shared = (await getMailAccounts()).filter((a) => !a.isPrimary);
  return Promise.all(
    shared.map(async (account) => ({
      account,
      mailboxes: await getMailboxes(account.id).catch(() => [] as Mailbox[]),
    })),
  );
}
