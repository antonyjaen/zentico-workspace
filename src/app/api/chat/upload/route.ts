// Chat attachments: multipart form with conversationId, optional text and threadRoot, and up to
// 10 files (25 MB each). Stores the files on disk and posts one 'file' message.
import { NextResponse, type NextRequest } from "next/server";
import { BODY_MAX, FILE_MAX_BYTES, isConversationId, type FileMeta } from "@/app/(apps)/chat/shared";
import { removeFiles, saveFile } from "@/lib/chat/files";
import { jsonError, sameOrigin } from "@/lib/chat/http";
import { chatUserOrNull } from "@/lib/chat/session";
import { canReadConversation, ChatError, newId, postMessage, recordFile, removeFileRecords } from "@/lib/chat/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FILES = 10;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
// Control characters and path separators are stripped from file names.
const BAD_NAME = /[\u0000-\u001f\u007f/\\]/g;

export async function POST(req: NextRequest) {
  const me = await chatUserOrNull();
  if (!me) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);

  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_FILES * FILE_MAX_BYTES + 1024 * 1024) return jsonError("tooLarge", 413);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("invalid", 400);
  }
  const conversationId = form.get("conversationId");
  if (!isConversationId(conversationId)) return jsonError("invalid", 400);
  if (!canReadConversation(conversationId, me.id)) return jsonError("notFound", 404);
  const rawText = form.get("text");
  const text = typeof rawText === "string" ? rawText.replace(/\r\n?/g, "\n").trim() : "";
  if (text.length > BODY_MAX) return jsonError("tooLong", 400);
  const rawRoot = form.get("threadRoot");
  const threadRoot = typeof rawRoot === "string" && /^\d{1,15}$/.test(rawRoot) ? Number(rawRoot) : null;

  const files = form.getAll("file").filter((f): f is File => typeof f !== "string");
  if (files.length === 0 || files.length > MAX_FILES) return jsonError("invalid", 400);
  if (files.some((f) => f.size > FILE_MAX_BYTES)) return jsonError("tooLarge", 413);

  const saved: FileMeta[] = [];
  try {
    for (const f of files) {
      const id = newId(24);
      const name = (f.name || "file").replace(BAD_NAME, "").trim().slice(0, 200) || "file";
      const type = (f.type || "").toLowerCase();
      const mime = MIME.test(type) ? type : "application/octet-stream";
      await saveFile(id, new Uint8Array(await f.arrayBuffer()));
      recordFile(conversationId, me.id, { id, name, mime, size: f.size });
      saved.push({ id, name, mime, size: f.size });
    }
    const message = postMessage(conversationId, me.id, { body: text, files: saved, threadRoot });
    return NextResponse.json({ message });
  } catch (e) {
    const ids = saved.map((f) => f.id);
    removeFileRecords(ids);
    await removeFiles(ids);
    if (e instanceof ChatError) return jsonError(e.message, e.message === "notFound" ? 404 : 403);
    console.error("[chat] upload failed", e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}
