import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { cleanFileName, MAX_ATTACHMENT_BYTES, uploadBlob } from "@/lib/mail-compose";

/**
 * Attachment upload proxy: the browser posts the raw file here and we forward it to the JMAP
 * upload endpoint with the user's token, so the token never reaches the browser.
 * Query: ?name=<file name>&account=<identity account id>. Body: the file bytes. Header Content-Type: the file type.
 */
export async function POST(req: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Same-origin only (the session cookie is SameSite=Lax, but be explicit for POSTs).
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin && origin !== new URL(env.appUrl).origin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_ATTACHMENT_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const body = await readLimited(req, MAX_ATTACHMENT_BYTES);
  if (!body) return NextResponse.json({ error: "too_large" }, { status: 413 });
  if (body.byteLength === 0) return NextResponse.json({ error: "empty" }, { status: 400 });

  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim() || "application/octet-stream";
  try {
    // ?account=: the sending identity's account, so the blob lands where the message is created.
    const blob = await uploadBlob(body, type, req.nextUrl.searchParams.get("account"));
    return NextResponse.json({ ...blob, name: cleanFileName(req.nextUrl.searchParams.get("name")) });
  } catch {
    return NextResponse.json({ error: "upload_failed" }, { status: 502 });
  }
}

/** Reads the request body, giving up (null) as soon as it exceeds `max` bytes. */
async function readLimited(req: NextRequest, max: number): Promise<ArrayBuffer | null> {
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}
