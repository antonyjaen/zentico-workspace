// /ui-safe: the guaranteed way back from any Zentico UI customization. It lives outside the (apps)
// layout, so none of the user's theme, shell, slots or mods load here; it is plain HTML forms in
// the default tokens (works without JavaScript). Linked from the settings menu (never hideable).
import { RotateCcw, ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { SAFE_COOKIE } from "@/lib/ui/workspace";

export const dynamic = "force-dynamic";

export default async function UiSafePage({ searchParams }: { searchParams: Promise<{ restored?: string }> }) {
  await requireSession();
  const t = await getTranslations("dashboard.workspace");
  const safe = (await cookies()).get(SAFE_COOKIE)?.value === "1";
  const restored = (await searchParams).restored === "1";
  const btn = "inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg px-4 text-[14px] font-medium transition-colors";
  return (
    <main className="zw-safe grid min-h-dvh place-items-center bg-canvas p-4 text-ink">
      <div className="sheet w-full max-w-md p-6">
        <ShieldCheck size={22} aria-hidden className="text-accent" />
        <h1 className="mt-3 text-[20px] font-semibold">{t("safeTitle")}</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">{t("safeBody")}</p>
        {restored && (
          <p role="status" className="mt-4 rounded-lg border border-line bg-sheet-muted px-3 py-2 text-[13.5px]">
            {t("restored")}
          </p>
        )}
        {safe && <p className="mt-4 rounded-lg border border-line bg-sheet-muted px-3 py-2 text-[13.5px]">{t("safeActive")}</p>}
        <form action="/api/ui/safe" method="post" className="mt-5 flex flex-col gap-2">
          <button type="submit" name="op" value="restore" className={`${btn} bg-primary text-primary-ink hover:bg-primary-hover`}>
            <RotateCcw size={16} aria-hidden />
            {t("safeRestore")}
          </button>
          <button type="submit" name="op" value={safe ? "off" : "on"} className={`${btn} border border-line text-ink hover:bg-hover`}>
            {safe ? t("safeLeave") : t("safeEnter")}
          </button>
        </form>
        <Link href="/" className="mt-4 block text-center text-[13.5px] text-ink-soft underline underline-offset-2 hover:text-ink">
          {t("safeBack")}
        </Link>
      </div>
    </main>
  );
}
