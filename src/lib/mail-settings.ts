// Mail settings over JMAP: identities & signatures, vacation responder, Sieve filters and
// display preferences. Server-only (uses the user's access token).
import { cookies } from "next/headers";
import { cache } from "react";
import { actingAccountId, requireSession } from "./auth";
import { actAs } from "./delegation";
import { env } from "./env";
import { CAP, jmap, JmapError } from "./jmap";
import type { Mailbox } from "./mail";
import {
  LABEL_COLOR_NAMES,
  LABEL_ID,
  MAX_LABELS,
  labelKeyword,
  type Label,
  type LabelColor,
} from "./mail-labels";

export const SETTINGS_CAP = {
  submission: CAP.submission,
  vacation: "urn:ietf:params:jmap:vacationresponse",
  sieve: "urn:ietf:params:jmap:sieve",
} as const;

/* ------------------------------------------------------------------ session */

export type SessionAccount = {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
};

type FullSession = {
  apiUrl: string;
  accounts: Record<string, SessionAccount>;
  downloadUrl: string;
  uploadUrl: string;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
};

export const getFullSession = async () => fullSessionFor(await actingAccountId());

const fullSessionFor = cache(async (acting: string | null): Promise<FullSession & { token: string }> => {
  const { accessToken } = await requireSession();
  const res = await fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`JMAP session failed: ${res.status}`);
  return { ...actAs((await res.json()) as FullSession, acting), token: accessToken };
});

/** The account id for a capability, or null when the server does not offer it. */
export async function accountFor(capability: string): Promise<string | null> {
  const s = await getFullSession();
  if (!s.capabilities?.[capability]) return null;
  return s.primaryAccounts?.[capability] ?? null;
}

/** Uploads a blob through the session uploadUrl (RFC 8620 §6.1) and returns its id. */
export async function uploadBlob(accountId: string, body: string, type: string): Promise<string> {
  const s = await getFullSession();
  const url = s.uploadUrl.replace("{accountId}", encodeURIComponent(accountId));
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": type },
    body,
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`Upload failed: ${res.status}`);
  const { blobId } = (await res.json()) as { blobId?: string };
  if (!blobId) throw new JmapError("Upload returned no blobId");
  return blobId;
}

/** Downloads a blob as text through the session downloadUrl template. */
export async function downloadBlobText(accountId: string, blobId: string, type: string, name: string) {
  const s = await getFullSession();
  const url = s.downloadUrl
    .replace("{accountId}", encodeURIComponent(accountId))
    .replace("{blobId}", encodeURIComponent(blobId))
    .replace("{type}", encodeURIComponent(type))
    .replace("{name}", encodeURIComponent(name));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${s.token}` }, cache: "no-store" });
  if (!res.ok) throw new JmapError(`Download failed: ${res.status}`);
  return res.text();
}

/* --------------------------------------------------------------- validation */

const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
export const ID = /^[A-Za-z0-9_-]{1,255}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f]/;

export const isEmail = (v: unknown): v is string => typeof v === "string" && v.length <= 254 && EMAIL.test(v);

/** Trims a single-line string and enforces a max length; throws on bad input. */
export function line(v: unknown, max: number, { required = false } = {}): string {
  if (typeof v !== "string") throw new Error("invalid");
  const s = v.trim();
  if (s.length > max || CONTROL_OR_NEWLINE.test(s) || (required && !s)) throw new Error("invalid");
  return s;
}

/** Multi-line text with a max length; throws on bad input. */
export function text(v: unknown, max: number): string {
  if (typeof v !== "string" || v.length > max || CONTROL.test(v)) throw new Error("invalid");
  return v;
}

const ALLOWED_TAGS = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "br", "p", "div", "span", "ul", "ol", "li", "blockquote", "hr", "img",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);

const escapeText = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => s.replace(/&(?![a-zA-Z#0-9]+;)/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function safeUrl(url: string, tag: string): string | null {
  const u = url.trim().replace(/&amp;/g, "&");
  if (tag === "a" && /^(https?:|mailto:)/i.test(u)) return u;
  if (tag === "img" && /^https:/i.test(u)) return u;
  return null;
}

/**
 * Allowlist HTML sanitizer for signatures and vacation bodies: keeps simple formatting tags,
 * links (http/https/mailto) and https images; drops everything else (scripts, handlers, styles).
 */
export function sanitizeHtml(input: string): string {
  const src = input
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|template|noscript|svg|math|title|head)\b[\s\S]*?<\/\1\s*>/gi, "");
  const out: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g;
  let last = 0;
  for (let m = tagRe.exec(src); m; m = tagRe.exec(src)) {
    out.push(escapeText(src.slice(last, m.index)));
    last = tagRe.lastIndex;
    const [, closing, rawName, rawAttrs] = m;
    const tag = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (closing) {
      if (!VOID_TAGS.has(tag)) out.push(`</${tag}>`);
      continue;
    }
    const attrs: string[] = [];
    const attrRe = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    for (let a = attrRe.exec(rawAttrs); a; a = attrRe.exec(rawAttrs)) {
      const name = a[1].toLowerCase();
      const value = a[3] ?? a[4] ?? a[5] ?? "";
      if ((tag === "a" && name === "href") || (tag === "img" && name === "src")) {
        const url = safeUrl(value, tag);
        if (url) attrs.push(`${name}="${escapeAttr(url)}"`);
      } else if (tag === "img" && (name === "alt" || name === "width" || name === "height")) {
        attrs.push(`${name}="${escapeAttr(value)}"`);
      }
    }
    if (tag === "a") attrs.push('target="_blank"', 'rel="noopener noreferrer"');
    out.push(`<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`);
  }
  out.push(escapeText(src.slice(last)));
  return out.join("");
}

/* --------------------------------------------------------------- identities */

export type Identity = {
  id: string;
  name: string;
  email: string;
  replyTo: { name: string | null; email: string }[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
};

/** The user's sending identities, or null when submission is unavailable. */
export async function getIdentities(): Promise<Identity[] | null> {
  const accountId = await accountFor(SETTINGS_CAP.submission);
  if (!accountId) return null;
  const r = await jmap([["Identity/get", { accountId }, "i"]], [CAP.core, CAP.mail, SETTINGS_CAP.submission]);
  const list = (r.i.list as Identity[]) ?? [];
  return list
    .map((i) => ({
      ...i,
      name: i.name ?? "",
      textSignature: i.textSignature ?? "",
      htmlSignature: sanitizeHtml(i.htmlSignature ?? ""),
      mayDelete: Boolean(i.mayDelete),
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/* ----------------------------------------------------------------- vacation */

export type Vacation = {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string;
  textBody: string;
  htmlBody: string;
};

export async function getVacation(): Promise<Vacation | null> {
  const accountId = await accountFor(SETTINGS_CAP.vacation);
  if (!accountId) return null;
  const r = await jmap(
    [["VacationResponse/get", { accountId, ids: ["singleton"] }, "v"]],
    [CAP.core, SETTINGS_CAP.vacation],
  );
  const v = ((r.v.list as Partial<Vacation>[]) ?? [])[0] ?? {};
  return {
    isEnabled: Boolean(v.isEnabled),
    fromDate: v.fromDate ?? null,
    toDate: v.toDate ?? null,
    subject: v.subject ?? "",
    textBody: v.textBody ?? "",
    htmlBody: sanitizeHtml(v.htmlBody ?? ""),
  };
}

/* ------------------------------------------------------------------ filters */

// Filters and label definitions are stored together in the "zentico-filters" Sieve script:
// a one-line JSON header (`# zentico-rules: {"v":2,"rules":[...],"labels":[...]}`) that we parse
// back, followed by the generated Sieve. Labels need no Sieve code of their own, but keeping
// their definitions there makes them server-persisted without another storage backend.

export const FILTER_SCRIPT_NAME = "zentico-filters";
export const CONDITION_FIELDS = ["from", "to", "subject", "listId", "hasAttachment", "sizeOver"] as const;
export const CONDITION_OPS = ["contains", "notContains"] as const;
export const RULE_ACTIONS = ["move", "label", "markRead", "star", "forward", "delete"] as const;
export const MAX_RULES = 100;
const MAX_CONDITIONS = 10;
const SIZE = /^[1-9]\d{0,5}[KM]$/;

export type ConditionField = (typeof CONDITION_FIELDS)[number];
export type FilterCondition = {
  field: ConditionField;
  /** Text fields only. */
  op?: (typeof CONDITION_OPS)[number];
  /** Text to match; for `sizeOver` a size like "500K" or "5M"; unused for `hasAttachment`. */
  value?: string;
};
export type FilterAction = {
  type: (typeof RULE_ACTIONS)[number];
  /** Mailbox id for `move`, label id for `label`, address for `forward`. */
  target?: string;
};
export type FilterRule = {
  name: string;
  enabled: boolean;
  match: "all" | "any";
  conditions: FilterCondition[];
  actions: FilterAction[];
  /** Skip the moves/forwards/deletes of later rules once this one matched. */
  stop: boolean;
};
export type MailConfig = { rules: FilterRule[]; labels: Label[] };

export type SieveScript = { id: string; name: string; blobId: string; isActive: boolean };

export type FiltersState = {
  scripts: SieveScript[];
  /** Name and content of the currently active script, if any. */
  active: { name: string; content: string } | null;
  /** Rules recovered from our own script (empty when it does not exist yet). */
  rules: FilterRule[];
  labels: Label[];
  /** True when our script exists but its rules header could not be parsed. */
  unreadable: boolean;
};

const RULES_MARKER = "# zentico-rules: ";

export function sieveCall(calls: Parameters<typeof jmap>[0]) {
  return jmap(calls, [CAP.core, SETTINGS_CAP.sieve]);
}

export async function getSieveScripts(accountId: string): Promise<SieveScript[]> {
  const r = await sieveCall([
    ["SieveScript/get", { accountId, properties: ["id", "name", "blobId", "isActive"] }, "s"],
  ]);
  return (r.s.list as SieveScript[]) ?? [];
}

type StoredConfig = {
  accountId: string;
  scripts: SieveScript[];
  ours: SieveScript | undefined;
  activeScript: SieveScript | undefined;
  activeContent: string | null;
  /** Null when our script exists but can't be parsed. */
  config: MailConfig | null;
};

/** Loads our script (and the active one) once per request. Null when Sieve is unavailable. */
const loadConfig = cache(async (): Promise<StoredConfig | null> => {
  const accountId = await accountFor(SETTINGS_CAP.sieve);
  if (!accountId) return null;
  const scripts = await getSieveScripts(accountId);
  const fetchText = (s: SieveScript) => downloadBlobText(accountId, s.blobId, "application/sieve", `${s.name}.sieve`);
  const activeScript = scripts.find((s) => s.isActive);
  const ours = scripts.find((s) => s.name === FILTER_SCRIPT_NAME);
  const [activeContent, ourContent] = await Promise.all([
    activeScript ? fetchText(activeScript) : null,
    ours && ours !== activeScript ? fetchText(ours) : null,
  ]);
  const ourText = ours ? (ours === activeScript ? activeContent : ourContent) : null;
  const config = ourText != null ? parseConfig(ourText) : { rules: [], labels: [] };
  return { accountId, scripts, ours, activeScript, activeContent, config };
});

export async function getFilters(): Promise<FiltersState | null> {
  const s = await loadConfig();
  if (!s) return null;
  return {
    scripts: s.scripts,
    active: s.activeScript && s.activeContent != null ? { name: s.activeScript.name, content: s.activeContent } : null,
    rules: s.config?.rules ?? [],
    labels: s.config?.labels ?? [],
    unreadable: s.config == null,
  };
}

/** The user's label definitions ([] when Sieve is unavailable or the script is unreadable). */
export async function getLabels(): Promise<Label[]> {
  try {
    return (await loadConfig())?.config?.labels ?? [];
  } catch (e) {
    console.error("[mail] labels load failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Current stored config for a read-modify-write. Throws "unavailable" / "unreadable". */
export async function readConfigForUpdate(): Promise<MailConfig> {
  const s = await loadConfig();
  if (!s) throw new Error("unavailable");
  if (!s.config) throw new Error("unreadable");
  return s.config;
}

/**
 * Uploads and stores the script. `activate` turns our script on; otherwise it is only activated
 * when no script is active yet (so label edits never switch off someone's hand-written script).
 * Returns the JMAP SetError on rejection.
 */
export async function writeConfig(
  config: MailConfig,
  mailboxes: Mailbox[],
  { activate }: { activate: boolean },
): Promise<Record<string, unknown> | null> {
  const accountId = await accountFor(SETTINGS_CAP.sieve);
  if (!accountId) throw new Error("unavailable");
  const script = buildSieve(config, mailboxes);
  const blobId = await uploadBlob(accountId, script, "application/sieve");
  const scripts = await getSieveScripts(accountId);
  const existing = scripts.find((s) => s.name === FILTER_SCRIPT_NAME);
  const turnOn = activate || !scripts.some((s) => s.isActive);
  const r = await sieveCall([
    [
      "SieveScript/set",
      existing
        ? {
            accountId,
            update: { [existing.id]: { blobId } },
            ...(turnOn ? { onSuccessActivateScript: existing.id } : {}),
          }
        : {
            accountId,
            create: { z: { name: FILTER_SCRIPT_NAME, blobId } },
            ...(turnOn ? { onSuccessActivateScript: "#z" } : {}),
          },
      "s",
    ],
  ]);
  const errs = (existing ? r.s.notUpdated : r.s.notCreated) as Record<string, Record<string, unknown>> | undefined;
  return errs?.[existing ? existing.id : "z"] ?? null;
}

/** Validates untrusted label definitions. */
export function validateLabels(input: unknown): Label[] {
  if (!Array.isArray(input) || input.length > MAX_LABELS) throw new Error("invalid");
  const seen = new Set<string>();
  return input.map((l: Record<string, unknown>) => {
    if (!l || typeof l !== "object" || typeof l.id !== "string" || !LABEL_ID.test(l.id) || seen.has(l.id))
      throw new Error("invalid");
    seen.add(l.id);
    const color = LABEL_COLOR_NAMES.includes(l.color as LabelColor) ? (l.color as LabelColor) : "gray";
    return { id: l.id, name: line(l.name, 60, { required: true }), color };
  });
}

/** Validates untrusted rules. Throws on anything malformed. */
export function validateRules(
  input: unknown,
  ctx: { mailboxIds?: Set<string>; labelIds?: Set<string> } = {},
): FilterRule[] {
  if (!Array.isArray(input) || input.length > MAX_RULES) throw new Error("invalid");
  return input.map((r: Record<string, unknown>) => {
    if (!r || typeof r !== "object") throw new Error("invalid");
    const conds = r.conditions;
    const acts = r.actions;
    if (!Array.isArray(conds) || !conds.length || conds.length > MAX_CONDITIONS) throw new Error("invalid");
    if (!Array.isArray(acts) || !acts.length || acts.length > RULE_ACTIONS.length) throw new Error("invalid");

    const conditions = conds.map((c: Record<string, unknown>): FilterCondition => {
      const field = c?.field as ConditionField;
      if (!CONDITION_FIELDS.includes(field)) throw new Error("invalid");
      if (field === "hasAttachment") return { field };
      if (field === "sizeOver") {
        if (typeof c.value !== "string" || !SIZE.test(c.value)) throw new Error("invalid");
        return { field, value: c.value };
      }
      const op = (c.op ?? "contains") as FilterCondition["op"];
      if (!CONDITION_OPS.includes(op!)) throw new Error("invalid");
      return { field, op, value: line(c.value, 200, { required: true }) };
    });

    const types = new Set<string>();
    const actions = acts.map((a: Record<string, unknown>): FilterAction => {
      const type = a?.type as FilterAction["type"];
      if (!RULE_ACTIONS.includes(type)) throw new Error("invalid");
      // One action of each kind, except labels (several labels per rule are fine).
      if (type !== "label" && types.has(type)) throw new Error("invalid");
      types.add(type);
      if (type === "move") {
        if (typeof a.target !== "string" || !ID.test(a.target)) throw new Error("invalidFolder");
        if (ctx.mailboxIds && !ctx.mailboxIds.has(a.target)) throw new Error("invalidFolder");
        return { type, target: a.target };
      }
      if (type === "label") {
        if (typeof a.target !== "string" || !LABEL_ID.test(a.target)) throw new Error("invalidLabel");
        if (ctx.labelIds && !ctx.labelIds.has(a.target)) throw new Error("invalidLabel");
        return { type, target: a.target };
      }
      if (type === "forward") {
        if (!isEmail(a.target)) throw new Error("invalidEmail");
        return { type, target: a.target };
      }
      return { type };
    });

    return {
      name: typeof r.name === "string" ? line(r.name, 80) : "",
      enabled: r.enabled !== false,
      match: r.match === "any" ? "any" : "all",
      conditions,
      actions,
      stop: Boolean(r.stop),
    };
  });
}

type RuleV1 = { field: "from" | "to" | "subject"; value: string; action: string; target?: string };

/** Reads the config back from the JSON header of a script we generated; null if absent/invalid. */
export function parseConfig(script: string): MailConfig | null {
  const header = script.split(/\r?\n/).find((l) => l.startsWith(RULES_MARKER));
  if (!header) return null;
  try {
    const data = JSON.parse(header.slice(RULES_MARKER.length)) as { v?: number; rules?: unknown; labels?: unknown };
    if (data.v === 1 && Array.isArray(data.rules)) {
      // v1: one condition and one action per rule; flag actions ran before moves.
      const order: Record<string, number> = { markRead: 0, star: 0, forward: 1, move: 2, delete: 3 };
      const v1 = [...(data.rules as RuleV1[])].sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9));
      const rules = v1.map((r) => ({
        name: "",
        enabled: true,
        match: "all",
        conditions: [{ field: r.field, op: "contains", value: r.value }],
        actions: [{ type: r.action, target: r.target }],
        stop: r.action === "move" || r.action === "delete",
      }));
      return { rules: validateRules(rules), labels: [] };
    }
    if (data.v !== 2) return null;
    const labels = validateLabels(data.labels ?? []);
    return { rules: validateRules(data.rules, { labelIds: new Set(labels.map((l) => l.id)) }), labels };
  } catch {
    return null;
  }
}

const sieveString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Full folder path ("Parent/Child") as Sieve fileinto expects on Stalwart. */
function mailboxPath(id: string, byId: Map<string, Mailbox>): string {
  const parts: string[] = [];
  for (let m = byId.get(id), guard = 0; m && guard < 20; m = m.parentId ? byId.get(m.parentId) : undefined, guard++) {
    parts.unshift(m.name);
  }
  return parts.join("/");
}

const HEADER: Record<string, string> = {
  from: '"from"',
  to: '["to", "cc"]',
  subject: '"subject"',
  listId: '"list-id"',
};

function sieveTest(c: FilterCondition): string {
  switch (c.field) {
    case "hasAttachment":
      // Portable approximation: messages with attachments are multipart/mixed.
      return 'header :contains "content-type" "multipart/mixed"';
    case "sizeOver":
      return `size :over ${c.value}`;
    default: {
      const test = `header :contains ${HEADER[c.field]} ${sieveString(c.value ?? "")}`;
      return c.op === "notContains" ? `not ${test}` : test;
    }
  }
}

/**
 * Generates the Sieve script. Two passes keep flags reliable: first every matching rule adds its
 * flags (read, star, labels) — `fileinto` copies carry the flags set before it runs — then the
 * forwards, moves and deletes run in rule order, where "stop" ends processing.
 */
export function buildSieve(config: MailConfig, mailboxes: Mailbox[]): string {
  const byId = new Map(mailboxes.map((m) => [m.id, m]));
  const trash = mailboxes.find((m) => m.role === "trash");
  const needs = new Set<string>();
  const rules = config.rules.filter((r) => r.enabled && r.conditions.length && r.actions.length);

  const cond = (r: FilterRule) => {
    const tests = r.conditions.map(sieveTest);
    return tests.length === 1 ? tests[0] : `${r.match === "any" ? "anyof" : "allof"}(${tests.join(", ")})`;
  };

  const flagBlocks: string[] = [];
  const moveBlocks: string[] = [];
  for (const r of rules) {
    const flags = r.actions.flatMap((a) => {
      if (a.type === "markRead") return ["\\\\Seen"];
      if (a.type === "star") return ["\\\\Flagged"];
      if (a.type === "label" && a.target) return [labelKeyword(a.target)];
      return [];
    });
    if (flags.length) {
      needs.add("imap4flags");
      flagBlocks.push(`if ${cond(r)} {\n    addflag [${flags.map((f) => `"${f}"`).join(", ")}];\n}`);
    }

    const steps: string[] = [];
    const fwd = r.actions.find((a) => a.type === "forward");
    if (fwd?.target) {
      needs.add("copy");
      steps.push(`redirect :copy ${sieveString(fwd.target)};`);
    }
    const del = r.actions.some((a) => a.type === "delete");
    const move = r.actions.find((a) => a.type === "move");
    if (del) {
      if (trash) {
        needs.add("fileinto");
        steps.push(`fileinto ${sieveString(mailboxPath(trash.id, byId))};`);
      } else steps.push("discard;");
    } else if (move?.target && byId.has(move.target)) {
      needs.add("fileinto");
      steps.push(`fileinto ${sieveString(mailboxPath(move.target, byId))};`);
    }
    if (r.stop) steps.push("stop;");
    if (steps.length) moveBlocks.push(`if ${cond(r)} {\n    ${steps.join("\n    ")}\n}`);
  }

  const lines = [
    "# Generated by Zentico Workspace. Edit filters in Mail settings; manual changes are overwritten.",
    RULES_MARKER + JSON.stringify({ v: 2, rules: config.rules, labels: config.labels }),
  ];
  if (needs.size) lines.push(`require [${[...needs].sort().map(sieveString).join(", ")}];`);
  lines.push("", ...[...flagBlocks, ...moveBlocks].flatMap((b) => [b, ""]));
  return lines.join("\n");
}


/* ------------------------------------------------------------------ display */

export const DENSITY_COOKIE = "zw_density";
export const PANE_COOKIE = "zw_pane";
export const DENSITIES = ["comfortable", "compact"] as const;
export const PANES = ["none", "right"] as const;
export type Density = (typeof DENSITIES)[number];
export type ReadingPane = (typeof PANES)[number];

export async function getDisplayPrefs(): Promise<{ density: Density; pane: ReadingPane }> {
  const store = await cookies();
  const d = store.get(DENSITY_COOKIE)?.value as Density | undefined;
  const p = store.get(PANE_COOKIE)?.value as ReadingPane | undefined;
  return {
    density: d && DENSITIES.includes(d) ? d : "comfortable",
    pane: p && PANES.includes(p) ? p : "none",
  };
}
