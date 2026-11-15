// Audio upload from the recorder's browser: multipart form with one chunk of one speaker's track.
// Fields: segment (client id), identity (speaker email), name, offset (ms from recording start),
// seq (0-based, per segment), mime, file.
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { errorResponse, jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { addChunk } from "@/lib/meetings/store";
import { AUDIO_MIMES, CHUNK_MAX_BYTES, MEETING_ID, SEGMENT_ID } from "@/app/(apps)/meet/recording";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/;
const BAD_TEXT = /[\u0000-\u001f\u007f]/g;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  const { id } = await params;
  if (!MEETING_ID.test(id)) return jsonError("not_found", 404);

  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > CHUNK_MAX_BYTES + 64 * 1024) return jsonError("too_large", 413);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("invalid", 400);
  }
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const clientId = field("segment");
  const identity = field("identity").trim();
  const name = field("name").replace(BAD_TEXT, " ").trim().slice(0, 200);
  const offsetMs = Number(field("offset"));
  const seq = Number(field("seq"));
  const mime = field("mime").split(";")[0].trim().toLowerCase();
  const file = form.get("file");

  if (
    !SEGMENT_ID.test(clientId) ||
    !EMAIL.test(identity) ||
    !Number.isFinite(offsetMs) ||
    offsetMs < 0 ||
    offsetMs > 7 * 24 * 3600_000 ||
    !Number.isInteger(seq) ||
    seq < 0 ||
    seq > 1_000_000 ||
    !(AUDIO_MIMES as readonly string[]).includes(mime) ||
    !(file instanceof Blob) ||
    file.size === 0
  ) {
    return jsonError("invalid", 400);
  }
  if (file.size > CHUNK_MAX_BYTES) return jsonError("too_large", 413);

  try {
    const { duplicate } = await addChunk({
      id,
      session,
      segment: { clientId, identity, name: name || identity, offsetMs, mime },
      seq,
      data: new Uint8Array(await file.arrayBuffer()),
    });
    return NextResponse.json({ ok: true, duplicate }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e, "chunk");
  }
}
