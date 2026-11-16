"use client";

// Drive's "Documents" section (what used to be the Docs app): a "Start a new…" template gallery
// over every editable file in the drive, filterable by type. Plus the slim quick-create strip
// shown at the top of My Drive.
import {
  Check,
  CircleAlert,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  SearchX,
  Trash2,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { driveHref, type ViewMode } from "./shared";
import { createDocumentAction, deleteDocumentAction, renameDocumentAction, type ActionResult } from "@/app/(apps)/docs/actions";
import {
  DOC_KINDS,
  downloadHref,
  folderHref,
  fold,
  formatDate,
  formatSize,
  isNativeKind,
  openHref,
  PRESETS,
  type DocItem,
  type DocKind,
  type PresetId,
} from "@/app/(apps)/docs/shared";
import { DocIcon, KIND_COLOR, Notice } from "@/app/(apps)/docs/ui";
import { usePopover } from "@/components/usePopover";

type Filter = "all" | DocKind;
type Sort = "modified" | "name";
type Toast = { kind: "error" | "info"; text: string };

/** Presets offered: office ones only when the document server (Collabora) is configured. */
const presetsFor = (office: boolean) => PRESETS.filter((p) => office || isNativeKind(p.kind));

/** Translated message for a Drive error code. */
function useErrorText() {
  const td = useTranslations("drive");
  return useCallback((code: string) => (td.has(`errors.${code}`) ? td(`errors.${code}` as "errors.failed") : td("errors.failed")), [td]);
}

/** Creates a file from a preset in the My Drive root and opens it in its editor. */
function useCreateDoc(from: "docs" | "drive", onError: (code: string) => void) {
  const router = useRouter();
  const [creating, setCreating] = useState<PresetId | null>(null);
  const create = async (preset: PresetId) => {
    if (creating) return;
    setCreating(preset);
    try {
      const r = await createDocumentAction(preset);
      if (r.ok) {
        router.push(openHref(r.data, PRESETS.find((p) => p.id === preset)?.kind ?? "text", from));
        return; // keep the spinner until navigation
      }
      onError(r.error);
    } catch {
      onError("failed");
    }
    setCreating(null);
  };
  return { creating, create };
}

/** Slim "New document / spreadsheet / …" row at the top of the My Drive root. */
export function QuickCreate({ office, onError }: { office: boolean; onError: (code: string) => void }) {
  const t = useTranslations("drive.docs");
  const { creating, create } = useCreateDoc("drive", onError);
  const blanks = presetsFor(office).filter((p) => p.id.startsWith("blank"));
  return (
    <section className="flex items-center gap-2 overflow-x-auto border-b border-line px-4 py-2.5" aria-label={t("startNew")}>
      <span className="mr-1 shrink-0 text-[12.5px] text-ink-mute">{t("quickNew")}</span>
      {blanks.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => create(p.id)}
          disabled={!!creating}
          aria-busy={creating === p.id}
          className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-line px-3 text-[13px] text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:opacity-60 aria-busy:opacity-100"
        >
          {creating === p.id ? <Loader2 size={15} className="animate-spin text-ink-mute" aria-hidden /> : <DocIcon kind={p.kind} size={15} />}
          {t(`kind.${p.kind}`)}
        </button>
      ))}
      <Link
        href={driveHref({ section: "docs" })}
        className="ml-auto shrink-0 rounded-md px-2 py-1 text-[12.5px] text-ink-mute transition-colors hover:bg-hover hover:text-ink"
      >
        {t("allTemplates")}
      </Link>
    </section>
  );
}

export function DocsSection({ docs, view, office }: { docs: DocItem[]; view: ViewMode; office: boolean }) {
  const t = useTranslations("drive.docs");
  const td = useTranslations("drive");
  const tEditor = useTranslations("docs");
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const errorText = useErrorText();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("modified");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const { creating, create } = useCreateDoc("docs", (code) => setToast({ kind: "error", text: errorText(code) }));

  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

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

  const kinds = office ? DOC_KINDS : DOC_KINDS.filter(isNativeKind);

  /* ------------------------------------------------------------ actions */

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
      setToast({ kind: "error", text: errorText("failed") });
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
    <>
      {/* Start a new document */}
      <section className="border-b border-line bg-sheet-muted" aria-labelledby="docs-new">
        <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="docs-new" className="text-[14px] font-medium text-ink">
              {t("startNew")}
            </h2>
            <p className="hidden text-[12.5px] text-ink-mute sm:block">{t("templatesNote")}</p>
          </div>
          <ul className="-mx-1 mt-4 flex gap-4 overflow-x-auto px-1 pb-1">
            {presetsFor(office).map((p) => (
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
          {!office && (
            <p className="mt-4 flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-mute">
              <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                <span className="font-medium text-ink-soft">{tEditor("notConfigured")}.</span> {tEditor("notConfiguredHint")}
              </span>
            </p>
          )}
        </div>
      </section>

      {/* Every editable document in the drive */}
      <section className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6" aria-labelledby="docs-all">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <h2 id="docs-all" className="mr-auto text-[14px] font-medium text-ink">
            {t("all")}
          </h2>
          <label className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-sheet px-2.5 transition-colors focus-within:border-line-strong hover:border-line-strong sm:w-52">
            <Search size={14} className="shrink-0 text-ink-mute" aria-hidden />
            <span className="sr-only">{t("search")}</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value.slice(0, 200))}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder={t("search")}
              autoComplete="off"
              className="h-full w-full bg-transparent text-[13px] text-ink placeholder:text-ink-mute focus:outline-none"
            />
          </label>
          <div className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-line p-0.5" role="tablist" aria-label={t("filterLabel")}>
            {(["all", ...kinds] as Filter[]).map((f) => (
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
        </div>

        <div className="mt-4">
          {counts.all === 0 ? (
            <Notice icon={FileText} title={t("empty")} hint={t("emptyHint")} />
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
                <span>{td("name")}</span>
                <span>{t("location")}</span>
                <span>{td("modified")}</span>
                <span className="text-right">{td("size")}</span>
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

      {toast && (
        <div role={toast.kind === "error" ? "alert" : "status"} className="pop absolute bottom-4 left-1/2 z-30 flex max-w-[90%] -translate-x-1/2 items-center gap-2 px-3.5 py-2.5 text-[13px] text-ink">
          {toast.kind === "error" ? <CircleAlert size={15} className="shrink-0 text-danger" aria-hidden /> : <Check size={15} className="shrink-0 text-signal" aria-hidden />}
          <span className="min-w-0 truncate">{toast.text}</span>
          <button type="button" onClick={() => setToast(null)} className="icon-btn ml-1 h-6 w-6 shrink-0" aria-label={td("close")}>
            <X size={13} aria-hidden />
          </button>
        </div>
      )}
    </>
  );
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
      className="group flex w-[128px] flex-col text-left disabled:cursor-default"
    >
      <span className="relative grid aspect-[4/5] w-full place-items-center overflow-hidden rounded-lg border border-line bg-sheet transition-colors duration-150 group-hover:border-line-strong group-disabled:opacity-70 group-aria-busy:opacity-100">
        {blank ? (
          <span className="grid place-items-center gap-2">
            <Plus size={30} strokeWidth={1.5} aria-hidden style={{ color: KIND_COLOR[kind] }} />
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
  const td = useTranslations("drive");
  const { doc } = p;
  const where = doc.location ?? td("myDrive");
  return (
    <li className="group relative grid min-h-12 grid-cols-[minmax(0,1fr)_40px] items-center gap-4 border-b border-line/70 px-4 py-1.5 transition-colors last:rounded-b-lg last:border-b-0 hover:bg-hover md:grid-cols-[minmax(0,1fr)_200px_120px_80px_40px]">
      <span className="flex min-w-0 items-center gap-3">
        <DocIcon kind={doc.kind} />
        {p.renaming ? (
          <RenameInput initial={doc.name} onDone={p.onRenameDone} onCancel={p.onRenameCancel} />
        ) : (
          <span className="min-w-0">
            <Link
              href={openHref(doc.id, doc.kind, "docs")}
              className="block truncate text-[14px] text-ink after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-md focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-accent"
              title={doc.name}
            >
              {doc.name}
            </Link>
            <span className="block truncate text-[12px] text-ink-mute md:hidden">
              {formatDate(doc.modified, p.locale)} · {where}
            </span>
          </span>
        )}
      </span>
      <span className="hidden min-w-0 items-center gap-1.5 text-[13px] text-ink-mute md:flex" title={where}>
        <FolderOpen size={14} aria-hidden className="shrink-0" />
        <span className="truncate">{where}</span>
      </span>
      <span className="hidden truncate text-[13px] text-ink-mute md:block">{formatDate(doc.modified, p.locale)}</span>
      <span className="hidden text-right font-mono text-[12px] tabular-nums text-ink-mute md:block">{formatSize(doc.size, p.locale)}</span>
      <span className="relative z-10 flex justify-end">
        {p.busy ? <Loader2 size={15} className="m-2 animate-spin text-ink-mute" aria-label={td("working")} /> : <RowMenu {...p} />}
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
  const td = useTranslations("drive");
  const { doc } = p;
  const where = doc.location ?? td("myDrive");
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
              href={openHref(doc.id, doc.kind, "docs")}
              className="block truncate text-[13.5px] font-medium text-ink after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-lg focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-accent"
              title={doc.name}
            >
              {doc.name}
            </Link>
          )}
          <span className="mt-0.5 block truncate text-[12px] text-ink-mute" title={where}>
            {formatDate(doc.modified, p.locale)} · {where}
          </span>
        </span>
        <span className="relative z-10 shrink-0">
          {p.busy ? <Loader2 size={15} className="m-2 animate-spin text-ink-mute" aria-label={td("working")} /> : <RowMenu {...p} />}
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
  const t = useTranslations("drive.docs");
  const td = useTranslations("drive");
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
          {td("delete")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 rounded-md border border-line bg-sheet px-2.5 text-[12.5px] font-medium text-ink-soft hover:bg-hover hover:text-ink"
        >
          {td("cancel")}
        </button>
      </span>
    </div>
  );
}

function RowMenu({ doc, onRename, onDelete }: RowProps) {
  const t = useTranslations("drive.docs");
  const td = useTranslations("drive");
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
          <Link role="menuitem" href={openHref(doc.id, doc.kind, "docs")} className={item} onClick={close}>
            <ExternalLink size={16} aria-hidden className="shrink-0" />
            {td("open")}
          </Link>
          <button type="button" role="menuitem" className={item} onClick={() => (close(), onRename())}>
            <Pencil size={16} aria-hidden className="shrink-0" />
            {td("rename")}
          </button>
          <Link role="menuitem" href={folderHref(doc.folderId)} className={item} onClick={close}>
            <FolderOpen size={16} aria-hidden className="shrink-0" />
            {t("openFolder")}
          </Link>
          <a role="menuitem" href={downloadHref(doc.id)} download={doc.name} className={item} onClick={close}>
            <Download size={16} aria-hidden className="shrink-0" />
            {td("download")}
          </a>
          <div className="my-1 h-px bg-line" />
          <button type="button" role="menuitem" className={`${item} hover:text-danger`} onClick={() => (close(), onDelete())}>
            <Trash2 size={16} aria-hidden className="shrink-0" />
            {td("delete")}
          </button>
        </div>
      )}
    </div>
  );
}

function RenameInput({ initial, onDone, onCancel }: { initial: string; onDone: (name: string) => void; onCancel: () => void }) {
  const td = useTranslations("drive");
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
      aria-label={td("rename")}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className="relative z-10 h-8 w-full min-w-0 rounded-md border border-line-strong bg-sheet px-2 text-[13.5px] text-ink focus:outline-none"
    />
  );
}
