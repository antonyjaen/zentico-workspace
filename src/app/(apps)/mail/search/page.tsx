import { getTranslations } from "next-intl/server";
import { redirect, unstable_rethrow } from "next/navigation";
import { EmailList, PAGE_SIZE } from "../EmailList";
import { getEmails, getMailboxes, type EmailFilter } from "@/lib/mail";
import { LABEL_ID, labelKeyword } from "@/lib/mail-labels";
import { getLabels } from "@/lib/mail-settings";

/** Advanced search params (all optional; combined with AND). */
type Params = {
  q?: string;
  from?: string;
  to?: string;
  subject?: string;
  not?: string;
  att?: string;
  within?: string;
  in?: string;
  page?: string;
};

const FIELDS = ["q", "from", "to", "subject", "not", "att", "within", "in"] as const;
const WITHIN_DAYS: Record<string, number> = { "1d": 1, "3d": 3, "1w": 7, "2w": 14, "1m": 31, "6m": 183, "1y": 365 };
const ID = /^[A-Za-z0-9_-]{1,255}$/;

const clean = (v: string | undefined) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";

/** Builds a JMAP Email/query filter: one FilterCondition per field, joined with an AND operator. */
function buildFilter(p: Record<(typeof FIELDS)[number], string>): EmailFilter | null {
  const conditions: EmailFilter[] = [];
  if (p.q) conditions.push({ text: p.q });
  if (p.from) conditions.push({ from: p.from });
  if (p.to) conditions.push({ to: p.to });
  if (p.subject) conditions.push({ subject: p.subject });
  if (p.not) conditions.push({ operator: "NOT", conditions: [{ text: p.not }] });
  if (p.att === "1") conditions.push({ hasAttachment: true });
  if (WITHIN_DAYS[p.within]) {
    const after = new Date(Date.now() - WITHIN_DAYS[p.within] * 86_400_000);
    conditions.push({ after: after.toISOString().replace(/\.\d{3}Z$/, "Z") });
  }
  if (p.in.startsWith("label:") && LABEL_ID.test(p.in.slice(6))) conditions.push({ hasKeyword: labelKeyword(p.in.slice(6)) });
  else if (p.in && ID.test(p.in)) conditions.push({ inMailbox: p.in });
  if (!conditions.length) return null;
  return conditions.length === 1 ? conditions[0] : { operator: "AND", conditions };
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const raw = await searchParams;
  const p = Object.fromEntries(FIELDS.map((f) => [f, clean(raw[f])])) as Record<(typeof FIELDS)[number], string>;
  const filter = buildFilter(p);
  if (!filter) redirect("/mail");
  const page = Math.max(0, Number.parseInt(raw.page ?? "0", 10) || 0);
  const t = await getTranslations("mail");

  const qs = new URLSearchParams();
  for (const f of FIELDS) if (p[f]) qs.set(f, p[f]);

  try {
    const [{ emails, total }, mailboxes, labels] = await Promise.all([
      getEmails(filter, {
        limit: PAGE_SIZE,
        position: page * PAGE_SIZE,
        // Searching inside one folder: actions apply to the messages in that folder.
        scope: p.in && !p.in.startsWith("label:") ? p.in : undefined,
      }),
      getMailboxes(),
      getLabels(),
    ]);
    return (
      <EmailList
        emails={emails}
        total={total}
        page={page}
        basePath={`/mail/search?${qs.toString()}`}
        emptyText={t("empty")}
        mailboxId="search"
        mailboxes={mailboxes}
        labels={labels}
        view="search"
      />
    );
  } catch (e) {
    unstable_rethrow(e);
    return <p className="p-8 text-[15px] text-ink-soft">{t("error")}</p>;
  }
}
