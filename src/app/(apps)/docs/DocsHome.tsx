"use client";

import {
  Check,
  CircleAlert,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  LayoutGrid,
  List,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  SearchX,
  Trash2,
  Upload as UploadIcon,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createDocumentAction, deleteDocumentAction, renameDocumentAction, type ActionResult } from "./actions";
import {
  DOC_KINDS,
  downloadHref,
  extOf,
  folderHref,
  fold,
  formatDate,
  formatSize,
  MAX_UPLOAD_BYTES,
  openHref,
  PRESETS,
  UPLOAD_ACCEPT,
  UPLOAD_EXTS,
  VIEW_COOKIE,
  type DocItem,
  type DocKind,
  type PresetId,
  type ViewMode,
} from "./shared";
import { DocIcon, KIND_COLOR, Notice } from "./ui";
import { usePopover } from "@/components/usePopover";

type Filter = "all" | DocKind;
type Sort = "modified" | "name";
type Toast = { kind: "error" | "info"; text: string };
type UploadState = { name: string; pct: number; index: number; total: number };

export function DocsHome({ docs, initialView }: { docs: DocItem[]; initialView: ViewMode }) {
  const t = useTranslations("docs");
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [view, setView] = useState<ViewMode>(initialView);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("modified");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<PresetId | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const errorText = (code: string) => (t.has(`errors.${code}`) ? t(`errors.${code}` as "errors.failed") : t("errors.failed"));

  const items = useMemo(() => {
    const needle = fold(query.trim());
    const coll = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    return docs
      .filter((d) => !hidden.has(d.id))
      .filter((d) => filter === "all" || d.kind === filter)
      .filter((d) => !needle || fold(d.name).includes(needle))
      .sort((a, b) =>
        sort === "name"
          ? coll.compare(a.name, b.name)
          : (b.modified ?? "").localeCompare(a.modified ?? "") || coll.compare(a.name, b.name),
      );
  }, [docs, hidden, filter, query, sort, locale]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, text: 0, spreadsheet: 0, presentation: 0, whiteboard: 0, markdown: 0 };
    for (const d of docs) {
      if (hidden.has(d.id)) continue;
      c.all++;
      c[d.kind]++;
    }
    return c;
  }, [docs, hidden]);

  const setViewMode = (v: ViewMode) => {
    setView(v);
    document.cookie = `${VIEW_COOKIE}=${v}; path=/; max-age=31536000; samesite=lax`;
  };

  /* ------------------------------------------------------------ actions */

  const create = async (preset: PresetId) => {
    if (creating) return;
    setCreating(preset);
    try {
      const r = await createDocumentAction(preset);
      if (r.ok) {
        router.push(openHref(r.data, PRESETS.find((p) => p.id === preset)?.kind ?? "text"));
        return; // keep the tile spinner until navigation
      }
      setToast({ kind: "error", text: errorText(r.error) });
    } catch {
      setToast({ kind: "error", text: t("errors.failed") });
    }
    setCreating(null);
  };

  async function act<T>(id: string, fn: () => Promise<ActionResult<T>>): Promise<T | null> {
    setBusyId(id);
    try {
      const r = await fn();
      if (!r.ok) {
        setToast({ kind: "error", text: errorText(r.error) });
        return null;
      }
      return r.data;
    } catch {
      setToast({ kind: "error", text: t("errors.failed") });
      return null;
    } finally {
      setBusyId(null);
    }
  }

  const rename = async (doc: DocItem, name: string) => {
    setRenaming(null);
    const next = name.trim();
    if (!next || next === doc.name) return;
    if (await act(doc.id, () => renameDocumentAction(doc.id, next))) refresh();
  };

  const remove = async (doc: DocItem) => {
    setConfirming(null);
    const r = await act(doc.id, () => deleteDocumentAction(doc.id));
    if (!r) return;
    setHidden((h) => new Set(h).add(doc.id));
    setToast({ kind: "info", text: r === "trashed" ? t("movedToTrash", { name: doc.name }) : t("deleted", { name: doc.name }) });
    refresh();
  };

  /* ------------------------------------------------------------- upload */

  const uploadFiles = async (files: File[]) => {
    if (upload || !files.length) return;
    const accepted = files.filter((f) => UPLOAD_EXTS.includes(extOf(f.name)));
    if (accepted.length < files.length) setToast({ kind: "error", text: t("errors.unsupported_type") });
    const ok: { id: string; name: string }[] = [];
    for (let i = 0; i < accepted.length; i++) {
      const file = accepted[i];
      if (file.size > MAX_UPLOAD_BYTES) {
        setToast({ kind: "error", text: `${file.name}: ${errorText("too_large")}` });
        continue;
      }
      setUpload({ name: file.name, pct: 0, index: i + 1, total: accepted.length });
      const r = await sendFile(file, (pct) => setUpload((u) => (u ? { ...u, pct } : u)));
      if (r.ok) ok.push({ id: r.id, name: file.name });
      else setToast({ kind: "error", text: `${file.name}: ${errorText(r.error)}` });
    }
    setUpload(null);
    if (ok.length === 1 && accepted.length === 1) router.push(openHref(ok[0].id, ok[0].name));
    else if (ok.length) {
      setToast({ kind: "info", text: t("uploaded", { count: ok.length }) });
      refresh();
    }
  };

  const isFileDrag = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth.current++;
      setFileDrag(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setFileDrag(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setFileDrag(false);
      void uploadFiles([...e.dataTransfer.files]);
    },
  };

  /* ------------------------------------------------------------- render */

  const rowProps = (doc: DocItem) => ({
    doc,
    locale,
    busy: busyId === doc.id,
    renaming: renaming === doc.id,
    confirming: confirming === doc.id,
    onRename: () => (setConfirming(null), setRenaming(doc.id)),
    onRenameDone: (name: string) => rename(doc, name),
    onRenameCancel: () => setRenaming(null),
    onDelete: () => (setRenaming(null), setConfirming(doc.id)),
    onDeleteConfirm: () => remove(doc),
    onDeleteCancel: () => setConfirming(null),
  });

  return (
    <main className="sheet relative flex min-w-0 flex-1 flex-col overflow-hidden" {...dropProps}>
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:gap-3">
        <h1 className="flex shrink-0 items-center gap-2 px-1 text-[15px] font-medium text-ink">
          <FileText size={18} aria-hidden style={{ color: "var(--color-app-docs)" }} />
          <span className="hidden sm:inline">{t("title")}</span>
        </h1>
        <div role="search" className="mx-auto w-full max-w-xl min-w-0 flex-1">
          <label className="flex h-9 items-center gap-2 rounded-md border border-line bg-sheet-muted px-3 transition-colors focus-within:border-line-strong focus-within:bg-sheet hover:border-line-strong">
            <Search size={15} className="shrink-0 text-ink-mute" aria-hidden />
            <span className="sr-only">{t("search")}</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value.slice(0, 200))}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder={t("search")}
              autoComplete="off"
              className="h-full w-full bg-transparent text-[13.5px] text-ink placeholder:text-ink-mute focus:outline-none"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={!!upload}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-line px-3 text-[13.5px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:opacity-60"
          title={t("uploadHint")}
        >
          {upload ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <UploadIcon size={15} aria-hidden />}
          <span className="hidden sm:inline">{t("upload")}</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = "";
            void uploadFiles(files);
          }}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Start a new document */}
        <section className="border-b border-line bg-sheet-muted" aria-labelledby="docs-new">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="docs-new" className="text-[14px] font-medium text-ink">
                {t("startNew")}
              </h2>
              <p className="hidden text-[12.5px] text-ink-mute sm:block">{t("templatesNote")}</p>
            </div>
            <ul className="-mx-1 mt-4 flex gap-4 overflow-x-auto px-1 pb-1">
              {PRESETS.map((p) => (
                <li key={p.id} className="shrink-0">
                  <PresetTile
                    id={p.id}
                    kind={p.kind}
                    label={t(`presetLabel.${p.id}`)}
                    sub={t(`kind.${p.kind}`)}
                    pending={creating === p.id}
                    disabled={!!creating}
                    onClick={() => create(p.id)}
                  />
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Recent */}
        <section className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8" aria-labelledby="docs-recent">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <h2 id="docs-recent" className="mr-auto text-[14px] font-medium text-ink">
              {t("recent")}
            </h2>
            <div className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-line p-0.5" role="tablist" aria-label={t("filterLabel")}>
              {(["all", ...DOC_KINDS] as Filter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded px-2.5 text-[12.5px] text-ink-mute transition-colors hover:text-ink aria-selected:bg-hover aria-selected:font-medium aria-selected:text-ink"
                >
                  {t(`filter.${f}`)}
                  <span className="font-mono text-[11px] tabular-nums text-ink-mute">{counts[f]}</span>
                </button>
              ))}
            </div>
            <label className="flex h-8 items-center gap-1.5 text-[12.5px] text-ink-mute">
              <span>{t("sortBy")}</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value === "name" ? "name" : "modified")}
                className="h-8 rounded-md border border-line bg-sheet px-2 text-[12.5px] text-ink focus:border-line-strong focus:outline-none"
              >
                <option value="modified">{t("sort.modified")}</option>
                <option value="name">{t("sort.name")}</option>
              </select>
            </label>
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

          <div className="mt-4">
            {counts.all === 0 ? (
              <Notice icon={FileText} title={t("empty")} hint={t("emptyHint")}>
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="mt-5 inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-[13.5px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
                >
                  <UploadIcon size={15} aria-hidden />
                  {t("upload")}
                </button>
              </Notice>
            ) : items.length === 0 ? (
              <Notice icon={SearchX} title={t("noMatches")} hint={query ? t("noMatchesHint", { q: query.trim() }) : undefined}>
                <button
                  type="button"
                  onClick={() => (setQuery(""), setFilter("all"))}
                  className="mt-5 inline-flex h-8 items-center rounded-md border border-line px-3 text-[13px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
                >
                  {t("clearFilters")}
                </button>
              </Notice>
            ) : view === "list" ? (
              <div className="rounded-lg border border-line">
                <div className="hidden h-9 grid-cols-[minmax(0,1fr)_200px_120px_80px_40px] items-center gap-4 rounded-t-lg border-b border-line bg-sheet-muted px-4 text-[12px] text-ink-mute md:grid">
                  <span>{t("name")}</span>
                  <span>{t("location")}</span>
                  <span>{t("modified")}</span>
                  <span className="text-right">{t("size")}</span>
                  <span className="sr-only">{t("actions")}</span>
                </div>
                <ul>
                  {items.map((doc) => (
                    <ListRow key={doc.id} {...rowProps(doc)} />
                  ))}
                </ul>
              </div>
            ) : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
                {items.map((doc) => (
                  <GridCard key={doc.id} {...rowProps(doc)} />
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {fileDrag && (
        <div
          className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-lg border-2 border-dashed bg-sheet/85"
          style={{ borderColor: "var(--color-app-docs)" }}
        >
          <div className="text-center">
            <UploadIcon size={28} className="mx-auto" style={{ color: "var(--color-app-docs)" }} aria-hidden />
            <p className="mt-3 text-[15px] font-medium text-ink">{t("dropToUpload")}</p>
            <p className="mt-1 text-[13px] text-ink-mute">{t("uploadHint")}</p>
          </div>
        </div>
      )}

      {upload && (
        <div role="status" aria-live="polite" className="pop absolute right-4 bottom-4 z-30 w-72 px-4 py-3" style={{ transformOrigin: "bottom right" }}>
          <div className="flex items-center gap-2 text-[13px]">
            <Loader2 size={14} className="shrink-0 animate-spin text-ink-mute" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-ink" title={upload.name}>
              {upload.total > 1 ? t("uploadingN", { index: upload.index, total: upload.total }) : t("uploading")} · {upload.name}
            </span>
            <span className="font-mono text-[11.5px] tabular-nums text-ink-mute">{upload.pct}%</span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${upload.pct}%`, background: "var(--color-app-docs)" }} />
          </div>
        </div>
      )}

      {toast && (
        <div role={toast.kind === "error" ? "alert" : "status"} className="pop absolute bottom-4 left-1/2 z-30 flex max-w-[90%] -translate-x-1/2 items-center gap-2 px-3.5 py-2.5 text-[13px] text-ink">
          {toast.kind === "error" ? <CircleAlert size={15} className="shrink-0 text-danger" aria-hidden /> : <Check size={15} className="shrink-0 text-signal" aria-hidden />}
          <span className="min-w-0 truncate">{toast.text}</span>
          <button type="button" onClick={() => setToast(null)} className="icon-btn ml-1 h-6 w-6 shrink-0" aria-label={t("close")}>
            <X size={13} aria-hidden />
          </button>
        </div>
      )}
    </main>
  );
}

/* ----------------------------------------------------------------- upload */

function sendFile(file: File, onProgress: (pct: number) => void): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/drive/upload?${new URLSearchParams({ name: file.name })}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && e.total && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: { item?: { id?: string }; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && body.item?.id) resolve({ ok: true, id: body.item.id });
      else resolve({ ok: false, error: body.error ?? "upload_failed" });
    };
    xhr.onerror = () => resolve({ ok: false, error: "network" });
    xhr.send(file);
  });
}

/* ----------------------------------------------------------------- pieces */

function PresetTile({
  id,
  kind,
  label,
  sub,
  pending,
  disabled,
  onClick,
}: {
  id: PresetId;
  kind: DocKind;
  label: string;
  sub: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const blank = id.startsWith("blank");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={pending}
      className="group flex w-[136px] flex-col text-left disabled:cursor-default"
    >
      <span className="relative grid aspect-[4/5] w-full place-items-center overflow-hidden rounded-lg border border-line bg-sheet transition-colors duration-150 group-hover:border-line-strong group-disabled:opacity-70 group-aria-busy:opacity-100">
        {blank ? (
          <span className="grid place-items-center gap-2">
            <Plus size={30} strokeWidth={1.5} aria-hidden style={{ color: "var(--color-app-docs)" }} />
          </span>
        ) : (
          <TemplateSketch kind={kind} />
        )}
        <span className="absolute bottom-2 left-2">
          <DocIcon kind={kind} size={15} />
        </span>
        {pending && (
          <span className="absolute inset-0 grid place-items-center bg-sheet/70">
            <Loader2 size={20} className="animate-spin text-ink-mute" aria-hidden />
          </span>
        )}
      </span>
      <span className="mt-2 truncate text-[13px] font-medium text-ink">{label}</span>
      <span className="truncate text-[12px] text-ink-mute">{sub}</span>
    </button>
  );
}

/** Abstract wireframe hinting at the preset's kind (no real template content). */
function TemplateSketch({ kind }: { kind: DocKind }) {
  const line = "block h-1 rounded-full bg-line-strong";
  if (kind === "spreadsheet") {
    return (
      <span aria-hidden className="grid w-[74%] grid-cols-3 gap-px overflow-hidden rounded-sm border border-line bg-line">
        {Array.from({ length: 18 }, (_, i) => (
          <span key={i} className="h-3 bg-sheet" style={i < 3 ? { background: "var(--color-sheet-muted)" } : undefined} />
        ))}
      </span>
    );
  }
  if (kind === "presentation") {
    return (
      <span aria-hidden className="flex w-[78%] flex-col gap-1.5 rounded-sm border border-line p-2">
        <span className="block h-1.5 w-2/3 rounded-full" style={{ background: KIND_COLOR.presentation, opacity: 0.6 }} />
        <span className={`${line} w-full`} />
        <span className={`${line} w-4/5`} />
        <span className="mt-1 block h-6 rounded-sm bg-sheet-muted" />
      </span>
    );
  }
  return (
    <span aria-hidden className="flex w-[70%] flex-col gap-1.5">
      <span className="block h-1.5 w-1/2 rounded-full" style={{ background: KIND_COLOR.text, opacity: 0.6 }} />
      <span className={`${line} w-full`} />
      <span className={`${line} w-11/12`} />
      <span className={`${line} w-full`} />
      <span className={`${line} w-3/4`} />
      <span className={`${line} mt-1.5 w-full`} />
      <span className={`${line} w-5/6`} />
    </span>
  );
}

type RowProps = {
  doc: DocItem;
  locale: string;
  busy: boolean;
  renaming: boolean;
  confirming: boolean;
  onRename: () => void;
  onRenameDone: (name: string) => void;
  onRenameCancel: () => void;
  onDelete: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
};

function ListRow(p: RowProps) {
  const t = useTranslations("docs");
  const { doc } = p;
  return (
    <li className="group relative grid min-h-12 grid-cols-[minmax(0,1fr)_40px] items-center gap-4 border-b border-line/70 px-4 py-1.5 transition-colors last:rounded-b-lg last:border-b-0 hover:bg-hover md:grid-cols-[minmax(0,1fr)_200px_120px_80px_40px]">
      <span className="flex min-w-0 items-center gap-3">
        <DocIcon kind={doc.kind} />
        {p.renaming ? (
          <RenameInput initial={doc.name} onDone={p.onRenameDone} onCancel={p.onRenameCancel} />
        ) : (
          <span className="min-w-0">
            <Link
              href={openHref(doc.id, doc.kind)}
              className="block truncate text-[14px] text-ink after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-md focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-accent"
              title={doc.name}
            >
              {doc.name}
            </Link>
            <span className="block truncate text-[12px] text-ink-mute md:hidden">
              {formatDate(doc.modified, p.locale)} · {doc.location ?? t("myDrive")}
            </span>
          </span>
        )}
      </span>
      <span className="hidden min-w-0 items-center gap-1.5 text-[13px] text-ink-mute md:flex" title={doc.location ?? t("myDrive")}>
        <FolderOpen size={14} aria-hidden className="shrink-0" />
        <span className="truncate">{doc.location ?? t("myDrive")}</span>
      </span>
      <span className="hidden truncate text-[13px] text-ink-mute md:block">{formatDate(doc.modified, p.locale)}</span>
      <span className="hidden text-right font-mono text-[12px] tabular-nums text-ink-mute md:block">{formatSize(doc.size, p.locale)}</span>
      <span className="relative z-10 flex justify-end">
        {p.busy ? <Loader2 size={15} className="m-2 animate-spin text-ink-mute" aria-label={t("working")} /> : <RowMenu {...p} />}
      </span>
      {p.confirming && (
        <ConfirmDelete
          className="absolute inset-y-0 right-0 z-20 bg-sheet pr-3 pl-6 [mask-image:linear-gradient(to_right,transparent,black_24px)]"
          busy={p.busy}
          onConfirm={p.onDeleteConfirm}
          onCancel={p.onDeleteCancel}
        />
      )}
    </li>
  );
}

function GridCard(p: RowProps) {
  const t = useTranslations("docs");
  const { doc } = p;
  return (
    <li className="group relative flex flex-col overflow-hidden rounded-lg border border-line transition-colors hover:border-line-strong">
      <span className="grid aspect-[4/3] place-items-center border-b border-line bg-sheet-muted">
        <DocIcon kind={doc.kind} size={40} />
      </span>
      <div className="flex min-h-[60px] items-start gap-2 py-2.5 pr-1 pl-3">
        <span className="min-w-0 flex-1">
          {p.renaming ? (
            <RenameInput initial={doc.name} onDone={p.onRenameDone} onCancel={p.onRenameCancel} />
          ) : (
            <Link
              href={openHref(doc.id, doc.kind)}
              className="block truncate text-[13.5px] font-medium text-ink after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-lg focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-accent"
              title={doc.name}
            >
              {doc.name}
            </Link>
          )}
          <span className="mt-0.5 block truncate text-[12px] text-ink-mute" title={doc.location ?? t("myDrive")}>
            {formatDate(doc.modified, p.locale)} · {doc.location ?? t("myDrive")}
          </span>
        </span>
        <span className="relative z-10 shrink-0">
          {p.busy ? <Loader2 size={15} className="m-2 animate-spin text-ink-mute" aria-label={t("working")} /> : <RowMenu {...p} />}
        </span>
      </div>
      {p.confirming && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-sheet/95 p-3 text-center">
          <ConfirmDelete stacked busy={p.busy} onConfirm={p.onDeleteConfirm} onCancel={p.onDeleteCancel} />
        </div>
      )}
    </li>
  );
}

function ConfirmDelete({
  busy,
  onConfirm,
  onCancel,
  stacked,
  className = "",
}: {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  stacked?: boolean;
  className?: string;
}) {
  const t = useTranslations("docs");
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      role="alert"
      className={`flex items-center justify-end gap-2 ${stacked ? "flex-col" : "flex-wrap"} ${className}`}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <span className="text-[13px] text-ink-soft">{t("confirmDelete")}</span>
      <span className="flex gap-2">
        <button
          ref={ref}
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="h-7 rounded-md bg-danger px-2.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {t("delete")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 rounded-md border border-line bg-sheet px-2.5 text-[12.5px] font-medium text-ink-soft hover:bg-hover hover:text-ink"
        >
          {t("cancel")}
        </button>
      </span>
    </div>
  );
}

function RowMenu({ doc, onRename, onDelete }: RowProps) {
  const t = useTranslations("docs");
  const { open, setOpen, toggle, ref } = usePopover();
  const item = "flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-[13.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink";
  const close = () => setOpen(false);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="icon-btn h-8 w-8 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:aria-expanded:opacity-100"
        aria-label={t("moreActions", { name: doc.name })}
        title={t("moreActions", { name: doc.name })}
      >
        <MoreVertical size={16} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="pop absolute top-full right-0 z-40 mt-1 w-56 p-1.5" style={{ transformOrigin: "top right" }}>
          <Link role="menuitem" href={openHref(doc.id, doc.kind)} className={item} onClick={close}>
            <ExternalLink size={16} aria-hidden className="shrink-0" />
            {t("open")}
          </Link>
          <button type="button" role="menuitem" className={item} onClick={() => (close(), onRename())}>
            <Pencil size={16} aria-hidden className="shrink-0" />
            {t("rename")}
          </button>
          <Link role="menuitem" href={folderHref(doc.folderId)} className={item} onClick={close}>
            <FolderOpen size={16} aria-hidden className="shrink-0" />
            {t("openFolder")}
          </Link>
          <a role="menuitem" href={downloadHref(doc.id)} download={doc.name} className={item} onClick={close}>
            <Download size={16} aria-hidden className="shrink-0" />
            {t("download")}
          </a>
          <div className="my-1 h-px bg-line" />
          <button type="button" role="menuitem" className={`${item} hover:text-danger`} onClick={() => (close(), onDelete())}>
            <Trash2 size={16} aria-hidden className="shrink-0" />
            {t("delete")}
          </button>
        </div>
      )}
    </div>
  );
}

function RenameInput({ initial, onDone, onCancel }: { initial: string; onDone: (name: string) => void; onCancel: () => void }) {
  const t = useTranslations("docs");
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
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className="relative z-10 h-8 w-full min-w-0 rounded-md border border-line-strong bg-sheet px-2 text-[13.5px] text-ink focus:outline-none"
    />
  );
}
