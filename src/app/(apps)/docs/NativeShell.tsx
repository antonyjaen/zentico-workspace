"use client";

// Shared shell for the built-in editors (whiteboard, Markdown): the slim top bar (back, icon,
// inline rename, save status, extra tools, Open in Drive, Download) and the autosave hook.
import { ArrowLeft, CircleAlert, Download, FolderOpen, X } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { renameDocumentAction } from "./actions";
import { NameField, SaveStatus, type Status } from "./edit/[fileId]/EditorFrame";
import { AccessChip, DocShareDialog, ReadOnlyBadge, ShareButton, useDocShare } from "./ShareControls";
import { downloadHref, folderHref, splitName, type DocAccess, type NativeKind } from "./shared";
import { DocIcon } from "./ui";

const saveUrl = (id: string) => `/api/docs/content/${encodeURIComponent(id)}`;

/** Beacons/keepalive requests are capped at 64 KB in browsers: stay below it. */
const KEEPALIVE_MAX = 60 * 1024;

type SaverOpts = {
  fileId: string;
  readOnly: boolean;
  /** Serializes the editor's current content. */
  getBody: () => string;
  /** Debounce after the last change, in ms. */
  delay?: number;
  onError: (code: string) => void;
};

/**
 * Debounced autosave: `markDirty()` after each real change; saves `delay` ms after the last one,
 * on Ctrl/Cmd+S, when the tab is hidden, on in-app navigation (unmount) and before unload
 * (sendBeacon; if the content is too big for a beacon the browser asks before leaving).
 */
export function useDocSaver({ fileId, readOnly, getBody, delay = 1500, onError }: SaverOpts) {
  const [status, setStatus] = useState<Status>("saved");
  const dirty = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyRef = useRef(getBody);
  const errRef = useRef(onError);
  bodyRef.current = getBody;
  errRef.current = onError;

  const send = useCallback(async (): Promise<boolean> => {
    const body = bodyRef.current();
    dirty.current = false;
    setStatus("saving");
    try {
      const res = await fetch(saveUrl(fileId), {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body,
      });
      if (!res.ok) {
        let code = "failed";
        try {
          code = ((await res.json()) as { error?: string }).error ?? code;
        } catch {}
        throw new Error(code);
      }
      setStatus(dirty.current ? "modified" : "saved");
      return true;
    } catch (e) {
      dirty.current = true;
      setStatus("error");
      errRef.current(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "network");
      return false;
    }
  }, [fileId]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (readOnly) return true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // Let a running save finish first, then save whatever changed meanwhile.
    while (inFlight.current) await inFlight.current;
    if (!dirty.current) return true;
    const p = send();
    inFlight.current = p;
    try {
      return await p;
    } finally {
      inFlight.current = null;
    }
  }, [readOnly, send]);

  const markDirty = useCallback(() => {
    if (readOnly) return;
    dirty.current = true;
    setStatus((s) => (s === "saving" ? s : "modified"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveNow(), delay);
  }, [readOnly, delay, saveNow]);

  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        dirty.current = true; // explicit save: always write
        void saveNow();
      }
    };
    const onHide = () => document.visibilityState === "hidden" && dirty.current && void saveNow();
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!dirty.current && !inFlight.current) return;
      const body = bodyRef.current();
      const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
      const sent = blob.size <= KEEPALIVE_MAX && navigator.sendBeacon(saveUrl(fileId), blob);
      if (sent) {
        dirty.current = false;
        return;
      }
      e.preventDefault();
      e.returnValue = "";
    };
    // Capture phase: runs before the editor's own shortcuts (Excalidraw's "save to file").
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [readOnly, fileId, saveNow]);

  // In-app navigation away: the page stays alive, so a plain request completes.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (readOnly || !dirty.current) return;
      const body = bodyRef.current();
      void fetch(saveUrl(fileId), {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body,
        keepalive: body.length < KEEPALIVE_MAX,
      }).catch(() => {});
    },
    [readOnly, fileId],
  );

  return { status, markDirty, saveNow, isDirty: () => dirty.current || !!inFlight.current };
}

/** Triggers a browser download of a Blob or URL. */
export function downloadFile(src: Blob | string, name: string) {
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof src !== "string") setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function NativeShell({
  file,
  kind,
  folderId,
  back,
  readOnly,
  status,
  error,
  onError,
  onSave,
  tools,
  download,
  onRenamed,
  access,
  children,
}: {
  file: { id: string; name: string } | null;
  kind: NativeKind;
  folderId: string | null;
  back: { href: string; label: string };
  readOnly: boolean;
  status: Status | null;
  error: string | null;
  onError: (msg: string | null) => void;
  onSave?: () => void;
  /** Editor-specific controls placed after the save status. */
  tools?: React.ReactNode;
  /** Replaces the default Download link (e.g. a menu with export formats). */
  download?: React.ReactNode;
  onRenamed?: (name: string) => void;
  /** Viewer's rights and share count; null/undefined hides the Share controls. */
  access?: DocAccess | null;
  children: React.ReactNode;
}) {
  const t = useTranslations("docs");
  const [name, setName] = useState(file?.name ?? "");
  const share = useDocShare(access);

  useEffect(() => setName(file?.name ?? ""), [file?.name]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => onError(null), 5000);
    return () => clearTimeout(timer);
  }, [error, onError]);

  const rename = async (next: string) => {
    if (!file) return;
    const [, ext] = splitName(name);
    const full = ext ? `${next}.${ext}` : next;
    if (full === name) return;
    const prev = name;
    setName(full);
    try {
      const r = await renameDocumentAction(file.id, full);
      if (r.ok) {
        setName(r.data);
        onRenamed?.(r.data);
      } else {
        setName(prev);
        onError(t.has(`errors.${r.error}`) ? t(`errors.${r.error}` as "errors.failed") : t("errors.failed"));
      }
    } catch {
      setName(prev);
      onError(t("errors.failed"));
    }
  };

  return (
    <main className="sheet relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <Link
          href={back.href}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
          aria-label={`${t("back")}: ${back.label}`}
          title={`${t("back")}: ${back.label}`}
        >
          <ArrowLeft size={16} aria-hidden />
          <span className="hidden sm:inline">{back.label}</span>
        </Link>
        {file && (
          <>
            <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />
            <DocIcon kind={kind} size={17} />
            {readOnly ? (
              <h1 className="min-w-0 truncate px-1.5 text-[14px] font-medium text-ink" title={name}>
                {name}
              </h1>
            ) : (
              <NameField name={name} onRename={rename} />
            )}
            {readOnly && <ReadOnlyBadge share={share} />}
            <AccessChip share={share} />
            {status && <SaveStatus status={status} readOnly={readOnly} onSave={() => onSave?.()} />}
            <span className="flex-1" />
            {tools}
            <Link
              href={folderHref(folderId)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
              title={t("openInDrive")}
            >
              <FolderOpen size={16} aria-hidden />
              <span className="hidden md:inline">{t("openInDrive")}</span>
            </Link>
            {download ?? (
              <a
                href={downloadHref(file.id)}
                download={name}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
                title={t("download")}
              >
                <Download size={15} aria-hidden />
                <span className="hidden sm:inline">{t("download")}</span>
              </a>
            )}
            <ShareButton share={share} />
          </>
        )}
      </div>

      {children}

      {file && <DocShareDialog share={share} file={{ id: file.id, name }} />}

      {error && (
        <div role="alert" className="pop absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 px-3.5 py-2.5 text-[13px] text-ink">
          <CircleAlert size={15} className="shrink-0 text-danger" aria-hidden />
          {error}
          <button type="button" onClick={() => onError(null)} className="icon-btn ml-1 h-6 w-6" aria-label={t("close")}>
            <X size={13} aria-hidden />
          </button>
        </div>
      )}
    </main>
  );
}
