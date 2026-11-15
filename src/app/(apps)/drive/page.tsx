import { HardDrive } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { DriveApp } from "./DriveApp";
import { VIEW_COOKIE, type Item, type Section, type SortKey } from "./shared";
import {
  getDriveSession,
  getPath,
  getQuota,
  getTrashId,
  listChildren,
  recentFiles,
  searchNodes,
  validId,
  type DriveNode,
} from "@/lib/drive";

type Params = { folder?: string; view?: string; q?: string; sort?: string; dir?: string };

const toItem = (n: DriveNode): Item => ({
  id: n.id,
  parentId: n.parentId,
  name: n.name,
  isFolder: n.isFolder,
  type: n.type,
  size: n.size,
  modified: n.modified,
});

function sortItems(items: Item[], key: SortKey, desc: boolean, locale: string): Item[] {
  const coll = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const cmp = (a: Item, b: Item) =>
    key === "size"
      ? a.size - b.size || coll.compare(a.name, b.name)
      : key === "modified"
        ? (a.modified ?? "").localeCompare(b.modified ?? "") || coll.compare(a.name, b.name)
        : coll.compare(a.name, b.name);
  return [...items].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return desc ? -cmp(a, b) : cmp(a, b);
  });
}

function Unavailable({ title, hint }: { title: string; hint: string }) {
  return (
    <main className="sheet grid flex-1 place-items-center p-10 text-center">
      <div className="rise max-w-sm">
        <span
          className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-line bg-sheet-muted"
          style={{ color: "var(--color-app-drive)" }}
        >
          <HardDrive size={26} aria-hidden />
        </span>
        <p className="mt-6 text-[17px] font-medium text-ink">{title}</p>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">{hint}</p>
      </div>
    </main>
  );
}

export default async function DrivePage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const t = await getTranslations("drive");
  const locale = await getLocale();

  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 200) : "";
  const folder = validId(sp.folder) ? sp.folder : null;
  const section: Section = q ? "search" : sp.view === "recent" ? "recent" : sp.view === "trash" ? "trash" : "my";
  const sort: SortKey = sp.sort === "modified" || sp.sort === "size" ? sp.sort : "name";
  const desc = sp.dir === "desc";
  const viewMode = (await cookies()).get(VIEW_COOKIE)?.value === "grid" ? "grid" : "list";

  let data: {
    items: Item[];
    path: { id: string; name: string }[];
    quota: Awaited<ReturnType<typeof getQuota>>;
    hasTrash: boolean;
    trashId: string | null;
    missing: boolean;
  };
  try {
    const session = await getDriveSession();
    if (!session) return <Unavailable title={t("unavailable")} hint={t("unavailableHint")} />;
    const trashId = await getTrashId();
    let nodes: DriveNode[];
    let path: DriveNode[] = [];
    if (section === "search") nodes = await searchNodes(q);
    else if (section === "recent") nodes = await recentFiles();
    else if (section === "trash") nodes = trashId ? await listChildren(folder ?? trashId) : [];
    else {
      nodes = await listChildren(folder);
      if (folder) path = await getPath(folder);
    }
    const quota = await getQuota();
    data = {
      items: nodes.filter((n) => n.role == null).map(toItem),
      path: path.map(({ id, name }) => ({ id, name })),
      quota,
      hasTrash: !!trashId,
      trashId,
      missing: section === "my" && !!folder && path.length === 0,
    };
  } catch (e) {
    unstable_rethrow(e);
    console.error("[drive] page:", e instanceof Error ? e.message : e);
    return <Unavailable title={t("unavailable")} hint={t("unavailableHint")} />;
  }

  const items = section === "recent" && sp.sort == null ? data.items : sortItems(data.items, sort, desc, locale);

  return (
    <DriveApp
      key={`${section}:${folder ?? ""}:${q}`}
      section={section}
      folderId={section === "my" ? folder : null}
      path={data.path}
      items={items}
      q={q}
      sort={sort}
      desc={desc}
      initialView={viewMode}
      quota={data.quota}
      hasTrash={data.hasTrash}
      missing={data.missing}
    />
  );
}
