// Mail read view: thread loading, HTML sanitizing and blob download helpers (server only).
import { headers } from "next/headers";
import { cache } from "react";
import { actingAccountId, requireSession } from "./auth";
import { actAs } from "./delegation";
import { env } from "./env";
import { CAP, JmapError, jmap, primaryAccount } from "./jmap";

export const BLOB_ROUTE = "/api/mail/blob/";

const ID = /^[A-Za-z0-9_-]{1,255}$/;
export const BLOB_ID = /^[A-Za-z0-9_.-]{1,512}$/;
export const MIME = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}$/;

/** Image types that are safe to render inline (no SVG: it can carry script). */
export const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

// ---------------------------------------------------------------------------
// JMAP session (download URL template)

type MailSession = { downloadUrl: string; accountId: string; token: string };

/**
 * Fetches the JMAP session to get Stalwart's `downloadUrl` template. Kept here (instead of
 * extending jmap.ts) so blob downloads don't depend on the shared client's internals.
 */
export const getMailSession = async () => mailSessionFor(await actingAccountId());

const mailSessionFor = cache(async (acting: string | null): Promise<MailSession> => {
  const { accessToken } = await requireSession();
  const res = await fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`JMAP session failed: ${res.status}`);
  const s = actAs((await res.json()) as { downloadUrl?: string; primaryAccounts?: Record<string, string> }, acting);
  const accountId = s.primaryAccounts?.[CAP.mail];
  if (!s.downloadUrl || !accountId) throw new JmapError("JMAP session has no mail download URL");
  return { downloadUrl: s.downloadUrl, accountId, token: accessToken };
});

/** Expands the RFC 8620 download URL template. */
export function expandDownloadUrl(
  template: string,
  v: { accountId: string; blobId: string; name: string; type: string },
): string {
  return template
    .replace("{accountId}", encodeURIComponent(v.accountId))
    .replace("{blobId}", encodeURIComponent(v.blobId))
    .replace("{name}", encodeURIComponent(v.name))
    .replace("{type}", encodeURIComponent(v.type));
}

/** Strips anything that could break a header or a path out of an attachment name. */
export function cleanFileName(name: string | null | undefined): string {
  const cleaned = (name ?? "")
    .replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "attachment";
}

/** Same-origin URL of the blob proxy route. `mode` "text" serves the start of the blob as plain text. */
export function blobHref(
  blobId: string,
  name: string | null,
  type: string | null,
  mode: boolean | "inline" | "text" = false,
): string {
  const q = new URLSearchParams({ name: cleanFileName(name), type: type && MIME.test(type) ? type : "application/octet-stream" });
  if (mode === true || mode === "inline") q.set("inline", "1");
  if (mode === "text") q.set("text", "1");
  return `${BLOB_ROUTE}${encodeURIComponent(blobId)}?${q}`;
}

/** Types the blob route serves inline for previews (raster images; PDF framed same-origin only). */
export const isPreviewable = (type: string) =>
  INLINE_IMAGE_TYPES.has(type.toLowerCase()) || type.toLowerCase() === "application/pdf";

/** Origin of the current request (used to scope the frame's CSP to our blob route). */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return env.appUrl;
  const fwd = h.get("x-forwarded-proto")?.split(",")[0].trim();
  const proto =
    fwd === "http" || fwd === "https"
      ? fwd
      : /^(localhost|127\.0\.0\.1)(:|$)/.test(host)
        ? "http"
        : "https";
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Thread loading

export type Address = { name: string | null; email: string };

type BodyPart = {
  partId: string | null;
  blobId: string | null;
  size: number;
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
};

type RawEmail = {
  id: string;
  blobId?: string | null;
  size?: number;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: Address[] | null;
  to: Address[] | null;
  cc: Address[] | null;
  bcc: Address[] | null;
  replyTo: Address[] | null;
  subject: string | null;
  sentAt: string | null;
  receivedAt: string;
  preview: string;
  htmlBody: BodyPart[];
  textBody: BodyPart[];
  attachments: BodyPart[];
  bodyValues: Record<string, { value: string; isTruncated?: boolean }>;
  "header:Return-Path:asText"?: string | null;
  "header:Authentication-Results:asText:all"?: string[] | null;
  "header:Received:asText:all"?: string[] | null;
};

export type Attachment = {
  blobId: string;
  name: string;
  type: string;
  size: number;
  /** Download URL (Content-Disposition: attachment). */
  href: string;
  /** Inline URL for thumbnails / preview (raster images and PDF), else null. */
  inlineHref: string | null;
};

/** What the receiving server recorded about delivery; every field is best effort. */
export type Delivery = {
  /** Envelope sender domain (Return-Path). */
  mailedBy: string | null;
  /** Domain of a passing DKIM signature, from our server's Authentication-Results. */
  signedBy: string | null;
  /** Whether the last hop used TLS; null when unknown. */
  tls: boolean | null;
};

export type ReadMessage = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  sentAt: string | null;
  receivedAt: string;
  preview: string;
  /** Complete, sanitized document for an `<iframe srcdoc>`; null for plain-text messages. */
  html: string | null;
  /**
   * True when the HTML is a designed email (own backgrounds, colors, layout tables): it keeps a
   * white "paper" look. Simple HTML is restyled with the app's theme instead.
   */
  rich: boolean;
  text: string | null;
  hasRemoteImages: boolean;
  truncated: boolean;
  attachments: Attachment[];
  /** Raw message download (.eml) and plain-text source view; null if the server sent no blobId. */
  emlHref: string | null;
  sourceHref: string | null;
  delivery: Delivery;
};

const EMAIL_PROPERTIES = [
  "blobId",
  "size",
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "receivedAt",
  "preview",
  "htmlBody",
  "textBody",
  "attachments",
  "bodyValues",
];
/** Optional delivery headers; dropped (and the request retried) if the server rejects them. */
const HEADER_PROPERTIES = [
  "header:Return-Path:asText",
  "header:Authentication-Results:asText:all",
  "header:Received:asText:all",
];
const BODY_PROPERTIES = ["partId", "blobId", "size", "name", "type", "charset", "disposition", "cid"];

/** Loads every message of a thread (oldest first), with sanitized bodies. Null if not found. */
export async function getThread(
  threadId: string,
  { allowRemoteImages = false, accountId: account }: { allowRemoteImages?: boolean; accountId?: string } = {},
): Promise<ReadMessage[] | null> {
  if (!ID.test(threadId)) return null;
  // `accountId` (validated by the caller) reads a thread from a shared mailbox.
  const accountId = account ?? (await primaryAccount(CAP.mail));
  const load = (properties: string[]) =>
    jmap([
      ["Thread/get", { accountId, ids: [threadId] }, "t"],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
          properties,
          bodyProperties: BODY_PROPERTIES,
          fetchHTMLBodyValues: true,
          fetchTextBodyValues: true,
          maxBodyValueBytes: 2_000_000,
        },
        "e",
      ],
    ]);
  let r: Awaited<ReturnType<typeof jmap>>;
  try {
    r = await load([...EMAIL_PROPERTIES, ...HEADER_PROPERTIES]);
  } catch (e) {
    if (!(e instanceof JmapError)) throw e;
    r = await load(EMAIL_PROPERTIES); // header properties unsupported: show the thread without them
  }
  const thread = (r.t.list as { id: string; emailIds: string[] }[] | undefined)?.[0];
  if (!thread) return null;
  const byId = new Map(((r.e.list as RawEmail[]) ?? []).map((e) => [e.id, e]));
  const origin = await requestOrigin();
  return thread.emailIds
    .map((id) => byId.get(id))
    .filter((e): e is RawEmail => !!e)
    .map((e) => toReadMessage(e, { allowRemoteImages, origin }));
}

function toReadMessage(e: RawEmail, opts: { allowRemoteImages: boolean; origin: string }): ReadMessage {
  // Content-ID → inline blob URL, from every part that could be referenced by `cid:`.
  const cids = new Map<string, string>();
  for (const p of [...(e.attachments ?? []), ...(e.htmlBody ?? [])]) {
    if (p.cid && p.blobId && BLOB_ID.test(p.blobId)) {
      cids.set(normalizeCid(p.cid), blobHref(p.blobId, p.name, p.type, true));
    }
  }

  const values = e.bodyValues ?? {};
  const htmlParts = e.htmlBody ?? [];
  const hasHtml = htmlParts.some((p) => p.type === "text/html");
  let truncated = false;
  let html: string | null = null;
  let text: string | null = null;
  let hasRemoteImages = false;
  let rich = false;
  const usedCids = new Set<string>();
  const inlinedBlobs = new Set<string>();

  if (hasHtml) {
    const chunks: string[] = [];
    for (const p of htmlParts) {
      const v = p.partId ? values[p.partId] : undefined;
      if (v?.isTruncated) truncated = true;
      if (p.type === "text/html" && v) {
        const s = sanitizeHtml(v.value, { allowRemoteImages: opts.allowRemoteImages, cids, usedCids });
        hasRemoteImages ||= s.hasRemoteImages;
        chunks.push(s.html);
      } else if (p.type === "text/plain" && v) {
        chunks.push(`<div style="white-space:pre-wrap">${escapeHtml(v.value)}</div>`);
      } else if (p.blobId && INLINE_IMAGE_TYPES.has(p.type.toLowerCase()) && BLOB_ID.test(p.blobId)) {
        inlinedBlobs.add(p.blobId);
        chunks.push(`<img src="${escapeHtml(blobHref(p.blobId, p.name, p.type, true))}" alt="">`);
      }
    }
    const body = chunks.join("\n");
    rich = looksDesigned(body);
    html = frameDocument(body, { allowRemoteImages: opts.allowRemoteImages, origin: opts.origin });
  } else {
    const chunks: string[] = [];
    for (const p of e.textBody ?? []) {
      const v = p.partId ? values[p.partId] : undefined;
      if (v?.isTruncated) truncated = true;
      if (v && p.type.startsWith("text/")) chunks.push(v.value);
    }
    text = chunks.join("\n\n");
  }

  const attachments: Attachment[] = [];
  for (const p of e.attachments ?? []) {
    if (!p.blobId || !BLOB_ID.test(p.blobId)) continue;
    if (p.cid && usedCids.has(normalizeCid(p.cid))) continue; // already shown inline
    if (inlinedBlobs.has(p.blobId)) continue;
    const name = cleanFileName(p.name);
    attachments.push({
      blobId: p.blobId,
      name,
      type: p.type,
      size: p.size,
      href: blobHref(p.blobId, name, p.type),
      inlineHref: isPreviewable(p.type) ? blobHref(p.blobId, name, p.type, "inline") : null,
    });
  }

  const emlName = `${(e.subject ?? "").trim().slice(0, 120) || "message"}.eml`;
  const emailBlob = e.blobId && BLOB_ID.test(e.blobId) ? e.blobId : null;

  return {
    id: e.id,
    threadId: e.threadId,
    mailboxIds: e.mailboxIds ?? {},
    keywords: e.keywords ?? {},
    from: e.from ?? [],
    to: e.to ?? [],
    cc: e.cc ?? [],
    bcc: e.bcc ?? [],
    replyTo: e.replyTo ?? [],
    subject: e.subject ?? "",
    sentAt: e.sentAt,
    receivedAt: e.receivedAt,
    preview: e.preview ?? "",
    html,
    rich,
    text,
    hasRemoteImages,
    truncated,
    attachments,
    emlHref: emailBlob ? blobHref(emailBlob, emlName, "message/rfc822") : null,
    sourceHref: emailBlob ? blobHref(emailBlob, emlName, "text/plain", "text") : null,
    delivery: deliveryOf(e),
  };
}

// ---------------------------------------------------------------------------
// Delivery details (mailed-by / signed-by / TLS)

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function deliveryOf(e: RawEmail): Delivery {
  const returnPath = e["header:Return-Path:asText"] ?? "";
  const rpDomain = returnPath.match(/@([^\s>]+)/)?.[1]?.toLowerCase() ?? null;
  // Only the topmost Authentication-Results is trusted: our own server added it.
  const auth = e["header:Authentication-Results:asText:all"]?.[0] ?? "";
  const dkim = auth.match(/\bdkim=pass\b[^;]*?\bheader\.d=([^\s;]+)/i)?.[1]?.toLowerCase() ?? null;
  const received = e["header:Received:asText:all"]?.[0];
  return {
    mailedBy: rpDomain && DOMAIN.test(rpDomain) ? rpDomain : null,
    signedBy: dkim && DOMAIN.test(dkim) ? dkim : null,
    tls: received ? /\bwith\s+E?SMTPSA?\b|\bTLS/i.test(received) : null,
  };
}

// ---------------------------------------------------------------------------
// Designed vs. simple HTML

type Rgb = [number, number, number];

const NAMED: Record<string, Rgb> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  snow: [255, 250, 250],
  whitesmoke: [245, 245, 245],
  windowtext: [0, 0, 0],
};
const NEUTRAL_KEYWORDS = new Set(["transparent", "inherit", "initial", "unset", "none", "currentcolor", "window", "auto"]);

function parseColor(v: string): Rgb | "neutral" | null {
  // First token only: shorthands like `background: #fff none repeat`.
  const s = (v.trim().toLowerCase().match(/^(?:rgba?\([^)]*\)|\S+)/)?.[0] ?? "").replace(/!important$/, "");
  if (NEUTRAL_KEYWORDS.has(s)) return "neutral";
  if (NAMED[s]) return NAMED[s];
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const h = m[1].length < 6 ? m[1].slice(0, 3).replace(/./g, "$&$&") : m[1].slice(0, 6);
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+)%?)?/);
  if (m) {
    if (m[4] !== undefined && Number.parseFloat(m[4]) === 0) return "neutral";
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

const isGray = ([r, g, b]: Rgb) => Math.max(r, g, b) - Math.min(r, g, b) < 24;
const isLight = ([r, g, b]: Rgb) => r > 235 && g > 235 && b > 235;
const COLOR_VALUE = "([#\\w(),.%\\s]+?)(?=[\"';>}]|\\s!|$)";
const BG_RE = new RegExp(`(?:bgcolor\\s*=\\s*["']?|background(?:-color)?\\s*:\\s*)${COLOR_VALUE}`, "gi");
const FG_RE = new RegExp(`(?:[^-\\w]color\\s*:\\s*|<font[^>]*\\scolor\\s*=\\s*["']?)${COLOR_VALUE}`, "gi");

/**
 * Heuristic: designed emails (newsletters, receipts) set their own backgrounds, colors and layout
 * tables, and restyling them would break their design. Personal mail rarely goes beyond gray text.
 */
function looksDesigned(html: string): boolean {
  if (/background-image\s*:|background\s*:[^;"']*url\(|\sbackground\s*=/i.test(html)) return true;
  for (const m of html.matchAll(BG_RE)) {
    const c = parseColor(m[1]);
    if (c === "neutral") continue;
    if (!c || !(isGray(c) && isLight(c))) return true;
  }
  let colored = 0;
  for (const m of html.matchAll(FG_RE)) {
    const c = parseColor(m[1]);
    if (c && c !== "neutral" && !isGray(c) && ++colored > 4) return true;
  }
  if ((html.match(/<table\b/gi)?.length ?? 0) >= 3) return true;
  if ((html.match(/<img\b/gi)?.length ?? 0) >= 4) return true;
  return false;
}

// ---------------------------------------------------------------------------
// HTML sanitizing
//
// Defense in depth: the frame is sandboxed without scripts and locked down by CSP, so this pass
// mainly removes active content, forces links to new tabs and blocks remote images (trackers).

const normalizeCid = (cid: string) => cid.trim().replace(/^<|>$/g, "").toLowerCase();

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Elements removed together with their content. */
const DROP_BLOCK = /<(script|iframe|object|embed|applet|frameset|noembed|template|title|xml)\b[\s\S]*?<\/\1\s*>/gi;
/** Elements whose tags are removed (content, if any, is kept). */
const DROP_TAGS = new Set([
  "script", "iframe", "object", "embed", "applet", "frame", "frameset", "noembed", "template", "title",
  "form", "meta", "link", "base", "html", "head", "body", "xml", "param", "portal",
]);
const URL_ATTRS = new Set(["href", "src", "background", "poster", "xlink:href", "cite", "longdesc", "lowsrc", "dynsrc", "data", "action", "formaction", "srcset", "ping"]);
const DROP_ATTRS = new Set(["srcdoc", "action", "formaction", "ping", "target", "http-equiv", "autofocus", "rel"]);

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const REMOTE_CSS_URL = /url\(\s*['"]?\s*(?:https?:)?\/\//i;

function decodeForCheck(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16) || 32))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d) || 32))
    .replace(/&colon;/gi, ":")
    .replace(/&(tab|newline);/gi, "")
    .replace(/[\u0000- \u007f]/g, "")
    .toLowerCase();
}

const isRemote = (v: string) => /^(https?:)?\/\//.test(v);

function sanitizeHtml(
  input: string,
  opts: { allowRemoteImages: boolean; cids: Map<string, string>; usedCids: Set<string> },
): { html: string; hasRemoteImages: boolean } {
  let hasRemoteImages = false;

  let html = input
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<![^>]*>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(DROP_BLOCK, "");

  // Style blocks: drop @import, note remote images (CSP blocks them unless allowed).
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_, open: string, css: string, close: string) => {
    if (REMOTE_CSS_URL.test(css)) hasRemoteImages = true;
    return open + cleanCss(css) + close;
  });

  html = html.replace(TAG, (_m, slash: string, rawName: string, rawAttrs: string) => {
    const name = rawName.toLowerCase();
    if (DROP_TAGS.has(name)) return "";
    if (slash) return `</${name}>`;

    const out: string[] = [];
    let m: RegExpExecArray | null;
    ATTR.lastIndex = 0;
    while ((m = ATTR.exec(rawAttrs))) {
      const attr = m[1].toLowerCase();
      let value = m[2] ?? m[3] ?? m[4] ?? "";
      if (!/^[a-z][a-z0-9:_.-]*$/.test(attr) || attr.startsWith("on") || DROP_ATTRS.has(attr)) continue;

      if (attr === "style") {
        if (REMOTE_CSS_URL.test(value)) hasRemoteImages = true;
        value = cleanCss(value);
      } else if (URL_ATTRS.has(attr)) {
        const check = decodeForCheck(value);
        if (attr === "href" && (name === "a" || name === "area")) {
          if (!/^(https?:|mailto:|tel:|#)/.test(check)) continue;
        } else if ((attr === "src" && name === "img") || attr === "background") {
          if (check.startsWith("cid:")) {
            const cid = normalizeCid(safeDecode(value.trim().slice(4)));
            const url = opts.cids.get(cid);
            if (!url) continue;
            opts.usedCids.add(cid);
            out.push(`${attr}="${escapeHtml(url)}"`);
            continue;
          }
          if (isRemote(check)) {
            hasRemoteImages = true;
            if (!opts.allowRemoteImages) {
              out.push(`data-blocked-${attr}="${escapeAttr(value)}"`);
              continue;
            }
          } else if (!/^data:image\/(png|jpe?g|gif|webp|avif|bmp);/.test(check)) {
            continue;
          }
        } else if (attr === "srcset" && name === "img") {
          if (/^(https?:)?\/\//.test(check) || check.includes("//")) {
            hasRemoteImages = true;
            if (!opts.allowRemoteImages) continue;
          }
          if (/(javascript|vbscript|data):/.test(check)) continue;
        } else {
          // Any other URL-bearing attribute (video poster, object data, cite, ...) is unneeded.
          continue;
        }
      }
      out.push(m[2] === undefined && m[3] === undefined && m[4] === undefined ? attr : `${attr}="${escapeAttr(value)}"`);
    }

    if (name === "a" || name === "area") out.push('target="_blank"', 'rel="noopener noreferrer"');
    return `<${name}${out.length ? " " + out.join(" ") : ""}>`;
  });

  return { html, hasRemoteImages };
}

function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "(")
    .replace(/-moz-binding/gi, "")
    .replace(/(javascript|vbscript):/gi, "");
}

/** Keeps entities as authored, only neutralizes the quote that delimits the value. */
const escapeAttr = (v: string) => v.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Wraps sanitized markup in a locked-down document for the sandboxed frame. The client sets
 * `data-theme` (light|dark) and `data-mode` on <html>:
 * - themed:   simple mail restyled with the app's tokens (transparent, ink text, accent links)
 * - paper:    the email's own design on white
 * - inverted: designed mail shown dark (inverted, with images re-inverted)
 * Elements marked `data-zw-q` (quoted history) are hidden unless <html> has `zw-showq`.
 */
function frameDocument(body: string, { allowRemoteImages, origin }: { allowRemoteImages: boolean; origin: string }) {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data: ${origin}${BLOB_ROUTE}${allowRemoteImages ? " https:" : ""}`,
    "font-src data:",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="referrer" content="no-referrer">
<base target="_blank">
<style>${FRAME_CSS}</style></head><body>${body}</body></html>`;
}

const FRAME_CSS = `
:root{color-scheme:light;--ink:#0a0a0a;--soft:#525252;--line:#e5e5e5;--link:#3b6cf6}
html[data-mode=themed][data-theme=dark]{color-scheme:dark;--ink:#ededed;--soft:#a1a1a1;--line:#2e2e2e;--link:#5b8cff}
html,body{margin:0;padding:0}
body{font:14px/1.6 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);word-wrap:break-word;overflow-wrap:break-word;-webkit-font-smoothing:antialiased}
img{max-width:100%;height:auto}
table{max-width:100%}
pre{white-space:pre-wrap}
blockquote{margin:.6em 0 .6em .2em;padding-left:.9em;border-left:2px solid var(--line);color:var(--soft)}
html[data-mode=paper],html[data-mode=paper] body{background:#fff}
html[data-mode=paper] body{color:#0a0a0a;padding:20px 22px}
html[data-mode=paper] a{color:#2f5fe0}
html[data-mode=themed],html[data-mode=themed] body{background:transparent}
html[data-mode=themed] body{padding:2px 1px}
html[data-mode=themed] a{color:var(--link)}
html[data-mode=themed][data-theme=dark] body *:not(a){color:inherit!important;background-color:transparent!important;border-color:var(--line)!important}
html[data-mode=themed][data-theme=dark] body blockquote{color:var(--soft)!important}
html[data-mode=themed][data-theme=dark] body a{color:var(--link)!important}
html[data-mode=inverted]{background:#f5f5f5;filter:invert(1) hue-rotate(180deg)}
html[data-mode=inverted] body{padding:20px 22px;background:#f5f5f5;color:#0a0a0a}
html[data-mode=inverted] img,html[data-mode=inverted] video,html[data-mode=inverted] [style*="background-image"]{filter:invert(1) hue-rotate(180deg)}
html:not(.zw-showq) [data-zw-q]{display:none!important}
@media print{
html[data-mode]{filter:none!important;background:#fff!important}
html[data-mode] body{background:#fff!important}
html[data-mode=themed] body,html[data-mode=themed] body *:not(a){color:#000!important}
html[data-mode=inverted] img,html[data-mode=inverted] video,html[data-mode=inverted] [style*="background-image"]{filter:none!important}
}`.replace(/\n/g, "");
