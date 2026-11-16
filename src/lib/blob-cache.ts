// On-disk cache of Drive blobs for media playback. Stalwart ignores HTTP Range, so every range a
// video player asks for (dozens per playback, plus one per seek) would re-stream the blob from
// byte 0. Blobs are immutable (a new upload gets a new blobId), so the first ranged request
// downloads the whole blob once and later ranges are read from the local file. Server-only.
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { fetchBlob, type DriveNode } from "./drive";

const MAX_BYTES = 4 * 1024 ** 3; // whole cache
const MAX_FILE = 2 * 1024 ** 3;

const dir = () => join(process.env.DATA_DIR || join(process.cwd(), "data"), "blobcache");

const g = globalThis as typeof globalThis & { __zwBlobCache?: Map<string, Promise<string>> };
const inflight = (g.__zwBlobCache ??= new Map());

/** Local path of the node's blob, downloading it once if needed. Null if it can't be cached. */
export async function cachedBlobPath(node: DriveNode): Promise<string | null> {
  if (!node.blobId || !(node.size > 0) || node.size > MAX_FILE) return null;
  const key = createHash("sha256").update(`${node.accountId}\n${node.blobId}`).digest("hex");
  const path = join(dir(), key);
  try {
    const s = await stat(path);
    if (s.size === node.size) {
      const now = new Date();
      void utimes(path, now, now).catch(() => undefined); // LRU by mtime
      return path;
    }
  } catch {
    // not cached yet
  }
  let p = inflight.get(key);
  if (!p) {
    p = download(node, path).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p.catch(() => null);
}

async function download(node: DriveNode, path: string): Promise<string> {
  await mkdir(dir(), { recursive: true });
  await prune(node.size);
  const tmp = `${path}.${randomBytes(4).toString("hex")}.part`;
  const res = await fetchBlob(node, null);
  if (!res.ok || !res.body) throw new Error(`blob download ${res.status}`);
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as NodeWebStream<Uint8Array>), createWriteStream(tmp));
    const s = await stat(tmp);
    if (s.size !== node.size) throw new Error("size mismatch");
    await rename(tmp, path);
    return path;
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Deletes least-recently-used files until `incoming` more bytes fit under MAX_BYTES. */
async function prune(incoming: number): Promise<void> {
  const names = await readdir(dir()).catch(() => [] as string[]);
  const files = (
    await Promise.all(
      names.map(async (n) => {
        try {
          const s = await stat(join(dir(), n));
          return { path: join(dir(), n), size: s.size, mtime: s.mtimeMs, part: n.endsWith(".part") };
        } catch {
          return null;
        }
      }),
    )
  ).filter((f): f is NonNullable<typeof f> => !!f);
  // Stale partial downloads (crash mid-download) older than an hour.
  for (const f of files) if (f.part && Date.now() - f.mtime > 3_600_000) await rm(f.path, { force: true }).catch(() => undefined);
  const done = files.filter((f) => !f.part).sort((a, b) => a.mtime - b.mtime);
  let total = done.reduce((n, f) => n + f.size, 0);
  for (const f of done) {
    if (total + incoming <= MAX_BYTES) break;
    await rm(f.path, { force: true }).catch(() => undefined);
    total -= f.size;
  }
}
