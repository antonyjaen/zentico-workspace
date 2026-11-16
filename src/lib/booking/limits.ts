// In-process sliding-window rate limits for the public booking endpoints (single instance, like
// Chat and the MCP token limits). Server-only.

const g = globalThis as typeof globalThis & { __zwBookingHits?: Map<string, number[]> };
const hits: Map<string, number[]> = (g.__zwBookingHits ??= new Map());

/** Records a hit on `key`; returns seconds to wait when over `limit` per `windowMs`, else 0. */
export function hit(key: string, limit: number, windowMs: number): number {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(key, list);
    return Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 20_000) hits.clear();
  return 0;
}

/** Limits per action: [per client IP, per booking page] as [count, window]. */
export const LIMITS = {
  slots: { ip: [90, 60_000], page: [600, 60_000] },
  book: { ip: [8, 10 * 60_000], page: [30, 60 * 60_000] },
  manage: { ip: [20, 10 * 60_000], page: [30, 60 * 60_000] },
  join: { ip: [30, 10 * 60_000], page: [60, 10 * 60_000] },
} as const satisfies Record<string, { ip: readonly [number, number]; page: readonly [number, number] }>;

/** Checks both limits of `action`; returns seconds to wait (0 = allowed). */
export function limit(action: keyof typeof LIMITS, ip: string, page: string): number {
  const l = LIMITS[action];
  return hit(`${action}:ip:${ip}`, l.ip[0], l.ip[1]) || hit(`${action}:page:${page}`, l.page[0], l.page[1]);
}

/** Client IP as seen by the reverse proxy (first X-Forwarded-For hop), else "unknown". */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = xff || headers.get("x-real-ip")?.trim() || "unknown";
  return ip.slice(0, 64);
}
