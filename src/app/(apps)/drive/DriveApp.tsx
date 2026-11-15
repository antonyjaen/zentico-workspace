"use client";

import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  FolderInput,
  FolderPlus,
  FolderUp,
  HardDrive,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  Plus,
  Presentation,
  Search,
  Trash2,
  Upload as UploadIcon,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { deleteAction, moveAction, newDocAction, newFolderAction, renameAction } from "./actions";
import { FileIcon } from "./FileIcon";
import { MoveDialog } from "./MoveDialog";
import { Preview } from "./Preview";
import {
  docsHref,
  driveHref,
  fileUrl,
  formatDate,
  formatSize,
  VIEW_COOKIE,
  type Item,
  type Section,
  type SortKey,
  type ViewMode,
} from "./shared";
import { entriesFromDrop, entriesFromInput, useUploads, type Upload } from "./uploads";
import { usePopover } from "@/components/usePopover";

const DRAG_MIME = "application/x-zw-drive";

type Props = {
  section: Section;
  folderId: string | null;
  path: { id: string; name: string }[];
  items: Item[];
  q: string;
  sort: SortKey;
  desc: boolean;
  initialView: ViewMode;
  quota: { used: number; limit: number | null } | null;
  hasTrash: boolean;
  missing: boolean;
};

export function DriveApp(props: Props) {
  const { section, folderId, path, items, q, sort, desc, initialView, quota, hasTrash, missing } = props;
  const t = useTranslations("drive");
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [view, setView] = useState<ViewMode>(initialView);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState<Item | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileDrag, setFileDrag] = useState(false);
  const dragDepth = useRef(0);
  const dragged = useRef<string[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);
  const { uploads, start: startUploads, clear: clearUploads } = useUploads(refresh);
  const canUpload = section !== "trash";
  const uploadTarget = section === "my" ? folderId : null;

  // Drop selections that no longer exist after a refresh.
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    setSelected((s) => (([...s].every((id) => ids.has(id)) ? s : new Set([...s].filter((id) => ids.has(id))))));
  }, [items]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);

  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected]);

  const setViewMode = (v: ViewMode) => {
    setView(v);
    document.cookie = `${VIEW_COOKIE}=${v}; path=/; max-age=31536000; samesite=lax`;
  };

  const errorText = (code: string) =>
    t.has(`errors.${code}`) ? t(`errors.${code}` as "errors.failed") : t("errors.failed");

  async function act<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<{ data: T } | null> {
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok) {
        setError(errorText(r.error));
        return null;
      }
      return { data: r.data };
    } catch {
      setError(t("errors.failed"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------ actions */

  const open = (item: Item) => {
    if (item.isFolder) router.push(driveHref({ folder: item.id, section: section === "trash" ? "trash" : "my" }));
    else setPreview(item);
  };

  const download = (list: Item[]) => {
    list
      .filter((i) => !i.isFolder)
      .forEach((i, n) =>
        setTimeout(() => {
          const a = document.createElement("a");
          a.href = fileUrl(i.id);
          a.download = i.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }, n * 300),
      );
  };

  const doRename = async (id: string, name: string) => {
    setRenaming(null);
    const current = items.find((i) => i.id === id);
    if (!current || !name.trim() || name.trim() === current.name) return;
    await act(() => renameAction(id, name.trim()));
  };

  const doMove = async (ids: string[], target: string | null) => {
    if (!ids.length) return;
    setMoving(null);
    if (await act(() => moveAction(ids, target))) setSelected(new Set());
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    const ids = [...selected];
    if (await act(() => deleteAction(ids, section === "trash"))) setSelected(new Set());
  };

  const newFolder = async (name: string) => {
    setNaming(false);
    const r = await act(() => newFolderAction(uploadTarget, name));
    if (r && section !== "my") router.push(driveHref({ folder: r.data }));
  };

  const newDoc = async (kind: "document" | "spreadsheet" | "presentation") => {
    const r = await act(() => newDocAction(uploadTarget, kind));
    if (r) router.push(docsHref(r.data));
  };

  /* ---------------------------------------------------------- selection */

  const clickItem = (e: React.MouseEvent, index: number) => {
    const id = items[index].id;
    if (e.shiftKey && anchor.current != null) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      const range = items.slice(a, b + 1).map((i) => i.id);
      setSelected((s) => new Set(e.metaKey || e.ctrlKey ? [...s, ...range] : range));
    } else if (e.metaKey || e.ctrlKey) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchor.current = index;
    } else {
      setSelected(new Set([id]));
      anchor.current = index;
    }
    setConfirmDelete(false);
  };

  const toggle = (index: number, shift: boolean) => {
    const id = items[index].id;
    if (shift && anchor.current != null) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      setSelected((s) => new Set([...s, ...items.slice(a, b + 1).map((i) => i.id)]));
    } else {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchor.current = index;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable=true]")) return;
    if (e.key === "Escape") {
      setSelected(new Set());
      setConfirmDelete(false);
    } else if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setSelected(new Set(items.map((i) => i.id)));
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
      e.preventDefault();
      setConfirmDelete(true);
    } else if (e.key === "F2" && selectedItems.length === 1 && section !== "trash") {
      e.preventDefault();
      setRenaming(selectedItems[0].id);
    } else if (e.key === "Enter" && selectedItems.length === 1) {
      e.preventDefault();
      open(selectedItems[0]);
    }
  };

  /* -------------------------------------------------------- drag & drop */

  const isFileDrag = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  const isMoveDrag = (e: React.DragEvent) => [...e.dataTransfer.types].includes(DRAG_MIME);

  const onItemDragStart = (e: React.DragEvent, item: Item) => {
    const ids = selected.has(item.id) ? [...selected] : [item.id];
    if (!selected.has(item.id)) setSelected(new Set([item.id]));
    dragged.current = ids;
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
  };

  const folderDropProps = (folder: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!isMoveDrag(e) || (folder && dragged.current.includes(folder))) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(folder ?? "__root");
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (e: React.DragEvent) => {
      if (!isMoveDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      const ids = dragged.current.filter((id) => id !== folder);
      dragged.current = [];
      void doMove(ids, folder);
    },
  });

  const mainDrop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!canUpload || !isFileDrag(e)) return;
      dragDepth.current++;
      setFileDrag(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!canUpload || !isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setFileDrag(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!canUpload || !isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setFileDrag(false);
      entriesFromDrop(e.dataTransfer).then((entries) => startUploads(entries, uploadTarget));
    },
  };

  /* ------------------------------------------------------------- render */

  const heading =
    section === "recent" ? t("recent") : section === "trash" ? t("trash") : section === "search" ? t("searchResults", { q }) : null;
  const sortHref = (key: SortKey) =>
    driveHref({ folder: folderId, section, q, sort: key, dir: sort === key && !desc ? "desc" : "asc" });

  return (
    <>
      <aside className="hidden w-[248px] shrink-0 flex-col pl-2 lg:flex">
        <NewMenu
          variant="primary"
          canUpload={canUpload}
          busy={busy}
          onNewFolder={() => setNaming(true)}
          onFiles={(entries) => startUploads(entries, uploadTarget)}
          onNewDoc={newDoc}
        />
        <nav className="flex flex-col gap-0.5 pr-2" aria-label={t("title")}>
          <NavItem href="/drive" active={section === "my"} icon={HardDrive} label={t("myDrive")} accent dropProps={folderDropProps(null)} dropActive={dropTarget === "__root"} />
          <NavItem href={driveHref({ section: "recent" })} active={section === "recent"} icon={Clock} label={t("recent")} />
          {hasTrash && <NavItem href={driveHref({ section: "trash" })} active={section === "trash"} icon={Trash2} label={t("trash")} />}
        </nav>
        {quota && <QuotaBar used={quota.used} limit={quota.limit} locale={locale} />}
      </aside>

      <main
        className="sheet relative flex min-w-0 flex-1 flex-col overflow-hidden outline-none"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        {...mainDrop}
      >
        {/* Toolbar */}
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
          <div className="lg:hidden">
            <NewMenu
              variant="icon"
              canUpload={canUpload}
              busy={busy}
              onNewFolder={() => setNaming(true)}
              onFiles={(entries) => startUploads(entries, uploadTarget)}
              onNewDoc={newDoc}
            />
          </div>
          <div className="min-w-0 flex-1">
            {heading ? (
              <h1 className="truncate px-1 text-[15px] font-medium text-ink">{heading}</h1>
            ) : (
              <nav className="flex min-w-0 items-center gap-0.5 text-[15px]" aria-label={t("path")}>
                <Link
                  href="/drive"
                  {...folderDropProps(null)}
                  data-drop={dropTarget === "__root" || undefined}
                  className={`shrink-0 rounded-md px-2 py-1 transition-colors hover:bg-hover data-[drop]:bg-primary-soft ${path.length ? "text-ink-soft" : "font-medium text-ink"}`}
                >
                  {t("myDrive")}
                </Link>
                {path.map((p, i) => (
                  <span key={p.id} className="flex min-w-0 items-center gap-0.5">
                    <ChevronRight size={15} className="shrink-0 text-ink-mute" aria-hidden />
                    <Link
                      href={driveHref({ folder: p.id })}
                      {...folderDropProps(p.id)}
                      data-drop={dropTarget === p.id || undefined}
                      aria-current={i === path.length - 1 ? "page" : undefined}
                      className="truncate rounded-md px-2 py-1 text-ink-soft transition-colors hover:bg-hover data-[drop]:bg-primary-soft aria-[current=page]:font-medium aria-[current=page]:text-ink"
                    >
                      {p.name}
                    </Link>
                  </span>
                ))}
              </nav>
            )}
          </div>
          <form action="/drive" role="search" className="hidden w-64 md:block">
            <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-sheet px-2.5 transition-colors focus-within:border-line-strong hover:border-line-strong">
              <Search size={15} className="shrink-0 text-ink-mute" aria-hidden />
              <span className="sr-only">{t("search")}</span>
              <input
                name="q"
                type="search"
                defaultValue={q}
                maxLength={200}
                placeholder={t("search")}
                autoComplete="off"
                className="h-full w-full bg-transparent text-[13.5px] text-ink placeholder:text-ink-mute focus:outline-none"
              />
            </label>
          </form>
          <div className="flex items-center rounded-md border border-line p-0.5" role="group" aria-label={t("layout")}>
            {(["list", "grid"] as const).map((v) => {
              const Icon = v === "list" ? List : LayoutGrid;
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setViewMode(v)}
                  className="grid h-7 w-7 place-items-center rounded text-ink-mute transition-colors hover:text-ink aria-pressed:bg-hover aria-pressed:text-ink"
                  aria-label={t(v === "list" ? "listView" : "gridView")}
                  title={t(v === "list" ? "listView" : "gridView")}
                >
                  <Icon size={15} aria-hidden />
                </button>
              );
            })}
          </div>
        </div>

        {/* Selection bar */}
        {selected.size > 0 && (
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-sheet-muted px-3">
            <button type="button" className="icon-btn h-8 w-8" onClick={() => setSelected(new Set())} aria-label={t("clearSelection")} title={t("clearSelection")}>
              <X size={15} aria-hidden />
            </button>
            <span className="mr-2 text-[13px] font-medium text-ink">{t("selected", { count: selected.size })}</span>
            {confirmDelete ? (
              <div className="flex items-center gap-2" role="alert">
                <span className="text-[13px] text-ink-soft">
                  {section === "trash" || !hasTrash ? t("confirmDeleteForever", { count: selected.size }) : t("confirmTrash", { count: selected.size })}
                </span>
                <button type="button" onClick={doDelete} disabled={busy} className="h-7 rounded-md bg-danger px-2.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50">
                  {t("delete")}
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="h-7 rounded-md border border-line px-2.5 text-[12.5px] font-medium text-ink-soft hover:bg-hover hover:text-ink">
                  {t("cancel")}
                </button>
              </div>
            ) : (
              <>
                {selectedItems.length === 1 && (
                  <ToolButton icon={Eye} label={selectedItems[0].isFolder ? t("open") : t("preview")} onClick={() => open(selectedItems[0])} />
                )}
                {selectedItems.some((i) => !i.isFolder) && <ToolButton icon={Download} label={t("download")} onClick={() => download(selectedItems)} />}
                {selectedItems.length === 1 && section !== "trash" && (
                  <ToolButton icon={Pencil} label={t("rename")} onClick={() => setRenaming(selectedItems[0].id)} />
                )}
                <ToolButton icon={FolderInput} label={section === "trash" ? t("restore") : t("move")} onClick={() => setMoving([...selected])} />
                <ToolButton icon={Trash2} label={section === "trash" || !hasTrash ? t("deleteForever") : t("delete")} onClick={() => setConfirmDelete(true)} />
              </>
            )}
            {busy && <Loader2 size={15} className="ml-auto animate-spin text-ink-mute" aria-label={t("working")} />}
          </div>
        )}

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto" onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}>
          {missing ? (
            <Empty title={t("folderMissing")} />
          ) : items.length === 0 ? (
            <Empty
              title={section === "search" ? t("noResults") : section === "trash" ? t("trashEmpty") : section === "recent" ? t("noRecent") : t("emptyFolder")}
              hint={section === "my" ? t("dropHint") : undefined}
            />
          ) : view === "list" ? (
            <table className="w-full table-fixed border-collapse text-[13.5px]">
              <thead className="sticky top-0 z-10 bg-sheet/95 backdrop-blur">
                <tr className="h-9 border-b border-line text-left text-[12px] text-ink-mute">
                  <th className="w-10 pl-3 font-normal">
                    <span className="sr-only">{t("select")}</span>
                  </th>
                  <SortHeader label={t("name")} active={sort === "name"} desc={desc} href={sortHref("name")} />
                  <th className="hidden w-32 font-normal md:table-cell">{t("owner")}</th>
                  <SortHeader label={t("modified")} active={sort === "modified"} desc={desc} href={sortHref("modified")} className="hidden w-36 sm:table-cell" />
                  <SortHeader label={t("size")} active={sort === "size"} desc={desc} href={sortHref("size")} className="w-24 pr-4 text-right" />
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => {
                  const isSel = selected.has(item.id);
                  return (
                    <tr
                      key={item.id}
                      draggable={renaming !== item.id && section !== "trash"}
                      onDragStart={(e) => onItemDragStart(e, item)}
                      onDragEnd={() => ((dragged.current = []), setDropTarget(null))}
                      {...(item.isFolder ? folderDropProps(item.id) : {})}
                      onClick={(e) => clickItem(e, index)}
                      onDoubleClick={() => open(item)}
                      aria-selected={isSel}
                      data-drop={dropTarget === item.id || undefined}
                      className="h-11 cursor-default border-b border-line/60 transition-colors select-none hover:bg-hover aria-selected:bg-primary-soft data-[drop]:bg-primary-soft data-[drop]:outline data-[drop]:outline-1 data-[drop]:-outline-offset-1 data-[drop]:outline-line-strong"
                    >
                      <td className="pl-3" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={isSel} label={item.name} onToggle={(shift) => toggle(index, shift)} />
                      </td>
                      <td className="pr-3">
                        <span className="flex min-w-0 items-center gap-3">
                          <FileIcon item={item} />
                          {renaming === item.id ? (
                            <RenameInput initial={item.name} onDone={(name) => doRename(item.id, name)} onCancel={() => setRenaming(null)} />
                          ) : (
                            <span className="truncate text-ink" title={item.name}>
                              {item.name}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="hidden truncate text-ink-mute md:table-cell">{t("me")}</td>
                      <td className="hidden truncate text-ink-mute sm:table-cell">{formatDate(item.modified, locale)}</td>
                      <td className="pr-4 text-right font-mono text-[12px] tabular-nums text-ink-mute">{item.isFolder ? "—" : formatSize(item.size, locale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3 p-4">
              {items.map((item, index) => {
                const isSel = selected.has(item.id);
                return (
                  <li
                    key={item.id}
                    draggable={renaming !== item.id && section !== "trash"}
                    onDragStart={(e) => onItemDragStart(e, item)}
                    onDragEnd={() => ((dragged.current = []), setDropTarget(null))}
                    {...(item.isFolder ? folderDropProps(item.id) : {})}
                    onClick={(e) => clickItem(e, index)}
                    onDoubleClick={() => open(item)}
                    aria-selected={isSel}
                    data-drop={dropTarget === item.id || undefined}
                    className="group relative flex cursor-default flex-col overflow-hidden rounded-lg border border-line transition-colors select-none hover:border-line-strong aria-selected:border-ink-mute aria-selected:bg-primary-soft data-[drop]:border-ink-mute data-[drop]:bg-primary-soft"
                  >
                    <span
                      className="absolute top-2 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100 group-aria-selected:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox checked={isSel} label={item.name} onToggle={(shift) => toggle(index, shift)} />
                    </span>
                    {item.isFolder ? (
                      <span className="flex h-12 items-center gap-3 px-3">
                        <FileIcon item={item} />
                        {renaming === item.id ? (
                          <RenameInput initial={item.name} onDone={(name) => doRename(item.id, name)} onCancel={() => setRenaming(null)} />
                        ) : (
                          <span className="truncate pr-6 text-[13.5px] font-medium text-ink" title={item.name}>
                            {item.name}
                          </span>
                        )}
                      </span>
                    ) : (
                      <>
                        <span className="grid h-28 place-items-center overflow-hidden bg-sheet-muted">
                          <Thumb item={item} />
                        </span>
                        <span className="flex h-11 items-center gap-2 border-t border-line px-3">
                          <FileIcon item={item} size={15} />
                          {renaming === item.id ? (
                            <RenameInput initial={item.name} onDone={(name) => doRename(item.id, name)} onCancel={() => setRenaming(null)} />
                          ) : (
                            <span className="truncate text-[13px] text-ink" title={item.name}>
                              {item.name}
                            </span>
                          )}
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {fileDrag && (
          <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-lg border-2 border-dashed bg-sheet/85" style={{ borderColor: "var(--color-app-drive)" }}>
            <div className="text-center">
              <UploadIcon size={28} className="mx-auto" style={{ color: "var(--color-app-drive)" }} aria-hidden />
              <p className="mt-3 text-[15px] font-medium text-ink">{t("dropToUpload")}</p>
              <p className="mt-1 text-[13px] text-ink-mute">{path.at(-1)?.name ?? t("myDrive")}</p>
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="pop absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 px-3.5 py-2.5 text-[13px] text-ink">
            <CircleAlert size={15} className="text-danger" aria-hidden />
            {error}
            <button type="button" onClick={() => setError(null)} className="icon-btn ml-1 h-6 w-6" aria-label={t("close")}>
              <X size={13} aria-hidden />
            </button>
          </div>
        )}
      </main>

      {uploads.length > 0 && <UploadTray uploads={uploads} onClose={clearUploads} />}
      {preview && <Preview item={preview} onClose={() => setPreview(null)} />}
      {moving && (
        <MoveDialog
          excluded={moving}
          startFolder={section === "my" ? folderId : null}
          onPick={(target) => doMove(moving, target)}
          onClose={() => setMoving(null)}
        />
      )}
      {naming && <NameDialog title={t("newFolder")} initial={t("untitledFolder")} onDone={newFolder} onClose={() => setNaming(false)} />}
    </>
  );
}

/* --------------------------------------------------------------- pieces */

function NavItem({
  href,
  active,
  icon: Icon,
  label,
  accent,
  dropProps,
  dropActive,
}: {
  href: string;
  active: boolean;
  icon: typeof HardDrive;
  label: string;
  accent?: boolean;
  dropProps?: Record<string, unknown>;
  dropActive?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      data-drop={dropActive || undefined}
      {...dropProps}
      className="flex h-8 items-center gap-3 rounded-md px-3 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink aria-[current=page]:bg-primary-soft aria-[current=page]:font-medium aria-[current=page]:text-ink data-[drop]:bg-primary-soft"
    >
      <Icon size={16} aria-hidden className="shrink-0" style={accent ? { color: "var(--color-app-drive)" } : undefined} />
      <span className="flex-1 truncate">{label}</span>
    </Link>
  );
}

function NewMenu({
  variant,
  canUpload,
  busy,
  onNewFolder,
  onFiles,
  onNewDoc,
}: {
  variant: "primary" | "icon";
  canUpload: boolean;
  busy: boolean;
  onNewFolder: () => void;
  onFiles: (entries: ReturnType<typeof entriesFromInput>) => void;
  onNewDoc: (kind: "document" | "spreadsheet" | "presentation") => void;
}) {
  const t = useTranslations("drive");
  const { open, setOpen, toggle, ref } = usePopover();
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    dirInput.current?.setAttribute("webkitdirectory", "");
    dirInput.current?.setAttribute("directory", "");
  }, []);

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.currentTarget.files?.length) onFiles(entriesFromInput(e.currentTarget.files));
    e.currentTarget.value = "";
  };

  const item = (icon: typeof Plus, label: string, onClick: () => void, disabled = false) => {
    const Icon = icon;
    return (
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => {
          setOpen(false);
          onClick();
        }}
        className="flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-[13.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-50"
      >
        <Icon size={16} aria-hidden className="shrink-0" />
        {label}
      </button>
    );
  };

  return (
    <div ref={ref} className={`relative ${variant === "primary" ? "mb-4 ml-1" : ""}`}>
      {variant === "primary" ? (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors duration-150 hover:bg-primary-hover disabled:opacity-60"
        >
          <Plus size={16} aria-hidden />
          {t("new")}
        </button>
      ) : (
        <button type="button" onClick={toggle} aria-haspopup="menu" aria-expanded={open} className="icon-btn h-8 w-8" aria-label={t("new")} title={t("new")}>
          <Plus size={17} aria-hidden />
        </button>
      )}
      {open && (
        <div role="menu" className="pop absolute top-full left-0 z-40 mt-1.5 w-64 p-1.5" style={{ transformOrigin: "top left" }}>
          {item(FolderPlus, t("newFolder"), onNewFolder)}
          <div className="my-1 h-px bg-line" />
          {item(UploadIcon, t("uploadFiles"), () => fileInput.current?.click(), !canUpload)}
          {item(FolderUp, t("uploadFolder"), () => dirInput.current?.click(), !canUpload)}
          <div className="my-1 h-px bg-line" />
          {item(FileText, t("newDocument"), () => onNewDoc("document"))}
          {item(FileSpreadsheet, t("newSpreadsheet"), () => onNewDoc("spreadsheet"))}
          {item(Presentation, t("newPresentation"), () => onNewDoc("presentation"))}
        </div>
      )}
      <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={pick} />
      <input ref={dirInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={pick} />
    </div>
  );
}

function QuotaBar({ used, limit, locale }: { used: number; limit: number | null; locale: string }) {
  const t = useTranslations("drive");
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="mt-auto border-t border-line px-3 pt-3 pb-1">
      <p className="text-[12.5px] font-medium text-ink-soft">{t("storage")}</p>
      {limit && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 90 ? "var(--color-danger)" : "var(--color-app-drive)" }} />
        </div>
      )}
      <p className="mt-1.5 text-[12px] text-ink-mute">
        {limit ? t("quotaOf", { used: formatSize(used, locale), limit: formatSize(limit, locale) }) : t("quotaUsed", { used: formatSize(used, locale) })}
      </p>
    </div>
  );
}

function ToolButton({ icon: Icon, label, onClick }: { icon: typeof Eye; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
      title={label}
    >
      <Icon size={15} aria-hidden />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function SortHeader({ label, active, desc, href, className = "" }: { label: string; active: boolean; desc: boolean; href: string; className?: string }) {
  const Arrow = desc ? ArrowDown : ArrowUp;
  return (
    <th className={`font-normal ${className}`} aria-sort={active ? (desc ? "descending" : "ascending") : "none"}>
      <Link href={href} replace className={`inline-flex items-center gap-1 transition-colors hover:text-ink ${active ? "font-medium text-ink" : ""}`}>
        {label}
        {active && <Arrow size={12} aria-hidden />}
      </Link>
    </th>
  );
}

function Checkbox({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: (shift: boolean) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => onToggle(e.shiftKey)}
      className="grid h-[18px] w-[18px] place-items-center rounded border border-line-strong bg-sheet text-primary-ink transition-colors aria-checked:border-primary aria-checked:bg-primary"
    >
      {checked && <Check size={12} strokeWidth={3} aria-hidden />}
    </button>
  );
}

function RenameInput({ initial, onDone, onCancel }: { initial: string; onDone: (name: string) => void; onCancel: () => void }) {
  const t = useTranslations("drive");
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    if (v == null) onCancel();
    else onDone(v);
  };
  return (
    <input
      ref={ref}
      defaultValue={initial}
      maxLength={255}
      aria-label={t("rename")}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className="h-7 min-w-0 flex-1 rounded border border-line-strong bg-sheet px-2 text-[13.5px] text-ink focus:outline-none"
    />
  );
}

function NameDialog({ title, initial, onDone, onClose }: { title: string; initial: string; onDone: (name: string) => void; onClose: () => void }) {
  const t = useTranslations("drive");
  const [value, setValue] = useState(initial);
  // eslint-disable-next-line no-control-regex
  const invalid = !value.trim() || value.length > 255 || /[\u0000-\u001f\u007f/]/.test(value);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <form
        className="pop w-full max-w-sm p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) onDone(value.trim());
        }}
      >
        <h2 className="text-[15px] font-medium text-ink">{title}</h2>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          maxLength={255}
          aria-label={t("name")}
          aria-invalid={invalid && value.length > 0}
          className="mt-4 h-9 w-full rounded-md border border-line bg-sheet px-3 text-[14px] text-ink focus:border-line-strong focus:outline-none aria-invalid:border-danger"
        />
        {invalid && value.includes("/") && <p className="mt-1.5 text-[12px] text-danger">{t("errors.invalid_name")}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-md border border-line px-3 text-[13px] font-medium text-ink-soft hover:border-line-strong hover:bg-hover hover:text-ink">
            {t("cancel")}
          </button>
          <button type="submit" disabled={invalid} className="h-8 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink hover:bg-primary-hover disabled:opacity-50">
            {t("create")}
          </button>
        </div>
      </form>
    </div>
  );
}

function Thumb({ item }: { item: Item }) {
  const [failed, setFailed] = useState(false);
  const raster = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(item.type) && item.size < 15 * 1024 * 1024;
  if (raster && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={fileUrl(item.id, { inline: true })} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} className="h-full w-full object-cover" />;
  }
  return <FileIcon item={item} size={36} />;
}

function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="grid h-full min-h-[320px] place-items-center p-10 text-center">
      <div className="rise">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-line bg-sheet-muted" style={{ color: "var(--color-app-drive)" }}>
          <HardDrive size={26} aria-hidden />
        </span>
        <p className="mt-5 text-[15px] font-medium text-ink">{title}</p>
        {hint && <p className="mt-1.5 text-[13.5px] text-ink-mute">{hint}</p>}
      </div>
    </div>
  );
}

function UploadTray({ uploads, onClose }: { uploads: Upload[]; onClose: () => void }) {
  const t = useTranslations("drive");
  const [collapsed, setCollapsed] = useState(false);
  const active = uploads.filter((u) => u.status === "queued" || u.status === "uploading").length;
  const failed = uploads.filter((u) => u.status === "error").length;
  const title = active ? t("uploading", { count: active }) : failed ? t("uploadsFailed", { count: failed }) : t("uploadsDone", { count: uploads.length });
  return (
    <div className="pop fixed right-4 bottom-4 z-40 w-80 overflow-hidden" style={{ transformOrigin: "bottom right" }} role="status" aria-live="polite">
      <div className="flex h-11 items-center gap-2 border-b border-line pr-1.5 pl-4">
        <button type="button" onClick={() => setCollapsed((c) => !c)} className="flex-1 truncate text-left text-[13.5px] font-medium text-ink">
          {title}
        </button>
        {!active && (
          <button type="button" onClick={onClose} className="icon-btn h-7 w-7" aria-label={t("close")}>
            <X size={14} aria-hidden />
          </button>
        )}
      </div>
      {!collapsed && (
        <ul className="max-h-64 overflow-y-auto py-1">
          {uploads.map((u) => {
            const pct = u.size ? Math.round((u.loaded / u.size) * 100) : u.status === "done" ? 100 : 0;
            return (
              <li key={u.key} className="px-4 py-2">
                <div className="flex items-center gap-2 text-[12.5px]">
                  <span className="min-w-0 flex-1 truncate text-ink" title={u.name}>
                    {u.name}
                  </span>
                  {u.status === "done" ? (
                    <Check size={14} className="text-signal" aria-label={t("done")} />
                  ) : u.status === "error" ? (
                    <span className="shrink-0 text-danger" title={u.error}>
                      {u.error && t.has(`errors.${u.error}`) ? t(`errors.${u.error}` as "errors.failed") : t("errors.upload_failed")}
                    </span>
                  ) : (
                    <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-mute">{u.status === "queued" ? t("queued") : `${pct}%`}</span>
                  )}
                </div>
                {(u.status === "uploading" || u.status === "queued") && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
                    <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${pct}%`, background: "var(--color-app-drive)" }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
