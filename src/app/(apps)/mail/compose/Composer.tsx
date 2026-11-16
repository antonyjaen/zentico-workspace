"use client";

import { Check, Loader2, Maximize2, Minimize2, Minus, Paperclip, Pencil, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, ComposeAttachment, ComposePrefill, Identity, QuotedOriginal } from "@/lib/mail-compose";
import { composeHref, parseCompose } from "../hrefs";
import { discardDraftAction, loadCompose, saveDraftAction, sendAction } from "./actions";
import { parseRecipients, RecipientField, toRecipient, type Recipient } from "./RecipientField";
import { RichEditor } from "./RichEditor";
import { escapeHtml, htmlToText, sanitizeHtml, SIGNATURE_ATTR, textToHtml } from "./sanitize";

// Mirrors MAX_ATTACHMENT_BYTES in src/lib/mail-compose.ts (enforced again server-side).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const AUTOSAVE_MS = 2000;

/** Mounted once in the mail layout; shows the panel while `?compose=` is present. */
export function Composer() {
  const t = useTranslations("compose");
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const value = params.get("compose");
  const parsed = parseCompose(value);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const close = useCallback(() => {
    const next = new URLSearchParams(params.toString());
    next.delete("compose");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  const qs = params.toString();
  // Phone compose button: on lists only (threads have reply buttons, settings has its own forms).
  const fab = !pathname.startsWith("/mail/settings") && !/^\/mail\/[^/]+\/t\//.test(pathname);
  return (
    <>
      {parsed && value ? (
        <ComposerPanel
          key={value}
          value={value}
          onClose={close}
          onDone={(msg) => {
            setToast(msg);
            close();
          }}
        />
      ) : fab ? (
        <Link
          href={composeHref(qs ? `${pathname}?${qs}` : pathname, "new")}
          scroll={false}
          aria-label={t("newMessage")}
          // Hidden while the phone selection bar is up (it takes the bottom edge).
          className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-ink shadow-[var(--shadow-pop)] transition-colors hover:bg-primary-hover lg:hidden [body:has([data-mail-bulkbar])_&]:hidden"
        >
          <Pencil size={20} aria-hidden />
        </Link>
      ) : null}
      {toast && (
        <div
          role="status"
          className="pop fixed bottom-4 left-1/2 z-50 -translate-x-1/2 px-4 py-2.5 text-[13px] text-ink"
        >
          {toast}
        </div>
      )}
    </>
  );
}

type Upload = {
  key: string;
  name: string;
  size: number;
  type: string;
  blobId?: string;
  progress: number;
  error?: string;
  xhr?: XMLHttpRequest;
};

type WindowMode = "normal" | "min" | "max";

const formatAddress = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email);

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function signatureHtml(identity: Identity | undefined): string {
  if (!identity) return "";
  if (identity.htmlSignature.trim()) return sanitizeHtml(identity.htmlSignature);
  if (identity.textSignature.trim()) return textToHtml(identity.textSignature);
  return "";
}

function ComposerPanel({
  value,
  onClose,
  onDone,
}: {
  value: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const t = useTranslations("compose");
  const locale = useLocale();

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [win, setWin] = useState<WindowMode>("normal");
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [identityId, setIdentityId] = useState("");
  const [to, setTo] = useState<Recipient[]>([]);
  const [cc, setCc] = useState<Recipient[]>([]);
  const [bcc, setBcc] = useState<Recipient[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [initialHtml, setInitialHtml] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [version, setVersion] = useState(0);
  const [modKey, setModKey] = useState("Ctrl");

  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setModKey("⌘");
  }, []);

  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const threading = useRef<{ inReplyTo: string[] | null; references: string[] | null }>({
    inReplyTo: null,
    references: null,
  });
  const draftId = useRef<string | null>(null);
  const versionRef = useRef(0);
  const savedVersion = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const finished = useRef(false);
  const state = useRef({ identityId, to, cc, bcc, subject, uploads });
  state.current = { identityId, to, cc, bcc, subject, uploads };

  const touch = useCallback(() => {
    versionRef.current += 1;
    setVersion(versionRef.current);
    setError(null);
  }, []);

  /* ------------------------------------------------------------- loading */

  useEffect(() => {
    let cancelled = false;
    loadCompose(value)
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) {
          setStatus("error");
          return;
        }
        const { identities, prefill } = r.data;
        setIdentities(identities);
        setIdentityId(prefill.identityId ?? identities[0]?.id ?? "");
        // `?to=` prefills a new message (e.g. "Send email" from Contacts).
        const toParam = new URLSearchParams(window.location.search).get("to");
        setTo(
          prefill.to.length || !toParam ? prefill.to.map(toRecipient) : parseRecipients(toParam.slice(0, 2000)),
        );
        setCc(prefill.cc.map(toRecipient));
        setBcc(prefill.bcc.map(toRecipient));
        setShowCc(prefill.cc.length > 0);
        setShowBcc(prefill.bcc.length > 0);
        setSubject(prefill.subject);
        setUploads(
          prefill.attachments.map((a, i) => ({ ...a, key: `${a.blobId}-${i}`, progress: 1 })),
        );
        threading.current = { inReplyTo: prefill.inReplyTo, references: prefill.references };
        draftId.current = prefill.draftId;
        const identity = identities.find((i) => i.id === prefill.identityId);
        setInitialHtml(initialBody(prefill, identity));
        setStatus("ready");
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
    // `value` is the panel key; load once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function quoteHeader(q: QuotedOriginal) {
    const date = q.sentAt
      ? new Intl.DateTimeFormat(locale, {
          weekday: "short",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(q.sentAt))
      : "";
    return { date, from: q.from.map(formatAddress).join(", ") };
  }

  function initialBody(p: ComposePrefill, identity: Identity | undefined): string {
    if (p.draftId || (!p.quote && (p.html || p.text))) {
      return p.html ? sanitizeHtml(p.html) : textToHtml(p.text ?? "");
    }
    // Reply text, then the signature, then the quoted original (Gmail-style "signature above quote").
    const sig = signatureHtml(identity);
    const sigBlock = `<div ${SIGNATURE_ATTR}="">${sig ? `<br>-- <br>${sig}` : ""}</div>`;
    let out = `<div><br></div>${sigBlock}`;
    const q = p.quote;
    if (!q) return out;
    // The original keeps its formatting (sanitized); plain-text originals keep their line breaks.
    const original = q.html ? sanitizeHtml(q.html) : textToHtml(q.text ?? "");
    const { date, from } = quoteHeader(q);
    if (value.startsWith("forward")) {
      const field = (label: string, v: string) => `<b>${escapeHtml(label)}:</b> ${escapeHtml(v)}`;
      const lines = [
        escapeHtml(t("forward.header")),
        field(t("forward.from"), from),
        date && field(t("forward.date"), date),
        field(t("forward.subject"), q.subject),
        q.to.length && field(t("forward.to"), q.to.map(formatAddress).join(", ")),
        q.cc.length && field(t("forward.cc"), q.cc.map(formatAddress).join(", ")),
      ].filter(Boolean) as string[];
      out += `<br><div>${lines.join("<br>")}</div><br><div>${original}</div>`;
    } else {
      const header = date ? t("replyHeader", { date, name: from }) : t("replyHeaderNoDate", { name: from });
      out += `<br><div>${escapeHtml(header)}</div><blockquote>${original}</blockquote>`;
    }
    return out;
  }

  /* ----------------------------------------------------- payload & saving */

  function payload(forSend: boolean) {
    const s = state.current;
    const html = editorRef.current?.innerHTML ?? "";
    // Structured plain-text alternative ("> " quoting) rather than the editor's rendered text.
    const text = editorRef.current ? htmlToText(editorRef.current) : "";
    const emails = (list: Recipient[]) => list.filter((r) => forSend || r.valid).map((r) => r.email);
    const attachments: ComposeAttachment[] = s.uploads
      .filter((u) => u.blobId && !u.error)
      .map((u) => ({ blobId: u.blobId!, name: u.name, type: u.type, size: u.size }));
    return {
      identityId: s.identityId,
      to: emails(s.to),
      cc: emails(s.cc),
      bcc: emails(s.bcc),
      subject: s.subject,
      // Give quotes a visible rule in recipients' clients too.
      html: html.replace(
        /<blockquote>/g,
        '<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">',
      ),
      text,
      attachments,
      inReplyTo: threading.current.inReplyTo,
      references: threading.current.references,
    };
  }

  const isBlank = () => {
    const s = state.current;
    const text = (editorRef.current?.innerText ?? "").trim();
    return !s.to.length && !s.cc.length && !s.bcc.length && !s.subject.trim() && !text && !s.uploads.length;
  };

  /** Queues a draft save of the current content (serialized, newest content wins). */
  const save = useCallback((final = false): Promise<void> => {
    queue.current = queue.current.then(async () => {
      if (finished.current && !final) return; // sent, discarded or closed meanwhile
      const v = versionRef.current;
      if (v === savedVersion.current) return;
      if (!state.current.identityId || (!draftId.current && isBlank())) return;
      setSaveState("saving");
      const r = await saveDraftAction(payload(false), draftId.current, final).catch(() => null);
      if (r?.ok) {
        draftId.current = r.data;
        savedVersion.current = v;
        setSaveState("saved");
      } else {
        setSaveState("error");
      }
    });
    return queue.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced autosave.
  useEffect(() => {
    if (status !== "ready" || version === 0 || finished.current) return;
    const id = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(id);
  }, [version, status, save]);

  /* ----------------------------------------------------------- actions */

  const close = () => {
    if (!finished.current && status === "ready") {
      finished.current = true;
      void save(true); // keep the latest content as a draft
    }
    for (const u of state.current.uploads) u.xhr?.abort();
    onClose();
  };

  const discard = async () => {
    finished.current = true;
    for (const u of state.current.uploads) u.xhr?.abort();
    await queue.current;
    if (draftId.current) await discardDraftAction(draftId.current).catch(() => null);
    onDone(t("discarded"));
  };

  const send = async () => {
    if (sending || status !== "ready") return;
    const s = state.current;
    if (!s.to.length && !s.cc.length && !s.bcc.length) return setError(t("errors.noRecipients"));
    if ([...s.to, ...s.cc, ...s.bcc].some((r) => !r.valid)) return setError(t("errors.invalidRecipients"));
    if (s.uploads.some((u) => !u.blobId && !u.error)) return setError(t("errors.uploading"));
    if (!s.identityId) return setError(t("errors.noIdentity"));
    setSending(true);
    setError(null);
    finished.current = true;
    await queue.current;
    const r = await sendAction(payload(true), draftId.current).catch(() => null);
    if (r?.ok && r.data.ok) {
      onDone(t("sent"));
      return;
    }
    if (r?.ok && !r.data.ok) draftId.current = r.data.draftId;
    finished.current = false;
    setSending(false);
    setError(t("errors.sendFailed", { reason: r ? (r.ok ? (r.data.ok ? "" : r.data.error) : r.error) : "network" }));
  };

  /* -------------------------------------------------------- attachments */

  const addFiles = (files: FileList | File[]) => {
    let total = state.current.uploads.reduce((n, u) => n + (u.error ? 0 : u.size), 0);
    for (const file of Array.from(files)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const base: Upload = { key, name: file.name, size: file.size, type: file.type || "application/octet-stream", progress: 0 };
      total += file.size;
      if (total > MAX_ATTACHMENT_BYTES) {
        total -= file.size;
        setUploads((u) => [...u, { ...base, error: t("errors.tooLarge") }]);
        continue;
      }
      const xhr = new XMLHttpRequest();
      const patch = (p: Partial<Upload>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));
      xhr.open("POST", `/api/mail/upload?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("Content-Type", base.type);
      xhr.upload.onprogress = (e) => e.lengthComputable && patch({ progress: e.loaded / e.total });
      xhr.onload = () => {
        if (xhr.status === 200) {
          try {
            const r = JSON.parse(xhr.responseText) as { blobId: string; type: string; size: number; name: string };
            patch({ blobId: r.blobId, type: r.type || base.type, size: r.size, name: r.name, progress: 1, xhr: undefined });
            touch();
            return;
          } catch {
            /* fall through */
          }
        }
        patch({ error: xhr.status === 413 ? t("errors.tooLarge") : t("errors.uploadFailed"), xhr: undefined });
      };
      xhr.onerror = () => patch({ error: t("errors.uploadFailed"), xhr: undefined });
      setUploads((u) => [...u, { ...base, xhr }]);
      xhr.send(file);
    }
  };

  const removeUpload = (key: string) => {
    setUploads((list) => {
      list.find((u) => u.key === key)?.xhr?.abort();
      return list.filter((u) => u.key !== key);
    });
    touch();
  };

  /* -------------------------------------------------------- identity */

  const changeIdentity = (id: string) => {
    setIdentityId(id);
    const sigEl = editorRef.current?.querySelector(`[${SIGNATURE_ATTR}]`);
    if (sigEl) {
      const sig = signatureHtml(identities.find((i) => i.id === id));
      sigEl.innerHTML = sig ? `<br>-- <br>${sig}` : "";
    }
    touch();
  };

  /* ------------------------------------------------------------ render */

  const title = subject.trim() || t("newMessage");
  const frame =
    win === "max"
      ? "inset-0 md:inset-x-[8vw] md:inset-y-[6vh]"
      : win === "min"
        ? "bottom-0 right-0 md:right-6 w-full md:w-[320px]"
        : "inset-0 md:inset-auto md:right-6 md:bottom-0 md:h-[min(600px,calc(100dvh-5rem))] md:w-[560px]";
  const radius = win === "max" ? "md:rounded-xl" : "md:rounded-t-xl md:rounded-b-none";
  const uploading = uploads.some((u) => !u.blobId && !u.error);

  return (
    <>
      {win === "max" && <div className="fixed inset-0 z-40 hidden bg-black/40 md:block" onClick={() => setWin("normal")} />}
      <section
        role="dialog"
        aria-label={title}
        className={`fixed z-50 flex flex-col overflow-hidden bg-sheet shadow-[var(--shadow-pop)] ${frame} ${radius}`}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            void send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setWin("min");
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <header
          className="flex h-11 shrink-0 cursor-default items-center gap-1 border-b border-line bg-sheet-muted pr-1.5 pl-4"
          onClick={() => win === "min" && setWin("normal")}
        >
          <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{title}</h2>
          <SaveIndicator state={saveState} />
          <button
            type="button"
            className="icon-btn h-8 w-8"
            aria-label={win === "min" ? t("restore") : t("minimize")}
            title={win === "min" ? t("restore") : t("minimize")}
            onClick={(e) => {
              e.stopPropagation();
              setWin(win === "min" ? "normal" : "min");
            }}
          >
            <Minus size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-btn hidden h-8 w-8 md:inline-grid"
            aria-label={win === "max" ? t("exitFullscreen") : t("fullscreen")}
            title={win === "max" ? t("exitFullscreen") : t("fullscreen")}
            onClick={(e) => {
              e.stopPropagation();
              setWin(win === "max" ? "normal" : "max");
            }}
          >
            {win === "max" ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
          </button>
          <button
            type="button"
            className="icon-btn h-8 w-8"
            aria-label={t("close")}
            title={t("close")}
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className={`min-h-0 flex-1 flex-col ${win === "min" ? "hidden" : "flex"}`}>
          {status === "loading" && (
            <div className="grid flex-1 place-items-center text-ink-mute">
              <Loader2 size={18} className="animate-spin" aria-label={t("loading")} />
            </div>
          )}
          {status === "error" && (
            <div className="grid flex-1 place-items-center p-6 text-center text-[14px] text-ink-soft">
              {t("errors.loadFailed")}
            </div>
          )}
          {status === "ready" && (
            <>
              {identities.length > 0 && (
                <label className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
                  <span className="w-10 shrink-0 text-[13px] text-ink-mute">{t("from")}</span>
                  <select
                    value={identityId}
                    onChange={(e) => changeIdentity(e.target.value)}
                    className="min-w-0 flex-1 truncate bg-transparent text-[14px] text-ink outline-none"
                  >
                    {identities.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name ? `${i.name} <${i.email}>` : i.email}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <RecipientField
                label={t("to")}
                value={to}
                onChange={(v) => {
                  setTo(v);
                  touch();
                }}
                autoFocus={value === "new" || value.startsWith("forward")}
                trailing={
                  <div className="mt-[3px] flex shrink-0 gap-1 text-[13px]">
                    {!showCc && (
                      <button type="button" className="rounded px-1.5 py-0.5 text-ink-mute hover:bg-hover hover:text-ink" onClick={() => setShowCc(true)}>
                        {t("cc")}
                      </button>
                    )}
                    {!showBcc && (
                      <button type="button" className="rounded px-1.5 py-0.5 text-ink-mute hover:bg-hover hover:text-ink" onClick={() => setShowBcc(true)}>
                        {t("bcc")}
                      </button>
                    )}
                  </div>
                }
              />
              {showCc && (
                <RecipientField
                  label={t("cc")}
                  value={cc}
                  onChange={(v) => {
                    setCc(v);
                    touch();
                  }}
                />
              )}
              {showBcc && (
                <RecipientField
                  label={t("bcc")}
                  value={bcc}
                  onChange={(v) => {
                    setBcc(v);
                    touch();
                  }}
                />
              )}
              <input
                type="text"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                  touch();
                }}
                placeholder={t("subject")}
                aria-label={t("subject")}
                maxLength={998}
                className="h-10 shrink-0 border-b border-line bg-transparent px-4 text-[14px] text-ink outline-none placeholder:text-ink-mute focus-visible:outline-none"
              />

              <div className="relative flex min-h-0 flex-1 flex-col">
                <RichEditor editorRef={editorRef} initialHtml={initialHtml} onChange={touch} />
                {dragging && (
                  <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-dashed border-line-strong bg-sheet/90 text-[13px] text-ink-soft">
                    {t("dropFiles")}
                  </div>
                )}
              </div>

              {uploads.length > 0 && (
                <ul className="flex max-h-28 shrink-0 flex-wrap gap-1.5 overflow-y-auto border-t border-line px-4 py-2">
                  {uploads.map((u) => (
                    <li
                      key={u.key}
                      className={`relative flex h-8 max-w-[240px] items-center gap-2 overflow-hidden rounded-md border pr-1 pl-2.5 text-[12.5px] ${
                        u.error ? "border-danger/60 text-danger" : "border-line-strong text-ink"
                      }`}
                      title={u.error ?? u.name}
                    >
                      <Paperclip size={13} aria-hidden className="shrink-0 text-ink-mute" />
                      <span className="min-w-0 truncate">{u.name}</span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-mute">
                        {u.error ? t("failed") : u.blobId ? formatSize(u.size) : `${Math.round(u.progress * 100)}%`}
                      </span>
                      <button
                        type="button"
                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-mute hover:bg-hover hover:text-ink"
                        aria-label={t("removeAttachment", { name: u.name })}
                        onClick={() => removeUpload(u.key)}
                      >
                        <X size={12} aria-hidden />
                      </button>
                      {!u.blobId && !u.error && (
                        <span
                          className="absolute bottom-0 left-0 h-0.5 bg-accent transition-[width]"
                          style={{ width: `${u.progress * 100}%` }}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {error && (
                <p role="alert" className="shrink-0 border-t border-line px-4 py-2 text-[13px] text-danger">
                  {error}
                </p>
              )}

              <footer className="flex h-14 shrink-0 items-center gap-1 border-t border-line px-3">
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sending || uploading}
                  title={t("sendHint")}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors duration-150 hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {sending && <Loader2 size={14} className="animate-spin" aria-hidden />}
                  {sending ? t("sending") : t("send")}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t("attach")}
                  title={t("attach")}
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip size={17} aria-hidden />
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <span className="ml-auto hidden font-mono text-[11px] text-ink-mute sm:inline">
                  <span className="kbd">{modKey}</span> <span className="kbd">↵</span>
                </span>
                <button
                  type="button"
                  className="icon-btn ml-1"
                  aria-label={t("discard")}
                  title={t("discard")}
                  onClick={() => void discard()}
                  disabled={sending}
                >
                  <Trash2 size={17} aria-hidden />
                </button>
              </footer>
            </>
          )}
        </div>
      </section>
    </>
  );
}

function SaveIndicator({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  const t = useTranslations("compose");
  if (state === "idle") return null;
  return (
    <span
      aria-live="polite"
      className={`mr-1 inline-flex items-center gap-1 text-[12px] ${state === "error" ? "text-danger" : "text-ink-mute"}`}
    >
      {state === "saving" && <Loader2 size={12} className="animate-spin" aria-hidden />}
      {state === "saved" && <Check size={12} aria-hidden />}
      {state === "saving" ? t("saving") : state === "saved" ? t("saved") : t("saveFailed")}
    </span>
  );
}
