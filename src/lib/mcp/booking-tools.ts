// Booking pages (Calendly-style links guests book without an account): list them, get shareable
// links and create simple ones. Turning booking pages on needs the owner's one-off authorization in
// Calendar → Booking pages, so these tools only work once that is done.
import { randomUUID } from "node:crypto";
import { listTypes, hostBySub, saveType, upcomingBookings } from "../booking/db";
import { bookingPath, defaultSettings, parseSettings, SettingsError, slugify, type BookingType } from "../booking/types";
import { getCalendars } from "../calendar";
import { int, oneOf, str, strList, ToolError } from "./args";
import { userTimeZone, localIso } from "./calendar-tools";
import { A, appUrl, I, S, type Tool } from "./kit";

const MAX_TYPES = 30;

function hostOrThrow(sub: string) {
  const host = hostBySub(sub);
  if (!host || !host.credentialSealed) {
    throw new ToolError(`Booking pages are not turned on. Turn them on in Calendar → Booking pages (${appUrl()}/calendar/booking).`);
  }
  if (host.needsReauth) throw new ToolError(`Booking pages need reconnecting in Calendar → Booking pages (${appUrl()}/calendar/booking).`);
  return host;
}

const summary = (handle: string, t: BookingType) => ({
  id: t.id,
  title: t.title,
  slug: t.slug,
  url: `${appUrl()}${bookingPath(handle, t.slug)}`,
  active: t.active,
  durationsMinutes: t.durations,
  location: t.location.kind,
  timeZone: t.timeZone,
});

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const RANGE = /^([01]\d|2[0-3]):[0-5]\d-(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

export const BOOKING_TOOLS: Tool[] = [
  {
    name: "booking_list_types",
    description:
      "Lists the user's booking pages (Calendly-style scheduling links external people can book without an account) with their public URLs, plus the profile link listing all of them and the next upcoming bookings.",
    inputSchema: { type: "object", properties: { includeUpcoming: { type: "boolean", description: "Also return the next bookings.", default: false } } },
    async run(args, ctx) {
      const host = hostOrThrow(ctx.session.sub);
      const types = listTypes(host.sub);
      const tz = await userTimeZone();
      return {
        profileUrl: `${appUrl()}${bookingPath(host.handle)}`,
        types: types.map((t) => summary(host.handle, t)),
        upcoming:
          args.includeUpcoming === true
            ? upcomingBookings(host.sub, Date.now(), 20).map((b) => ({
                type: types.find((t) => t.id === b.typeId)?.title ?? null,
                start: localIso(b.start, tz),
                end: localIso(b.end, tz),
                guest: `${b.guestName} <${b.guestEmail}>`,
              }))
            : undefined,
      };
    },
  },
  {
    name: "booking_get_link",
    description: "Returns the shareable public link of one booking page (by slug, id or title), or the profile link when none is given.",
    inputSchema: {
      type: "object",
      properties: { page: S("Slug, id or title of the booking page. Omit for the profile link listing every active page.") },
    },
    async run(args, ctx) {
      const host = hostOrThrow(ctx.session.sub);
      const q = str(args, "page", { max: 200 })?.trim().toLowerCase();
      if (!q) return { url: `${appUrl()}${bookingPath(host.handle)}` };
      const types = listTypes(host.sub);
      const t = types.find((x) => x.slug === q || x.id === q) ?? types.find((x) => x.title.toLowerCase() === q) ?? types.find((x) => x.title.toLowerCase().includes(q));
      if (!t) throw new ToolError(`No booking page matches "${q}". Existing: ${types.map((x) => x.slug).join(", ") || "none"}`);
      return { ...summary(host.handle, t), note: t.active ? undefined : "This page is turned off; guests can't book it until it is turned on." };
    },
  },
  {
    name: "booking_create_type",
    description:
      "Creates a booking page with weekly hours (default Mon–Fri 09:00–17:00 in the user's time zone), written into the user's default calendar. Location defaults to a Zentico Meet video link. Returns its public link.",
    inputSchema: {
      type: "object",
      properties: {
        title: S("Title shown to guests, e.g. \"30-minute intro call\"."),
        durations: A("Durations in minutes the guest can pick (e.g. [30] or [15, 30, 60]). Default [30]."),
        description: S("Description shown on the page."),
        location: { type: "string", enum: ["meet", "phone", "inPerson", "custom"], description: "meet (Zentico Meet link, default), phone (the guest gives a number), inPerson or custom (needs locationDetails)." },
        locationDetails: S("Address (inPerson), text/link (custom) or your number for the guest to call (phone)."),
        hours: S('Weekly hours, e.g. "mon-fri 09:00-17:00" or "mon,wed 10:00-12:00 14:00-16:00; fri 09:00-13:00". Default "mon-fri 09:00-17:00".'),
        timeZone: S('IANA zone of the hours. Default: your calendar time zone.'),
        minNoticeHours: I("Minimum notice before a booking, in hours.", 0, 720, 4),
        windowDays: I("How many days ahead guests can book.", 1, 365, 60),
        bufferMinutes: I("Free minutes kept before and after each booking.", 0, 240, 0),
        maxPerDay: I("Maximum bookings per day (0 = no limit).", 0, 50, 0),
      },
      required: ["title"],
    },
    write: true,
    async run(args, ctx) {
      const host = hostOrThrow(ctx.session.sub);
      if (listTypes(host.sub).length >= MAX_TYPES) throw new ToolError(`At most ${MAX_TYPES} booking pages`);
      const title = str(args, "title", { required: true, max: 120 }).trim();
      const tz = str(args, "timeZone", { max: 64 }) ?? (await userTimeZone());
      const own = (await getCalendars()).filter((c) => c.owner === null && c.mayWrite);
      const cal = own.find((c) => c.isDefault) ?? own[0];
      if (!cal) throw new ToolError("No writable calendar found");
      const settings = defaultSettings(tz, cal.key);
      const durations = strList(args, "durations", { max: 6, itemMax: 4 }).map(Number);
      const location = oneOf(args, "location", ["meet", "phone", "inPerson", "custom"] as const, "meet");
      const hours = str(args, "hours", { max: 300 });
      const raw = {
        ...settings,
        title,
        slug: slugify(title),
        description: str(args, "description", { max: 2000 }) ?? "",
        durations: durations.length ? durations : [30],
        location: { kind: location, value: str(args, "locationDetails", { max: 300 }) ?? "" },
        weekly: hours ? parseHours(hours) : settings.weekly,
        minNotice: int(args, "minNoticeHours", { min: 0, max: 720, def: 4 }) * 60,
        windowDays: int(args, "windowDays", { min: 1, max: 365, def: 60 }),
        bufferBefore: int(args, "bufferMinutes", { min: 0, max: 240, def: 0 }),
        bufferAfter: int(args, "bufferMinutes", { min: 0, max: 240, def: 0 }),
        maxPerDay: int(args, "maxPerDay", { min: 0, max: 50, def: 0 }),
      };
      let parsed;
      try {
        parsed = parseSettings(raw);
      } catch (e) {
        if (e instanceof SettingsError) throw new ToolError(`Invalid ${e.field}`);
        throw e;
      }
      // Free slug: "intro-call", "intro-call-2", …
      let type: BookingType | null = null;
      for (let i = 1; i <= 20 && !type; i++) {
        const slug = i === 1 ? parsed.slug : `${parsed.slug.slice(0, 44)}-${i}`;
        type = saveType(host.sub, null, { ...parsed, slug }, randomUUID);
      }
      if (!type) throw new ToolError("Couldn't find a free link name; pass a different title");
      return summary(host.handle, type);
    },
  },
];

/** "mon-fri 09:00-17:00; sat 10:00-12:00" → weekly ranges (index 0 = Sunday). */
function parseHours(spec: string): { start: string; end: string }[][] {
  const weekly: { start: string; end: string }[][] = [[], [], [], [], [], [], []];
  for (const part of spec.toLowerCase().split(";").map((s) => s.trim()).filter(Boolean)) {
    const [daysSpec, ...ranges] = part.split(/\s+/);
    const days = new Set<number>();
    for (const d of daysSpec.split(",")) {
      const [a, b] = d.split("-");
      const from = DAYS.indexOf(a as (typeof DAYS)[number]);
      const to = b ? DAYS.indexOf(b as (typeof DAYS)[number]) : from;
      if (from < 0 || to < 0) throw new ToolError(`Unknown day in "${part}" (use mon, tue, wed, thu, fri, sat, sun)`);
      for (let i = from; ; i = (i + 1) % 7) {
        days.add(i);
        if (i === to) break;
      }
    }
    if (!ranges.length) throw new ToolError(`No hours in "${part}"`);
    for (const r of ranges) {
      if (!RANGE.test(r)) throw new ToolError(`Hours must look like 09:00-17:00 (got "${r}")`);
      const [start, end] = r.split("-");
      for (const d of days) weekly[d].push({ start, end });
    }
  }
  return weekly;
}
