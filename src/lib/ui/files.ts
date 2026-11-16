// Drive I/O for `Zentico UI/` in the signed-in user's own Drive (primary account): find or create
// the folder, list its files as paths (two levels: root files and mods/<id>/<file>), read them
// (cached by blobId, which is immutable), write and delete them. Runs with the current session
// (browser cookie or MCP runWithSession). Server-only.
import {
  createFile,
  createFolder,
  fetchBlob,
  getNode,
  getTrashId,
  listChildren,
  moveNodes,
  destroyNodes,
  replaceContent,
  uploadStream,
  type DriveNode,
} from "../drive";
import { hashText, isUiPath, MODS_DIR, UI_FOLDER } from "./schema";

export type UiFileEntry = { path: string; node: DriveNode };
export type UiTree = { folderId: string; files: UiFileEntry[]; dirs: Map<string, string> };

const MAX_READ_BYTES = 1024 * 1024;

const MIME: Record<string, string> = {
  json: "application/json",
  md: "text/markdown",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  txt: "text/plain",
};
export const mimeOf = (path: string) => MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "text/plain";

/* ------------------------------------------------------------- blob cache */

const g = globalThis as typeof globalThis & { __zwUiBlobs?: Map<string, string> };
const blobs = (g.__zwUiBlobs ??= new Map());
const BLOB_CACHE_MAX = 600;

async function readNode(node: DriveNode): Promise<string> {
  if (!node.blobId) return "";
  const key = `${node.accountId}:${node.blobId}`;
  const hit = blobs.get(key);
  if (hit !== undefined) {
    blobs.delete(key);
    blobs.set(key, hit);
    return hit;
  }
  const res = await fetchBlob(node);
  if (!res.ok) throw new Error(`Could not read ${node.name} (HTTP ${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf.byteLength > MAX_READ_BYTES ? buf.slice(0, MAX_READ_BYTES) : buf);
  blobs.set(key, text);
  if (blobs.size > BLOB_CACHE_MAX) blobs.delete(blobs.keys().next().value!);
  return text;
}

/* ----------------------------------------------------------------- folder */

/** In the Drive trash? (one small lookup of the parent instead of listing the whole Drive) */
const isTrashed = async (n: DriveNode) => {
  if (!n.parentId) return false;
  const parent = await getNode(n.parentId).catch(() => null);
  return parent?.role === "trash";
};

/** The user's `Zentico UI` folder (the remembered id when still valid), or null. */
export async function findUiFolder(rememberedId: string | null): Promise<DriveNode | null> {
  if (rememberedId) {
    const n = await getNode(rememberedId).catch(() => null);
    if (n?.isFolder && n.name === UI_FOLDER && !(await isTrashed(n))) return n;
  }
  const root = await listChildren(null);
  return root.find((n) => n.isFolder && n.name.toLowerCase() === UI_FOLDER.toLowerCase() && n.rights.mayAddChildren !== false) ?? null;
}

export async function createUiFolder(): Promise<DriveNode> {
  return createFolder(null, UI_FOLDER);
}

/** Every UI file under the folder, as paths. Other files and deeper levels are ignored. */
export async function readTree(folderId: string): Promise<UiTree> {
  const files: UiFileEntry[] = [];
  const dirs = new Map<string, string>();
  const top = await listChildren(folderId);
  const mods = top.find((n) => n.isFolder && n.name === MODS_DIR);
  for (const n of top) if (!n.isFolder && isUiPath(n.name)) files.push({ path: n.name, node: n });
  if (mods) {
    dirs.set(MODS_DIR, mods.id);
    const modDirs = (await listChildren(mods.id)).filter((n) => n.isFolder).slice(0, 40);
    const lists = await Promise.all(modDirs.map((d) => listChildren(d.id).then((l) => [d, l] as const)));
    for (const [d, list] of lists) {
      dirs.set(`${MODS_DIR}/${d.name}`, d.id);
      for (const n of list) {
        const path = `${MODS_DIR}/${d.name}/${n.name}`;
        if (!n.isFolder && isUiPath(path)) files.push({ path, node: n });
        // Folder names that aren't valid mod ids still show up, so the validator can report them.
        else if (!n.isFolder && !isUiPath(path) && /\.(json|html|css|js|md|txt)$/.test(n.name)) files.push({ path, node: n });
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { folderId, files, dirs };
}

/** Changes whenever any file is added, removed, renamed or rewritten. */
export const treeSignature = (t: UiTree) => hashText(t.files.map((f) => `${f.path}:${f.node.blobId ?? ""}:${f.node.size}`).join("|"));

export async function readTexts(t: UiTree): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const texts = await Promise.all(t.files.map((f) => readNode(f.node)));
  t.files.forEach((f, i) => (out[f.path] = texts[i]));
  return out;
}

/* ------------------------------------------------------------------ write */

async function ensureDir(t: UiTree, dir: string): Promise<string> {
  if (!dir) return t.folderId;
  const known = t.dirs.get(dir);
  if (known) return known;
  const parts = dir.split("/");
  const parent = await ensureDir(t, parts.slice(0, -1).join("/"));
  const existing = (await listChildren(parent)).find((n) => n.isFolder && n.name === parts[parts.length - 1]);
  const id = existing?.id ?? (await createFolder(parent, parts[parts.length - 1])).id;
  t.dirs.set(dir, id);
  return id;
}

const encode = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

/**
 * Applies changes (path → new text, or null to delete) to the folder. Deleted files go to the
 * Drive trash when there is one. Returns the paths actually changed.
 */
export async function writeTexts(t: UiTree, changes: Record<string, string | null>): Promise<string[]> {
  const byPath = new Map(t.files.map((f) => [f.path, f.node]));
  const done: string[] = [];
  const removed: string[] = [];
  for (const [path, text] of Object.entries(changes)) {
    if (!isUiPath(path)) throw new Error(`Invalid path "${path}"`);
    const existing = byPath.get(path);
    if (text === null) {
      if (existing) {
        removed.push(existing.id);
        done.push(path);
      }
      continue;
    }
    const type = mimeOf(path);
    if (existing) {
      const node = await replaceContent(existing.id, encode(text), type);
      if (node.blobId) blobs.set(`${node.accountId}:${node.blobId}`, text);
    } else {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const parent = await ensureDir(t, dir);
      const blob = await uploadStream(encode(text), type, null, { max: 2 * 1024 * 1024 });
      const node = await createFile(parent, path.slice(path.lastIndexOf("/") + 1), { ...blob, type });
      blobs.set(`${node.accountId}:${blob.blobId}`, text);
    }
    done.push(path);
  }
  if (removed.length) {
    const trash = await getTrashId().catch(() => null);
    if (trash) await moveNodes(removed, trash);
    else await destroyNodes(removed);
  }
  return done;
}
