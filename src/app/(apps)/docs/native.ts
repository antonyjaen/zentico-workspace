// Server loader for the built-in editors (whiteboard, Markdown): finds the file in the user's
// own drive, checks it belongs to the editor and reads its content as text.
import { unstable_rethrow } from "next/navigation";
import { MAX_NATIVE_BYTES, nativeKind, type NativeKind } from "./shared";
import { fetchBlob, getNode, getRootId, validId } from "@/lib/drive";

export type NativeDoc = {
  id: string;
  name: string;
  /** Drive folder for "Open in Drive" (null = My Drive root). */
  folderId: string | null;
  content: string;
  readOnly: boolean;
};

export type NativeLoad = { ok: true; doc: NativeDoc } | { ok: false; error: "not_found" | "wrong_kind" | "too_large" | "unavailable" };

export async function loadNativeDoc(fileId: string, kind: NativeKind): Promise<NativeLoad> {
  if (!validId(fileId)) return { ok: false, error: "not_found" };
  try {
    const node = await getNode(fileId);
    if (!node || node.isFolder || !node.blobId) return { ok: false, error: "not_found" };
    if (nativeKind(node.name) !== kind) return { ok: false, error: "wrong_kind" };
    if (node.size > MAX_NATIVE_BYTES) return { ok: false, error: "too_large" };

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

    return {
      ok: true,
      doc: { id: node.id, name: node.name, folderId, content, readOnly: !node.rights.mayModifyContent },
    };
  } catch (e) {
    unstable_rethrow(e);
    console.error("[docs] load native:", e instanceof Error ? e.message : e);
    return { ok: false, error: "unavailable" };
  }
}
