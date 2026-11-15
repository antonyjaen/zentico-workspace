// Server-side Drive on JMAP FileNode (draft-ietf-jmap-filenode) with Stalwart.
// The draft is still moving, so every call is defensive: FileNode/query falls back to
// FileNode/get + local filtering, folders are detected by several signals, and unexpected
// server errors are logged (never tokens) so they can be adjusted against the live server.
import { cache } from "react";
import { getSession } from "./auth";
import { env } from "./env";
import { CAP, jmap, JmapError } from "./jmap";

export const FILENODE = "urn:ietf:params:jmap:filenode";
export const QUOTA = "urn:ietf:params:jmap:quota";
const USING = [CAP.core, FILENODE];

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const TEXT_PREVIEW_BYTES = 200 * 1024;
export const ID = /^[A-Za-z0-9_-]{1,255}$/;
export const MIME = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}$/;

/* ------------------------------------------------------------------ types */

export type DriveNode = {
  id: string;
  parentId: string | null;
  name: string;
  isFolder: boolean;
  blobId: string | null;
  type: string;
  size: number;
  created: string | null;
  modified: string | null;
  role: string | null;
};

type RawNode = {
  id?: string;
  parentId?: string | null;
  name?: string | null;
  blobId?: string | null;
  "@type"?: string | null;
  type?: string | null;
  mediaType?: string | null;
  size?: number | null;
  created?: string | null;
  modified?: string | null;
  updated?: string | null;
  role?: string | null;
};

export class DriveError extends Error {
  constructor(
    message: string,
    readonly code: string = "failed",
  ) {
    super(message);
  }
}

/* ---------------------------------------------------------------- session */

type DriveSession = {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  accountId: string;
  quotaAccountId: string | null;
  token: string;
};

type RawSession = {
  apiUrl?: string;
  uploadUrl?: string;
  downloadUrl?: string;
  capabilities?: Record<string, unknown>;
  primaryAccounts?: Record<string, string>;
  accounts?: Record<string, { accountCapabilities?: Record<string, unknown> }>;
};

/** JMAP session details for Drive; null when the server has no FileNode support. */
export const getDriveSession = cache(async (): Promise<DriveSession | null> => {
  const session = await getSession();
  if (!session) return null;
  const res = await fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`JMAP session failed: ${res.status}`);
  const s = (await res.json()) as RawSession;
  if (!s.capabilities?.[FILENODE] || !s.apiUrl || !s.uploadUrl || !s.downloadUrl) return null;
  const accountId =
    s.primaryAccounts?.[FILENODE] ??
    Object.entries(s.accounts ?? {}).find(([, a]) => a.accountCapabilities?.[FILENODE])?.[0] ??
    s.primaryAccounts?.[CAP.mail];
  if (!accountId) return null;
  return {
    apiUrl: s.apiUrl,
    uploadUrl: s.uploadUrl,
    downloadUrl: s.downloadUrl,
    accountId,
    quotaAccountId: s.capabilities?.[QUOTA] ? (s.primaryAccounts?.[QUOTA] ?? accountId) : null,
    token: session.accessToken,
  };
});

async function account(): Promise<string> {
  const s = await getDriveSession();
  if (!s) throw new DriveError("Drive not available", "unavailable");
  return s.accountId;
}

/* ------------------------------------------------------------- validation */

/** Returns a clean node name or null: no '/', no control chars, 1–255 chars, not "." / "..". */
export function validName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFC").trim();
  if (!s || s.length > 255 || s === "." || s === "..") return null;
  if (/[\u0000-\u001f\u007f/]/.test(s)) return null;
  return s;
}

export const validId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

/* -------------------------------------------------------------- normalize */

function isFolderRaw(n: RawNode): boolean {
  if (n["@type"]) return n["@type"] === "Directory";
  const type = (n.mediaType ?? n.type ?? "").toLowerCase();
  return n.blobId == null || type === "inode/directory" || type === "httpd/unix-directory";
}

function normalize(n: RawNode): DriveNode | null {
  if (!n.id) return null;
  const isFolder = isFolderRaw(n);
  return {
    id: n.id,
    parentId: n.parentId ?? null,
    name: n.name ?? "",
    isFolder,
    blobId: isFolder ? null : (n.blobId ?? null),
    type: isFolder ? "inode/directory" : n.mediaType || n.type || "application/octet-stream",
    size: typeof n.size === "number" ? n.size : 0,
    created: n.created ?? null,
    modified: n.modified ?? n.updated ?? n.created ?? null,
    role: n.role ?? null,
  };
}

function list(r: Record<string, unknown> | undefined): DriveNode[] {
  return ((r?.list as RawNode[] | undefined) ?? []).map(normalize).filter((n): n is DriveNode => !!n);
}

function logError(where: string, e: unknown) {
  console.error(`[drive] ${where}:`, e instanceof Error ? e.message : e);
}

/* ------------------------------------------------------------------ reads */

/** Every node in the account (FileNode/get with ids: null). Cached per request. */
export const getAllNodes = cache(async (): Promise<DriveNode[]> => {
  const accountId = await account();
  const r = await jmap([["FileNode/get", { accountId, ids: null }, "g"]], USING);
  return list(r.g);
});

/** Nodes by id (missing ids are simply absent). */
export async function getNodes(ids: string[]): Promise<DriveNode[]> {
  if (!ids.length) return [];
  const accountId = await account();
  const r = await jmap([["FileNode/get", { accountId, ids }, "g"]], USING);
  return list(r.g);
}

export async function getNode(id: string): Promise<DriveNode | null> {
  if (!validId(id)) return null;
  return (await getNodes([id]))[0] ?? null;
}

/**
 * Some servers expose one top-level home folder (role "root" / "home"); its id is then the
 * effective root. Returns null when top-level nodes are the root contents.
 */
export const getRootId = cache(async (): Promise<string | null> => {
  const all = await getAllNodes().catch((e) => {
    logError("getAllNodes", e);
    return [];
  });
  return all.find((n) => n.parentId == null && n.isFolder && (n.role === "root" || n.role === "home"))?.id ?? null;
});

/** Trash folder, when the server has one (role "trash"). */
export const getTrashId = cache(async (): Promise<string | null> => {
  const all = await getAllNodes().catch(() => []);
  return all.find((n) => n.isFolder && n.role === "trash")?.id ?? null;
});

/** Children of a folder (null = root). Tries FileNode/query first, then get-all + filter. */
export async function listChildren(parentId: string | null): Promise<DriveNode[]> {
  const accountId = await account();
  const rootId = parentId ?? (await getRootId());
  const want = (n: DriveNode) => (n.parentId ?? null) === rootId;
  // Stalwart rejects `filter: { parentId: null }` (invalidArguments): list the root locally.
  if (rootId === null) return (await getAllNodes()).filter(want);
  try {
    const r = await jmap(
      [
        ["FileNode/query", { accountId, filter: { parentId: rootId } }, "q"],
        ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" } }, "g"],
      ],
      USING,
    );
    // Filter locally too, in case the server ignored the filter.
    return list(r.g).filter(want);
  } catch (e) {
    logError(`FileNode/query parentId=${rootId ?? "null"} (falling back to get-all)`, e);
    return (await getAllNodes()).filter(want);
  }
}

/** Folder chain from the root down to (and including) `id`. */
export async function getPath(id: string): Promise<DriveNode[]> {
  const rootId = await getRootId();
  const chain: DriveNode[] = [];
  let current: string | null = id;
  const seen = new Set<string>();
  while (current && current !== rootId && !seen.has(current) && chain.length < 64) {
    seen.add(current);
    const node = await getNode(current);
    if (!node) break;
    chain.unshift(node);
    current = node.parentId;
  }
  return chain;
}

export type FolderEntry = { id: string; name: string; parentId: string | null };

/** All folders, for the move picker (trash and its contents excluded). */
export async function listFolders(): Promise<{ rootId: string | null; folders: FolderEntry[] }> {
  const [all, rootId, trashId] = await Promise.all([getAllNodes(), getRootId(), getTrashId()]);
  const inTrash = trashId ? descendantsOf(all, trashId) : new Set<string>();
  return {
    rootId,
    folders: all
      .filter((n) => n.isFolder && n.id !== rootId && n.id !== trashId && !inTrash.has(n.id))
      .map(({ id, name, parentId }) => ({ id, name, parentId: parentId === rootId ? null : parentId })),
  };
}

/** Ids of every node below `id` (not including it). */
export function descendantsOf(all: DriveNode[], id: string): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const n of all) if (n.parentId) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n.id]);
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    for (const c of byParent.get(stack.pop()!) ?? []) {
      if (!out.has(c)) {
        out.add(c);
        stack.push(c);
      }
    }
  }
  return out;
}

/** Case- and accent-insensitive substring search over names (server filters match whole words only). */
export async function searchNodes(q: string): Promise<DriveNode[]> {
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const needle = fold(q);
  const [all, trashId] = await Promise.all([getAllNodes(), getTrashId()]);
  const inTrash = trashId ? descendantsOf(all, trashId) : new Set<string>();
  return all.filter((n) => n.role == null && !inTrash.has(n.id) && fold(n.name).includes(needle));
}

/** Most recently modified files. */
export async function recentFiles(limit = 50): Promise<DriveNode[]> {
  const [all, trashId] = await Promise.all([getAllNodes(), getTrashId()]);
  const inTrash = trashId ? descendantsOf(all, trashId) : new Set<string>();
  return all
    .filter((n) => !n.isFolder && !inTrash.has(n.id))
    .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""))
    .slice(0, limit);
}

export type Quota = { used: number; limit: number | null };

/** Storage usage (urn:ietf:params:jmap:quota); null if unsupported. */
export async function getQuota(): Promise<Quota | null> {
  const s = await getDriveSession();
  if (!s?.quotaAccountId) return null;
  try {
    const r = await jmap([["Quota/get", { accountId: s.quotaAccountId, ids: null }, "q"]], [CAP.core, QUOTA]);
    type RawQuota = { resourceType?: string; used?: number; hardLimit?: number; types?: string[]; scope?: string };
    const quotas = ((r.q.list as RawQuota[] | undefined) ?? []).filter((q) => q.resourceType === "octets");
    const pick =
      quotas.find((q) => q.types?.some((t) => /file/i.test(t))) ??
      quotas.find((q) => q.scope === "account") ??
      quotas[0];
    if (!pick) return null;
    return { used: pick.used ?? 0, limit: pick.hardLimit && pick.hardLimit > 0 ? pick.hardLimit : null };
  } catch (e) {
    logError("Quota/get", e);
    return null;
  }
}

/* ----------------------------------------------------------------- writes */

type SetError = { type?: string; description?: string; properties?: string[] };

function firstError(r: Record<string, unknown>, key: "notCreated" | "notUpdated" | "notDestroyed"): SetError | null {
  const errs = r[key] as Record<string, SetError> | null | undefined;
  return (errs && Object.values(errs)[0]) || null;
}

function setFailure(where: string, err: SetError): never {
  logError(`FileNode/set ${where}`, `${err.type ?? "error"}${err.description ? `: ${err.description}` : ""}`);
  const code = /exist|duplicate|conflict/i.test(`${err.type} ${err.description}`) ? "exists" : "failed";
  throw new DriveError(err.description || err.type || "FileNode/set failed", code);
}

/** Picks a name that doesn't collide with siblings: "a.txt" → "a (1).txt". */
export async function uniqueName(parentId: string | null, name: string): Promise<string> {
  const taken = new Set(
    (await listChildren(parentId).catch(() => [] as DriveNode[])).map((n) => n.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (candidate.length <= 255 && !taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

async function create(props: Record<string, unknown>): Promise<DriveNode> {
  const accountId = await account();
  // Stalwart rejects explicit nulls on create, so empty fields are omitted.
  const clean: Record<string, unknown> = {
    // Stalwart requires `@type` on creation: "Directory" for folders, "File" (with blobId) for files.
    "@type": props.blobId ? "File" : "Directory",
    ...Object.fromEntries(
      Object.entries(props)
        .filter(([, v]) => v != null)
        // Stalwart calls the MIME type `mediaType` and rejects `type`.
        .map(([k, v]) => [k === "type" ? "mediaType" : k, v]),
    ),
  };
  const r = await jmap([["FileNode/set", { accountId, create: { n: clean } }, "s"]], USING);
  const err = firstError(r.s, "notCreated");
  if (err) setFailure("create", err);
  const created = (r.s.created as Record<string, RawNode> | undefined)?.n;
  if (!created?.id) throw new DriveError("FileNode/set create returned no id");
  return (
    normalize({ ...clean, ...created }) ?? {
      id: created.id,
      parentId: (clean.parentId as string) ?? null,
      name: String(clean.name),
      isFolder: !clean.blobId,
      blobId: (clean.blobId as string) ?? null,
      type: String(clean.type ?? ""),
      size: 0,
      created: null,
      modified: null,
      role: null,
    }
  );
}

async function effectiveParent(parentId: string | null): Promise<string | null> {
  return parentId ?? (await getRootId());
}

export async function createFolder(parentId: string | null, name: string): Promise<DriveNode> {
  const parent = await effectiveParent(parentId);
  return create({ parentId: parent, name: await uniqueName(parentId, name) });
}

export async function createFile(
  parentId: string | null,
  name: string,
  blob: { blobId: string; type: string; size?: number },
): Promise<DriveNode> {
  const parent = await effectiveParent(parentId);
  const node = await create({
    parentId: parent,
    name: await uniqueName(parentId, name),
    blobId: blob.blobId,
    type: blob.type,
  });
  return { ...node, isFolder: false, blobId: node.blobId ?? blob.blobId, size: node.size || blob.size || 0 };
}

export async function updateNode(id: string, patch: { name?: string; parentId?: string | null }): Promise<void> {
  const accountId = await account();
  const p: Record<string, unknown> = { ...patch };
  if ("parentId" in patch) p.parentId = patch.parentId ?? (await getRootId());
  const r = await jmap([["FileNode/set", { accountId, update: { [id]: p } }, "s"]], USING);
  const err = firstError(r.s, "notUpdated");
  if (err) setFailure("update", err);
}

/** Moves nodes into `target` (null = root). Refuses moving a folder into itself or a descendant. */
export async function moveNodes(ids: string[], target: string | null): Promise<void> {
  const all = await getAllNodes();
  if (target) {
    const dest = all.find((n) => n.id === target);
    if (!dest?.isFolder) throw new DriveError("Target is not a folder", "invalid");
    for (const id of ids) {
      if (id === target || descendantsOf(all, id).has(target)) throw new DriveError("Cannot move into itself", "cycle");
    }
  }
  const accountId = await account();
  const parent = target ?? (await getRootId());
  const update = Object.fromEntries(ids.map((id) => [id, { parentId: parent }]));
  const r = await jmap([["FileNode/set", { accountId, update }, "s"]], USING);
  const err = firstError(r.s, "notUpdated");
  if (err) setFailure("move", err);
}

/**
 * Permanently destroys nodes. Non-empty folders: retry with onDestroyRemoveChildren, and if the
 * server doesn't know that argument, destroy the descendants explicitly (deepest first).
 */
export async function destroyNodes(ids: string[]): Promise<void> {
  const accountId = await account();
  const r = await jmap([["FileNode/set", { accountId, destroy: ids }, "s"]], USING);
  const err = firstError(r.s, "notDestroyed");
  if (!err) return;
  logError("FileNode/set destroy (retrying with children)", `${err.type}: ${err.description ?? ""}`);
  const failed = Object.keys((r.s.notDestroyed as Record<string, unknown>) ?? {});
  try {
    const r2 = await jmap(
      [["FileNode/set", { accountId, destroy: failed, onDestroyRemoveChildren: true }, "s"]],
      USING,
    );
    const err2 = firstError(r2.s, "notDestroyed");
    if (!err2) return;
  } catch (e) {
    logError("FileNode/set destroy onDestroyRemoveChildren", e);
  }
  const all = await getAllNodes();
  const depth = (id: string) => {
    let d = 0;
    let cur = all.find((n) => n.id === id);
    while (cur?.parentId && d < 64) {
      cur = all.find((n) => n.id === cur!.parentId);
      d++;
    }
    return d;
  };
  const everything = [...new Set(failed.flatMap((id) => [...descendantsOf(all, id), id]))].sort(
    (a, b) => depth(b) - depth(a),
  );
  const r3 = await jmap([["FileNode/set", { accountId, destroy: everything }, "s"]], USING);
  const err3 = firstError(r3.s, "notDestroyed");
  if (err3) setFailure("destroy", err3);
}

/* ------------------------------------------------------------------ blobs */

/** Streams `body` to the JMAP upload endpoint, aborting past `max` bytes. */
export async function uploadStream(
  body: ReadableStream<Uint8Array> | ArrayBuffer,
  type: string,
  expected: number | null = null,
  max = MAX_UPLOAD_BYTES,
): Promise<{ blobId: string; type: string; size: number }> {
  const s = await getDriveSession();
  if (!s) throw new DriveError("Drive not available", "unavailable");
  let total = 0;
  if (body instanceof ArrayBuffer && body.byteLength > max) throw new DriveError("File too large", "too_large");
  const limited = body instanceof ArrayBuffer ? body : body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        total += chunk.byteLength;
        if (total > max) ctl.error(new DriveError("File too large", "too_large"));
        else ctl.enqueue(chunk);
      },
      flush(ctl) {
        // A short body means the request was cut off (e.g. a proxy/middleware body limit).
        if (expected != null && total !== expected) ctl.error(new DriveError("Body truncated", "truncated"));
      },
    }),
  );
  const url = s.uploadUrl.replace("{accountId}", encodeURIComponent(s.accountId));
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.token}`, "Content-Type": MIME.test(type) ? type : "application/octet-stream" },
      body: limited,
      cache: "no-store",
      // Required by Node's fetch for streaming request bodies.
      ...(body instanceof ArrayBuffer ? {} : { duplex: "half" }),
    } as RequestInit);
  } catch (e) {
    if (total > max) throw new DriveError("File too large", "too_large");
    if (expected != null && total !== expected) throw new DriveError("Body truncated", "truncated");
    throw e;
  }
  if (!res.ok) {
    logError("upload", `HTTP ${res.status}`);
    throw new DriveError(`Upload failed: ${res.status}`, res.status === 413 ? "too_large" : "failed");
  }
  const out = (await res.json()) as { blobId: string; type?: string; size?: number };
  return { blobId: out.blobId, type: out.type || type, size: out.size ?? (body instanceof ArrayBuffer ? body.byteLength : total) };
}

/** Fetches a file's blob from the JMAP download endpoint (optionally forwarding a Range header). */
export async function fetchBlob(node: DriveNode, range?: string | null): Promise<Response> {
  const s = await getDriveSession();
  if (!s) throw new DriveError("Drive not available", "unavailable");
  if (!node.blobId) throw new DriveError("Not a file", "invalid");
  const url = s.downloadUrl
    .replace("{accountId}", encodeURIComponent(s.accountId))
    .replace("{blobId}", encodeURIComponent(node.blobId))
    .replace("{name}", encodeURIComponent(node.name || "file"))
    .replace("{type}", encodeURIComponent(MIME.test(node.type) ? node.type : "application/octet-stream"));
  const headers: Record<string, string> = { Authorization: `Bearer ${s.token}` };
  if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;
  return fetch(url, { headers, cache: "no-store" });
}
