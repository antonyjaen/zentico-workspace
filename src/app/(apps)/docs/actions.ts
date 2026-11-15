"use server";

// Docs mutations. Every argument is untrusted: ids, names and presets are validated here.
import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { NATIVE, PRESETS, extOf, isNativeKind, nativeKind, type DocKind } from "./shared";
import {
  createFile,
  destroyNodes,
  DriveError,
  getNode,
  getTrashId,
  listChildren,
  moveNodes,
  updateNode,
  uploadStream,
  validName,
} from "@/lib/drive";
import { docKind, NEW_DOC } from "@/lib/wopi";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

const ID = /^[A-Za-z0-9_-]{1,255}$/;

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    revalidatePath("/docs");
    revalidatePath("/drive");
    return { ok: true, data };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof DriveError) return { ok: false, error: e.code };
    console.error("[docs] action:", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

function fileId(v: unknown): string {
  if (typeof v !== "string" || !ID.test(v)) throw new DriveError("Invalid id", "invalid");
  return v;
}

async function fileNode(id: string) {
  const node = await getNode(id);
  if (!node || node.isFolder) throw new DriveError("Not found", "not_found");
  return node;
}

/** Creates an empty file in the Drive root (named after the preset) and returns its id. */
export async function createDocumentAction(preset: unknown) {
  return run(async () => {
    const spec = PRESETS.find((p) => p.id === preset);
    if (!spec) throw new DriveError("Invalid preset", "invalid");
    const kind: DocKind = spec.kind;
    const t = await getTranslations("docs");
    const base = spec.id.startsWith("blank") ? t(`untitled.${kind}`) : t(`presets.${spec.id}`);
    if (isNativeKind(kind)) {
      // Whiteboards start as an empty Excalidraw scene, Markdown as an empty text file.
      const { ext, mediaType, blank } = NATIVE[kind];
      const bytes = new TextEncoder().encode(blank);
      const blob = await uploadStream(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, mediaType);
      const node = await createFile(null, `${base}.${ext}`, { ...blob, type: mediaType });
      return node.id;
    }
    const { ext, type } = NEW_DOC[kind];
    // Zero-byte ODF: Collabora opens it as a new blank document of that type.
    const blob = await uploadStream(new ArrayBuffer(0), type);
    const node = await createFile(null, `${base}.${ext}`, { ...blob, type });
    return node.id;
  });
}

/**
 * Renames a file. The extension decides which editor opens it, so it's kept unless the new
 * name ends in another extension of the same editor (office ↔ office, .md ↔ .markdown).
 * Returns the final name.
 */
export async function renameDocumentAction(id: unknown, newName: unknown) {
  return run(async () => {
    const fid = fileId(id);
    let name = validName(newName);
    if (!name) throw new DriveError("Invalid name", "invalid_name");
    const node = await fileNode(fid);
    const oldExt = extOf(node.name);
    const oldNative = nativeKind(node.name);
    const keepsEditor = oldNative ? nativeKind(name) === oldNative : !!docKind(name);
    if (oldExt && !keepsEditor) name = validName(`${name}.${oldExt}`);
    if (!name) throw new DriveError("Invalid name", "invalid_name");
    if (name === node.name) return name;
    const siblings = await listChildren(node.parentId).catch(() => []);
    if (siblings.some((s) => s.id !== fid && s.name.toLowerCase() === name!.toLowerCase())) {
      throw new DriveError("Name taken", "exists");
    }
    await updateNode(fid, { name });
    return name;
  });
}

/** Moves a file to the Drive trash when the server has one, else deletes it permanently. */
export async function deleteDocumentAction(id: unknown) {
  return run(async () => {
    const fid = fileId(id);
    await fileNode(fid);
    const trashId = await getTrashId();
    if (trashId) {
      await moveNodes([fid], trashId);
      return "trashed" as const;
    }
    await destroyNodes([fid]);
    return "destroyed" as const;
  });
}
