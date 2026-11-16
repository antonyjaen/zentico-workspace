// Outbound HTTPS POSTs to user-supplied URLs (app event endpoints) without SSRF: https only, no
// credentials in the URL, no redirects, and the host is resolved at request time with every
// address checked against private/loopback/link-local/reserved ranges. The check runs inside the
// socket's own DNS lookup, so the address that was checked is the one connected to (no DNS
// rebinding window). Server-only.
import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

/** True for addresses we must never connect to (IPv4-mapped/compatible IPv6 checked as IPv4). */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  // ::ffff:127.0.0.1 (mapped) and ::127.0.0.1 (deprecated compatible form)
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  // ::ffff:7f00:1 style mapped addresses
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
  }
  return blocked.check(address, "ipv6");
}

export class UnsafeUrlError extends Error {}

/** Static checks for an endpoint URL (at save time and before each request). */
export function checkEndpointUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid URL");
  }
  if (u.protocol !== "https:") throw new UnsafeUrlError("only https:// URLs are allowed");
  if (u.username || u.password) throw new UnsafeUrlError("credentials in the URL are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("private host");
  }
  if (isIP(host) && isBlockedAddress(host)) throw new UnsafeUrlError("private address");
  return u;
}

/** dns.lookup that refuses hosts resolving to any blocked address (all of them are checked). */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, family: options.family as number | undefined }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = (addresses ?? []).filter((a) => a.family === 4 || a.family === 6);
    if (!list.length) return callback(new UnsafeUrlError("no address"), "", 0);
    if (list.some((a) => isBlockedAddress(a.address))) return callback(new UnsafeUrlError("resolves to a private address"), "", 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

export type SafeResponse = { status: number; contentType: string; body: string };

/** POSTs a body to an https URL with a hard timeout and response size cap. Throws on network/safety errors. */
export function safePost(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  { timeoutMs = 10_000, maxResponseBytes = 64 * 1024 }: { timeoutMs?: number; maxResponseBytes?: number } = {},
): Promise<SafeResponse> {
  const url = checkEndpointUrl(rawUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = request(
      url,
      {
        method: "POST",
        lookup: safeLookup,
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
        // No proxies or keep-alive pools shared with other code.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxResponseBytes) {
            req.destroy();
            done(() => reject(new Error("response too large")));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          done(() =>
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers["content-type"] ?? ""),
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
        res.on("error", (e) => done(() => reject(e)));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(() => reject(new Error("timed out")));
    }, timeoutMs);
    req.on("error", (e) => done(() => reject(e)));
    req.end(body);
  });
}
