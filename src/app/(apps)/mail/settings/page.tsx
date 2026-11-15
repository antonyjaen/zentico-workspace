import { ArrowLeft, Ban } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { getMailboxes, type Mailbox } from "@/lib/mail";
import {
  FILTER_SCRIPT_NAME,
  getDisplayPrefs,
  getFilters,
  getIdentities,
  getVacation,
} from "@/lib/mail-settings";
import { DisplayForm } from "./DisplayForm";
import { FiltersEditor } from "./FiltersEditor";
import { IdentitiesSection } from "./IdentitiesSection";
import { VacationForm } from "./VacationForm";

const TABS = ["identities", "vacation", "filters", "display"] as const;
type Tab = (typeof TABS)[number];

export default async function MailSettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const requested = (await searchParams).tab as Tab | undefined;
  const tab: Tab = requested && TABS.includes(requested) ? requested : "identities";
  const t = await getTranslations("mailSettings");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <Link href="/mail" className="icon-btn h-9 w-9" aria-label={t("back")} title={t("back")}>
          <ArrowLeft size={17} aria-hidden />
        </Link>
        <h1 className="text-[15px] font-medium text-ink">{t("title")}</h1>
      </div>

      <nav aria-label={t("title")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-4">
        {TABS.map((id) => (
          <Link
            key={id}
            href={`/mail/settings?tab=${id}`}
            aria-current={tab === id ? "page" : undefined}
            className="relative -mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-[14px] text-ink-mute transition-colors hover:text-ink aria-[current=page]:border-ink aria-[current=page]:text-ink"
          >
            {t(`tabs.${id}`)}
          </Link>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        <section key={tab} className="rise mx-auto w-full max-w-3xl px-5 py-8 md:px-8">
          <header className="mb-6">
            <h2 className="text-[20px] font-semibold tracking-tight text-ink">{t(`${tab}.title`)}</h2>
            <p className="mt-1 text-[14px] text-ink-mute">{t(`${tab}.description`)}</p>
          </header>
          <TabContent tab={tab} />
        </section>
      </div>
    </div>
  );
}

async function TabContent({ tab }: { tab: Tab }) {
  try {
    switch (tab) {
      case "identities": {
        const identities = await getIdentities();
        return identities ? <IdentitiesSection identities={identities} /> : <Unavailable />;
      }
      case "vacation": {
        const vacation = await getVacation();
        return vacation ? <VacationForm vacation={vacation} /> : <Unavailable />;
      }
      case "filters": {
        const [filters, mailboxes] = await Promise.all([getFilters(), getMailboxes()]);
        if (!filters) return <Unavailable />;
        const ours = filters.scripts.find((s) => s.name === FILTER_SCRIPT_NAME);
        return (
          <FiltersEditor
            rules={filters.rules}
            folders={folderOptions(mailboxes)}
            scriptName={FILTER_SCRIPT_NAME}
            active={filters.active}
            otherActive={Boolean(filters.active) && !ours?.isActive}
            unreadable={filters.unreadable}
          />
        );
      }
      case "display": {
        const prefs = await getDisplayPrefs();
        return <DisplayForm {...prefs} />;
      }
    }
  } catch (e) {
    unstable_rethrow(e);
    console.error("mail settings load failed", e);
    const t = await getTranslations("mailSettings");
    return <p className="rounded-lg border border-line px-4 py-6 text-[14px] text-ink-soft">{t("loadError")}</p>;
  }
}

/** Folder choices with their full path, excluding drafts/sent (not valid filter targets). */
function folderOptions(mailboxes: Mailbox[]) {
  const byId = new Map(mailboxes.map((m) => [m.id, m]));
  const path = (m: Mailbox): string => {
    const parent = m.parentId ? byId.get(m.parentId) : undefined;
    return parent ? `${path(parent)} / ${m.name}` : m.name;
  };
  return mailboxes
    .filter((m) => m.role !== "drafts" && m.role !== "sent")
    .map((m) => ({ id: m.id, label: path(m) }));
}

async function Unavailable() {
  const t = await getTranslations("mailSettings");
  return (
    <div className="grid place-items-center rounded-lg border border-dashed border-line-strong px-6 py-14 text-center">
      <Ban size={20} aria-hidden className="mb-3 text-ink-mute" />
      <p className="text-[15px] font-medium text-ink">{t("unavailable")}</p>
      <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-mute">{t("unavailableHint")}</p>
    </div>
  );
}
