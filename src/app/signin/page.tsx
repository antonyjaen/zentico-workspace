import { ArrowRight, CalendarDays, Download, FileText, HardDrive, Lock, Mail, Video } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/Logo";
import { getSession, getSessionForSetup, listAccounts } from "@/lib/auth";
import { availableDownloads, platformFromUA } from "@/lib/downloads";
import { safeLoginHint, safeReturnTo } from "@/lib/oidc";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS = ["invalid_state", "login_failed", "access_denied"] as const;

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; error?: string; hint?: string }>;
}) {
  const { returnTo, error, hint } = await searchParams;
  if (await getSession()) redirect(safeReturnTo(returnTo));
  // Signed in but held back by the workspace 2FA policy: finish setup first.
  if (await getSessionForSetup()) redirect("/signin/security");

  // Re-authenticating a signed-out account: pre-fill it, and offer the other signed-in accounts.
  const loginHint = safeLoginHint(hint);
  const others = (await listAccounts()).filter((a) => !a.active && !a.expired);
  const loginHref = `/api/auth/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}${
    loginHint ? `&hint=${encodeURIComponent(loginHint)}` : ""
  }`;

  const t = await getTranslations("signin");
  const tAccount = await getTranslations("account");
  const tApps = await getTranslations("apps");
  const tDl = await getTranslations("downloads");
  const downloads = await availableDownloads();
  const platform = platformFromUA((await headers()).get("user-agent"));
  const PLATFORM_NAME = { windows: "Windows", android: "Android", mac: "macOS", ios: "iPhone" } as const;
  const forMe = platform && downloads.some((d) => d.platform === platform);
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
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
      <div className="grid-canvas pointer-events-none absolute inset-0" aria-hidden />

      <div className="relative w-full max-w-[420px]">
        <div className="rise mb-8 flex justify-center">
          <Wordmark />
        </div>

        <section className="sheet rise p-8" style={{ animationDelay: "60ms" }}>
          <h1 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink">{t("title")}</h1>
          <p className="mt-3 text-[14.5px] leading-relaxed text-ink-soft">{t("body")}</p>

          <ul className="mt-6 flex flex-wrap gap-1.5" aria-label="Apps">
            {apps.map(({ icon: Icon, label, color }) => (
              <li
                key={label}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-sheet-muted px-2 text-[12.5px] text-ink-soft"
              >
                <Icon size={13} style={{ color }} aria-hidden />
                {label}
              </li>
            ))}
          </ul>

          {errorKey && (
            <p
              role="alert"
              className="mt-6 rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger"
            >
              {t(errorKey)}
            </p>
          )}

          <a
            href={loginHref}
            className="group mt-7 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary text-[14px] font-medium text-primary-ink transition-colors duration-150 hover:bg-primary-hover"
          >
            {t("cta")}
            <ArrowRight size={16} className="transition-transform duration-150 group-hover:translate-x-0.5" />
          </a>
          <p className="mt-3 text-center text-[12.5px] text-ink-mute">
            {loginHint ? tAccount("reauth", { email: loginHint }) : t("hint")}
          </p>

          {others.length > 0 && (
            <div className="mt-6 border-t border-line pt-4">
              <p className="mb-2 text-[12.5px] text-ink-mute">{tAccount("continueAs")}</p>
              <ul className="space-y-1">
                {others.map((a) => (
                  <li key={a.slot}>
                    <form action="/api/auth/switch" method="post">
                      <input type="hidden" name="slot" value={a.slot} />
                      <input type="hidden" name="returnTo" value={safeReturnTo(returnTo)} />
                      <button
                        type="submit"
                        className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:bg-hover"
                      >
                        <span className="text-[13.5px] text-ink">{a.name}</span>
                        <span className="text-[12.5px] text-ink-mute">{a.email}</span>
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {downloads.length > 0 && (
          <a
            href="/download"
            className="rise mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-line bg-sheet text-[13.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
            style={{ animationDelay: "90ms" }}
          >
            <Download size={15} aria-hidden />
            {forMe ? tDl("signinLink", { platform: PLATFORM_NAME[platform] }) : tDl("signinLinkGeneric")}
          </a>
        )}

        <p
          className="rise mt-6 flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-mute"
          style={{ animationDelay: "120ms" }}
        >
          <Lock size={12} aria-hidden />
          {t("footer")}
        </p>
      </div>
    </main>
  );
}
