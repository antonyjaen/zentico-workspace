"use client";

import { FileText, HardDrive, Loader2, Paperclip, SendHorizontal, Upload, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { usePopover } from "@/components/usePopover";
import { sendMessage } from "./actions";
import { DrivePickerDialog } from "./DrivePicker";
import { BODY_MAX, FILE_MAX_BYTES, formatSize, isPreviewableImage, type ChatMessage, type ChatUser } from "./shared";
import { Avatar, fold, useErrorText } from "./ui";

const TYPING_EVERY_MS = 3000;
const MAX_FILES = 10;

type Props = {
  conversationId: string;
  threadRoot: number | null;
  me: ChatUser;
  members: ChatUser[];
  placeholder: string;
  onSent: (m: ChatMessage) => void;
  /** Lets the conversation hand dropped files to the composer. */
  addFilesRef?: MutableRefObject<((files: File[]) => void) | null>;
  autoFocus?: boolean;
};

const handleOf = (u: ChatUser) => u.email.split("@")[0].toLowerCase();

export function Composer({ conversationId, threadRoot, me, members, placeholder, onSent, addFilesRef, autoFocus = true }: Props) {
  const t = useTranslations("chat");
  const errorText = useErrorText();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const attachMenu = usePopover();
  const [drivePicker, setDrivePicker] = useState(false);

  const addFiles = (list: File[]) => {
    setError(null);
    const tooBig = list.find((f) => f.size > FILE_MAX_BYTES);
    if (tooBig) setError(t("errors.fileTooLarge", { name: tooBig.name }));
    setFiles((prev) => [...prev, ...list.filter((f) => f.size <= FILE_MAX_BYTES)].slice(0, MAX_FILES));
    ref.current?.focus();
  };
  useEffect(() => {
    if (!addFilesRef) return;
    addFilesRef.current = addFiles;
    return () => {
      addFilesRef.current = null;
    };
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus && window.matchMedia("(pointer: fine)").matches) ref.current?.focus();
  }, [autoFocus, conversationId, threadRoot]);

  const suggestions = useMemo(() => {
    if (!mention) return [];
    const q = fold(mention.query);
    return members
      .filter((m) => m.id !== me.id && (handleOf(m).startsWith(q) || fold(m.name).includes(q)))
      .slice(0, 6);
  }, [mention, members, me.id]);

  const pingTyping = () => {
    const now = Date.now();
    if (now - lastTyping.current < TYPING_EVERY_MS) return;
    lastTyping.current = now;
    void fetch("/api/chat/typing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, threadRoot }),
    }).catch(() => {});
  };

  const updateMention = (value: string, caret: number) => {
    const m = /(^|\s)@([a-z0-9._-]{0,40})$/i.exec(value.slice(0, caret));
    setMention(m ? { query: m[2], start: caret - m[2].length - 1 } : null);
    setMentionIndex(0);
  };

  const pickMention = (u: ChatUser) => {
    if (!mention || !ref.current) return;
    const caret = ref.current.selectionStart;
    const insert = `@${handleOf(u)} `;
    const next = text.slice(0, mention.start) + insert + text.slice(caret);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = mention.start + insert.length;
      ref.current?.setSelectionRange(pos, pos);
      ref.current?.focus();
    });
  };

  const send = async () => {
    const body = text.trim();
    if (sending || (!body && files.length === 0)) return;
    if (body.length > BODY_MAX) return setError(errorText("tooLong"));
    setSending(true);
    setError(null);
    const pending = files;
    setText("");
    setFiles([]);
    lastTyping.current = 0;
    try {
      if (pending.length) {
        const form = new FormData();
        form.set("conversationId", conversationId);
        if (body) form.set("text", body);
        if (threadRoot !== null) form.set("threadRoot", String(threadRoot));
        for (const f of pending) form.append("file", f, f.name);
        const res = await fetch("/api/chat/upload", { method: "POST", body: form });
        const json = (await res.json().catch(() => ({}))) as { message?: ChatMessage; error?: string };
        if (!res.ok || !json.message) throw new Error(json.error ?? "failed");
        onSent(json.message);
      } else {
        const r = await sendMessage(conversationId, body, threadRoot);
        if (!r.ok) throw new Error(r.error);
        onSent(r.data);
      }
    } catch (e) {
      setText(body);
      setFiles(pending);
      setError(errorText(e instanceof Error ? e.message : "failed"));
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  return (
    <div className="shrink-0 px-3 pt-1 pb-3 md:px-4">
      {error && (
        <p role="alert" className="mb-1.5 px-1 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <div className="relative rounded-lg border border-line-strong bg-sheet transition-colors focus-within:border-ink-mute">
        {suggestions.length > 0 && (
          <ul role="listbox" className="pop absolute bottom-full left-2 z-20 mb-1 w-64 p-1">
            {suggestions.map((u, i) => (
              <li key={u.id} role="option" aria-selected={i === mentionIndex}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickMention(u)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${i === mentionIndex ? "bg-hover" : "hover:bg-hover"}`}
                >
                  <Avatar name={u.name} email={u.email} size={22} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{u.name}</span>
                  <span className="shrink-0 text-[11.5px] text-ink-mute">@{handleOf(u)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {files.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 border-b border-line p-2">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex max-w-[220px] items-center gap-2 rounded-md border border-line bg-sheet-muted py-1 pr-1 pl-2">
                {isPreviewableImage(f.type) ? <ImageThumb file={f} /> : <FileText size={16} className="shrink-0 text-ink-mute" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-ink">{f.name}</span>
                  <span className="block text-[11px] text-ink-mute">{formatSize(f.size)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="icon-btn h-6 w-6"
                  aria-label={t("removeFile", { name: f.name })}
                >
                  <X size={13} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-end gap-1 p-1.5">
          <div ref={attachMenu.ref} className="relative">
            <button
              type="button"
              onClick={attachMenu.toggle}
              className="icon-btn h-8 w-8"
              aria-label={t("attach")}
              title={t("attach")}
              aria-haspopup="menu"
              aria-expanded={attachMenu.open}
            >
              <Paperclip size={17} aria-hidden />
            </button>
            {attachMenu.open && (
              <div role="menu" className="pop absolute bottom-full left-0 z-20 mb-1.5 w-56 p-1">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    attachMenu.setOpen(false);
                    fileInput.current?.click();
                  }}
                  className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13.5px] text-ink-soft hover:bg-hover hover:text-ink"
                >
                  <Upload size={15} aria-hidden />
                  {t("drive.uploadFromComputer")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    attachMenu.setOpen(false);
                    setDrivePicker(true);
                  }}
                  className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13.5px] text-ink-soft hover:bg-hover hover:text-ink"
                >
                  <HardDrive size={15} aria-hidden style={{ color: "var(--color-app-drive)" }} />
                  {t("drive.chooseFromDrive")}
                </button>
              </div>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <textarea
            ref={ref}
            value={text}
            rows={1}
            maxLength={BODY_MAX}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => {
              setText(e.target.value);
              updateMention(e.target.value, e.target.selectionStart);
              if (e.target.value.trim()) pingTyping();
            }}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files);
              if (pasted.length) {
                e.preventDefault();
                addFiles(pasted);
              }
            }}
            onKeyDown={(e) => {
              if (suggestions.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  setMentionIndex((i) => (i + d + suggestions.length) % suggestions.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickMention(suggestions[mentionIndex]);
                  return;
                }
                if (e.key === "Escape") {
                  setMention(null);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            className="max-h-[200px] min-h-8 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[14px] leading-[1.45] text-ink outline-none placeholder:text-ink-mute"
          />
          <button
            type="button"
            onClick={send}
            disabled={sending || (!text.trim() && files.length === 0)}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary text-primary-ink transition-colors hover:bg-primary-hover disabled:bg-transparent disabled:text-ink-mute"
            aria-label={t("send")}
            title={t("send")}
          >
            {sending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <SendHorizontal size={16} aria-hidden />}
          </button>
        </div>
      </div>
      <p className="mt-1 hidden px-1 text-[11px] text-ink-mute md:block">{t("composerHint")}</p>
      {drivePicker && (
        <DrivePickerDialog
          conversationId={conversationId}
          threadRoot={threadRoot}
          text={text.trim()}
          onClose={() => {
            setDrivePicker(false);
            ref.current?.focus();
          }}
          onSent={(messages) => {
            if (text.trim()) setText("");
            for (const m of messages) onSent(m);
          }}
        />
      )}
    </div>
  );
}

function ImageThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" className="h-8 w-8 shrink-0 rounded object-cover" /> : null;
}
