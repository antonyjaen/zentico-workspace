// Mail read view: thread loading, HTML sanitizing and blob download helpers (server only).
import { headers } from "next/headers";
import { cache } from "react";
import { requireSession } from "./auth";
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
export const getMailSession = cache(async (): Promise<MailSession> => {
  const { accessToken } = await requireSession();
  const res = await fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`JMAP session failed: ${res.status}`);
  const s = (await res.json()) as { downloadUrl?: string; primaryAccounts?: Record<string, string> };
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

/** Same-origin URL of the blob proxy route. */
export function blobHref(blobId: string, name: string | null, type: string | null, inline = false): string {
  const q = new URLSearchParams({ name: cleanFileName(name), type: type && MIME.test(type) ? type : "application/octet-stream" });
  if (inline) q.set("inline", "1");
  return `${BLOB_ROUTE}${encodeURIComponent(blobId)}?${q}`;
}

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
};

export type Attachment = {
  blobId: string;
  name: string;
  type: string;
  size: number;
  href: string;
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
  text: string | null;
  hasRemoteImages: boolean;
  truncated: boolean;
  attachments: Attachment[];
};

const EMAIL_PROPERTIES = [
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
const BODY_PROPERTIES = ["partId", "blobId", "size", "name", "type", "charset", "disposition", "cid"];

/** Loads every message of a thread (oldest first), with sanitized bodies. Null if not found. */
export async function getThread(
  threadId: string,
  { allowRemoteImages = false }: { allowRemoteImages?: boolean } = {},
): Promise<ReadMessage[] | null> {
  if (!ID.test(threadId)) return null;
  const accountId = await primaryAccount(CAP.mail);
  const r = await jmap([
    ["Thread/get", { accountId, ids: [threadId] }, "t"],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
        properties: EMAIL_PROPERTIES,
        bodyProperties: BODY_PROPERTIES,
        fetchHTMLBodyValues: true,
        fetchTextBodyValues: true,
        maxBodyValueBytes: 2_000_000,
      },
      "e",
    ],
  ]);
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
    html = frameDocument(chunks.join("\n"), { allowRemoteImages: opts.allowRemoteImages, origin: opts.origin });
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
    attachments.push({ blobId: p.blobId, name, type: p.type, size: p.size, href: blobHref(p.blobId, name, p.type) });
  }

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
    text,
    hasRemoteImages,
    truncated,
    attachments,
  };
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

/** Wraps sanitized markup in a locked-down document for the sandboxed frame. */
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
<style>
html,body{margin:0;padding:0;background:#fff;color:#0a0a0a}
body{font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;word-wrap:break-word;overflow-wrap:break-word;padding:2px 1px}
img{max-width:100%;height:auto}
table{max-width:100%}
pre{white-space:pre-wrap}
a{color:#2f5fe0}
blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid #e5e5e5;color:#525252}
</style></head><body>${body}</body></html>`;
}
