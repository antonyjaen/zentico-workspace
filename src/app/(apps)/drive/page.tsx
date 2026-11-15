import { HardDrive } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { DriveApp } from "./DriveApp";
import { EXT_COOKIE, INIT_COOKIE, SORT_COOKIE, VIEW_COOKIE, type Item, type Section, type SortKey } from "./shared";
import {
  annotateShared,
  getDriveAccounts,
  getDriveSession,
  getPath,
  getQuota,
  getTrashId,
  listChildren,
  recentFiles,
  searchNodes,
  validId,
  type DriveAccount,
  type DriveNode,
} from "@/lib/drive";

type Params = { folder?: string; view?: string; q?: string; sort?: string; dir?: string; account?: string };

const toItem = (n: DriveNode, primaryId: string, owner: string | null): Item => ({
  id: n.id,
  accountId: n.accountId === primaryId ? null : n.accountId,
  parentId: n.parentId,
  name: n.name,
  isFolder: n.isFolder,
  type: n.type,
  size: n.size,
  modified: n.modified,
  owner,
  rights: n.rights,
  shared: n.shared,
});

const isSortKey = (v: unknown): v is SortKey => v === "name" || v === "modified" || v === "size";

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
  const jar = await cookies();

  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 200) : "";
  const folder = validId(sp.folder) ? sp.folder : null;
  const accountParam = validId(sp.account) ? sp.account : null;

  // Default sort from settings ("<key>.<dir>") unless the URL says otherwise.
  const [cookieKey, cookieDir] = (jar.get(SORT_COOKIE)?.value ?? "").split(".");
  const defaultSort = { key: isSortKey(cookieKey) ? cookieKey : ("name" as SortKey), desc: cookieDir === "desc" };
  const explicitSort = sp.sort != null || sp.dir != null;
  const sort: SortKey = isSortKey(sp.sort) ? sp.sort : explicitSort ? "name" : defaultSort.key;
  const desc = explicitSort ? sp.dir === "desc" : defaultSort.desc;
  const viewMode = jar.get(VIEW_COOKIE)?.value === "grid" ? "grid" : "list";
  const showExt = jar.get(EXT_COOKIE)?.value !== "0";

  let data: {
    section: Section;
    account: DriveAccount | null;
    accounts: DriveAccount[];
    items: Item[];
    path: { id: string; name: string }[];
    quota: Awaited<ReturnType<typeof getQuota>>;
    hasTrash: boolean;
    primaryTrash: boolean;
    missing: boolean;
    canAdd: boolean;
  };
  try {
    const session = await getDriveSession();
    if (!session) return <Unavailable title={t("unavailable")} hint={t("unavailableHint")} />;
    const accounts = await getDriveAccounts().catch((e) => {
      console.error("[drive] accounts:", e instanceof Error ? e.message : e);
      return [] as DriveAccount[];
    });
    const primaryId = session.accountId;
    // ?account=<primary> is just My Drive.
    const account = accountParam && accountParam !== primaryId ? (accounts.find((a) => a.id === accountParam) ?? null) : null;
    const accountMissing = !!accountParam && accountParam !== primaryId && !account;

    const section: Section = q
      ? "search"
      : account
        ? account.kind === "space"
          ? "spaces"
          : "shared"
        : sp.view === "recent" || sp.view === "trash" || sp.view === "shared" || sp.view === "spaces"
          ? sp.view
          : "my";

    let nodes: DriveNode[] = [];
    let path: DriveNode[] = [];
    let owner: (n: DriveNode) => string | null = () => account?.name ?? null;
    let hasTrash = false;
    let canAdd = false;

    if (accountMissing) {
      // Rendered as the "missing" state below.
    } else if (account) {
      nodes = await listChildren(folder, account.id);
      if (folder) path = await getPath(folder, account.id);
      hasTrash = !!(await getTrashId(account.id).catch(() => null));
      // At a shared account's root there's no parent the user may write into; spaces allow it
      // (the server still enforces the group's rights).
      canAdd = folder ? (path.at(-1)?.rights.mayAddChildren ?? false) : account.kind === "space" && !account.isReadOnly;
    } else if (section === "shared") {
      const shared = accounts.filter((a) => a.kind === "shared");
      const names = new Map(shared.map((a) => [a.id, a.name]));
      const lists = await Promise.all(
        shared.map((a) =>
          listChildren(null, a.id).catch((e) => {
            console.error(`[drive] shared roots of ${a.id}:`, e instanceof Error ? e.message : e);
            return [] as DriveNode[];
          }),
        ),
      );
      nodes = lists.flat();
      owner = (n) => names.get(n.accountId) ?? null;
    } else if (section !== "spaces") {
      const trashId = await getTrashId();
      hasTrash = !!trashId;
      if (section === "search") nodes = await searchNodes(q);
      else if (section === "recent") nodes = await recentFiles();
      else if (section === "trash") nodes = trashId ? await listChildren(folder ?? trashId) : [];
      else {
        nodes = await listChildren(folder);
        if (folder) path = await getPath(folder);
        canAdd = folder ? (path.at(-1)?.rights.mayAddChildren ?? false) : true;
      }
    }

    nodes = nodes.filter((n) => n.role == null);
    if (section !== "trash") nodes = await annotateShared(nodes);
    data = {
      section,
      account,
      accounts,
      items: nodes.map((n) => toItem(n, primaryId, owner(n))),
      path: path.map(({ id, name }) => ({ id, name })),
      quota: await getQuota(),
      hasTrash,
      primaryTrash: account || section === "shared" || section === "spaces" ? !!(await getTrashId().catch(() => null)) : hasTrash,
      missing: accountMissing || ((section === "my" || !!account) && !!folder && path.length === 0),
      canAdd,
    };
  } catch (e) {
    unstable_rethrow(e);
    console.error("[drive] page:", e instanceof Error ? e.message : e);
    return <Unavailable title={t("unavailable")} hint={t("unavailableHint")} />;
  }

  const { section, account } = data;
  let items = section === "recent" && !explicitSort ? data.items : sortItems(data.items, sort, desc, locale);
  if (section === "shared" && !account) {
    // Shared with me overview: grouped by owner (stable sort keeps the order inside groups).
    const coll = new Intl.Collator(locale, { sensitivity: "base" });
    items = [...items].sort((a, b) => coll.compare(a.owner ?? "", b.owner ?? ""));
  }

  return (
    <DriveApp
      key={`${section}:${account?.id ?? ""}:${folder ?? ""}:${q}`}
      section={section}
      account={account ? { id: account.id, name: account.name, kind: account.kind } : null}
      folderId={section === "my" || account ? folder : null}
      path={data.path}
      items={items}
      q={q}
      sort={sort}
      desc={desc}
      defaultSort={defaultSort}
      initialView={viewMode}
      showExt={showExt}
      quota={data.quota}
      hasTrash={data.hasTrash}
      showTrash={data.primaryTrash}
      missing={data.missing}
      canAdd={data.canAdd}
      spaces={data.accounts.filter((a) => a.kind === "space").map(({ id, name }) => ({ id, name }))}
      needsInit={section === "my" && !folder && !jar.get(INIT_COOKIE)}
    />
  );
}
