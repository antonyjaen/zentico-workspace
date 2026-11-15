import { CAP, jmap, primaryAccount } from "./jmap";

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
  mailboxIds: Record<string, boolean>;
  /** Ids of the thread's messages that list actions apply to (those in the listed mailbox). */
  emailIds: string[];
  threadSize: number;
  /** True when any message in scope is unread. */
  unread: boolean;
  /** True when any message in scope is starred. */
  flagged: boolean;
};

const ROLE_ORDER: Record<string, number> = { inbox: 0, drafts: 2, sent: 3, archive: 4, junk: 5, trash: 6 };

export async function getMailboxes(): Promise<Mailbox[]> {
  const accountId = await primaryAccount(CAP.mail);
  const r = await jmap([
    [
      "Mailbox/get",
      {
        accountId,
        properties: ["name", "role", "parentId", "sortOrder", "unreadEmails", "totalEmails"],
      },
      "m",
    ],
  ]);
  const list = (r.m.list as Mailbox[]) ?? [];
  return list.sort(
    (a, b) =>
      (ROLE_ORDER[a.role ?? ""] ?? 10) - (ROLE_ORDER[b.role ?? ""] ?? 10) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name),
  );
}

export type EmailFilter = { inMailbox: string } | { text: string };

export async function getEmails(
  filter: EmailFilter,
  { limit = 50, position = 0 } = {},
): Promise<{ emails: ThreadSummary[]; total: number }> {
  const accountId = await primaryAccount(CAP.mail);
  const r = await jmap([
    [
      "Email/query",
      {
        accountId,
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
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["threadId", "mailboxIds", "from", "subject", "preview", "receivedAt", "hasAttachment", "keywords"],
      },
      "g",
    ],
    [
      "Thread/get",
      { accountId, "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" } },
      "t",
    ],
    [
      "Email/get",
      {
        accountId,
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

  const emails = heads.map((head): ThreadSummary => {
    // Scope: the listed mailbox, or (for search) any mailbox the newest message is in.
    const scope = "inMailbox" in filter ? [filter.inMailbox] : Object.keys(head.mailboxIds ?? {});
    const inScope = (threads.get(head.threadId) ?? [head.id])
      .map((id) => members.get(id))
      .filter((e): e is Member => !!e && scope.some((m) => e.mailboxIds?.[m]));
    const scoped = inScope.length ? inScope : [{ id: head.id, mailboxIds: head.mailboxIds, keywords: head.keywords }];
    return {
      ...head,
      mailboxIds: head.mailboxIds ?? {},
      emailIds: scoped.map((e) => e.id),
      threadSize: threads.get(head.threadId)?.length ?? 1,
      unread: scoped.some((e) => !e.keywords?.["$seen"]),
      flagged: scoped.some((e) => !!e.keywords?.["$flagged"]),
    };
  });

  return { emails, total: (r.q.total as number) ?? 0 };
}
