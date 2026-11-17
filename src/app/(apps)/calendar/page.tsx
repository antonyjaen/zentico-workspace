import { ArrowLeft, CalendarX2 } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { actingAccountId, requireSession } from "@/lib/auth";
import { selfIdentity } from "@/lib/jmap";
import { getCalendars, getEvents, type CalEvent } from "@/lib/calendar";
import { listSubscriptions, refreshStale, subscriptionEvents, type Subscription } from "@/lib/calendar-subs/service";
import { env } from "@/lib/env";
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
  const session = await selfIdentity();
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
    const from = zonedToUtc(`${range.start}T00:00:00`, tz);
    const to = zonedToUtc(`${range.end}T00:00:00`, tz);
    const { events, expanded } = await getEvents(from, to, tz, session.email);
    const subs = await loadSubscriptions(from, to, tz);

    return (
      <CalendarApp
        key={`${view}:${date}`}
        calendars={calendars}
        events={subs.events.length ? [...events, ...subs.events].sort((a, b) => a.utcStart - b.utcStart || b.utcEnd - a.utcEnd) : events}
        expanded={expanded}
        subscriptions={subs.list}
        subscriptionsEnabled={subs.enabled}
        subscriptionsRefreshing={subs.refreshing}
        davServer={davServer()}
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

/**
 * The signed-in user's external calendar subscriptions and their cached events in the range
 * (never fetched here: stale feeds refresh in the background and the client reloads once).
 * Not shown while acting for a delegated account (they belong to the person signed in).
 */
async function loadSubscriptions(from: number, to: number, tz: string) {
  const none = { enabled: false, list: [] as Subscription[], events: [] as CalEvent[], refreshing: false };
  try {
    const [{ sub }, acting] = await Promise.all([requireSession(), actingAccountId()]);
    if (acting) return none;
    const refreshing = refreshStale(sub);
    return { enabled: true, list: listSubscriptions(sub), events: subscriptionEvents(sub, from, to, tz), refreshing };
  } catch (e) {
    unstable_rethrow(e);
    console.error("[calendar] subscriptions unavailable", e instanceof Error ? e.message : e);
    return none;
  }
}

/** CalDAV server for other apps: the mail server's origin (the OIDC issuer). */
function davServer(): string {
  try {
    return new URL(env.issuer).origin;
  } catch {
    return "";
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
