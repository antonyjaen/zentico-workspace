// Tests for external calendar subscriptions / .ics import: ICS parsing, RRULE expansion, time zones
// and the SSRF guard. Run: npx jiti scripts/calendar-sync.test.ts   (add --live to also fetch a
// public Google holidays feed through the real network path).
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { expandCalendar } from "../src/lib/ics/expand";
import { parseIcs, unescapeText } from "../src/lib/ics/parse";
import { toJsCalendar } from "../src/lib/ics/to-jscalendar";
import { ianaFor } from "../src/lib/ics/zones";
import {
  fetchCalendarFeed,
  isBlockedAddress,
  normalizeFeedUrl,
  pinnedLookup,
  SafeFetchError,
  vetHost,
  type Resolver,
  type Transport,
} from "../src/lib/safe-fetch";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const cal = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
const ev = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
const iso = (ms: number) => new Date(ms).toISOString().replace(".000", "");
const range = (a: string, b: string) => [Date.parse(a), Date.parse(b)] as const;
const starts = (text: string, a: string, b: string, tz = "UTC") => {
  const [from, to] = range(a, b);
  return expandCalendar(parseIcs(text), from, to, tz).map((o) => iso(o.utcStart));
};

const BERLIN_VTZ = [
  "BEGIN:VTIMEZONE",
  "TZID:Custom Central",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
].join("\r\n");

async function main() {
  // ---------------------------------------------------------------- parsing
  await test("unfolding, escaped text, params with quotes", () => {
    const c = parseIcs(
      cal(
        "X-WR-CALNAME:Team\\, offsite",
        ev(
          "UID:a1",
          "DTSTART:20261116T100000Z",
          "DTEND:20261116T110000Z",
          "SUMMARY:Long title that is",
          "  folded here",
          "DESCRIPTION:Line 1\\nLine 2\\; semi\\, comma \\\\ backslash",
          'LOCATION;ALTREP="http://x.example/a:b;c":Room 1',
        ),
      ),
    );
    assert.equal(c.name, "Team, offsite");
    assert.equal(c.events[0].title, "Long title that is folded here");
    assert.equal(c.events[0].description, "Line 1\nLine 2; semi, comma \\ backslash");
    assert.equal(c.events[0].location, "Room 1");
    assert.equal(unescapeText("a\\Nb"), "a\nb");
  });

  await test("rejects non-calendars", () => {
    assert.throws(() => parseIcs("<html>nope</html>"));
  });

  await test("Windows / Mozilla / UTC zone names → IANA", () => {
    assert.equal(ianaFor("W. Europe Standard Time"), "Europe/Berlin");
    assert.equal(ianaFor("Pacific Standard Time"), "America/Los_Angeles");
    assert.equal(ianaFor("Romance Standard Time"), "Europe/Paris");
    assert.equal(ianaFor("/mozilla.org/20050126_1/America/New_York"), "America/New_York");
    assert.equal(ianaFor("Europe/Madrid"), "Europe/Madrid");
    assert.equal(ianaFor("GMT"), "UTC");
    assert.equal(ianaFor("Nowhere Standard Time"), null);
  });

  // --------------------------------------------------------------- time zones / DST
  await test("TZID weekly event keeps wall time across US DST start", () => {
    const text = cal(ev("UID:w", "DTSTART;TZID=America/New_York:20260302T090000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;COUNT=3"));
    assert.deepEqual(starts(text, "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"), [
      "2026-03-02T14:00:00Z", // EST
      "2026-03-09T13:00:00Z", // EDT after Mar 8
      "2026-03-16T13:00:00Z",
    ]);
  });

  await test("Outlook Windows TZID with VTIMEZONE → Europe/Berlin (DST end)", () => {
    const text = cal(
      "BEGIN:VTIMEZONE",
      "TZID:W. Europe Standard Time",
      "BEGIN:STANDARD",
      "DTSTART:16010101T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10",
      "END:STANDARD",
      "END:VTIMEZONE",
      ev("UID:o", 'DTSTART;TZID="W. Europe Standard Time":20261023T100000', 'DTEND;TZID="W. Europe Standard Time":20261023T103000', "RRULE:FREQ=DAILY;COUNT=4"),
    );
    assert.deepEqual(starts(text, "2026-10-20T00:00:00Z", "2026-11-01T00:00:00Z"), [
      "2026-10-23T08:00:00Z",
      "2026-10-24T08:00:00Z",
      "2026-10-25T09:00:00Z", // CET from Oct 25
      "2026-10-26T09:00:00Z",
    ]);
  });

  await test("custom VTIMEZONE without IANA equivalent is evaluated from its rules", () => {
    const text = cal(BERLIN_VTZ, ev("UID:c", "DTSTART;TZID=Custom Central:20260325T120000", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=6"));
    assert.deepEqual(starts(text, "2026-03-20T00:00:00Z", "2026-04-05T00:00:00Z"), [
      "2026-03-25T11:00:00Z",
      "2026-03-26T11:00:00Z",
      "2026-03-27T11:00:00Z",
      "2026-03-28T11:00:00Z",
      "2026-03-29T10:00:00Z", // summer time from Mar 29 02:00
      "2026-03-30T10:00:00Z",
    ]);
  });

  await test("time in the spring-forward gap still produces an occurrence", () => {
    const text = cal(ev("UID:g", "DTSTART;TZID=America/New_York:20260307T023000", "DURATION:PT30M", "RRULE:FREQ=DAILY;COUNT=3"));
    const s = starts(text, "2026-03-07T00:00:00Z", "2026-03-11T00:00:00Z");
    assert.equal(s.length, 3);
    assert.equal(s[0], "2026-03-07T07:30:00Z");
    assert.equal(s[2], "2026-03-09T06:30:00Z");
  });

  await test("floating times use X-WR-TIMEZONE", () => {
    const text = cal("X-WR-TIMEZONE:Europe/Madrid", ev("UID:f", "DTSTART:20260715T100000", "DTEND:20260715T110000"));
    assert.deepEqual(starts(text, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"), ["2026-07-15T08:00:00Z"]);
  });

  // ---------------------------------------------------------------- all-day
  await test("all-day events (single, multi-day, yearly) in the viewer's zone", () => {
    const text = cal(
      ev("UID:d1", "DTSTART;VALUE=DATE:20261224", "DTEND;VALUE=DATE:20261227", "SUMMARY:Holidays"),
      ev("UID:d2", "DTSTART;VALUE=DATE:20200229", "RRULE:FREQ=YEARLY", "SUMMARY:Leap"),
      ev("UID:d3", "DTSTART:20261231", "SUMMARY:No VALUE param"),
    );
    const [from, to] = range("2026-12-01T00:00:00Z", "2029-01-01T00:00:00Z");
    const occ = expandCalendar(parseIcs(text), from, to, "Europe/Madrid");
    const d1 = occ.find((o) => o.uid === "d1")!;
    assert.equal(d1.allDay, true);
    assert.equal(d1.startDay, "2026-12-24");
    assert.equal(d1.endDay, "2026-12-27");
    assert.equal(iso(d1.utcStart), "2026-12-23T23:00:00Z");
    // Feb 29 only exists in leap years (RFC 5545: invalid dates are skipped).
    assert.deepEqual(occ.filter((o) => o.uid === "d2").map((o) => o.startDay), ["2028-02-29"]);
    assert.equal(occ.find((o) => o.uid === "d3")?.allDay, true);
  });

  // ---------------------------------------------------------------- RRULE
  await test("MONTHLY BYDAY ordinals (2MO, -1FR) and BYMONTHDAY=-1", () => {
    const a = cal(ev("UID:m1", "DTSTART:20260112T090000Z", "RRULE:FREQ=MONTHLY;BYDAY=2MO;COUNT=3"));
    assert.deepEqual(starts(a, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"), [
      "2026-01-12T09:00:00Z",
      "2026-02-09T09:00:00Z",
      "2026-03-09T09:00:00Z",
    ]);
    const b = cal(ev("UID:m2", "DTSTART:20260130T090000Z", "RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20260430T000000Z"));
    assert.deepEqual(starts(b, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"), [
      "2026-01-30T09:00:00Z",
      "2026-02-27T09:00:00Z",
      "2026-03-27T09:00:00Z",
      "2026-04-24T09:00:00Z",
    ]);
    const c = cal(ev("UID:m3", "DTSTART:20260131T090000Z", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3"));
    assert.deepEqual(starts(c, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"), [
      "2026-01-31T09:00:00Z",
      "2026-02-28T09:00:00Z",
      "2026-03-31T09:00:00Z",
    ]);
  });

  await test("MONTHLY on the 31st skips short months", () => {
    const t = cal(ev("UID:m4", "DTSTART:20260131T090000Z", "RRULE:FREQ=MONTHLY;COUNT=3"));
    assert.deepEqual(starts(t, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"), [
      "2026-01-31T09:00:00Z",
      "2026-03-31T09:00:00Z",
      "2026-05-31T09:00:00Z",
    ]);
  });

  await test("YEARLY BYMONTH+BYDAY (US Thanksgiving) and last weekday via BYSETPOS", () => {
    const t = cal(ev("UID:y", "DTSTART;VALUE=DATE:20241128", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH"));
    const [from, to] = range("2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z");
    assert.deepEqual(
      expandCalendar(parseIcs(t), from, to, "UTC").map((o) => o.startDay),
      ["2026-11-26", "2027-11-25"],
    );
    const s = cal(ev("UID:sp", "DTSTART:20260130T170000Z", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3"));
    assert.deepEqual(starts(s, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"), [
      "2026-01-30T17:00:00Z",
      "2026-02-27T17:00:00Z",
      "2026-03-31T17:00:00Z",
    ]);
  });

  await test("WEEKLY BYDAY with INTERVAL and WKST", () => {
    const t = cal(ev("UID:wk", "DTSTART:20260105T080000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=5;WKST=MO"));
    assert.deepEqual(starts(t, "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"), [
      "2026-01-05T08:00:00Z",
      "2026-01-08T08:00:00Z",
      "2026-01-19T08:00:00Z",
      "2026-01-22T08:00:00Z",
      "2026-02-02T08:00:00Z",
    ]);
  });

  await test("old open-ended daily series fast-forwards to the window", () => {
    const t = cal(ev("UID:old", "DTSTART:19900101T120000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY"));
    const s = starts(t, "2026-11-16T00:00:00Z", "2026-11-19T00:00:00Z");
    assert.deepEqual(s, ["2026-11-16T12:00:00Z", "2026-11-17T12:00:00Z", "2026-11-18T12:00:00Z"]);
  });

  await test("COUNT is honored from the series start even when the window is later", () => {
    const t = cal(ev("UID:cnt", "DTSTART:20260101T120000Z", "RRULE:FREQ=DAILY;COUNT=10"));
    assert.deepEqual(starts(t, "2026-01-09T00:00:00Z", "2026-02-01T00:00:00Z"), ["2026-01-09T12:00:00Z", "2026-01-10T12:00:00Z"]);
  });

  await test("expansion is capped", () => {
    const t = cal(ev("UID:cap", "DTSTART:20260101T000000Z", "RRULE:FREQ=DAILY"));
    const [from, to] = range("2026-01-01T00:00:00Z", "2036-01-01T00:00:00Z");
    assert.ok(expandCalendar(parseIcs(t), from, to, "UTC").length <= 1000);
  });

  await test("unsupported rules (HOURLY, BYWEEKNO) fall back to the first occurrence", () => {
    const t = cal(ev("UID:h", "DTSTART:20260101T000000Z", "RRULE:FREQ=HOURLY;COUNT=5"), ev("UID:wn", "DTSTART:20260101T000000Z", "RRULE:FREQ=YEARLY;BYWEEKNO=20"));
    assert.equal(starts(t, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z").length, 2);
  });

  // ---------------------------------------------------------------- EXDATE / overrides / cancellations
  const series = cal(
    ev(
      "UID:s1",
      "SUMMARY:Standup",
      "DTSTART;TZID=Europe/Madrid:20261116T093000",
      "DTEND;TZID=Europe/Madrid:20261116T094500",
      "RRULE:FREQ=DAILY;COUNT=5",
      "EXDATE;TZID=Europe/Madrid:20261117T093000",
    ),
    ev("UID:s1", "RECURRENCE-ID;TZID=Europe/Madrid:20261118T093000", "SUMMARY:Standup (moved)", "DTSTART;TZID=Europe/Madrid:20261118T150000", "DTEND;TZID=Europe/Madrid:20261118T151500"),
    ev("UID:s1", "RECURRENCE-ID:20261119T083000Z", "STATUS:CANCELLED", "DTSTART:20261119T083000Z", "SUMMARY:Standup"),
    ev("UID:gone", "STATUS:CANCELLED", "DTSTART:20261118T100000Z", "SUMMARY:Cancelled"),
    ev("UID:free", "TRANSP:TRANSPARENT", "DTSTART:20261118T110000Z", "DURATION:PT1H", "SUMMARY:FYI"),
  );

  await test("EXDATE, RECURRENCE-ID override (moved), cancelled instance and cancelled event", () => {
    const [from, to] = range("2026-11-16T00:00:00Z", "2026-11-23T00:00:00Z");
    const occ = expandCalendar(parseIcs(series), from, to, "Europe/Madrid");
    const s1 = occ.filter((o) => o.uid === "s1").map((o) => `${iso(o.utcStart)} ${o.title}`);
    assert.deepEqual(s1, ["2026-11-16T08:30:00Z Standup", "2026-11-18T14:00:00Z Standup (moved)", "2026-11-20T08:30:00Z Standup"]);
    assert.ok(!occ.some((o) => o.uid === "gone"));
    assert.equal(occ.find((o) => o.uid === "free")?.transparent, true);
  });

  await test("DATE-valued EXDATE on an all-day series", () => {
    const t = cal(ev("UID:ad", "DTSTART;VALUE=DATE:20261101", "RRULE:FREQ=WEEKLY;COUNT=3", "EXDATE;VALUE=DATE:20261108"));
    const [from, to] = range("2026-10-01T00:00:00Z", "2026-12-31T00:00:00Z");
    assert.deepEqual(expandCalendar(parseIcs(t), from, to, "UTC").map((o) => o.startDay), ["2026-11-01", "2026-11-15"]);
  });

  // ---------------------------------------------------------------- import conversion
  await test("toJsCalendar: series with rule, excluded and patched overrides", () => {
    const { items, cancelled } = toJsCalendar(parseIcs(series));
    assert.equal(cancelled, 1);
    const s1 = items.find((i) => i.uid === "s1")!.event;
    assert.equal(s1.start, "2026-11-16T09:30:00");
    assert.equal(s1.timeZone, "Europe/Madrid");
    assert.equal(s1.duration, "PT15M");
    assert.deepEqual(s1.recurrenceRules, [{ "@type": "RecurrenceRule", frequency: "daily", count: 5 }]);
    const ov = s1.recurrenceOverrides as Record<string, Record<string, unknown>>;
    assert.deepEqual(ov["2026-11-17T09:30:00"], { excluded: true });
    assert.deepEqual(ov["2026-11-19T09:30:00"], { excluded: true });
    assert.equal(ov["2026-11-18T09:30:00"].start, "2026-11-18T15:00:00");
    assert.equal(ov["2026-11-18T09:30:00"].title, "Standup (moved)");
    assert.equal(items.find((i) => i.uid === "free")!.event.freeBusyStatus, "free");
    const allDay = toJsCalendar(parseIcs(cal(ev("UID:ad2", "DTSTART;VALUE=DATE:20261224", "DTEND;VALUE=DATE:20261226")))).items[0].event;
    assert.equal(allDay.showWithoutTime, true);
    assert.equal(allDay.duration, "P2D");
    assert.equal(allDay.timeZone, undefined);
  });

  // ---------------------------------------------------------------- SSRF guard
  await test("URL policy: https/webcal only, no credentials, standard ports", () => {
    assert.equal(normalizeFeedUrl("webcal://calendar.google.com/calendar/ical/x/basic.ics").protocol, "https:");
    assert.equal(normalizeFeedUrl("WEBCALS://example.com/a.ics").href, "https://example.com/a.ics");
    for (const bad of ["http://example.com/a.ics", "ftp://example.com/a", "file:///etc/passwd", "https://user:pw@example.com/a.ics", "https://example.com:8080/a.ics", "javascript:alert(1)", ""]) {
      assert.throws(() => normalizeFeedUrl(bad), SafeFetchError, bad);
    }
  });

  await test("blocked address ranges (IPv4, IPv6, mapped, NAT64, 6to4)", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe",
      "fe80::1", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1", "64:ff9b::7f00:1", "2002:7f00:1::1", "2001:0:1::1", "2001:db8::1", "not-an-ip",
    ]) assert.equal(isBlockedAddress(ip), true, ip);
    for (const ip of ["8.8.8.8", "142.250.184.14", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4003:80e::200e", "::ffff:8.8.8.8"]) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  const publicResolver: Resolver = async () => [{ address: "93.184.215.14", family: 4 }];

  await test("decimal / hex / octal / bracketed IPv6 host forms are canonicalized and blocked", async () => {
    for (const u of ["https://2130706433/a.ics", "https://0x7f000001/a.ics", "https://0x7f.0.0.1/a.ics", "https://017700000001/a.ics", "https://127.1/a.ics", "https://[::1]/a.ics", "https://[::ffff:127.0.0.1]/a.ics", "https://[::ffff:a9fe:a9fe]/x", "https://localhost/a.ics", "https://metadata.google.internal/computeMetadata/v1/"]) {
      await assert.rejects(vetHost(normalizeFeedUrl(u), publicResolver), (e: unknown) => e instanceof SafeFetchError && e.code === "blocked", u);
    }
  });

  await test("any private address among the DNS answers blocks the host", async () => {
    const mixed: Resolver = async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ];
    await assert.rejects(vetHost(normalizeFeedUrl("https://feed.example/a.ics"), mixed), /blocked/);
    const v6: Resolver = async () => [{ address: "fd00::1", family: 6 }];
    await assert.rejects(vetHost(normalizeFeedUrl("https://feed.example/a.ics"), v6), /blocked/);
  });

  const body = (text: string | Buffer) => Readable.from([Buffer.isBuffer(text) ? text : Buffer.from(text)]);
  const ICS = cal(ev("UID:x", "DTSTART:20261116T100000Z", "SUMMARY:Hi"));

  await test("DNS rebinding: the connection is pinned to the address that was vetted", async () => {
    let calls = 0;
    const rebinding: Resolver = async () => (calls++ === 0 ? [{ address: "93.184.215.14", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
    let connectedTo = "";
    const transport: Transport = async (_url, vetted) => {
      // What the socket's lookup would return: always the vetted address, whatever DNS says now.
      await new Promise<void>((done) =>
        pinnedLookup(vetted)("feed.example", {}, (_err: unknown, address: unknown) => {
          connectedTo = String(address);
          done();
        }),
      );
      await new Promise<void>((done) =>
        pinnedLookup(vetted)("feed.example", { all: true }, (_err: unknown, list: unknown) => {
          assert.deepEqual(list, [{ address: "93.184.215.14", family: 4 }]);
          done();
        }),
      );
      return { status: 200, headers: { "content-type": "text/calendar" }, body: body(ICS) };
    };
    const r = await fetchCalendarFeed("https://feed.example/a.ics", {}, { resolve: rebinding, transport });
    assert.equal(r.kind, "ok");
    assert.equal(connectedTo, "93.184.215.14");
    assert.equal(calls, 1);
  });

  await test("redirects are re-validated (private target, http downgrade, too many)", async () => {
    const resolver: Resolver = async (host) =>
      host === "internal.example" ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "93.184.215.14", family: 4 }];
    const redirectTo = (location: string): Transport => async (url) =>
      url.hostname === "feed.example" ? { status: 302, headers: { location }, body: body("") } : { status: 200, headers: { "content-type": "text/calendar" }, body: body(ICS) };
    await assert.rejects(fetchCalendarFeed("https://feed.example/a", {}, { resolve: resolver, transport: redirectTo("https://internal.example/a.ics") }), /blocked/);
    await assert.rejects(fetchCalendarFeed("https://feed.example/a", {}, { resolve: resolver, transport: redirectTo("https://169.254.169.254/latest/meta-data") }), /blocked/);
    await assert.rejects(fetchCalendarFeed("https://feed.example/a", {}, { resolve: resolver, transport: redirectTo("http://other.example/a.ics") }), /invalid_url/);
    const ok = await fetchCalendarFeed("https://feed.example/a", {}, { resolve: resolver, transport: redirectTo("https://cdn.example/a.ics") });
    assert.equal(ok.kind, "ok");
    let hops = 0;
    const loop: Transport = async () => ({ status: 301, headers: { location: `https://feed.example/${++hops}` }, body: body("") });
    await assert.rejects(fetchCalendarFeed("https://feed.example/a", {}, { resolve: resolver, transport: loop }), /redirects/);
    assert.equal(hops, 4); // first request + 3 redirects followed
  });

  await test("size cap, content type, conditional GET, gzip", async () => {
    const big: Transport = async () => ({ status: 200, headers: { "content-type": "text/calendar", "content-length": String(11 * 1024 * 1024) }, body: body("") });
    await assert.rejects(fetchCalendarFeed("https://feed.example/a", {}, { resolve: publicResolver, transport: big }), /too_large/);
    const streamBig: Transport = async () => ({
      status: 200,
      headers: { "content-type": "text/calendar" },
      body: Readable.from((function* () {
        for (let i = 0; i < 12; i++) yield Buffer.alloc(1024 * 1024, 65);
      })()),
    });
    await assert.rejects(fetchCalendarFeed("https://feed.example/a", {}, { resolve: publicResolver, transport: streamBig }), /too_large/);
    const bomb: Transport = async () => ({
      status: 200,
      headers: { "content-type": "text/calendar", "content-encoding": "gzip" },
      body: body(gzipSync(Buffer.alloc(20 * 1024 * 1024, 65))),
    });
    await assert.rejects(fetchCalendarFeed("https://feed.example/a", {}, { resolve: publicResolver, transport: bomb }), /too_large/);
    const html: Transport = async () => ({ status: 200, headers: { "content-type": "text/html" }, body: body("<html>") });
    await assert.rejects(fetchCalendarFeed("https://feed.example/a", {}, { resolve: publicResolver, transport: html }), /not_calendar/);
    let sent: Record<string, string> = {};
    const notModified: Transport = async (_u, _v, headers) => {
      sent = headers;
      return { status: 304, headers: {}, body: body("") };
    };
    const r = await fetchCalendarFeed("https://feed.example/a", { etag: '"v1"', lastModified: "Mon, 16 Nov 2026 10:00:00 GMT" }, { resolve: publicResolver, transport: notModified });
    assert.equal(r.kind, "not_modified");
    assert.equal(sent["If-None-Match"], '"v1"');
    const gz: Transport = async () => ({ status: 200, headers: { "content-type": "text/calendar; charset=utf-8", "content-encoding": "gzip", etag: '"v2"' }, body: body(gzipSync(ICS)) });
    const g = await fetchCalendarFeed("https://feed.example/a", {}, { resolve: publicResolver, transport: gz });
    assert.ok(g.kind === "ok" && g.etag === '"v2"' && g.text.startsWith("BEGIN:VCALENDAR"));
    const err: Transport = async () => ({ status: 404, headers: {}, body: body("") });
    await assert.rejects(fetchCalendarFeed("https://feed.example/a", {}, { resolve: publicResolver, transport: err }), /http 404/);
  });

  await test("a stalled (compressed) body hits the 10 s deadline", async () => {
    const stalled: Transport = async () => ({
      status: 200,
      headers: { "content-type": "text/calendar", "content-encoding": "gzip" },
      body: new Readable({ read() {} }),
    });
    const t0 = Date.now();
    await assert.rejects(fetchCalendarFeed("https://feed.example/a", {}, { resolve: publicResolver, transport: stalled }), /timeout/);
    assert.ok(Date.now() - t0 < 12_000);
  });

  if (process.argv.includes("--live")) {
    await test("live: subscribe → sealed URL in sqlite → cached events → unsubscribe", async () => {
      const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "zw-subs-"));
      process.env.DATA_DIR = dir;
      process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret-123";
      const svc = await import("../src/lib/calendar-subs/service");
      const url = "webcal://calendar.google.com/calendar/ical/es.spain%23holiday%40group.v.calendar.google.com/public/basic.ics";
      const sub = await svc.addSubscription("test-user", { url, name: "", color: "#3b6cf6", busy: true, refreshMin: 15 });
      assert.ok(sub.name.length > 0, "name from X-WR-CALNAME");
      await assert.rejects(svc.addSubscription("test-user", { url, name: "", color: "#3b6cf6", busy: true, refreshMin: 15 }), /duplicate/);
      const [from, to] = range("2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z");
      const events = svc.subscriptionEvents("test-user", from, to, "Europe/Madrid");
      console.log(`  subscribed "${sub.name}" (${sub.eventCount} events); December 2026: ${events.map((e) => `${e.startDay} ${e.title}`).join(" | ")}`);
      assert.ok(events.some((e) => e.startDay === "2026-12-25" && e.allDay && e.external?.name === sub.name));
      // The URL is never stored in clear.
      assert.ok(!readFileSync(join(dir, "calendar-subs.sqlite")).toString("latin1").includes("calendar.google.com/calendar/ical"));
      // Holidays are all-day, so they never block booking slots.
      assert.equal(svc.subscriptionBusy("test-user", from, to, "Europe/Madrid").length, 0);
      const r = await svc.refreshNow("test-user", sub.id).catch((e: Error) => ({ ok: false, error: e.message }));
      console.log(`  refresh now right after subscribing → ${JSON.stringify(r)}`);
      svc.removeSubscription("test-user", sub.id);
      assert.equal(svc.listSubscriptions("test-user").length, 0);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    });

    await test("live: Google public holidays feed", async () => {
      const url = "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics";
      const r = await fetchCalendarFeed(url);
      assert.equal(r.kind, "ok");
      if (r.kind !== "ok") return;
      const parsed = parseIcs(r.text);
      const [from, to] = range("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
      const occ = expandCalendar(parsed, from, to, "America/New_York");
      console.log(`  live feed "${parsed.name}": ${parsed.events.length} events, ${occ.length} in 2026, etag=${r.etag ? "yes" : "no"}`);
      assert.ok(occ.some((o) => o.allDay));
      const again = await fetchCalendarFeed(url, { etag: r.etag, lastModified: r.lastModified });
      console.log(`  conditional refetch → ${again.kind}`);
    });
  }

  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  if (failures.length) process.exit(1);
}

void main();
