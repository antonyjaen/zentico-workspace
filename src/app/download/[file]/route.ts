// Public download of a native app installer (whitelisted names only, see src/lib/downloads.ts).
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { DOWNLOADS, downloadPath, isDownloadName } from "@/lib/downloads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!isDownloadName(file)) return new Response("Not found", { status: 404 });
  const path = downloadPath(file);
  let size: number;
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Content-Type": DOWNLOADS[file].type,
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
