// Upcoming events for browser-side reminders (next 26 h, timed events only), plus a cheap check
// for invitations waiting for my answer (next 14 days): each is recorded once as a notification.
// Polled by the notification leader tab every ~10 minutes with fetch (never a server action).
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isTimeZone, TZ_COOKIE, zonedParts } from "@/app/(apps)/calendar/time";
import { getSession } from "@/lib/auth";
import { getEvents } from "@/lib/calendar";
import { jsonError } from "@/lib/chat/http";
import { getPrefs, notify } from "@/lib/notifications/store";
import { DEFAULT_REMINDER_MIN, type UpcomingEvent } from "@/lib/notifications/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HOUR = 3_600_000;
const MEET_LINK = /\/meet\/([a-z0-9-]{3,64})(?![a-z0-9-])/;

export async function GET() {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!getPrefs(session.email).calendar) {
    return NextResponse.json({ events: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  const cookieTz = (await cookies()).get(TZ_COOKIE)?.value;
  const tz = isTimeZone(cookieTz) ? cookieTz : "UTC";
  const now = Date.now();

  let all: Awaited<ReturnType<typeof getEvents>>["events"];
  try {
    ({ events: all } = await getEvents(now - HOUR, now + 14 * 24 * HOUR, tz, session.email));
  } catch (e) {
    console.error("[notifications] upcoming:", e instanceof Error ? e.message : e);
    return jsonError("unavailable", 502);
  }

  const events: UpcomingEvent[] = [];
  const invited = new Set<string>();
  for (const e of all) {
    const date = zonedParts(e.utcStart, tz).key;
    const meet = `${e.location}\n${e.description}`.match(MEET_LINK)?.[1] ?? null;
    if (e.myStatus === "needs-action" && !e.isOrganizer && e.utcEnd > now) {
      const key = `invite:${e.accountId}:${e.baseId}`;
      if (!invited.has(key)) {
        invited.add(key);
        notify(session.email, {
          category: "calendar",
          kind: "invite",
          title: e.title,
          body: String(e.utcStart),
          href: `/calendar?view=day&date=${date}`,
          ref: e.baseId,
          key,
          once: true,
        });
      }
    }
    if (e.allDay || e.myStatus === "declined" || e.utcStart <= now || e.utcStart > now + 26 * HOUR) continue;
    events.push({
      id: e.id,
      title: e.title,
      start: e.utcStart,
      alerts: e.alerts.length ? e.alerts.slice(0, 5) : [DEFAULT_REMINDER_MIN],
      date,
      meet,
    });
  }
  return NextResponse.json({ events: events.slice(0, 100) }, { headers: { "Cache-Control": "no-store" } });
}
