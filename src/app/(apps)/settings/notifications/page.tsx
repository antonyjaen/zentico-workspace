import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { NotificationSettings } from "./NotificationSettings";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("notifications.page");
  return { title: t("title") };
}

export default async function NotificationSettingsPage() {
  await requireSession();
  const t = await getTranslations("notifications.page");
  return (
    <main className="sheet flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <Link href="/mail" className="icon-btn h-9 w-9" aria-label={t("back")} title={t("back")}>
          <ArrowLeft size={17} aria-hidden />
        </Link>
        <h1 className="text-[15px] font-medium text-ink">{t("title")}</h1>
      </div>
      <div className="flex-1 overflow-y-auto">
        <NotificationSettings />
      </div>
    </main>
  );
}
