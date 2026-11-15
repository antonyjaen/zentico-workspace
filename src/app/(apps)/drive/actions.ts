"use server";

// Drive mutations. Every argument is untrusted: ids and names are validated here.
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import {
  createFile,
  createFolder,
  destroyNodes,
  DriveError,
  getAllNodes,
  getNode,
  getRootId,
  getTrashId,
  listChildren,
  listFolders,
  moveNodes,
  updateNode,
  uploadStream,
  validId,
  validName,
  type FolderEntry,
} from "@/lib/drive";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

const MAX_BATCH = 500;

async function run<T>(fn: () => Promise<T>, mutates = true): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    if (mutates) revalidatePath("/drive");
    return { ok: true, data };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof DriveError) return { ok: false, error: e.code };
    console.error("[drive] action:", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

function parent(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (!validId(v)) throw new DriveError("Invalid folder", "invalid");
  return v;
}

function ids(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BATCH || !v.every(validId)) {
    throw new DriveError("Invalid selection", "invalid");
  }
  return [...new Set(v as string[])];
}

function name(v: unknown): string {
  const n = validName(v);
  if (!n) throw new DriveError("Invalid name", "invalid_name");
  return n;
}

export async function newFolderAction(parentId: unknown, folderName: unknown) {
  return run(async () => {
    const node = await createFolder(parent(parentId), name(folderName));
    return node.id;
  });
}

export async function renameAction(id: unknown, newName: unknown) {
  return run(async () => {
    if (!validId(id)) throw new DriveError("Invalid id", "invalid");
    const n = name(newName);
    const node = await getNode(id);
    if (!node) throw new DriveError("Not found", "not_found");
    const siblings = await listChildren(node.parentId).catch(() => []);
    if (siblings.some((s) => s.id !== id && s.name.toLowerCase() === n.toLowerCase())) {
      throw new DriveError("Name taken", "exists");
    }
    await updateNode(id, { name: n });
  });
}

export async function moveAction(nodeIds: unknown, target: unknown) {
  return run(() => moveNodes(ids(nodeIds), parent(target)));
}

/** Moves to the trash folder when the server has one (and the items aren't already there); else destroys. */
export async function deleteAction(nodeIds: unknown, permanent: unknown) {
  return run(async () => {
    const list = ids(nodeIds);
    const trashId = await getTrashId();
    if (trashId && permanent !== true) {
      await moveNodes(list, trashId);
      return "trashed" as const;
    }
    await destroyNodes(list);
    return "destroyed" as const;
  });
}

export async function folderTreeAction() {
  return run<{ rootId: string | null; folders: FolderEntry[] }>(() => listFolders(), false);
}

/**
 * Creates (or reuses) the folder chains for a folder upload. `paths` are relative folder paths
 * like "Photos/2024"; returns a map path → folder id.
 */
export async function ensureFoldersAction(parentId: unknown, paths: unknown) {
  return run(async () => {
    const base = parent(parentId);
    if (!Array.isArray(paths) || paths.length > MAX_BATCH) throw new DriveError("Invalid paths", "invalid");
    const clean = paths.map((p) => {
      if (typeof p !== "string" || p.length > 4096) throw new DriveError("Invalid path", "invalid");
      return p.split("/").filter(Boolean).map(name);
    });
    const [all, rootId] = await Promise.all([getAllNodes().catch(() => []), getRootId()]);
    const out: Record<string, string> = {};
    // Shortest paths first so parents exist before children.
    for (const segs of clean.sort((a, b) => a.length - b.length)) {
      let current = base;
      for (let i = 0; i < segs.length; i++) {
        const key = segs.slice(0, i + 1).join("/");
        if (out[key]) {
          current = out[key];
          continue;
        }
        const existing = all.find(
          (n) => n.isFolder && (n.parentId ?? null) === (current ?? rootId) && n.name.toLowerCase() === segs[i].toLowerCase(),
        );
        const id = existing?.id ?? (await createFolder(current, segs[i])).id;
        out[key] = id;
        current = id;
      }
    }
    return out;
  });
}

const BLANK: Record<string, { name: string; type: string }> = {
  document: { name: "Untitled document.odt", type: "application/vnd.oasis.opendocument.text" },
  spreadsheet: { name: "Untitled spreadsheet.ods", type: "application/vnd.oasis.opendocument.spreadsheet" },
  presentation: { name: "Untitled presentation.odp", type: "application/vnd.oasis.opendocument.presentation" },
};

/** Creates an empty office file (zero-byte placeholder) and returns its id for /docs/edit/<id>. */
export async function newDocAction(parentId: unknown, kind: unknown) {
  return run(async () => {
    const spec = typeof kind === "string" ? BLANK[kind] : undefined;
    if (!spec) throw new DriveError("Invalid kind", "invalid");
    const p = parent(parentId);
    const blob = await uploadStream(new ArrayBuffer(0), spec.type);
    const node = await createFile(p, spec.name, { ...blob, type: spec.type });
    return node.id;
  });
}
