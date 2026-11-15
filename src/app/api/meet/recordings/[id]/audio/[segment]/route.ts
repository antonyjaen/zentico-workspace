// Streams one speaker segment's audio to people who may read the recording (Range supported).
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { jsonError } from "@/lib/meetings/http";
import { audioFile } from "@/lib/meetings/store";
import { MEETING_ID } from "@/app/(apps)/meet/recording";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const stream = (path: string, start: number, end: number) =>
  Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; segment: string }> }) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  const { id, segment } = await params;
  if (!MEETING_ID.test(id) || !/^\d{1,12}$/.test(segment)) return jsonError("not_found", 404);
  const file = await audioFile(id, Number(segment), session.email);
  if (!file || file.size === 0) return jsonError("not_found", 404);
  const { size } = file;

  const headers: Record<string, string> = {
    "Content-Type": file.mime,
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };

  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    // "bytes=a-b", "bytes=a-" or the suffix form "bytes=-n".
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    return new Response(stream(file.path, start, end), {
      status: 206,
      headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
    });
  }
  return new Response(stream(file.path, 0, size - 1), { headers: { ...headers, "Content-Length": String(size) } });
}
