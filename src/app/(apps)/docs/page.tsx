import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { DocsHome } from "./DocsHome";
import { VIEW_COOKIE, type DocItem } from "./shared";
import { Notice } from "./ui";
import { descendantsOf, getAllNodes, getDriveSession, getRootId, getTrashId, type DriveNode } from "@/lib/drive";
import { collaboraUrl, docKind, extOf, supportedExts } from "@/lib/wopi";

export const dynamic = "force-dynamic";

/** Office files outside the trash, each with its Drive folder path. */
function toDocs(all: DriveNode[], rootId: string | null, trashId: string | null, supported: Set<string> | null): DocItem[] {
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
    const kind = docKind(n.name);
    if (!kind || (supported && !supported.has(extOf(n.name)))) continue;
    const folderId = n.parentId && n.parentId !== rootId ? n.parentId : null;
    out.push({ id: n.id, name: n.name, kind, folderId, location: locationOf(folderId), modified: n.modified, size: n.size });
  }
  return out;
}

export default async function DocsPage() {
  const t = await getTranslations("docs");
  const base = collaboraUrl();

  if (!base) {
    return (
      <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">
        <Notice title={t("notConfigured")} hint={t("notConfiguredHint")} />
      </main>
    );
  }

  const view = (await cookies()).get(VIEW_COOKIE)?.value === "grid" ? "grid" : "list";

  let docs: DocItem[] | null = null;
  try {
    if (await getDriveSession()) {
      const [all, rootId, trashId, supported] = await Promise.all([
        getAllNodes(),
        getRootId(),
        getTrashId(),
        // Discovery tells which extensions this Collabora opens; if it's unreachable, list everything.
        supportedExts(base).catch(() => null),
      ]);
      docs = toDocs(all, rootId, trashId, supported);
    }
  } catch (e) {
    unstable_rethrow(e);
    console.error("[docs] page:", e instanceof Error ? e.message : e);
  }

  if (!docs) {
    return (
      <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">
        <Notice title={t("unavailable")} hint={t("unavailableHint")} />
      </main>
    );
  }

  return <DocsHome docs={docs} initialView={view} />;
}
