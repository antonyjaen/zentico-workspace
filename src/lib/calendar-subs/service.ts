// External calendar subscriptions (ICS feeds): add/probe, refresh in the background, and turn the
// cached feeds into read-only calendar events for the Calendar views, booking pages (busy times)
// and the MCP calendar tools. Server-only; callers pass the owner (the signed-in user's `sub`).
import type { CalEvent } from "../calendar";
import { seal, unseal } from "../crypto";
import { expandCalendar } from "../ics/expand";
import { IcsError, parseIcs, type IcsCalendar } from "../ics/parse";
import { fetchCalendarFeed, normalizeFeedUrl, SafeFetchError } from "../safe-fetch";
import * as store from "./db";

export const MAX_SUBSCRIPTIONS = 20;
export const MIN_REFRESH_MIN = 5;
export const DEFAULT_REFRESH_MIN = 15;
export const MAX_REFRESH_MIN = 24 * 60;
const MAX_BACKOFF_MS = 6 * 3_600_000;

/** What the Calendar UI gets (never the URL: it is a secret, only its host is shown). */
export type Subscription = {
  id: string;
  key: string;
  name: string;
  color: string;
  host: string;
  visible: boolean;
  busy: boolean;
  refreshMin: number;
  lastSuccess: number;
  /** Error code of the last failed refresh ("" when the last refresh worked). */
  lastError: string;
  eventCount: number;
};

export const subscriptionKey = (id: string) => `sub/${id}`;

const toView = (r: store.SubscriptionRow): Subscription => ({
  id: r.id,
  key: subscriptionKey(r.id),
  name: r.name,
  color: r.color,
  host: r.host,
  visible: r.visible,
  busy: r.busy,
  refreshMin: r.refreshMin,
  lastSuccess: r.lastSuccess,
  lastError: r.lastError,
  eventCount: r.eventCount,
});

export const listSubscriptions = (owner: string): Subscription[] => store.listByOwner(owner).map(toView);

export class SubscriptionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const errorCode = (e: unknown): string =>
  e instanceof SafeFetchError ? (e.code === "http" ? `http_${e.status ?? 0}` : e.code) : e instanceof IcsError ? "not_calendar" : "failed";

// ---- Rate limits (per process; one app instance) ----

type G = typeof globalThis & {
  __zwSubsHits?: Map<string, number[]>;
  __zwSubsInflight?: Map<string, Promise<RefreshOutcome>>;
  __zwSubsParsed?: Map<string, { fetched: number; cal: IcsCalendar }>;
  __zwSubsProbes?: Map<string, { at: number; cal: IcsCalendar; etag: string; lastModified: string }>;
  __zwSubsSweeper?: ReturnType<typeof setInterval>;
};
const g = globalThis as G;
const hits: NonNullable<G["__zwSubsHits"]> = (g.__zwSubsHits ??= new Map());
const inflight: NonNullable<G["__zwSubsInflight"]> = (g.__zwSubsInflight ??= new Map());
const parsed: NonNullable<G["__zwSubsParsed"]> = (g.__zwSubsParsed ??= new Map());
const probes: NonNullable<G["__zwSubsProbes"]> = (g.__zwSubsProbes ??= new Map());

const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 20;

/** Counts one user-triggered fetch (probe, subscribe, refresh now); throws when over the limit. */
function takeToken(owner: string): void {
  const now = Date.now();
  const list = (hits.get(owner) ?? []).filter((t) => t > now - RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) throw new SubscriptionError("rate_limited");
  list.push(now);
  hits.set(owner, list);
  if (hits.size > 5000) hits.clear();
}

// ---- Fetch + cache ----

type RefreshOutcome = { ok: true } | { ok: false; error: string };

function remember(id: string, fetched: number, cal: IcsCalendar) {
  if (parsed.size >= 200) parsed.delete(parsed.keys().next().value as string);
  parsed.set(id, { fetched, cal });
}

/** The cached, parsed feed of a subscription (null before its first successful fetch). */
function cachedCalendar(id: string): IcsCalendar | null {
  const row = store.readCache(id);
  if (!row) return null;
  const hit = parsed.get(id);
  if (hit && hit.fetched === row.fetched) return hit.cal;
  try {
    const cal = JSON.parse(row.data) as IcsCalendar;
    remember(id, row.fetched, cal);
    return cal;
  } catch {
    return null;
  }
}

const nextAfterSuccess = (row: store.SubscriptionRow, now: number) => now + Math.max(MIN_REFRESH_MIN, row.refreshMin) * 60_000;
const nextAfterFailure = (row: store.SubscriptionRow, now: number) =>
  now + Math.min(MAX_BACKOFF_MS, Math.max(MIN_REFRESH_MIN, row.refreshMin) * 60_000 * 2 ** Math.min(row.failures, 6));

/** Fetches one subscription (conditional GET) and caches the parsed feed. One fetch per id at a time. */
export function refreshSubscription(row: store.SubscriptionRow): Promise<RefreshOutcome> {
  const running = inflight.get(row.id);
  if (running) return running;
  const job = (async (): Promise<RefreshOutcome> => {
    const now = Date.now();
    try {
      const url = await unseal<string>(row.urlSealed);
      if (!url) throw new SafeFetchError("invalid_url");
      const hasCache = !!store.readCache(row.id);
      const res = await fetchCalendarFeed(url, hasCache ? { etag: row.etag, lastModified: row.lastModified } : {});
      if (res.kind === "not_modified") {
        store.recordSuccess(row.id, now, nextAfterSuccess(row, now), { etag: row.etag, lastModified: row.lastModified }, null);
      } else {
        const cal = parseIcs(res.text);
        store.recordSuccess(row.id, now, nextAfterSuccess(row, now), res, { json: JSON.stringify(cal), eventCount: cal.events.length });
        remember(row.id, now, cal);
      }
      return { ok: true };
    } catch (e) {
      const code = errorCode(e);
      if (code === "failed") console.error("[calendar-subs] refresh failed", row.id, e instanceof Error ? e.message : e);
      store.recordFailure(row.id, now, nextAfterFailure(row, now), code);
      return { ok: false, error: code };
    }
  })().finally(() => inflight.delete(row.id));
  inflight.set(row.id, job);
  return job;
}

/** Starts (without waiting) refreshes of the owner's stale subscriptions; true if any started. */
export function refreshStale(owner: string): boolean {
  const now = Date.now();
  let started = false;
  for (const row of store.listByOwner(owner)) {
    if (row.nextFetch > now || inflight.has(row.id)) continue;
    started = true;
    void refreshSubscription(row);
  }
  return started;
}

/** Background sweep: refreshes due subscriptions of every user, a few at a time. */
async function sweep(): Promise<void> {
  const due = store.dueSubscriptions(Date.now(), 40).filter((r) => !inflight.has(r.id));
  for (let i = 0; i < due.length; i += 4) await Promise.all(due.slice(i, i + 4).map(refreshSubscription));
}

export function startSubscriptionSweeper(): void {
  if (g.__zwSubsSweeper) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweep();
    } catch (e) {
      console.error("[calendar-subs] sweep failed:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  };
  g.__zwSubsSweeper = setInterval(tick, 2 * 60_000);
  g.__zwSubsSweeper.unref?.();
  setTimeout(tick, 45_000).unref?.();
}

// ---- Managing ----

const probeKey = (owner: string, url: string) => `${owner}\n${url}`;

async function fetchForProbe(owner: string, url: URL) {
  const key = probeKey(owner, url.toString());
  const hit = probes.get(key);
  if (hit && hit.at > Date.now() - 5 * 60_000) return hit;
  takeToken(owner);
  let res;
  try {
    res = await fetchCalendarFeed(url.toString());
  } catch (e) {
    throw new SubscriptionError(errorCode(e));
  }
  if (res.kind !== "ok") throw new SubscriptionError("failed");
  let cal: IcsCalendar;
  try {
    cal = parseIcs(res.text);
  } catch {
    throw new SubscriptionError("not_calendar");
  }
  for (const [k, v] of probes) if (v.at < Date.now() - 5 * 60_000) probes.delete(k);
  if (probes.size >= 50) probes.delete(probes.keys().next().value as string);
  const entry = { at: Date.now(), cal, etag: res.etag, lastModified: res.lastModified };
  probes.set(key, entry);
  return entry;
}

function parseUrl(input: string): URL {
  try {
    return normalizeFeedUrl(input);
  } catch {
    throw new SubscriptionError("invalid_url");
  }
}

/** Fetches a feed the user is about to subscribe to: its name and how many events it has. */
export async function probeFeed(owner: string, input: string): Promise<{ name: string; events: number }> {
  const url = parseUrl(input);
  const { cal } = await fetchForProbe(owner, url);
  return { name: cal.name, events: cal.events.length };
}

export type NewSubscription = { url: string; name: string; color: string; busy: boolean; refreshMin: number };

/** Subscribes to a feed. The feed is fetched (and must parse) before anything is saved. */
export async function addSubscription(owner: string, input: NewSubscription): Promise<Subscription> {
  if (store.countByOwner(owner) >= MAX_SUBSCRIPTIONS) throw new SubscriptionError("limit");
  const url = parseUrl(input.url);
  const existing = store.listByOwner(owner);
  for (const row of existing) {
    if ((await unseal<string>(row.urlSealed)) === url.toString()) throw new SubscriptionError("duplicate");
  }
  const probe = await fetchForProbe(owner, url);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const name = (input.name.trim() || probe.cal.name || url.hostname).slice(0, 100);
  const refreshMin = Math.min(MAX_REFRESH_MIN, Math.max(MIN_REFRESH_MIN, Math.round(input.refreshMin) || DEFAULT_REFRESH_MIN));
  store.insertSubscription({
    id,
    owner,
    name,
    urlSealed: await seal(url.toString()),
    host: url.hostname.slice(0, 200),
    color: input.color,
    busy: input.busy,
    refreshMin,
  });
  const now = Date.now();
  store.recordSuccess(id, now, now + refreshMin * 60_000, probe, { json: JSON.stringify(probe.cal), eventCount: probe.cal.events.length });
  remember(id, now, probe.cal);
  probes.delete(probeKey(owner, url.toString()));
  const row = store.getSubscription(id);
  if (!row) throw new SubscriptionError("failed");
  return toView(row);
}

export function updateSubscription(
  owner: string,
  id: string,
  patch: Partial<{ name: string; color: string; visible: boolean; busy: boolean; refreshMin: number }>,
): void {
  const clean: Parameters<typeof store.updateSettings>[2] = {};
  if (patch.name !== undefined) clean.name = patch.name.trim().slice(0, 100);
  if (patch.color !== undefined) clean.color = patch.color;
  if (patch.visible !== undefined) clean.visible = patch.visible;
  if (patch.busy !== undefined) clean.busy = patch.busy;
  if (patch.refreshMin !== undefined)
    clean.refreshMin = Math.min(MAX_REFRESH_MIN, Math.max(MIN_REFRESH_MIN, Math.round(patch.refreshMin) || DEFAULT_REFRESH_MIN));
  if (clean.name === "") throw new SubscriptionError("invalid");
  if (!store.updateSettings(id, owner, clean)) throw new SubscriptionError("not_found");
}

export function removeSubscription(owner: string, id: string): void {
  if (!store.deleteSubscription(id, owner)) throw new SubscriptionError("not_found");
  parsed.delete(id);
}

/** "Refresh now": waits for the fetch (≤ 10 s). At most once per 30 s per subscription. */
export async function refreshNow(owner: string, id: string): Promise<RefreshOutcome> {
  const row = store.getSubscription(id);
  if (!row || row.owner !== owner) throw new SubscriptionError("not_found");
  if (!inflight.has(id)) {
    if (row.lastAttempt > Date.now() - 30_000) throw new SubscriptionError("rate_limited");
    takeToken(owner);
  }
  return refreshSubscription(row);
}

// ---- Events ----

/**
 * Read-only events of the owner's subscriptions overlapping [from, to) from the cache (never
 * fetches). `only` narrows the subscriptions (e.g. visible + busy for booking pages).
 */
export function subscriptionEvents(
  owner: string,
  from: number,
  to: number,
  displayTz: string,
  only?: (s: Subscription) => boolean,
): CalEvent[] {
  const out: CalEvent[] = [];
  for (const row of store.listByOwner(owner)) {
    const sub = toView(row);
    if (only && !only(sub)) continue;
    const cal = cachedCalendar(row.id);
    if (!cal) continue;
    for (const o of expandCalendar(cal, from, to, displayTz)) {
      const id = `sub:${row.id}:${o.uid.slice(0, 120)}:${o.recurrenceKey}`;
      out.push({
        id,
        baseId: id,
        accountId: "",
        calendarId: row.id,
        calKey: sub.key,
        title: o.title,
        description: o.url && !o.description.includes(o.url) ? `${o.description}\n\n${o.url}`.trim() : o.description,
        location: o.location,
        start: new Date(o.utcStart).toISOString().slice(0, 19),
        timeZone: null,
        allDay: o.allDay,
        utcStart: o.utcStart,
        utcEnd: o.utcEnd,
        startDay: o.startDay,
        endDay: o.endDay,
        recurrence: o.repeat,
        isInstance: o.recurring,
        alerts: [],
        participants: [],
        isOrganizer: false,
        myStatus: null,
        external: { id: row.id, name: row.name, transparent: o.transparent },
      });
    }
  }
  return out;
}

/** Busy intervals for booking pages: timed, opaque events of visible subscriptions that count as busy. */
export function subscriptionBusy(owner: string, from: number, to: number, tz: string): { start: number; end: number }[] {
  try {
    refreshStale(owner);
    return subscriptionEvents(owner, from, to, tz, (s) => s.visible && s.busy)
      .filter((e) => !e.allDay && !e.external?.transparent)
      .map((e) => ({ start: e.utcStart, end: e.utcEnd }));
  } catch (e) {
    console.error("[calendar-subs] busy lookup failed:", e instanceof Error ? e.message : e);
    return [];
  }
}
