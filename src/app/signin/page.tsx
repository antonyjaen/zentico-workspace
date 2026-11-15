import { ArrowRight, CalendarDays, FileText, HardDrive, Lock, Mail, Video } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/Logo";
import { getSession } from "@/lib/auth";
import { safeReturnTo } from "@/lib/oidc";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS = ["invalid_state", "login_failed", "access_denied"] as const;

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; error?: string }>;
}) {
  const { returnTo, error } = await searchParams;
  if (await getSession()) redirect(safeReturnTo(returnTo));

  const t = await getTranslations("signin");
  const tApps = await getTranslations("apps");
  const errorKey = error
    ? (ERRORS as readonly string[]).includes(error)
      ? `errors.${error}`
      : "errors.default"
    : null;

  const apps = [
    { icon: Mail, label: tApps("mail"), color: "var(--color-app-mail)" },
    { icon: CalendarDays, label: tApps("calendar"), color: "var(--color-app-calendar)" },
    { icon: HardDrive, label: tApps("drive"), color: "var(--color-app-drive)" },
    { icon: FileText, label: tApps("docs"), color: "var(--color-app-docs)" },
    { icon: Video, label: tApps("meet"), color: "var(--color-app-meet)" },
  ];

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[440px]">
        <div className="rise mb-8 flex justify-center">
          <Wordmark />
        </div>

        <section className="sheet rise p-8 sm:p-10" style={{ animationDelay: "60ms" }}>
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-primary">{t("eyebrow")}</p>
          <h1 className="mt-3 text-[28px] font-semibold leading-[1.15] tracking-tight text-ink">
            {t("title")}
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">{t("body")}</p>

          <ul className="mt-6 flex flex-wrap gap-2" aria-label="Apps">
            {apps.map(({ icon: Icon, label, color }) => (
              <li
                key={label}
                className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12.5px] text-ink-soft"
              >
                <Icon size={14} style={{ color }} aria-hidden />
                {label}
              </li>
            ))}
          </ul>

          {errorKey && (
            <p role="alert" className="mt-6 rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">
              {t(errorKey)}
            </p>
          )}

          <a
            href={`/api/auth/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`}
            className="group mt-8 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-primary text-[15px] font-medium text-primary-ink transition-colors duration-200 hover:bg-primary-hover active:scale-[0.99]"
          >
            {t("cta")}
            <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </a>
          <p className="mt-3 text-center text-[13px] text-ink-mute">{t("hint")}</p>
        </section>

        <p className="rise mt-6 flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute" style={{ animationDelay: "120ms" }}>
          <Lock size={12} aria-hidden />
          {t("footer")}
        </p>
      </div>
    </main>
  );
}
