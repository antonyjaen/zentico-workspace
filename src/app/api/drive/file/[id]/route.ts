// Drive file download / preview proxy. The node is looked up by id server-side, so name, type
// and blob come from the server, never from the query string.
import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { guessType } from "@/app/(apps)/drive/shared";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { cachedBlobPath } from "@/lib/blob-cache";
import { DriveError, fetchBlob, getNode, TEXT_PREVIEW_BYTES, validId } from "@/lib/drive";

export const dynamic = "force-dynamic";

const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const MEDIA = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
]);

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validId(id)) return new Response("Invalid id", { status: 400 });
  const q = req.nextUrl.searchParams;
  // ?account=<id> reads from a shared account; lib/drive checks it's one of the session's.
  const account = q.get("account") || null;
  if (account !== null && !validId(account)) return new Response("Invalid account", { status: 400 });

  try {
    const node = await getNode(id, account);
    if (!node || node.isFolder || !node.blobId) return new Response("Not found", { status: 404 });
    const type = guessType(node.name, node.type);
    const name = node.name || "file";

    if (q.get("text") === "1") {
      const upstream = await fetchBlob(node, `bytes=0-${TEXT_PREVIEW_BYTES - 1}`);
      if (!upstream.ok || !upstream.body) return new Response("Not found", { status: upstream.status === 404 ? 404 : 502 });
      const bytes = await readUpTo(upstream.body, TEXT_PREVIEW_BYTES);
      return new Response(new TextDecoder("utf-8", { fatal: false }).decode(bytes), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "private, no-store",
          "X-Truncated": node.size > TEXT_PREVIEW_BYTES ? "1" : "0",
        },
      });
    }

    const wantInline = q.get("inline") === "1";
    const isPdf = type === "application/pdf";
    const isSvg = type === "image/svg+xml";
    const inline = wantInline && (RASTER.has(type) || MEDIA.has(type) || isPdf || isSvg);

    const rangeHeader = req.headers.get("range");
    // Media players ask for many ranges; serve them from a local copy (see blob-cache).
    const cached = inline && MEDIA.has(type) && rangeHeader ? await cachedBlobPath(node) : null;
    if (cached) {
      const size = node.size;
      const range = parseRange(rangeHeader, size) ?? { start: 0, end: size - 1 };
      if (range === "invalid") return new Response("Range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      const file = Readable.toWeb(createReadStream(cached, { start: range.start, end: range.end })) as ReadableStream<Uint8Array>;
      return new Response(file, {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Disposition": `inline; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
          "Content-Length": String(range.end - range.start + 1),
          "Accept-Ranges": "bytes",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          "X-Frame-Options": "SAMEORIGIN",
          "Cache-Control": "private, no-cache, no-transform",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    const upstream = await fetchBlob(node, rangeHeader);
    if (!upstream.body || (!upstream.ok && upstream.status !== 206)) {
      return new Response(upstream.status === 404 ? "Not found" : "Download failed", {
        status: upstream.status === 404 ? 404 : upstream.status === 416 ? 416 : 502,
      });
    }

    const headers = new Headers({
      "Content-Type": inline ? type : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
      // PDFs are framed by the preview modal (same origin only); the browser's PDF viewer
      // doesn't run inside a CSP sandbox, so PDFs get frame-ancestors only.
      "Content-Security-Policy": isPdf && inline ? "frame-ancestors 'self'" : "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Frame-Options": "SAMEORIGIN",
      // no-transform: Next's gzip would drop Content-Length/Content-Range and break media playback.
      "Cache-Control": "private, no-cache, no-transform",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "Accept-Ranges": "bytes",
    });
    if (upstream.status === 206) {
      for (const h of ["content-length", "content-range"]) {
        const v = upstream.headers.get(h);
        if (v && /^[\w\s\-/*=]+$/.test(v)) headers.set(h, v);
      }
      return new Response(upstream.body, { status: 206, headers });
    }
    // Stalwart ignores Range and streams the whole blob (chunked, no length). Media players need
    // byte ranges and a length to start playing and to seek, so serve the range from the stream.
    const size = node.size;
    const range = parseRange(req.headers.get("range"), size);
    if (range === "invalid") {
      await upstream.body.cancel().catch(() => {});
      return new Response("Range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    if (range) {
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      headers.set("Content-Length", String(range.end - range.start + 1));
      return new Response(sliceStream(upstream.body, range.start, range.end), { status: 206, headers });
    }
    if (size > 0) headers.set("Content-Length", String(size));
    return new Response(upstream.body, { status: 200, headers });
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof DriveError && e.code === "not_found") return new Response("Not found", { status: 404 });
    console.error("[drive] file route:", e instanceof Error ? e.message : e);
    return new Response("Download failed", { status: 502 });
  }
}

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

/** A single "bytes=a-b" / "bytes=a-" / "bytes=-n" range within `size`; null = whole file. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header || !(size > 0)) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null; // multi-range or malformed: send it all
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/** Bytes [start, end] of a stream (skipping what comes before, stopping after end). */
function sliceStream(body: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        const from = pos;
        pos += value.byteLength;
        if (pos <= start) continue;
        const a = Math.max(0, start - from);
        const b = Math.min(value.byteLength, end + 1 - from);
        if (b > a) controller.enqueue(value.subarray(a, b));
        if (pos > end) {
          // Close first: awaiting the upstream cancel can stall and leave the response open.
          controller.close();
          void reader.cancel().catch(() => {});
          return;
        }
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
}
