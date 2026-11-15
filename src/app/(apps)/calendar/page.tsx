import { ArrowLeft, CalendarX2 } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getCalendars, getEvents } from "@/lib/calendar";
import { CalendarApp } from "./CalendarApp";
import { parsePeople, PEOPLE_COOKIE } from "./shared";
import { isDayKey, isTimeZone, TZ_COOKIE, VIEWS, viewRange, weekStartFor, zonedParts, zonedToUtc, type View } from "./time";

export async function generateMetadata() {
  const t = await getTranslations("apps");
  return { title: t("calendar") };
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const session = await requireSession();
  const locale = await getLocale();
  const jar = await cookies();
  const cookieTz = jar.get(TZ_COOKIE)?.value;
  const people = parsePeople(jar.get(PEOPLE_COOKIE)?.value);

  try {
    const calendars = await getCalendars();
    const fallbackTz = calendars.find((c) => c.isDefault)?.timeZone ?? calendars[0]?.timeZone ?? "UTC";
    const tz = isTimeZone(cookieTz) ? cookieTz : isTimeZone(fallbackTz) ? fallbackTz : "UTC";

    const view: View = VIEWS.includes(sp.view as View) ? (sp.view as View) : "week";
    const date = isDayKey(sp.date) ? sp.date : zonedParts(Date.now(), tz).key;
    const weekStart = weekStartFor(locale);
    const range = viewRange(view, date, weekStart);
    const { events, expanded } = await getEvents(
      zonedToUtc(`${range.start}T00:00:00`, tz),
      zonedToUtc(`${range.end}T00:00:00`, tz),
      tz,
      session.email,
    );

    return (
      <CalendarApp
        key={`${view}:${date}`}
        calendars={calendars}
        events={events}
        expanded={expanded}
        view={view}
        date={date}
        tz={tz}
        tzFromCookie={isTimeZone(cookieTz)}
        weekStart={weekStart}
        people={people}
        myEmail={session.email}
      />
    );
  } catch (e) {
    unstable_rethrow(e);
    console.error("calendar unavailable", e instanceof Error ? e.message : e);
    return <Unavailable />;
  }
}

async function Unavailable() {
  const t = await getTranslations("calendar.unavailable");
  return (
    <main className="sheet grid flex-1 place-items-center p-8">
      <div className="rise max-w-md text-center">
        <span
          className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-line bg-sheet-muted"
          style={{ color: "var(--color-app-calendar)" }}
        >
          <CalendarX2 size={26} aria-hidden />
        </span>
        <h1 className="mt-6 text-[24px] font-semibold tracking-tight text-ink">{t("title")}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">{t("body")}</p>
        <Link
          href="/mail"
          className="mt-8 inline-flex h-10 items-center gap-2 rounded-lg border border-line px-4 text-[14px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
        >
          <ArrowLeft size={16} aria-hidden />
          {t("back")}
        </Link>
      </div>
    </main>
  );
}
