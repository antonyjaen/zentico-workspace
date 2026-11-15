"use client";

import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  HardDriveUpload,
  Loader2,
  Presentation,
  CalendarDays,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@/lib/mail-read";
import { saveAttachmentToDrive } from "./actions";
import { fileKind, formatBytes, type FileKind } from "./format";

const ICONS: Record<FileKind, { icon: LucideIcon; color: string }> = {
  image: { icon: FileImage, color: "#8b5cf6" },
  pdf: { icon: FileText, color: "var(--color-danger)" },
  video: { icon: FileVideo, color: "#db2777" },
  audio: { icon: FileAudio, color: "#0891b2" },
  archive: { icon: FileArchive, color: "var(--color-ink-mute)" },
  spreadsheet: { icon: FileSpreadsheet, color: "var(--color-signal)" },
  presentation: { icon: Presentation, color: "var(--color-amber)" },
  document: { icon: FileText, color: "var(--color-app-mail)" },
  code: { icon: FileCode, color: "var(--color-ink-mute)" },
  text: { icon: FileText, color: "var(--color-ink-mute)" },
  calendar: { icon: CalendarDays, color: "var(--color-app-calendar)" },
  other: { icon: File, color: "var(--color-ink-mute)" },
};

export function AttachmentIcon({ a, size = 18 }: { a: Pick<Attachment, "name" | "type">; size?: number }) {
  const { icon: Icon, color } = ICONS[fileKind(a.name, a.type)];
  return <Icon size={size} aria-hidden className="shrink-0" style={{ color }} />;
}

/** Triggers browser downloads one after another (browsers block bursts of parallel downloads). */
export async function downloadSequentially(list: { href: string; name: string }[]) {
  for (const [i, f] of list.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 450));
    const a = document.createElement("a");
    a.href = f.href;
    a.download = f.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

export function AttachmentGrid({
  attachments,
  onPreview,
  onToast,
}: {
  attachments: Attachment[];
  onPreview: (index: number) => void;
  onToast: (message: string) => void;
}) {
  const t = useTranslations("mailRead");
  const total = attachments.reduce((n, a) => n + a.size, 0);

  return (
    <section className="mt-5 border-t border-line pt-4" aria-label={t("attachmentCount", { count: attachments.length })}>
      <div className="mb-3 flex items-center gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute">
          {t("attachmentCount", { count: attachments.length })}
          <span className="ml-2 normal-case tracking-normal">· {formatBytes(total)}</span>
        </p>
        {attachments.length > 1 && (
          <button
            type="button"
            onClick={() => void downloadSequentially(attachments.map((a) => ({ href: a.href, name: a.name })))}
            className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink print:hidden"
          >
            <Download size={14} aria-hidden />
            {t("downloadAll")}
          </button>
        )}
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2.5">
        {attachments.map((a, i) => (
          <AttachmentCard key={a.blobId + i} a={a} onPreview={() => onPreview(i)} onToast={onToast} />
        ))}
      </ul>
    </section>
  );
}

function AttachmentCard({ a, onPreview, onToast }: { a: Attachment; onPreview: () => void; onToast: (m: string) => void }) {
  const t = useTranslations("mailRead");
  const [saving, setSaving] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const kind = fileKind(a.name, a.type);
  const thumb = kind === "image" && a.inlineHref && !thumbFailed ? a.inlineHref : null;

  const save = async () => {
    setSaving(true);
    const r = await saveAttachmentToDrive({ blobId: a.blobId, name: a.name, type: a.type }).catch(() => null);
    setSaving(false);
    onToast(r?.ok ? t("savedToDrive", { name: r.name }) : t("saveToDriveFailed", { reason: r && !r.ok ? r.error : "network" }));
  };

  return (
    <li className="group relative overflow-hidden rounded-lg border border-line bg-sheet transition-colors hover:border-line-strong focus-within:border-line-strong">
      <button
        type="button"
        onClick={a.inlineHref ? onPreview : undefined}
        tabIndex={a.inlineHref ? 0 : -1}
        aria-label={a.inlineHref ? `${t("preview")} ${a.name}` : a.name}
        className={`grid h-[92px] w-full place-items-center overflow-hidden bg-sheet-muted ${a.inlineHref ? "cursor-zoom-in" : "cursor-default"}`}
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" loading="lazy" onError={() => setThumbFailed(true)} className="h-full w-full object-cover" />
        ) : (
          <AttachmentIcon a={a} size={30} />
        )}
      </button>
      <div className="flex items-center gap-2 border-t border-line px-2.5 py-2">
        <AttachmentIcon a={a} size={15} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-ink" title={a.name}>
            {a.name}
          </span>
          <span className="block font-mono text-[10.5px] text-ink-mute">{formatBytes(a.size)}</span>
        </span>
      </div>
      <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 print:hidden">
        {a.inlineHref && <HoverAction icon={Eye} label={t("preview")} onClick={onPreview} />}
        <HoverAction icon={Download} label={t("download")} href={a.href} download={a.name} />
        <HoverAction icon={saving ? Loader2 : HardDriveUpload} spin={saving} label={t("saveToDrive")} onClick={save} disabled={saving} />
      </div>
    </li>
  );
}

function HoverAction({
  icon: Icon,
  label,
  onClick,
  href,
  download,
  disabled,
  spin,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  href?: string;
  download?: string;
  disabled?: boolean;
  spin?: boolean;
}) {
  const cls =
    "grid h-7 w-7 place-items-center rounded-md border border-line-strong bg-sheet/95 text-ink-soft shadow-sm backdrop-blur transition-colors hover:bg-hover hover:text-ink disabled:opacity-60";
  const icon = <Icon size={14} aria-hidden className={spin ? "animate-spin" : undefined} />;
  return href ? (
    <a href={href} download={download} className={cls} aria-label={label} title={label}>
      {icon}
    </a>
  ) : (
    <button type="button" onClick={onClick} disabled={disabled} className={cls} aria-label={label} title={label}>
      {icon}
    </button>
  );
}

/** Full-screen preview for image and PDF attachments, with ← / → between previewable files. */
export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: Attachment[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const t = useTranslations("mailRead");
  const closeRef = useRef<HTMLButtonElement>(null);
  const a = items[index];
  const many = items.length > 1;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (many && e.key === "ArrowRight") onIndex((index + 1) % items.length);
      else if (many && e.key === "ArrowLeft") onIndex((index - 1 + items.length) % items.length);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [index, items.length, many, onClose, onIndex]);

  if (!a?.inlineHref) return null;
  const isImage = fileKind(a.name, a.type) === "image";
  const navCls =
    "absolute top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={a.name}
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm print:hidden"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="flex h-14 shrink-0 items-center gap-3 px-4 text-white">
        <AttachmentIcon a={a} />
        <p className="min-w-0 flex-1 truncate text-[14px] font-medium">{a.name}</p>
        <span className="hidden font-mono text-[12px] text-white/60 sm:block">
          {many && `${index + 1} / ${items.length} · `}
          {formatBytes(a.size)}
        </span>
        <a
          href={a.href}
          download={a.name}
          className="grid h-8 w-8 place-items-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          aria-label={t("download")}
          title={t("download")}
        >
          <Download size={16} aria-hidden />
        </a>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 place-items-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          aria-label={t("close")}
          title={t("close")}
        >
          <X size={18} aria-hidden />
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4 pt-0" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={a.inlineHref} src={a.inlineHref} alt={a.name} className="max-h-full max-w-full rounded-md object-contain" />
        ) : (
          <iframe key={a.inlineHref} src={a.inlineHref} title={a.name} className="h-full w-full max-w-5xl rounded-md bg-white" />
        )}
        {many && (
          <>
            <button type="button" className={`${navCls} left-4`} aria-label={t("previous")} onClick={() => onIndex((index - 1 + items.length) % items.length)}>
              <ChevronLeft size={20} aria-hidden />
            </button>
            <button type="button" className={`${navCls} right-4`} aria-label={t("next")} onClick={() => onIndex((index + 1) % items.length)}>
              <ChevronRight size={20} aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** "Show original": the raw message source as inert text. */
export function SourceViewer({ href, emlHref, title, onClose }: { href: string; emlHref: string | null; title: string; onClose: () => void }) {
  const t = useTranslations("mailRead");
  const [state, setState] = useState<{ text: string; truncated: boolean } | "loading" | "error">("loading");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const ctl = new AbortController();
    fetch(href, { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setState({ text: await r.text(), truncated: r.headers.get("X-Truncated") === "1" });
      })
      .catch(() => !ctl.signal.aborted && setState("error"));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      ctl.abort();
      document.removeEventListener("keydown", onKey, true);
    };
  }, [href, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("showOriginal")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:p-8 print:hidden"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="pop flex h-full w-full max-w-5xl flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-1.5">
          <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">
            {t("showOriginal")} <span className="font-normal text-ink-mute">· {title}</span>
          </p>
          {state !== "loading" && state !== "error" && (
            <button
              type="button"
              className="inline-flex h-8 items-center rounded-md px-2.5 text-[12.5px] text-ink-soft hover:bg-hover hover:text-ink"
              onClick={() => void navigator.clipboard?.writeText(state.text)}
            >
              {t("copy")}
            </button>
          )}
          {emlHref && (
            <a href={emlHref} download className="icon-btn h-8 w-8" aria-label={t("downloadEml")} title={t("downloadEml")}>
              <Download size={15} aria-hidden />
            </a>
          )}
          <button ref={closeRef} type="button" onClick={onClose} className="icon-btn h-8 w-8" aria-label={t("close")} title={t("close")}>
            <X size={16} aria-hidden />
          </button>
        </header>
        {state === "loading" ? (
          <div className="grid flex-1 place-items-center text-ink-mute">
            <Loader2 size={18} className="animate-spin" aria-label={t("loading")} />
          </div>
        ) : state === "error" ? (
          <p className="grid flex-1 place-items-center p-6 text-[14px] text-ink-soft">{t("sourceFailed")}</p>
        ) : (
          <>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-[12px] leading-relaxed text-ink">
              {state.text}
            </pre>
            {state.truncated && <p className="shrink-0 border-t border-line px-4 py-2 text-[12px] text-ink-mute">{t("sourceTruncated")}</p>}
          </>
        )}
      </div>
    </div>
  );
}
