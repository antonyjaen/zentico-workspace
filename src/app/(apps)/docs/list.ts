// Docs listing: which Drive files open in Docs (office files Collabora supports, whiteboards and
// Markdown), each with its folder path. Shared by the Docs home page and the MCP server.
import { nativeKind, type DocItem } from "./shared";
import { descendantsOf, type DriveNode } from "@/lib/drive";
import { docKind, extOf } from "@/lib/wopi";

/** Office files, whiteboards and Markdown files outside the trash, each with its Drive folder path. */
export function toDocs(all: DriveNode[], rootId: string | null, trashId: string | null, supported: Set<string> | null): DocItem[] {
  const byId = new Map(all.map((n) => [n.id, n]));
  const inTrash = trashId ? descendantsOf(all, trashId) : new Set<string>();
  const locationOf = (parentId: string | null): string | null => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let id = parentId; id && id !== rootId && !seen.has(id) && names.length < 64; ) {
      seen.add(id);
      const folder = byId.get(id);
      if (!folder) break;
      names.unshift(folder.name);
      id = folder.parentId;
    }
    return names.length ? names.join(" / ") : null;
  };
  const out: DocItem[] = [];
  for (const n of all) {
    if (n.isFolder || !n.blobId || n.role != null || inTrash.has(n.id)) continue;
    // Whiteboards and Markdown open in the built-in editors; office files need Collabora support.
    const native = nativeKind(n.name);
    const office = native ? null : docKind(n.name);
    if (!native && (!office || (supported && !supported.has(extOf(n.name))))) continue;
    const kind = native ?? office!;
    const folderId = n.parentId && n.parentId !== rootId ? n.parentId : null;
    out.push({ id: n.id, name: n.name, kind, folderId, location: locationOf(folderId), modified: n.modified, size: n.size });
  }
  return out;
}
