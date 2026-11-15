// Server loader for the built-in editors (whiteboard, Markdown): finds the file in the user's
// own drive, checks it belongs to the editor and reads its content as text. Also resolves the
// viewer's access (rights + share count) for every editor's top bar.
import { unstable_rethrow } from "next/navigation";
import { MAX_NATIVE_BYTES, nativeKind, type DocAccess, type NativeKind } from "./shared";
import { fetchBlob, getNode, getRootId, getSharing, roleOf, validId, type DriveNode } from "@/lib/drive";

export type NativeDoc = {
  id: string;
  name: string;
  /** Drive folder for "Open in Drive" (null = My Drive root). */
  folderId: string | null;
  content: string;
  readOnly: boolean;
  /** Null when the rights couldn't be read (the Share controls are then hidden). */
  access: DocAccess | null;
};

export type NativeLoad = { ok: true; doc: NativeDoc } | { ok: false; error: "not_found" | "wrong_kind" | "too_large" | "unavailable" };

/**
 * The viewer's rights on a file in their own drive and how many principals it's shared with.
 * Rights come from an explicit FileNode/get of myRights + shareWith; when the server doesn't
 * expose shareWith, falls back to the node's default rights with an unknown share count.
 */
export async function getDocAccess(fileId: string, fallback?: DriveNode | null): Promise<DocAccess | null> {
  if (!validId(fileId)) return null;
  try {
    const sharing = await getSharing(fileId);
    const node = sharing.node ?? fallback ?? (await getNode(fileId));
    if (!node) return null;
    return {
      canShare: sharing.supported && node.rights.mayShare,
      canEdit: node.rights.mayModifyContent,
      sharedWith: sharing.supported ? Object.values(sharing.shareWith).filter((r) => roleOf(r)).length : null,
    };
  } catch (e) {
    unstable_rethrow(e);
    console.error("[docs] access:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function loadNativeDoc(fileId: string, kind: NativeKind): Promise<NativeLoad> {
  if (!validId(fileId)) return { ok: false, error: "not_found" };
  try {
    const node = await getNode(fileId);
    if (!node || node.isFolder || !node.blobId) return { ok: false, error: "not_found" };
    if (nativeKind(node.name) !== kind) return { ok: false, error: "wrong_kind" };
    if (node.size > MAX_NATIVE_BYTES) return { ok: false, error: "too_large" };

    // Started early, awaited after the content: never rejects (early returns leave it unawaited).
    const accessP = getDocAccess(fileId, node).catch(() => null);
    let content = "";
    if (node.size > 0) {
      const res = await fetchBlob(node);
      if (res.status === 404) return { ok: false, error: "not_found" };
      if (!res.ok) return { ok: false, error: "unavailable" };
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_NATIVE_BYTES) return { ok: false, error: "too_large" };
      content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }

    let folderId = node.parentId;
    const rootId = await getRootId().catch(() => null);
    if (folderId && folderId === rootId) folderId = null;
    const access = await accessP;

    return {
      ok: true,
      doc: {
        id: node.id,
        name: node.name,
        folderId,
        content,
        readOnly: !node.rights.mayModifyContent || access?.canEdit === false,
        access,
      },
    };
  } catch (e) {
    unstable_rethrow(e);
    console.error("[docs] load native:", e instanceof Error ? e.message : e);
    return { ok: false, error: "unavailable" };
  }
}
