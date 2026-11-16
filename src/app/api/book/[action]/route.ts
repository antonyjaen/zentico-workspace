// Public booking API (no sign-in; excluded from the auth middleware):
//   GET  /api/book/slots?handle&slug&duration&from&to   (or ?token&from&to when rescheduling)
//   POST /api/book/book        { handle, slug, start, duration, name, email, phone, answers, timeZone, locale, website }
//   POST /api/book/cancel      { token, reason }
//   POST /api/book/reschedule  { token, start }
//   POST /api/book/join        { token, name }   → LiveKit token for the guest
// Every input is validated here; per-IP and per-page rate limits apply to each action.
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isTimeZone } from "@/app/(apps)/calendar/time";
import { HostUnavailable } from "@/lib/booking/host";
import { clientIp, limit } from "@/lib/booking/limits";
import {
  activePage,
  book,
  BookingProblem,
  cancel,
  getSlots,
  joinContext,
  manageContext,
  reschedule,
  TOKEN_PATTERN,
} from "@/lib/booking/service";
import { cleanText, HANDLE, SLUG } from "@/lib/booking/types";
import { livekitConfig, mintAccessToken } from "@/lib/livekit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
const fail = (error: string, status = 400) => json({ error }, status);
const tooMany = (seconds: number) => json({ error: "rate" }, 429, { "Retry-After": String(seconds) });

const STATUS: Record<string, number> = { not_found: 404, unavailable: 503, invalid: 400, slot_taken: 409, limit: 409, failed: 502, too_late: 409 };

function problem(e: unknown) {
  if (e instanceof BookingProblem) return fail(e.code, STATUS[e.code] ?? 400);
  if (e instanceof HostUnavailable) return fail("unavailable", 503);
  console.error("[booking] api:", e instanceof Error ? e.message : e);
  return fail("failed", 500);
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
/** Epoch ms on a whole minute within ±2 years. */
const instant = (v: unknown) => {
  const n = num(v);
  return Number.isInteger(n) && n % 60_000 === 0 && Math.abs(n - Date.now()) < 2 * 366 * 86_400_000 ? n : null;
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  if ((await params).action !== "slots") return fail("not_found", 404);
  const q = req.nextUrl.searchParams;
  const from = instant(q.get("from"));
  const to = instant(q.get("to"));
  if (from == null || to == null || to <= from) return fail("invalid");
  const ip = clientIp(req.headers);
  try {
    const token = q.get("token");
    if (token) {
      const ctx = manageContext(token);
      if (!ctx?.type || ctx.booking.status !== "confirmed") return fail("not_found", 404);
      const wait = limit("slots", ip, ctx.type.id);
      if (wait) return tooMany(wait);
      const duration = Math.round((ctx.booking.end - ctx.booking.start) / 60_000);
      // Rescheduling keeps the booked duration even if the page no longer offers it.
      const type = ctx.type.durations.includes(duration) ? ctx.type : { ...ctx.type, durations: [...ctx.type.durations, duration] };
      return json({ slots: await getSlots(ctx.host, type, duration, from, to, ctx.booking) });
    }
    const handle = q.get("handle") ?? "";
    const slug = q.get("slug") ?? "";
    if (!HANDLE.test(handle) || !SLUG.test(slug)) return fail("not_found", 404);
    const page = activePage(handle, slug);
    if (!page) return fail("not_found", 404);
    const wait = limit("slots", ip, page.type.id);
    if (wait) return tooMany(wait);
    const duration = num(q.get("duration"));
    if (!page.type.durations.includes(duration)) return fail("invalid");
    return json({ slots: await getSlots(page.host, page.type, duration, from, to) });
  } catch (e) {
    return problem(e);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const action = (await params).action;
  // JSON only: cross-site HTML forms can't send it without a CORS preflight.
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail("unsupported_media_type", 415);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 32_000) return fail("invalid", 413);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("invalid");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail("invalid");
  }
  const ip = clientIp(req.headers);

  try {
    switch (action) {
      case "book": {
        const handle = typeof body.handle === "string" ? body.handle : "";
        const slug = typeof body.slug === "string" ? body.slug : "";
        if (!HANDLE.test(handle) || !SLUG.test(slug)) return fail("not_found", 404);
        const page = activePage(handle, slug);
        if (!page) return fail("not_found", 404);
        const wait = limit("book", ip, page.type.id);
        if (wait) return tooMany(wait);
        // Honeypot: people never see this field; bots that fill it get a quiet "ok".
        if (typeof body.website === "string" && body.website.trim()) return json({ ok: true });
        const start = instant(body.start);
        const timeZone = typeof body.timeZone === "string" && isTimeZone(body.timeZone) ? body.timeZone : null;
        if (start == null || !timeZone) return fail("invalid");
        const answers = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers) ? (body.answers as Record<string, unknown>) : {};
        const { manageToken, booking } = await book(page.host, page.type, {
          start,
          duration: num(body.duration),
          name: cleanText(body.name, 200),
          email: cleanText(body.email, 300),
          phone: cleanText(body.phone, 60),
          answers,
          timeZone,
          locale: body.locale === "en" ? "en" : "es",
        });
        return json({ ok: true, manage: `/book/manage/${manageToken}`, start: booking.start, end: booking.end });
      }
      case "cancel":
      case "reschedule": {
        const token = typeof body.token === "string" ? body.token : "";
        if (!TOKEN_PATTERN.test(token)) return fail("not_found", 404);
        const ctx = manageContext(token);
        if (!ctx) return fail("not_found", 404);
        const wait = limit("manage", ip, ctx.booking.typeId);
        if (wait) return tooMany(wait);
        if (action === "cancel") {
          await cancel(token, body.reason);
          return json({ ok: true });
        }
        const start = instant(body.start);
        if (start == null) return fail("invalid");
        const moved = await reschedule(token, start);
        return json({ ok: true, start: moved.start, end: moved.end });
      }
      case "join": {
        const token = typeof body.token === "string" ? body.token : "";
        const ctx = joinContext(token);
        if (!ctx) return fail("not_found", 404);
        const wait = limit("join", ip, ctx.booking.id);
        if (wait) return tooMany(wait);
        if (ctx.open !== "open") return fail(ctx.open === "early" ? "too_early" : "too_late", 409);
        const config = livekitConfig();
        if (!config) return fail("not_configured", 503);
        const name = cleanText(body.name, 80) || ctx.booking.guestName;
        const lk = await mintAccessToken(config, {
          // Never collides with a member's identity (their e-mail address).
          identity: `guest-${ctx.booking.id.slice(0, 8)}-${randomUUID().slice(0, 6)}`,
          name,
          room: ctx.booking.room,
        });
        return json({ token: lk, url: config.url });
      }
      default:
        return fail("not_found", 404);
    }
  } catch (e) {
    return problem(e);
  }
}
