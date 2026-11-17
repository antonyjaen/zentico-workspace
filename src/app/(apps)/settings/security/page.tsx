import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Link from "next/link";
import {
  AppPasswordsCard,
  type AppPasswordView,
  PasswordCard,
  PolicyCard,
  type PolicyView,
  TwoFactorCard,
} from "@/components/security/SecurityPanels";
import { requireSession } from "@/lib/auth";
import { unseal } from "@/lib/crypto";
import { listAppPasswords, otpEnabled, StalwartError } from "@/lib/security/stalwart";
import { getPolicy, HOUR_MS, isAdmin, listStatuses, recordStatus } from "@/lib/security/store";
import { SECURITY_COOKIE, type SecurityGrant } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("security");
  return { title: t("title") };
}

export default async function SecuritySettingsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await requireSession();
  const { error } = await searchParams;
  const t = await getTranslations("security");
  const policy = getPolicy();

  // Live status and app passwords need the user's short-lived security grant; without one the
  // page offers to sign in again for it.
  const cookie = await unseal<SecurityGrant>((await cookies()).get(SECURITY_COOKIE)?.value);
  const grant = cookie && cookie.sub === session.sub && cookie.expiresAt > Date.now() + 15_000 ? cookie : null;
  let enabled: boolean | null = null;
  let appPasswords: AppPasswordView[] | null = null;
  let grantWorks = !!grant;
  if (grant) {
    try {
      enabled = await otpEnabled(grant.accessToken);
      recordStatus(session.sub, session.email, enabled);
      if (grant.stepUp) {
        appPasswords = (await listAppPasswords(grant.accessToken)).map(({ id, description, createdAt }) => ({ id, description, createdAt }));
      }
    } catch (e) {
      grantWorks = false;
      if (!(e instanceof StalwartError && e.code === "authorize")) {
        console.error("[security] reading status failed:", e instanceof Error ? e.message : e);
      }
    }
  }

  const admin: PolicyView | null = isAdmin(session.email)
    ? { required: policy.required, enforceAfter: policy.enforceAfter, sessionHours: Math.round(policy.sessionMaxMs / HOUR_MS), members: listStatuses() }
    : null;

  return (
    <main className="sheet flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <Link href="/mail" className="icon-btn h-9 w-9" aria-label={t("back")} title={t("back")}>
          <ArrowLeft size={17} aria-hidden />
        </Link>
        <h1 className="text-[15px] font-medium text-ink">{t("title")}</h1>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-5 py-6">
          <p className="text-[14px] leading-relaxed text-ink-soft">{t("intro")}</p>
          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
              {t(error === "account_mismatch" ? "errors.account_mismatch" : "errors.verifyFailed", { email: session.email })}
            </p>
          )}
          <div className="mt-6">
            <PasswordCard canManage={grantWorks && !!grant?.stepUp} otpOn={enabled === true} email={session.email} />
          </div>
          <div className="mt-8">
            <TwoFactorCard
              enabled={enabled}
              hasGrant={grantWorks}
              required={policy.required}
              mode="settings"
              email={session.email}
              returnTo="/settings/security"
            />
          </div>
          <AppPasswordsCard items={appPasswords} canManage={grantWorks && !!grant?.stepUp} />
          {admin && <PolicyCard policy={admin} />}
        </div>
      </div>
    </main>
  );
}
