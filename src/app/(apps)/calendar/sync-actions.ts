"use server";

// External calendar subscriptions (ICS URL) and .ics import. Every input is validated here; the
// fetching itself (SSRF guard, limits) lives in lib/safe-fetch + lib/calendar-subs.
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { actingAccountId, requireSession } from "@/lib/auth";
import { CAL_USING, calendarAccount, getCalendars } from "@/lib/calendar";
import {
  addSubscription,
  probeFeed,
  refreshNow,
  removeSubscription,
  SubscriptionError,
  updateSubscription,
  type Subscription,
} from "@/lib/calendar-subs/service";
import { IcsError, parseIcs } from "@/lib/ics/parse";
import { toJsCalendar, type ImportItem } from "@/lib/ics/to-jscalendar";
import { jmap } from "@/lib/jmap";
import { MAX_BYTES } from "@/lib/safe-fetch";

export type SyncResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

const SUB_ID = /^[a-f0-9]{16}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

class InputError extends Error {}

/** The subscriptions' owner: the signed-in user (none while acting as a delegated account). */
async function owner(): Promise<string> {
  const session = await requireSession();
  if (await actingAccountId()) throw new SubscriptionError("delegated");
  return session.sub;
}

async function run<T>(fn: () => Promise<T>): Promise<SyncResult<T>> {
  try {
    const data = await fn();
    revalidatePath("/calendar");
    return { ok: true, data };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof SubscriptionError) return { ok: false, error: e.code };
    if (e instanceof InputError) return { ok: false, error: "invalid" };
    console.error("calendar sync action failed", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

function subId(id: unknown): string {
  if (typeof id !== "string" || !SUB_ID.test(id)) throw new InputError("Invalid id");
  return id;
}
function color(v: unknown): string {
  if (typeof v !== "string" || !COLOR.test(v)) throw new InputError("Invalid color");
  return v.toLowerCase();
}
function name(v: unknown): string {
  if (typeof v !== "string") throw new InputError("Invalid name");
  return v.trim().slice(0, 100);
}
function minutes(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 5 || v > 1440) throw new InputError("Invalid interval");
  return v;
}
function url(v: unknown): string {
  if (typeof v !== "string" || v.length > 2048) throw new InputError("Invalid URL");
  return v;
}

// ---- Subscriptions ----

/** Fetches a feed to show its name before subscribing. */
export async function probeSubscription(feedUrl: string): Promise<SyncResult<{ name: string; events: number }>> {
  return run(async () => probeFeed(await owner(), url(feedUrl)));
}

export async function subscribe(input: { url: string; name: string; color: string; busy: boolean; refreshMin: number }): Promise<SyncResult<Subscription>> {
  return run(async () => {
    if (!input || typeof input !== "object") throw new InputError("Invalid input");
    return addSubscription(await owner(), {
      url: url(input.url),
      name: name(input.name),
      color: color(input.color),
      busy: input.busy !== false,
      refreshMin: minutes(input.refreshMin),
    });
  });
}

export async function updateSubscriptionSettings(
  id: string,
  patch: { name?: string; color?: string; visible?: boolean; busy?: boolean; refreshMin?: number },
): Promise<SyncResult> {
  return run(async () => {
    if (!patch || typeof patch !== "object") throw new InputError("Invalid input");
    updateSubscription(await owner(), subId(id), {
      ...(patch.name !== undefined ? { name: name(patch.name) } : {}),
      ...(patch.color !== undefined ? { color: color(patch.color) } : {}),
      ...(patch.visible !== undefined ? { visible: patch.visible === true } : {}),
      ...(patch.busy !== undefined ? { busy: patch.busy === true } : {}),
      ...(patch.refreshMin !== undefined ? { refreshMin: minutes(patch.refreshMin) } : {}),
    });
  });
}

export async function unsubscribe(id: string): Promise<SyncResult> {
  return run(async () => removeSubscription(await owner(), subId(id)));
}

/** "Refresh now": returns the refresh's own error code (e.g. "http_404") as data, not as a failure. */
export async function refreshSubscriptionNow(id: string): Promise<SyncResult<{ error: string | null }>> {
  return run(async () => {
    const r = await refreshNow(await owner(), subId(id));
    return { error: r.ok ? null : r.error };
  });
}

// ---- .ics import ----

const MAX_IMPORT = 5_000;
const BATCH = 50;

export type ImportPreview = { events: number; recurring: number; cancelled: number; existing: number };
export type ImportReport = { created: number; updated: number; skipped: number; failed: number };

type Raw = Record<string, unknown>;

/** Reads the uploaded file (≤ 10 MB) and converts it. */
async function readImport(form: FormData): Promise<{ items: ImportItem[]; cancelled: number }> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw new InputError("No file");
  if (file.size > MAX_BYTES) throw new SubscriptionError("too_large");
  let text: string;
  try {
    text = new TextDecoder("utf-8").decode(await file.arrayBuffer());
  } catch {
    throw new SubscriptionError("not_calendar");
  }
  try {
    const { items, cancelled } = toJsCalendar(parseIcs(text));
    if (!items.length) throw new SubscriptionError("empty");
    if (items.length > MAX_IMPORT) throw new SubscriptionError("too_many");
    return { items, cancelled };
  } catch (e) {
    if (e instanceof IcsError) throw new SubscriptionError("not_calendar");
    throw e;
  }
}

/** One of my own writable calendars, from its key ("account/id"). */
async function targetCalendar(key: unknown): Promise<{ accountId: string; id: string }> {
  if (typeof key !== "string" || key.length > 600) throw new InputError("Invalid calendar");
  const primary = await calendarAccount();
  const cal = (await getCalendars()).find((c) => c.key === key && c.accountId === primary && c.owner === null && c.mayWrite);
  if (!cal) throw new InputError("Invalid calendar");
  return { accountId: cal.accountId, id: cal.id };
}

/** UID → event id of the events already in the calendar. */
async function existingUids(accountId: string, calendarId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let position = 0; position < 50_000; ) {
    const r = await jmap(
      [
        ["CalendarEvent/query", { accountId, filter: { inCalendar: calendarId }, position, limit: 500, calculateTotal: true }, "q"],
        ["CalendarEvent/get", { accountId, "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" }, properties: ["id", "uid"] }, "g"],
      ],
      CAL_USING,
    );
    const ids = (r.q.ids as string[] | undefined) ?? [];
    for (const e of (r.g.list as Raw[] | undefined) ?? []) if (typeof e.uid === "string" && typeof e.id === "string") out.set(e.uid, e.id);
    position += ids.length;
    const total = typeof r.q.total === "number" ? r.q.total : 0;
    if (!ids.length || position >= total) break;
  }
  return out;
}

export async function previewIcsImport(form: FormData): Promise<SyncResult<ImportPreview>> {
  return run(async () => {
    await requireSession();
    const { items, cancelled } = await readImport(form);
    const target = await targetCalendar(form.get("calendar"));
    const existing = await existingUids(target.accountId, target.id);
    return {
      events: items.length,
      recurring: items.filter((i) => Array.isArray(i.event.recurrenceRules)).length,
      cancelled,
      existing: items.filter((i) => existing.has(i.uid)).length,
    };
  });
}

/**
 * Creates the file's events in one of my calendars (JMAP CalendarEvent/set, UIDs kept, no
 * scheduling messages). Events whose UID is already there are skipped, or updated with
 * mode=update.
 */
export async function importIcs(form: FormData): Promise<SyncResult<ImportReport>> {
  return run(async () => {
    await requireSession();
    const { items, cancelled } = await readImport(form);
    const target = await targetCalendar(form.get("calendar"));
    const update = form.get("mode") === "update";
    const existing = await existingUids(target.accountId, target.id);
    const report: ImportReport = { created: 0, updated: 0, skipped: cancelled, failed: 0 };

    const creates: ImportItem[] = [];
    const updates: { id: string; item: ImportItem }[] = [];
    for (const item of items) {
      const id = existing.get(item.uid);
      if (!id) creates.push(item);
      else if (update) updates.push({ id, item });
      else report.skipped++;
    }

    for (let i = 0; i < creates.length; i += BATCH) {
      const chunk = creates.slice(i, i + BATCH);
      const create = Object.fromEntries(chunk.map((it, j) => [`c${j}`, { ...it.event, calendarIds: { [target.id]: true } }]));
      try {
        const r = await jmap([["CalendarEvent/set", { accountId: target.accountId, create, sendSchedulingMessages: false }, "s"]], CAL_USING);
        const created = Object.keys((r.s.created as Raw | undefined) ?? {}).length;
        report.created += created;
        report.failed += chunk.length - created;
        const errs = r.s.notCreated as Record<string, { type?: string; description?: string }> | undefined;
        if (errs) {
          const first = Object.values(errs)[0];
          console.error("[calendar import] notCreated", Object.keys(errs).length, first?.type, first?.description?.slice(0, 200));
        }
      } catch (e) {
        unstable_rethrow(e);
        console.error("[calendar import] batch failed", e instanceof Error ? e.message : e);
        report.failed += chunk.length;
      }
    }

    for (let i = 0; i < updates.length; i += BATCH) {
      const chunk = updates.slice(i, i + BATCH);
      // uid is immutable and calendarIds stays as it is; every other imported property is replaced.
      const patch = Object.fromEntries(chunk.map(({ id, item }) => [id, Object.fromEntries(Object.entries(item.event).filter(([k]) => k !== "uid"))]));
      try {
        const r = await jmap([["CalendarEvent/set", { accountId: target.accountId, update: patch, sendSchedulingMessages: false }, "s"]], CAL_USING);
        const updated = Object.keys((r.s.updated as Raw | undefined) ?? {}).length;
        report.updated += updated;
        report.failed += chunk.length - updated;
      } catch (e) {
        unstable_rethrow(e);
        console.error("[calendar import] update batch failed", e instanceof Error ? e.message : e);
        report.failed += chunk.length;
      }
    }
    return report;
  });
}
