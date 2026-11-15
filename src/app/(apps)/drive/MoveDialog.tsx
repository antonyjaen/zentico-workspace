"use client";

import { ChevronRight, HardDrive, Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { folderTreeAction } from "./actions";
import { FileIcon } from "./FileIcon";

type Folder = { id: string; name: string; parentId: string | null };

/** Folder picker: browse folders level by level and pick a destination. */
export function MoveDialog({
  excluded,
  startFolder,
  onPick,
  onClose,
}: {
  /** Selected ids: they (and their descendants) can't be destinations. */
  excluded: string[];
  startFolder: string | null;
  onPick: (folderId: string | null) => void;
  onClose: () => void;
}) {
  const t = useTranslations("drive");
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [error, setError] = useState(false);
  const [current, setCurrent] = useState<string | null>(startFolder);

  useEffect(() => {
    folderTreeAction().then((r) => (r.ok ? setFolders(r.data.folders) : setError(true)));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const blocked = useMemo(() => {
    const out = new Set(excluded);
    if (!folders) return out;
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) (out.add(f.id), (grew = true));
    }
    return out;
  }, [folders, excluded]);

  const byId = useMemo(() => new Map((folders ?? []).map((f) => [f.id, f])), [folders]);
  const crumbs: Folder[] = [];
  for (let id = current, i = 0; id && i < 64; i++) {
    const f = byId.get(id);
    if (!f) break;
    crumbs.unshift(f);
    id = f.parentId;
  }
  const children = (folders ?? [])
    .filter((f) => (f.parentId ?? null) === current && !blocked.has(f.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const disabled = (current != null && blocked.has(current)) || !folders;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("moveTo")}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="pop flex max-h-[70dvh] w-full max-w-md flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <h2 className="flex-1 text-[14px] font-medium text-ink">{t("moveTo")}</h2>
          <button type="button" onClick={onClose} className="icon-btn h-8 w-8" aria-label={t("close")}>
            <X size={16} aria-hidden />
          </button>
        </div>
        <nav className="flex shrink-0 flex-wrap items-center gap-1 px-3 py-2 text-[13px]" aria-label={t("path")}>
          <button type="button" onClick={() => setCurrent(null)} className="rounded px-1.5 py-0.5 text-ink-soft hover:bg-hover hover:text-ink">
            {t("myDrive")}
          </button>
          {crumbs.map((c) => (
            <span key={c.id} className="flex items-center gap-1">
              <ChevronRight size={13} className="text-ink-mute" aria-hidden />
              <button type="button" onClick={() => setCurrent(c.id)} className="max-w-[10rem] truncate rounded px-1.5 py-0.5 text-ink-soft hover:bg-hover hover:text-ink">
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="min-h-[200px] flex-1 overflow-y-auto border-y border-line py-1">
          {error ? (
            <p className="p-6 text-center text-[13px] text-danger">{t("errors.failed")}</p>
          ) : !folders ? (
            <div className="grid h-40 place-items-center">
              <Loader2 size={20} className="animate-spin text-ink-mute" aria-label={t("loading")} />
            </div>
          ) : children.length === 0 ? (
            <p className="p-6 text-center text-[13px] text-ink-mute">{t("noSubfolders")}</p>
          ) : (
            <ul>
              {children.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => setCurrent(f.id)}
                    className="flex h-9 w-full items-center gap-3 px-4 text-left text-[13.5px] text-ink hover:bg-hover"
                  >
                    <FileIcon item={{ name: f.name, isFolder: true, type: "" }} size={16} />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <ChevronRight size={14} className="text-ink-mute" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 px-4 py-3">
          <span className="mr-auto flex min-w-0 items-center gap-2 truncate text-[12.5px] text-ink-mute">
            <HardDrive size={13} aria-hidden />
            <span className="truncate">{crumbs.at(-1)?.name ?? t("myDrive")}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-line px-3 text-[13px] font-medium text-ink-soft hover:border-line-strong hover:bg-hover hover:text-ink"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPick(current)}
            className="h-8 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink hover:bg-primary-hover disabled:opacity-50"
          >
            {t("moveHere")}
          </button>
        </div>
      </div>
    </div>
  );
}
