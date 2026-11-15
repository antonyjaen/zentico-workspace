// Mail settings over JMAP: identities & signatures, vacation responder, Sieve filters and
// display preferences. Server-only (uses the user's access token).
import { cookies } from "next/headers";
import { cache } from "react";
import { requireSession } from "./auth";
import { env } from "./env";
import { CAP, jmap, JmapError } from "./jmap";
import type { Mailbox } from "./mail";

export const SETTINGS_CAP = {
  submission: CAP.submission,
  vacation: "urn:ietf:params:jmap:vacationresponse",
  sieve: "urn:ietf:params:jmap:sieve",
} as const;

/* ------------------------------------------------------------------ session */

type FullSession = {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
};

const getFullSession = cache(async (): Promise<FullSession & { token: string }> => {
  const { accessToken } = await requireSession();
  const res = await fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`JMAP session failed: ${res.status}`);
  return { ...(await res.json()), token: accessToken };
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

export const FILTER_SCRIPT_NAME = "zentico-filters";
export const FILTER_FIELDS = ["from", "to", "subject"] as const;
export const FILTER_ACTIONS = ["move", "markRead", "star", "delete", "forward"] as const;
export const MAX_RULES = 100;

export type FilterRule = {
  field: (typeof FILTER_FIELDS)[number];
  value: string;
  action: (typeof FILTER_ACTIONS)[number];
  /** Mailbox id for `move`, address for `forward`. */
  target?: string;
};

export type SieveScript = { id: string; name: string; blobId: string; isActive: boolean };

export type FiltersState = {
  scripts: SieveScript[];
  /** Name and content of the currently active script, if any. */
  active: { name: string; content: string } | null;
  /** Rules recovered from our own script (empty when it does not exist yet). */
  rules: FilterRule[];
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

export async function getFilters(): Promise<FiltersState | null> {
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
  const rules = ourText != null ? parseRules(ourText) : [];
  return {
    scripts,
    active: activeScript && activeContent != null ? { name: activeScript.name, content: activeContent } : null,
    rules: rules ?? [],
    unreadable: ourText != null && rules == null,
  };
}

/** Validates untrusted rules. Throws on anything malformed. */
export function validateRules(input: unknown, mailboxIds?: Set<string>): FilterRule[] {
  if (!Array.isArray(input) || input.length > MAX_RULES) throw new Error("invalid");
  return input.map((r: Record<string, unknown>) => {
    if (!r || typeof r !== "object") throw new Error("invalid");
    const field = r.field as FilterRule["field"];
    const action = r.action as FilterRule["action"];
    if (!FILTER_FIELDS.includes(field) || !FILTER_ACTIONS.includes(action)) throw new Error("invalid");
    const value = line(r.value, 200, { required: true });
    const rule: FilterRule = { field, value, action };
    if (action === "move") {
      if (typeof r.target !== "string" || !ID.test(r.target)) throw new Error("invalidFolder");
      if (mailboxIds && !mailboxIds.has(r.target)) throw new Error("invalidFolder");
      rule.target = r.target;
    } else if (action === "forward") {
      if (!isEmail(r.target)) throw new Error("invalidEmail");
      rule.target = r.target;
    }
    return rule;
  });
}

/** Reads rules back from the JSON header of a script we generated; null if absent/invalid. */
export function parseRules(script: string): FilterRule[] | null {
  const header = script.split(/\r?\n/).find((l) => l.startsWith(RULES_MARKER));
  if (!header) return null;
  try {
    const data = JSON.parse(header.slice(RULES_MARKER.length)) as { v?: number; rules?: unknown };
    if (data.v !== 1) return null;
    return validateRules(data.rules);
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

/**
 * Generates the Sieve script for the rules. Flag rules run first so later `fileinto`
 * actions carry the flags; the original rules are embedded as a JSON comment header.
 */
export function buildSieve(rules: FilterRule[], mailboxes: Mailbox[]): string {
  const byId = new Map(mailboxes.map((m) => [m.id, m]));
  const trash = mailboxes.find((m) => m.role === "trash");
  const needs = new Set<string>();
  const order: Record<FilterRule["action"], number> = { markRead: 0, star: 0, forward: 1, move: 2, delete: 3 };
  const sorted = [...rules].sort((a, b) => order[a.action] - order[b.action]);

  const blocks = sorted.map((r) => {
    const header = r.field === "to" ? '["to", "cc"]' : sieveString(r.field);
    let action: string;
    switch (r.action) {
      case "markRead":
        needs.add("imap4flags");
        action = 'addflag "\\\\Seen";';
        break;
      case "star":
        needs.add("imap4flags");
        action = 'addflag "\\\\Flagged";';
        break;
      case "forward":
        needs.add("copy");
        action = `redirect :copy ${sieveString(r.target!)};`;
        break;
      case "move":
        needs.add("fileinto");
        action = `fileinto ${sieveString(mailboxPath(r.target!, byId))};\n    stop;`;
        break;
      case "delete":
        if (trash) {
          needs.add("fileinto");
          action = `fileinto ${sieveString(mailboxPath(trash.id, byId))};\n    stop;`;
        } else action = "discard;\n    stop;";
        break;
    }
    return `if header :contains ${header} ${sieveString(r.value)} {\n    ${action}\n}`;
  });

  const lines = [
    "# Generated by Zentico Workspace. Edit filters in Mail settings; manual changes are overwritten.",
    RULES_MARKER + JSON.stringify({ v: 1, rules }),
  ];
  if (needs.size) lines.push(`require [${[...needs].sort().map(sieveString).join(", ")}];`);
  lines.push("", ...blocks.flatMap((b) => [b, ""]));
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
