"use client";

import { Download, ExternalLink, Loader2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FileIcon } from "./FileIcon";
import { docsHref, fileUrl, formatSize, isOffice, kindOf, type Item } from "./shared";

/** Full-screen preview: images, PDF, video/audio, text (first 200 KB), office → "Open in Docs". */
export function Preview({ item, onClose }: { item: Item; onClose: () => void }) {
  const t = useTranslations("drive");
  const locale = useLocale();
  const kind = kindOf(item);
  // Docs opens files from the user's own account only, so shared files aren't offered there.
  const office = isOffice(item.name) && !item.accountId;
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="flex h-14 shrink-0 items-center gap-3 px-4 text-white">
        <FileIcon item={item} />
        <p className="min-w-0 flex-1 truncate text-[14px] font-medium">{item.name}</p>
        <span className="hidden font-mono text-[12px] text-white/60 sm:block">{formatSize(item.size, locale)}</span>
        {office && (
          <Link
            href={docsHref(item.id)}
            className="inline-flex h-8 items-center gap-2 rounded-md bg-white px-3 text-[13px] font-medium text-black transition-colors hover:bg-white/90"
          >
            <ExternalLink size={14} aria-hidden />
            {t("openInDocs")}
          </Link>
        )}
        <a
          href={fileUrl(item.id, { account: item.accountId })}
          download
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
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pt-0" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(item.id, { inline: true, account: item.accountId })} alt={item.name} className="max-h-full max-w-full rounded-md object-contain" />
        ) : kind === "pdf" ? (
          <iframe
            src={fileUrl(item.id, { inline: true, account: item.accountId })}
            title={item.name}
            className="h-full w-full max-w-5xl rounded-md bg-white"
          />
        ) : kind === "video" ? (
          <video src={fileUrl(item.id, { inline: true, account: item.accountId })} controls autoPlay className="max-h-full max-w-full rounded-md bg-black" />
        ) : kind === "audio" ? (
          <div className="sheet w-full max-w-md p-6">
            <p className="mb-4 truncate text-[14px] font-medium text-ink">{item.name}</p>
            <audio src={fileUrl(item.id, { inline: true, account: item.accountId })} controls autoPlay className="w-full" />
          </div>
        ) : kind === "text" || kind === "code" ? (
          <TextPreview item={item} />
        ) : (
          <div className="sheet max-w-sm p-8 text-center">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-line bg-sheet-muted">
              <FileIcon item={item} size={26} />
            </span>
            <p className="mt-5 text-[15px] font-medium text-ink">{office ? t("officeHint") : t("noPreview")}</p>
            <div className="mt-5 flex justify-center gap-2">
              {office && (
                <Link
                  href={docsHref(item.id)}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-[13.5px] font-medium text-primary-ink transition-colors hover:bg-primary-hover"
                >
                  <ExternalLink size={15} aria-hidden />
                  {t("openInDocs")}
                </Link>
              )}
              <a
                href={fileUrl(item.id, { account: item.accountId })}
                download
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-line px-3.5 text-[13.5px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
              >
                <Download size={15} aria-hidden />
                {t("download")}
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TextPreview({ item }: { item: Item }) {
  const t = useTranslations("drive");
  const [state, setState] = useState<{ text: string; truncated: boolean } | "loading" | "error">("loading");

  useEffect(() => {
    const ctl = new AbortController();
    fetch(fileUrl(item.id, { text: true, account: item.accountId }), { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setState({ text: await r.text(), truncated: r.headers.get("X-Truncated") === "1" });
      })
      .catch(() => !ctl.signal.aborted && setState("error"));
    return () => ctl.abort();
  }, [item.id, item.accountId]);

  if (state === "loading") return <Loader2 size={24} className="animate-spin text-white/70" aria-label={t("loading")} />;
  if (state === "error") return <p className="text-[14px] text-white/80">{t("previewFailed")}</p>;
  return (
    <div className="sheet flex h-full w-full max-w-4xl flex-col overflow-hidden">
      <pre className="min-h-0 flex-1 overflow-auto p-5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-ink">
        {state.text}
      </pre>
      {state.truncated && (
        <p className="shrink-0 border-t border-line px-5 py-2 text-[12px] text-ink-mute">{t("truncated")}</p>
      )}
    </div>
  );
}
