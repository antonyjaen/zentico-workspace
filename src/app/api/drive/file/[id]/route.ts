// Drive file download / preview proxy. The node is looked up by id server-side, so name, type
// and blob come from the server, never from the query string.
import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { guessType } from "@/app/(apps)/drive/shared";
import { fetchBlob, getNode, TEXT_PREVIEW_BYTES, validId } from "@/lib/drive";

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

  try {
    const node = await getNode(id);
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

    const upstream = await fetchBlob(node, req.headers.get("range"));
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
      "Cache-Control": "private, no-cache",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "Accept-Ranges": "bytes",
    });
    for (const h of ["content-length", "content-range"]) {
      const v = upstream.headers.get(h);
      if (v && /^[\w\s\-/*=]+$/.test(v)) headers.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
  } catch (e) {
    unstable_rethrow(e);
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

function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
}
