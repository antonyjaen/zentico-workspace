// Notification center for the signed-in user.
//   GET   → { items (newest 50), unread, prefs }
//   POST  { action: "read", ids } | { action: "readAll" } | { action: "dismiss", ids } | { action: "clear" }
//         | { action: "prefs", prefs }
//         | { action: "reminder", eventId, title, start, minutes, date, meet? }
// Reminders are scheduled in the browser from /api/notifications/upcoming and recorded here once
// (deduplicated per event, start and offset), so every tab and device shows the same one.
import { NextResponse, type NextRequest } from "next/server";
import { ROOM_PATTERN } from "@/app/(apps)/meet/shared";
import { getSession } from "@/lib/auth";
import { jsonError, sameOrigin } from "@/lib/chat/http";
import { dismiss, dismissAll, getPrefs, listNotifications, markAllRead, markRead, notify, savePrefs } from "@/lib/notifications/store";
import type { NotificationsResponse } from "@/lib/notifications/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_ID = /^[A-Za-z0-9_:.@-]{1,300}$/;

export async function GET() {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  const body: NotificationsResponse = { ...listNotifications(session.email), prefs: getPrefs(session.email) };
  return NextResponse.json(body, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  const text = await req.text();
  if (text.length > 20_000) return jsonError("too_large", 413);
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonError("invalid", 400);
    input = parsed as Record<string, unknown>;
  } catch {
    return jsonError("invalid", 400);
  }

  switch (input.action) {
    case "read": {
      if (!Array.isArray(input.ids)) return jsonError("invalid", 400);
      markRead(session.email, input.ids.filter((x): x is string => typeof x === "string"));
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    case "readAll":
      markAllRead(session.email);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    case "dismiss": {
      if (!Array.isArray(input.ids)) return jsonError("invalid", 400);
      dismiss(session.email, input.ids.filter((x): x is string => typeof x === "string"));
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    case "clear":
      dismissAll(session.email);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    case "prefs":
      return NextResponse.json({ ok: true, prefs: savePrefs(session.email, input.prefs) }, { headers: NO_STORE });
    case "reminder": {
      const { eventId, title, start, minutes, date, meet } = input;
      if (
        typeof eventId !== "string" ||
        !EVENT_ID.test(eventId) ||
        typeof title !== "string" ||
        typeof start !== "number" ||
        !Number.isFinite(start) ||
        typeof minutes !== "number" ||
        !Number.isInteger(minutes) ||
        minutes < 0 ||
        minutes > 40_320 ||
        typeof date !== "string" ||
        !DAY.test(date) ||
        (meet != null && (typeof meet !== "string" || !ROOM_PATTERN.test(meet)))
      ) {
        return jsonError("invalid", 400);
      }
      // Only around the time it is due: a reminder can't be planted for later or long after.
      const due = start - minutes * 60_000;
      if (Math.abs(Date.now() - due) > 10 * 60_000) return jsonError("not_due", 400);
      notify(session.email, {
        category: "calendar",
        kind: "reminder",
        title: title.slice(0, 200),
        body: String(start),
        href: typeof meet === "string" ? `/meet/${meet}` : `/calendar?view=day&date=${date}`,
        priority: "high",
        ref: eventId,
        key: `reminder:${eventId}:${start}:${minutes}`,
        once: true,
      });
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    default:
      return jsonError("invalid", 400);
  }
}
