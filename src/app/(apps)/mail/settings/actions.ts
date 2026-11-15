"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { CAP, jmap } from "@/lib/jmap";
import { getMailboxes } from "@/lib/mail";
import {
  DENSITIES,
  DENSITY_COOKIE,
  FILTER_SCRIPT_NAME,
  ID,
  PANES,
  PANE_COOKIE,
  SETTINGS_CAP,
  accountFor,
  buildSieve,
  getSieveScripts,
  isEmail,
  line,
  sanitizeHtml,
  sieveCall,
  text,
  uploadBlob,
  validateRules,
  type Density,
  type FilterRule,
  type ReadingPane,
} from "@/lib/mail-settings";

export type ActionResult = { ok: true } | { ok: false; error: string; detail?: string };

const PATH = "/mail/settings";
const fail = (error: string, detail?: string): ActionResult => ({ ok: false, error, detail });

/** Maps a JMAP SetError to a stable error code for the UI. */
function setError(e: Record<string, unknown> | undefined): ActionResult {
  const type = String(e?.type ?? "unknown");
  const known = ["forbidden", "forbiddenFrom", "invalidSieve", "invalidProperties", "tooLarge", "overQuota"];
  return fail(known.includes(type) ? type : "unknown", typeof e?.description === "string" ? e.description : undefined);
}

async function guard(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await fn();
  } catch (e) {
    unstable_rethrow(e);
    const msg = e instanceof Error ? e.message : "";
    if (["invalid", "invalidEmail", "invalidFolder", "invalidDates"].includes(msg)) return fail(msg);
    console.error("mail settings action failed", e);
    return fail("server");
  }
}

/* --------------------------------------------------------------- identities */

export type IdentityInput = {
  id?: string;
  email?: string;
  name: string;
  replyTo: string;
  textSignature: string;
  htmlSignature: string;
};

export async function saveIdentity(input: IdentityInput): Promise<ActionResult> {
  return guard(async () => {
    const accountId = await accountFor(SETTINGS_CAP.submission);
    if (!accountId) return fail("unavailable");
    const replyTo = line(input.replyTo, 254);
    if (replyTo && !isEmail(replyTo)) return fail("invalidEmail");
    const props = {
      name: line(input.name, 120),
      replyTo: replyTo ? [{ name: null, email: replyTo }] : null,
      textSignature: text(input.textSignature, 5000),
      htmlSignature: sanitizeHtml(text(input.htmlSignature, 20000)),
    };
    const using = [CAP.core, CAP.mail, SETTINGS_CAP.submission];

    if (input.id) {
      if (!ID.test(input.id)) return fail("invalid");
      const r = await jmap([["Identity/set", { accountId, update: { [input.id]: props } }, "s"]], using);
      const nu = r.s.notUpdated as Record<string, Record<string, unknown>> | undefined;
      if (nu?.[input.id]) return setError(nu[input.id]);
    } else {
      const email = line(input.email, 254).toLowerCase();
      if (!isEmail(email)) return fail("invalidEmail");
      const r = await jmap([["Identity/set", { accountId, create: { n: { email, ...props } } }, "s"]], using);
      const nc = r.s.notCreated as Record<string, Record<string, unknown>> | undefined;
      if (nc?.n) return setError(nc.n);
    }
    revalidatePath(PATH);
    return { ok: true };
  });
}

export async function deleteIdentity(id: string): Promise<ActionResult> {
  return guard(async () => {
    const accountId = await accountFor(SETTINGS_CAP.submission);
    if (!accountId) return fail("unavailable");
    if (typeof id !== "string" || !ID.test(id)) return fail("invalid");
    const r = await jmap(
      [["Identity/set", { accountId, destroy: [id] }, "s"]],
      [CAP.core, CAP.mail, SETTINGS_CAP.submission],
    );
    const nd = r.s.notDestroyed as Record<string, Record<string, unknown>> | undefined;
    if (nd?.[id]) return setError(nd[id]);
    revalidatePath(PATH);
    return { ok: true };
  });
}

/* ----------------------------------------------------------------- vacation */

export type VacationInput = {
  isEnabled: boolean;
  /** YYYY-MM-DD or "" */
  fromDate: string;
  toDate: string;
  subject: string;
  textBody: string;
  htmlBody: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function toUtc(day: string, end: boolean): string | null {
  if (!day) return null;
  if (typeof day !== "string" || !DAY.test(day)) throw new Error("invalidDates");
  const iso = `${day}T${end ? "23:59:59" : "00:00:00"}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) throw new Error("invalidDates");
  return iso;
}

export async function saveVacation(input: VacationInput): Promise<ActionResult> {
  return guard(async () => {
    const accountId = await accountFor(SETTINGS_CAP.vacation);
    if (!accountId) return fail("unavailable");
    const fromDate = toUtc(input.fromDate, false);
    const toDate = toUtc(input.toDate, true);
    if (fromDate && toDate && fromDate > toDate) return fail("invalidDates");
    const htmlBody = sanitizeHtml(text(input.htmlBody, 20000));
    const textBody = text(input.textBody, 10000);
    const patch = {
      isEnabled: Boolean(input.isEnabled),
      fromDate,
      toDate,
      subject: line(input.subject, 200) || null,
      textBody: textBody.trim() ? textBody : null,
      htmlBody: htmlBody.trim() ? htmlBody : null,
    };
    if (patch.isEnabled && !patch.textBody && !patch.htmlBody) return fail("emptyBody");
    const r = await jmap(
      [["VacationResponse/set", { accountId, update: { singleton: patch } }, "s"]],
      [CAP.core, SETTINGS_CAP.vacation],
    );
    const nu = r.s.notUpdated as Record<string, Record<string, unknown>> | undefined;
    if (nu?.singleton) return setError(nu.singleton);
    revalidatePath(PATH);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ filters */

export async function saveFilters(input: FilterRule[]): Promise<ActionResult> {
  return guard(async () => {
    const accountId = await accountFor(SETTINGS_CAP.sieve);
    if (!accountId) return fail("unavailable");
    const mailboxes = await getMailboxes();
    const rules = validateRules(input, new Set(mailboxes.map((m) => m.id)));
    const script = buildSieve(rules, mailboxes);

    const blobId = await uploadBlob(accountId, script, "application/sieve");
    const existing = (await getSieveScripts(accountId)).find((s) => s.name === FILTER_SCRIPT_NAME);
    const r = await sieveCall([
      [
        "SieveScript/set",
        existing
          ? { accountId, update: { [existing.id]: { blobId } }, onSuccessActivateScript: existing.id }
          : { accountId, create: { z: { name: FILTER_SCRIPT_NAME, blobId } }, onSuccessActivateScript: "#z" },
        "s",
      ],
    ]);
    const errs = (existing ? r.s.notUpdated : r.s.notCreated) as Record<string, Record<string, unknown>> | undefined;
    const err = errs?.[existing ? existing.id : "z"];
    if (err) return setError(err);
    revalidatePath(PATH);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ display */

const YEAR = 60 * 60 * 24 * 365;

export async function setDisplayPrefs(input: { density: Density; pane: ReadingPane }): Promise<ActionResult> {
  if (!DENSITIES.includes(input?.density) || !PANES.includes(input?.pane)) return fail("invalid");
  const store = await cookies();
  const opts = { path: "/", maxAge: YEAR, sameSite: "lax" as const };
  store.set(DENSITY_COOKIE, input.density, opts);
  store.set(PANE_COOKIE, input.pane, opts);
  revalidatePath("/mail", "layout");
  return { ok: true };
}
