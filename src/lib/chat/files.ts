// Chat attachments on disk (CHAT_FILES_DIR, default ./data/chat-files). Server-only.
// Files are stored flat under random ids; names and types live in the files table, and
// downloads are authorized per conversation (see /api/chat/file/[id]).
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";

export const FILE_ID = /^[a-z0-9]{24}$/;

function dir(): string {
  return resolve(process.env.CHAT_FILES_DIR?.trim() || "./data/chat-files");
}

const pathOf = (id: string) => {
  if (!FILE_ID.test(id)) throw new Error("Invalid file id");
  return join(dir(), id);
};

export async function saveFile(id: string, data: Uint8Array): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await writeFile(pathOf(id), data, { flag: "wx" });
}

export async function removeFiles(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => rm(pathOf(id), { force: true }).catch(() => {})));
}

/** A web stream of the file, or null when it's missing on disk. */
export async function readFileStream(id: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null> {
  const path = pathOf(id);
  try {
    const s = await stat(path);
    return { stream: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, size: s.size };
  } catch {
    return null;
  }
}
