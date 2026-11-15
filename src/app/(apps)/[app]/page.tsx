import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { APPS, UPCOMING_APPS, type AppId } from "@/components/apps";

export default async function UpcomingApp({ params }: { params: Promise<{ app: string }> }) {
  const { app } = await params;
  if (!(UPCOMING_APPS as string[]).includes(app)) notFound();
  const meta = APPS.find((a) => a.id === app)!;
  const t = await getTranslations("soon");
  const tApps = await getTranslations("apps");
  const Icon = meta.icon;

  return (
    <main className="sheet grid flex-1 place-items-center p-8">
      <div className="rise max-w-md text-center">
        <span
          className="mx-auto grid h-16 w-16 place-items-center rounded-3xl"
          style={{ background: `color-mix(in oklab, ${meta.color} 14%, transparent)`, color: meta.color }}
        >
          <Icon size={30} aria-hidden />
        </span>
        <h1 className="mt-6 text-[24px] font-semibold tracking-tight text-ink">
          {t("title", { app: tApps(app as AppId) })}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">{t("body")}</p>
        <Link
          href="/mail"
          className="mt-8 inline-flex items-center gap-2 rounded-full border border-line-strong px-5 py-2.5 text-[14px] font-medium text-ink-soft transition-colors hover:bg-hover hover:text-ink"
        >
          <ArrowLeft size={16} aria-hidden />
          {t("back")}
        </Link>
      </div>
    </main>
  );
}
