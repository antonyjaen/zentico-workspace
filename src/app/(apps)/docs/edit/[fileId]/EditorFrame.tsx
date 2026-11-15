"use client";

// Editor page shell: slim top bar (back, inline rename, save status, download, open in Drive)
// over the standard Collabora integration: POST the WOPI access token into a named iframe,
// then talk to the editor over postMessage (ready handshake, load/modified/save status, close).
import { ArrowLeft, Check, CircleAlert, CloudUpload, Download, FolderOpen, Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { renameDocumentAction } from "../../actions";
import { downloadHref, folderHref, splitName, type DocKind } from "../../shared";
import { DocIcon } from "../../ui";

const FRAME = "collabora-editor";

export type Status = "loading" | "saved" | "modified" | "saving" | "error";
type Frame = { action: string; origin: string; token: string; ttl: number; title: string };
type Msg = { MessageId?: string; Values?: Record<string, unknown> };

export function EditorWorkspace({
  file,
  folderId,
  back,
  readOnly,
  frame,
  children,
}: {
  file: { id: string; name: string; kind: DocKind } | null;
  folderId: string | null;
  back: { href: string; label: string };
  readOnly: boolean;
  frame?: Frame;
  children?: React.ReactNode;
}) {
  const t = useTranslations("docs");
  const router = useRouter();
  const [name, setName] = useState(file?.name ?? "");
  const [status, setStatus] = useState<Status | null>(frame ? "loading" : null);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const saveWaiters = useRef<((ok: boolean) => void)[]>([]);

  useEffect(() => setName(file?.name ?? ""), [file?.name]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);

  const post = useCallback(
    (MessageId: string, Values: Record<string, unknown> = {}) => {
      if (!frame) return;
      frameRef.current?.contentWindow?.postMessage(JSON.stringify({ MessageId, SendTime: Date.now(), Values }), frame.origin);
    },
    [frame],
  );

  useEffect(() => {
    if (frame) formRef.current?.submit();
  }, [frame?.action, frame?.token]);

  useEffect(() => {
    if (!frame) return;
    const settle = (ok: boolean) => saveWaiters.current.splice(0).forEach((w) => w(ok));
    function onMessage(e: MessageEvent) {
      if (!frame || e.origin !== frame.origin || e.source !== frameRef.current?.contentWindow) return;
      let msg: Msg;
      try {
        msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      const v = msg?.Values ?? {};
      switch (msg?.MessageId) {
        case "App_LoadingStatus":
          if (v.Status === "Frame_Ready") post("Host_PostmessageReady");
          else if (v.Status === "Document_Loaded") setStatus((s) => (s === "loading" ? "saved" : s));
          else if (v.Status === "Failed") setStatus("error");
          break;
        case "Doc_ModifiedStatus":
          setStatus(v.Modified === true ? "modified" : "saved");
          if (v.Modified === false) settle(true);
          break;
        case "Action_Save_Resp":
          if (v.success === false) {
            setStatus("error");
            settle(false);
          } else {
            setStatus("saved");
            settle(true);
          }
          break;
        case "File_Rename":
          if (typeof v.NewName === "string" && v.NewName) setName(v.NewName);
          break;
        case "UI_Close":
          router.push(back.href);
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame, back.href, router, post]);

  /** Asks Collabora to save now; resolves when it confirms (or after a timeout). */
  const saveNow = useCallback(() => {
    if (!frame) return Promise.resolve(true);
    setStatus("saving");
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000);
      saveWaiters.current.push((ok) => (clearTimeout(timer), resolve(ok)));
      post("Action_Save", { DontTerminateEdit: true, DontSaveIfUnmodified: true, Notify: true });
    });
  }, [frame, post]);

  const download = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!file || status !== "modified") return; // stored copy is current: plain link
    e.preventDefault();
    await saveNow();
    const a = document.createElement("a");
    a.href = downloadHref(file.id);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const rename = async (next: string) => {
    if (!file) return;
    const [, ext] = splitName(name);
    const full = ext ? `${next}.${ext}` : next;
    if (full === name) return;
    const prev = name;
    setName(full);
    try {
      const r = await renameDocumentAction(file.id, full);
      if (r.ok) setName(r.data);
      else {
        setName(prev);
        setError(t.has(`errors.${r.error}`) ? t(`errors.${r.error}` as "errors.failed") : t("errors.failed"));
      }
    } catch {
      setName(prev);
      setError(t("errors.failed"));
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
            <DocIcon kind={file.kind} size={17} />
            <NameField name={name} onRename={rename} />
            {readOnly && (
              <span className="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-ink-mute">{t("readOnly")}</span>
            )}
            {status && <SaveStatus status={status} readOnly={readOnly} onSave={() => void saveNow()} />}
            <span className="flex-1" />
            <Link
              href={folderHref(folderId)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
              title={t("openInDrive")}
            >
              <FolderOpen size={16} aria-hidden />
              <span className="hidden md:inline">{t("openInDrive")}</span>
            </Link>
            <a
              href={downloadHref(file.id)}
              download={name}
              onClick={download}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
              title={t("download")}
            >
              <Download size={15} aria-hidden />
              <span className="hidden sm:inline">{t("download")}</span>
            </a>
          </>
        )}
      </div>

      {frame ? (
        <div className="relative min-h-0 flex-1 bg-sheet-muted">
          <form ref={formRef} action={frame.action} method="post" target={FRAME} className="hidden">
            <input type="hidden" name="access_token" value={frame.token} />
            <input type="hidden" name="access_token_ttl" value={String(frame.ttl)} />
          </form>
          {status === "loading" && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden>
              <div className="flex flex-col items-center gap-3 text-[13px] text-ink-mute">
                <Loader2 size={22} className="animate-spin" />
                {t("loadingEditor")}
              </div>
            </div>
          )}
          <iframe
            ref={frameRef}
            name={FRAME}
            title={frame.title}
            allow="clipboard-read; clipboard-write; fullscreen"
            allowFullScreen
            className="absolute inset-0 h-full w-full border-0"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      )}

      {error && (
        <div role="alert" className="pop absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 px-3.5 py-2.5 text-[13px] text-ink">
          <CircleAlert size={15} className="shrink-0 text-danger" aria-hidden />
          {error}
          <button type="button" onClick={() => setError(null)} className="icon-btn ml-1 h-6 w-6" aria-label={t("close")}>
            <X size={13} aria-hidden />
          </button>
        </div>
      )}
    </main>
  );
}

export function NameField({ name, onRename }: { name: string; onRename: (base: string) => void }) {
  const t = useTranslations("docs");
  const [editing, setEditing] = useState(false);
  const [base, ext] = splitName(name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!editing) return;
    done.current = false;
    ref.current?.focus();
    ref.current?.select();
  }, [editing]);

  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = v?.trim();
    // eslint-disable-next-line no-control-regex
    if (next && next !== base && next.length <= 250 && !/[\u0000-\u001f\u007f/]/.test(next)) onRename(next);
  };

  if (editing) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <input
          ref={ref}
          defaultValue={base}
          maxLength={250}
          aria-label={t("rename")}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(e.currentTarget.value);
            if (e.key === "Escape") finish(null);
          }}
          onBlur={(e) => finish(e.currentTarget.value)}
          className="h-8 w-[min(28rem,50vw)] min-w-0 rounded-md border border-line-strong bg-sheet px-2 text-[14px] font-medium text-ink focus:outline-none"
        />
        {ext && <span className="shrink-0 text-[13px] text-ink-mute">.{ext}</span>}
      </span>
    );
  }
  return (
    <h1 className="min-w-0">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="block max-w-full truncate rounded-md border border-transparent px-1.5 py-1 text-left text-[14px] font-medium text-ink transition-colors hover:border-line"
        title={t("renameHint")}
      >
        {base}
        {ext && <span className="font-normal text-ink-mute">.{ext}</span>}
      </button>
    </h1>
  );
}

export function SaveStatus({ status, readOnly, onSave }: { status: Status; readOnly: boolean; onSave: () => void }) {
  const t = useTranslations("docs");
  const base = "ml-1 hidden shrink-0 items-center gap-1.5 text-[12.5px] text-ink-mute sm:inline-flex";
  if (status === "loading" || (readOnly && status !== "error")) return null;
  if (status === "modified") {
    return (
      <button type="button" onClick={onSave} className={`${base} rounded-md px-1.5 py-1 transition-colors hover:bg-hover hover:text-ink`} title={t("status.saveNow")}>
        <CloudUpload size={14} aria-hidden />
        {t("status.modified")}
      </button>
    );
  }
  return (
    <span className={base} role="status" aria-live="polite">
      {status === "saving" ? (
        <Loader2 size={14} className="animate-spin" aria-hidden />
      ) : status === "error" ? (
        <CircleAlert size={14} className="text-danger" aria-hidden />
      ) : (
        <Check size={14} aria-hidden />
      )}
      {t(`status.${status}`)}
    </span>
  );
}
