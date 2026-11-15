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
): Promise<{ emails: EmailSummary[]; total: number }> {
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
        properties: ["threadId", "from", "subject", "preview", "receivedAt", "hasAttachment", "keywords"],
      },
      "g",
    ],
  ]);
  return {
    emails: (r.g.list as EmailSummary[]) ?? [],
    total: (r.q.total as number) ?? 0,
  };
}
