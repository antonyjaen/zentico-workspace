"use client";

import { ChevronDown, Download, FileImage, Loader2, Shapes } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import type { CanvasController } from "./Canvas";
import { downloadFile, NativeShell, useDocSaver } from "../../NativeShell";
import type { NativeDoc } from "../../native";
import { downloadHref, splitName } from "../../shared";
import { Notice } from "../../ui";
import { useAppTheme } from "@/app/(apps)/mail/[mailboxId]/t/[threadId]/MessageFrame";
import { usePopover } from "@/components/usePopover";

function Loading() {
  const t = useTranslations("docs");
  return (
    <div className="absolute inset-0 grid place-items-center" aria-busy="true">
      <div className="flex flex-col items-center gap-3 text-[13px] text-ink-mute">
        <Loader2 size={22} className="animate-spin" aria-hidden />
        {t("loadingEditor")}
      </div>
    </div>
  );
}

const Canvas = dynamic(() => import("./Canvas"), { ssr: false, loading: Loading });

type Parsed = { ok: true; scene: Record<string, unknown> | null } | { ok: false };

/** Empty file → blank scene; otherwise it must be an Excalidraw document. */
function parseScene(content: string | undefined): Parsed {
  if (!content?.trim()) return { ok: true, scene: null };
  try {
    const v = JSON.parse(content) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false };
    const o = v as Record<string, unknown>;
    if (o.type !== "excalidraw" || !Array.isArray(o.elements)) return { ok: false };
    return { ok: true, scene: o };
  } catch {
    return { ok: false };
  }
}

export function Whiteboard({
  doc,
  back,
  notice,
}: {
  doc: NativeDoc | null;
  back: { href: string; label: string };
  notice?: { title: string; hint?: string };
}) {
  const t = useTranslations("docs");
  const locale = useLocale();
  const theme = useAppTheme() ?? "light";
  const ctl = useRef<CanvasController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(doc?.name ?? "");
  const parsed = useMemo(() => parseScene(doc?.content), [doc?.content]);
  const readOnly = !doc || doc.readOnly || !parsed.ok;

  const errText = useCallback(
    (code: string) =>
      code === "too_large" ? t("nativeTooLarge") : t.has(`errors.${code}`) ? t(`errors.${code}` as "errors.failed") : t("errors.failed"),
    [t],
  );
  const saver = useDocSaver({
    fileId: doc?.id ?? "",
    readOnly,
    getBody: () => ctl.current?.serialize() ?? doc?.content ?? "",
    onError: (code) => setError(errText(code)),
  });

  const onReady = useCallback((c: CanvasController) => {
    ctl.current = c;
  }, []);

  const base = splitName(name)[0] || t("untitled.whiteboard");

  const exportAs = async (format: "excalidraw" | "png" | "svg") => {
    if (!doc) return;
    if (format === "excalidraw") {
      if (saver.isDirty() && !(await saver.saveNow())) return;
      downloadFile(downloadHref(doc.id), name);
      return;
    }
    const c = ctl.current;
    if (!c) return;
    if (!c.count()) {
      setError(t("draw.emptyExport"));
      return;
    }
    try {
      const blob = format === "png" ? await c.exportPng() : await c.exportSvg();
      downloadFile(blob, `${base}.${format}`);
    } catch {
      setError(t("errors.failed"));
    }
  };

  return (
    <NativeShell
      file={doc ? { id: doc.id, name: doc.name } : null}
      kind="whiteboard"
      folderId={doc?.folderId ?? null}
      back={back}
      readOnly={readOnly}
      status={doc && !readOnly ? saver.status : null}
      error={error}
      onError={setError}
      onSave={() => void saver.saveNow()}
      onRenamed={setName}
      download={doc ? <DownloadMenu onPick={exportAs} /> : undefined}
    >
      {notice || !doc ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Notice icon={Shapes} title={notice?.title ?? t("notFound")} hint={notice?.hint} />
        </div>
      ) : !parsed.ok ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Notice icon={Shapes} title={t("draw.invalid")} hint={t("draw.invalidHint")} />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-[var(--radius-sheet)]">
          <div className="absolute inset-0">
            <Canvas
              scene={parsed.scene}
              name={base}
              theme={theme}
              langCode={locale.startsWith("es") ? "es-ES" : "en"}
              readOnly={readOnly}
              onReady={onReady}
              onChange={saver.markDirty}
            />
          </div>
        </div>
      )}
    </NativeShell>
  );
}

function DownloadMenu({ onPick }: { onPick: (format: "excalidraw" | "png" | "svg") => void }) {
  const t = useTranslations("docs");
  const { open, setOpen, toggle, ref } = usePopover();
  const item =
    "flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-[13.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink";
  const pick = (f: "excalidraw" | "png" | "svg") => {
    setOpen(false);
    onPick(f);
  };
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
        title={t("download")}
      >
        <Download size={15} aria-hidden />
        <span className="hidden sm:inline">{t("download")}</span>
        <ChevronDown size={14} aria-hidden className="hidden sm:block" />
      </button>
      {open && (
        <div role="menu" className="pop absolute top-full right-0 z-40 mt-1 w-60 p-1.5" style={{ transformOrigin: "top right" }}>
          <button type="button" role="menuitem" className={item} onClick={() => pick("excalidraw")}>
            <Shapes size={16} aria-hidden className="shrink-0" />
            {t("draw.downloadFile")}
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => pick("png")}>
            <FileImage size={16} aria-hidden className="shrink-0" />
            {t("draw.downloadPng")}
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => pick("svg")}>
            <FileImage size={16} aria-hidden className="shrink-0" />
            {t("draw.downloadSvg")}
          </button>
        </div>
      )}
    </div>
  );
}
