import { LogOut } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/Logo";
import { TwoFactorCard } from "@/components/security/SecurityPanels";
import { getSessionForSetup } from "@/lib/auth";
import { unseal } from "@/lib/crypto";
import { isGated, statusOf } from "@/lib/security/store";
import { SECURITY_COOKIE, type SecurityGrant } from "@/lib/session";

export const metadata: Metadata = { title: "Two-step verification" };
export const dynamic = "force-dynamic";

/**
 * Where an account lands while the workspace requires two-step verification and it isn't set up:
 * nothing else works until it is (every other page, action and API sees it as signed out).
 */
export default async function SecuritySetupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSessionForSetup();
  if (!session) redirect("/signin");
  if (!isGated(session.sub)) redirect("/mail");
  const { error } = await searchParams;

  const grant = await unseal<SecurityGrant>((await cookies()).get(SECURITY_COOKIE)?.value);
  const hasGrant = !!grant && grant.sub === session.sub && grant.expiresAt > Date.now() + 15_000;
  // No grant yet: get one silently on the provider's single sign-on session. After a failure, the
  // page shows the error and a retry button instead (no redirect loop).
  if (!hasGrant && !error) redirect("/api/auth/login?security=check&returnTo=%2Fsignin%2Fsecurity");

  const t = await getTranslations("security");

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
      <div className="grid-canvas pointer-events-none absolute inset-0" aria-hidden />
      <div className="relative w-full max-w-[560px]">
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>
        <section className="sheet p-8">
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">{t("setupPage.title")}</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
            {t("setupPage.body", { email: session.email })}
          </p>
          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
              {t(error === "account_mismatch" ? "errors.account_mismatch" : "errors.verifyFailed", { email: session.email })}
            </p>
          )}
          <div className="mt-6">
            <TwoFactorCard
              enabled={hasGrant ? statusOf(session.sub) === true : null}
              hasGrant={hasGrant}
              required
              mode="setup"
              email={session.email}
              returnTo="/signin/security"
            />
          </div>
          <form action="/api/auth/logout" method="post" className="mt-6 border-t border-line pt-4">
            <input type="hidden" name="scope" value="current" />
            <button type="submit" className="inline-flex items-center gap-2 text-[13.5px] text-ink-soft hover:text-ink">
              <LogOut size={15} aria-hidden /> {t("setupPage.signOut")}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
