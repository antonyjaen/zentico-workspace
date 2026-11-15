// Downloads a Chat attachment for people who can read its conversation.
import { NextResponse, type NextRequest } from "next/server";
import { isPreviewableImage } from "@/app/(apps)/chat/shared";
import { FILE_ID, readFileStream } from "@/lib/chat/files";
import { jsonError } from "@/lib/chat/http";
import { chatUserOrNull } from "@/lib/chat/session";
import { fileFor } from "@/lib/chat/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await chatUserOrNull();
  if (!me) return jsonError("unauthorized", 401);
  const { id } = await params;
  if (!FILE_ID.test(id)) return jsonError("notFound", 404);
  const file = fileFor(id, me.id);
  if (!file) return jsonError("notFound", 404);
  const data = await readFileStream(id);
  if (!data) return jsonError("notFound", 404);

  // Only raster images render inline (for previews); everything else downloads.
  const inline = req.nextUrl.searchParams.get("download") !== "1" && isPreviewableImage(file.mime);
  const disposition = `${inline ? "inline" : "attachment"}; filename="${asciiName(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  return new NextResponse(data.stream, {
    headers: {
      "Content-Type": inline ? file.mime : "application/octet-stream",
      "Content-Length": String(data.size),
      "Content-Disposition": disposition,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
