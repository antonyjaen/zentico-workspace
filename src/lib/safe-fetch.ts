// Server-side fetch of user-supplied calendar URLs (external calendar subscriptions) with SSRF
// protection. Server-only.
//
// - https only (webcal:// and webcals:// are rewritten to https://); no credentials in the URL;
//   only the default port (443) or 8443.
// - The host is resolved here and EVERY address must be public (no loopback, private, link-local,
//   CGNAT, metadata, multicast, documentation, IPv6 ULA/site-local, NAT64/6to4/Teredo…). The
//   connection then goes to that vetted address (pinned via `lookup`), so a DNS answer that changes
//   between the check and the connection (rebinding) can't redirect it; TLS still verifies the
//   certificate against the hostname.
// - Redirects are followed manually (max 3), each hop re-validated the same way.
// - 10 s overall deadline, 10 MB cap (after decompression), text/calendar or text/plain only.
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export type FetchErrorCode =
  | "invalid_url"
  | "blocked"
  | "dns"
  | "timeout"
  | "too_large"
  | "not_calendar"
  | "redirects"
  | "http"
  | "network";

export class SafeFetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    readonly status?: number,
  ) {
    super(status ? `${code} ${status}` : code);
  }
}

export const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const ALLOWED_PORTS = new Set(["", "443", "8443"]);

/** Normalizes a feed URL typed by a user (webcal → https) or throws invalid_url. */
export function normalizeFeedUrl(input: string): URL {
  const raw = (input ?? "").trim();
  if (!raw || raw.length > 2048) throw new SafeFetchError("invalid_url");
  const rewritten = raw.replace(/^webcals?:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(rewritten);
  } catch {
    throw new SafeFetchError("invalid_url");
  }
  if (url.protocol !== "https:") throw new SafeFetchError("invalid_url");
  if (url.username || url.password) throw new SafeFetchError("invalid_url");
  if (!url.hostname || !ALLOWED_PORTS.has(url.port)) throw new SafeFetchError("invalid_url");
  url.hash = "";
  return url;
}

// ---- Address policy ----

const blocked4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) blocked4.addSubnet(net, prefix, "ipv4");

const blocked6 = new BlockList();
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible (mapped ::ffff:0:0/96 handled separately)
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) blocked6.addSubnet(net, prefix, "ipv6");

/** Expands an IPv6 address into its 8 16-bit groups (null if malformed). */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase().split("%")[0];
  // Trailing dotted IPv4 ("::ffff:1.2.3.4") → two hex groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    if (isIP(v4[1]) !== 4) return null;
    const p = v4[1].split(".").map(Number);
    addr = addr.slice(0, -v4[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True when an IP literal must never be fetched (anything that isn't plain public unicast). */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked4.check(ip, "ipv4");
  if (family !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  // IPv4-mapped (::ffff:a.b.c.d): judge the embedded IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isBlockedAddress(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  const canonical = g.map((x) => x.toString(16)).join(":");
  return blocked6.check(canonical, "ipv6");
}

export type Resolved = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<Resolved[]>;

const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

/** Resolves the URL's host and checks every address; returns the one to connect to. */
export async function vetHost(url: URL, resolve: Resolver = systemResolver): Promise<Resolved> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new SafeFetchError("blocked");
  }
  const literal = isIP(host);
  let addresses: Resolved[];
  if (literal) addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new SafeFetchError("dns");
    }
  }
  if (!addresses.length) throw new SafeFetchError("dns");
  if (addresses.some((a) => isBlockedAddress(a.address))) throw new SafeFetchError("blocked");
  return addresses.find((a) => a.family === 4) ?? addresses[0];
}

/** A dns.lookup replacement that always answers with the vetted address. */
export function pinnedLookup(vetted: Resolved): LookupFunction {
  return ((_hostname: string, options: { all?: boolean } | number | undefined, callback?: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
    const all = typeof options === "object" && options?.all;
    if (all) cb(null, [{ address: vetted.address, family: vetted.family }]);
    else cb(null, vetted.address, vetted.family);
  }) as LookupFunction;
}

// ---- Transport ----

export type TransportResponse = { status: number; headers: IncomingHttpHeaders; body: Readable };
export type Transport = (url: URL, vetted: Resolved, headers: Record<string, string>, signal: AbortSignal) => Promise<TransportResponse>;

const httpsTransport: Transport = (url, vetted, headers, signal) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        lookup: pinnedLookup(vetted),
        agent: false,
        signal,
        ...(isIP(url.hostname.replace(/^\[|\]$/g, "")) ? {} : { servername: url.hostname }),
      },
      (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }),
    );
    req.on("error", reject);
    req.end();
  });

async function readBody(res: TransportResponse, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    res.body.destroy();
    throw new SafeFetchError("too_large");
  }
  const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase().trim();
  let stream: Readable = res.body;
  if (encoding === "gzip" || encoding === "x-gzip") stream = res.body.pipe(createGunzip());
  else if (encoding === "deflate") stream = res.body.pipe(createInflate());
  else if (encoding === "br") stream = res.body.pipe(createBrotliDecompress());
  else if (encoding !== "identity" && encoding !== "") {
    res.body.destroy();
    throw new SafeFetchError("not_calendar");
  }
  // Errors and the deadline must reach the decompressor too, or iterating it could hang.
  if (stream !== res.body) res.body.once("error", (e) => stream.destroy(e));
  const onAbort = () => stream.destroy(new SafeFetchError("timeout"));
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new SafeFetchError("timeout");
      size += (chunk as Buffer).length;
      if (size > MAX_BYTES) throw new SafeFetchError("too_large");
      chunks.push(chunk as Buffer);
    }
  } catch (e) {
    res.body.destroy();
    if (e instanceof SafeFetchError) throw e;
    throw new SafeFetchError(signal.aborted ? "timeout" : "network");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

const CALENDAR_TYPES = new Set(["text/calendar", "text/plain"]);

export type FeedResult =
  | { kind: "not_modified" }
  | { kind: "ok"; text: string; etag: string; lastModified: string };

/**
 * GETs a calendar feed with the protections above. `etag` / `lastModified` make it conditional
 * (a 304 returns `not_modified`). Throws SafeFetchError.
 */
export async function fetchCalendarFeed(
  input: string,
  conditional: { etag?: string; lastModified?: string } = {},
  deps: { resolve?: Resolver; transport?: Transport } = {},
): Promise<FeedResult> {
  const transport = deps.transport ?? httpsTransport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let url = normalizeFeedUrl(input);
    for (let hop = 0; ; hop++) {
      const vetted = await vetHost(url, deps.resolve);
      const headers: Record<string, string> = {
        Accept: "text/calendar, text/plain;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": "ZenticoCalendar/1.0 (+calendar subscription)",
      };
      // Validators only apply to the URL they came from.
      if (hop === 0 && conditional.etag) headers["If-None-Match"] = conditional.etag;
      if (hop === 0 && conditional.lastModified) headers["If-Modified-Since"] = conditional.lastModified;

      let res: TransportResponse;
      try {
        res = await transport(url, vetted, headers, controller.signal);
      } catch (e) {
        if (e instanceof SafeFetchError) throw e;
        throw new SafeFetchError(controller.signal.aborted ? "timeout" : "network");
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        res.body.destroy();
        const location = res.headers.location;
        if (!location || hop >= MAX_REDIRECTS) throw new SafeFetchError("redirects");
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new SafeFetchError("invalid_url");
        }
        // Re-validated like the first URL (scheme, credentials, port, then DNS + addresses).
        url = normalizeFeedUrl(next.toString());
        continue;
      }
      if (res.status === 304) {
        res.body.destroy();
        return { kind: "not_modified" };
      }
      if (res.status < 200 || res.status >= 300) {
        res.body.destroy();
        throw new SafeFetchError("http", res.status);
      }
      const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (type && !CALENDAR_TYPES.has(type)) {
        res.body.destroy();
        throw new SafeFetchError("not_calendar");
      }
      const text = await readBody(res, controller.signal);
      if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(text)) throw new SafeFetchError("not_calendar");
      const header = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : (h ?? "")).slice(0, 200);
      return { kind: "ok", text, etag: header(res.headers.etag), lastModified: header(res.headers["last-modified"]) };
    }
  } finally {
    clearTimeout(timer);
  }
}
