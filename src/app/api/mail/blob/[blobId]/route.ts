// Proxies JMAP blob downloads (attachments, inline cid: images) so the token never reaches the browser.
import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  BLOB_ID,
  cleanFileName,
  expandDownloadUrl,
  getMailSession,
  INLINE_IMAGE_TYPES,
  MIME,
} from "@/lib/mail-read";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ blobId: string }> }) {
  const { blobId } = await params;
  if (!BLOB_ID.test(blobId)) return new Response("Invalid blob id", { status: 400 });

  const q = req.nextUrl.searchParams;
  const name = cleanFileName(q.get("name"));
  const rawType = (q.get("type") ?? "").toLowerCase();
  const type = MIME.test(rawType) ? rawType : "application/octet-stream";
  // Only raster images (and PDF, framed same-origin only) render inline; the rest downloads.
  const isPdf = type === "application/pdf";
  const inline = q.get("inline") === "1" && (INLINE_IMAGE_TYPES.has(type) || isPdf);
  // `text=1`: the first bytes as inert plain text (used for "Show original").
  const asText = q.get("text") === "1";

  try {
    const session = await getMailSession();
    const url = expandDownloadUrl(session.downloadUrl, { accountId: session.accountId, blobId, name, type });
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${session.token}` },
      cache: "no-store",
    });
    if (!upstream.ok || !upstream.body) {
      return new Response(upstream.status === 404 ? "Not found" : "Download failed", {
        status: upstream.status === 404 ? 404 : 502,
      });
    }

    if (asText) {
      const bytes = await readUpTo(upstream.body, TEXT_LIMIT);
      return new Response(new TextDecoder("utf-8", { fatal: false }).decode(bytes), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
          "X-Truncated": bytes.byteLength >= TEXT_LIMIT ? "1" : "0",
        },
      });
    }

    const headers = new Headers({
      "Content-Type": inline ? type : type.startsWith("text/") || type.includes("html") || type.includes("xml") ? "application/octet-stream" : type,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
      // The browser's PDF viewer doesn't run inside a CSP sandbox; PDFs may only be framed by us.
      "Content-Security-Policy": inline && isPdf ? "frame-ancestors 'self'" : "default-src 'none'; sandbox",
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": "private, max-age=86400, immutable",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    });
    const length = upstream.headers.get("content-length");
    if (length && /^\d+$/.test(length)) headers.set("Content-Length", length);
    return new Response(upstream.body, { status: 200, headers });
  } catch (e) {
    unstable_rethrow(e);
    return new Response("Download failed", { status: 502 });
  }
}

const TEXT_LIMIT = 2 * 1024 * 1024;

async function readUpTo(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const out = new Uint8Array(max);
  let n = 0;
  while (n < max) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, max - n);
    out.set(value.subarray(0, take), n);
    n += take;
  }
  await reader.cancel().catch(() => {});
  return out.subarray(0, n);
}

/** ASCII fallback for the legacy `filename=` parameter. */
function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachment";
}
