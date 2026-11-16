import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { joinUrl, manageContext } from "@/lib/booking/service";
import { publicView } from "@/lib/booking/types";
import { formatRange } from "../../_ui/BookingWidget";
import { Shell } from "../../_ui/Shell";
import { ManageActions } from "./ManageActions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

/** /book/manage/<token>: the guest's view of their booking (reschedule / cancel). */
export default async function ManagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = manageContext(token);
  if (!ctx) notFound();
  const { booking, host, type } = ctx;
  const t = await getTranslations("booking.manage");
  const locale = await getLocale();
  const ownerName = host.name || host.email;
  const cancelled = booking.status === "cancelled";
  const started = booking.start <= Date.now();
  const changeable = !cancelled && !started && !!type?.active;

  return (
    <Shell>
      <section className="sheet rise p-6">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{type?.title ?? t("title")}</h1>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[14px]">
          <dt className="text-ink-mute">{t("with")}</dt>
          <dd>{host.showEmail ? `${ownerName} <${host.email}>` : ownerName}</dd>
          <dt className="text-ink-mute">{t("when")}</dt>
          <dd className={cancelled ? "line-through text-ink-mute" : ""}>{formatRange(booking.start, booking.end, booking.guestTz, locale)}</dd>
          <dt className="text-ink-mute">{t("guest")}</dt>
          <dd>
            {booking.guestName} ({booking.guestEmail})
          </dd>
        </dl>
        {cancelled && <p className="mt-5 text-[14px] text-ink-soft">{t("cancelled")}</p>}
        {!cancelled && started && <p className="mt-5 text-[14px] text-ink-soft">{t("past")}</p>}
        {!cancelled && booking.room && booking.end + 2 * 3_600_000 > Date.now() && (
          <p className="mt-5">
            <a href={joinUrl(token)} className="text-[14px] font-medium text-accent underline underline-offset-2">
              {t("join")}
            </a>
          </p>
        )}
        {changeable && type && (
          <ManageActions
            token={token}
            type={publicView(type)}
            duration={Math.round((booking.end - booking.start) / 60_000)}
            guestTz={booking.guestTz}
            ownerName={ownerName}
          />
        )}
      </section>
    </Shell>
  );
}
