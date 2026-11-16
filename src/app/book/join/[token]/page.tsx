import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { joinContext } from "@/lib/booking/service";
import { livekitConfig } from "@/lib/livekit";
import { formatRange } from "../../_ui/BookingWidget";
import { Shell } from "../../_ui/Shell";
import { GuestCall } from "./GuestCall";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * /book/join/<token>: the guest's way into the booking's Zentico Meet room without an account.
 * Workspace members (signed in) go to the regular /meet/<room> page instead.
 */
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = joinContext(token);
  if (!ctx) notFound();
  if (await getSession()) redirect(`/meet/${ctx.booking.room}`);
  const t = await getTranslations("booking.join");
  const locale = await getLocale();
  const when = formatRange(ctx.booking.start, ctx.booking.end, ctx.booking.guestTz, locale);

  if (ctx.open !== "open" || !livekitConfig()) {
    return (
      <Shell>
        <section className="sheet rise p-6">
          <h1 className="text-[20px] font-semibold">{t("title")}</h1>
          <p className="mt-2 text-[14px] text-ink-soft">{when}</p>
          <p className="mt-4 text-[14px] text-ink-soft">{!livekitConfig() ? t("notConfigured") : ctx.open === "early" ? t("early") : t("over")}</p>
        </section>
      </Shell>
    );
  }
  return (
    <Shell wide>
      <GuestCall token={token} defaultName={ctx.booking.guestName} ownerName={ctx.host.name || ctx.host.email} when={when} />
    </Shell>
  );
}
