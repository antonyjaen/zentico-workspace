import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { hostBySub, listTypes, upcomingBookings } from "@/lib/booking/db";
import { asHost, hostSession } from "@/lib/booking/host";
import { getCalendars } from "@/lib/calendar";
import { env } from "@/lib/env";
import { isTimeZone, TZ_COOKIE } from "../time";
import { BookingSettings, type CalendarOption, type UpcomingView } from "./BookingSettings";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("booking.settings");
  return { title: t("title") };
}

/** Calendar → Booking pages: the owner's Calendly-style booking pages. */
export default async function BookingPagesPage({ searchParams }: { searchParams: Promise<{ mcp?: string; mcp_error?: string }> }) {
  const session = await requireSession();
  const sp = await searchParams;
  const t = await getTranslations("booking.settings");
  const host = hostBySub(session.sub);
  const cookieTz = (await cookies()).get(TZ_COOKIE)?.value;
  const defaultZone = isTimeZone(cookieTz) ? cookieTz : "UTC";

  let enabled = false;
  let calendars: CalendarOption[] = [];
  let upcoming: UpcomingView[] = [];
  if (host?.credentialSealed && !host.needsReauth) {
    try {
      // Calendars as the booking key sees them: the owner's own account, never a delegated one.
      enabled = !!(await hostSession(host));
      if (enabled) {
        calendars = (await asHost(host, () => getCalendars())).map((c) => ({
          key: c.key,
          name: c.owner ? `${c.name} (${c.owner})` : c.name,
          color: c.color,
          own: c.owner === null,
          mayWrite: c.mayWrite,
          isDefault: c.isDefault,
        }));
      }
    } catch (e) {
      console.error("[booking] settings:", e instanceof Error ? e.message : e);
    }
  }
  const types = host ? listTypes(host.sub) : [];
  if (host && enabled) {
    const titles = new Map(types.map((x) => [x.id, x.title]));
    upcoming = upcomingBookings(host.sub, Date.now()).map((b) => ({
      id: b.id,
      start: b.start,
      end: b.end,
      guest: `${b.guestName} <${b.guestEmail}>`,
      title: titles.get(b.typeId) ?? "",
    }));
  }

  return (
    <main className="sheet flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <Link href="/calendar" className="icon-btn h-9 w-9" aria-label={t("back")} title={t("back")}>
          <ArrowLeft size={17} aria-hidden />
        </Link>
        <h1 className="text-[15px] font-medium text-ink">{t("title")}</h1>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-6">
          <BookingSettings
            appUrl={env.appUrl}
            enabled={enabled}
            needsReauth={!!host?.credentialSealed && !enabled}
            host={host ? { handle: host.handle, showEmail: host.showEmail } : null}
            types={types}
            calendars={calendars}
            upcoming={upcoming}
            defaultZone={defaultZone}
            authReturn={sp.mcp === "ok" ? "ok" : sp.mcp_error ? "error" : null}
          />
        </div>
      </div>
    </main>
  );
}
