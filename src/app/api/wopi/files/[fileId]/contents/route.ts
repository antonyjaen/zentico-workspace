// WOPI GetFile (GET) and PutFile (POST): file bytes, streamed from / uploaded to JMAP blobs.
import {
  clientFor,
  currentLock,
  FilesError,
  ID,
  isoTime,
  MAX_PUT_BYTES,
  verifyWopiToken,
  WOPI_HEADERS,
  wopiError,
} from "@/lib/wopi";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fileId: string }> };

function failure(e: unknown) {
  if (e instanceof FilesError) return wopiError(e.status === 401 ? 401 : e.status === 404 ? 404 : 500);
  return wopiError(500);
}

export async function GET(req: Request, { params }: Ctx) {
  const { fileId } = await params;
  if (!ID.test(fileId)) return wopiError(404);
  const token = await verifyWopiToken(req, fileId);
  if (!token) return wopiError(401);

  try {
    const client = clientFor(token);
    const node = await client.getNode(fileId);
    if (!node || !node.blobId) return wopiError(404);
    const res = await client.download(node);
    const headers: Record<string, string> = {
      ...WOPI_HEADERS,
      "Content-Type": "application/octet-stream",
      "X-WOPI-ItemVersion": node.blobId,
    };
    const length = res.headers.get("content-length");
    if (length) headers["Content-Length"] = length;
    return new Response(res.body, { status: 200, headers });
  } catch (e) {
    return failure(e);
  }
}

/** Reads the request body, refusing anything larger than `max` bytes. */
async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
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
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function POST(req: Request, { params }: Ctx) {
  const { fileId } = await params;
  if (!ID.test(fileId)) return wopiError(404);
  const token = await verifyWopiToken(req, fileId);
  if (!token) return wopiError(401);
  if (req.headers.get("x-wopi-override")?.toUpperCase() !== "PUT") return wopiError(501);

  // Lock semantics: a different lock is a conflict. An unlocked file is accepted (lenient on
  // purpose: the in-memory lock table is lost on restart and we must not drop the user's save).
  const lock = req.headers.get("x-wopi-lock") ?? "";
  const current = currentLock(fileId);
  if (current && current !== lock) return wopiError(409, { "X-WOPI-Lock": current });

  try {
    const client = clientFor(token);
    const node = await client.getNode(fileId);
    if (!node || !node.blobId) return wopiError(404);

    // Collabora's conflict detection: it sends the timestamp it last saw; if the file changed
    // since, answer 1010 so the user can choose to overwrite or reload.
    const seen = req.headers.get("x-cool-wopi-timestamp") ?? req.headers.get("x-lool-wopi-timestamp");
    if (seen && new Date(seen).getTime() !== new Date(isoTime(node.modified)).getTime()) {
      return Response.json({ COOLStatusCode: 1010, LOOLStatusCode: 1010 }, { status: 409, headers: WOPI_HEADERS });
    }

    const body = await readLimited(req, MAX_PUT_BYTES);
    if (!body) return wopiError(413);
    const next = await client.replaceContent(node, body);
    return Response.json(
      { LastModifiedTime: isoTime(next.modified) },
      { headers: { ...WOPI_HEADERS, ...(next.blobId ? { "X-WOPI-ItemVersion": next.blobId } : {}) } },
    );
  } catch (e) {
    return failure(e);
  }
}
