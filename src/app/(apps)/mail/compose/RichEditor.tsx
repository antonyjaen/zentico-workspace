"use client";

import { Bold, Italic, Link2, List, ListOrdered, Underline, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { escapeHtml, safeHref, sanitizeHtml } from "./sanitize";

type Command = "bold" | "italic" | "underline" | "insertUnorderedList" | "insertOrderedList";

const TOOLS: { cmd: Command | "link"; icon: LucideIcon; label: string }[] = [
  { cmd: "bold", icon: Bold, label: "bold" },
  { cmd: "italic", icon: Italic, label: "italic" },
  { cmd: "underline", icon: Underline, label: "underline" },
  { cmd: "link", icon: Link2, label: "link" },
  { cmd: "insertUnorderedList", icon: List, label: "bulleted" },
  { cmd: "insertOrderedList", icon: ListOrdered, label: "numbered" },
];

// document.execCommand is deprecated but remains the only dependency-free rich-text primitive.
const exec = (cmd: string, value?: string) => document.execCommand(cmd, false, value);

/** Minimal rich-text editor over contentEditable. The caller reads HTML through `editorRef`. */
export function RichEditor({
  editorRef,
  initialHtml,
  onChange,
}: {
  editorRef: RefObject<HTMLDivElement | null>;
  /** Already-sanitized HTML. */
  initialHtml: string;
  onChange: () => void;
}) {
  const t = useTranslations("compose.toolbar");
  const [active, setActive] = useState<Record<string, boolean>>({});

  useLayoutEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = initialHtml;
    // Initial content only: the editor is uncontrolled afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const update = () => {
      const el = editorRef.current;
      const sel = document.getSelection();
      if (!el || !sel?.anchorNode || !el.contains(sel.anchorNode)) return;
      const next: Record<string, boolean> = {};
      for (const tool of TOOLS) if (tool.cmd !== "link") next[tool.cmd] = document.queryCommandState(tool.cmd);
      setActive(next);
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [editorRef]);

  const addLink = () => {
    const raw = window.prompt(t("linkPrompt"), "https://")?.trim();
    if (!raw) return;
    const href = safeHref(/^[a-z]+:/i.test(raw) ? raw : `https://${raw}`);
    if (!href) {
      window.alert(t("invalidLink"));
      return;
    }
    editorRef.current?.focus();
    const sel = document.getSelection();
    if (sel?.isCollapsed) exec("insertHTML", `<a href="${escapeHtml(href)}">${escapeHtml(raw)}</a>`);
    else exec("createLink", href);
    onChange();
  };

  const run = (cmd: Command | "link") => {
    if (cmd === "link") return addLink();
    editorRef.current?.focus();
    exec(cmd);
    onChange();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={t("body")}
        onInput={onChange}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            addLink();
          }
        }}
        onPaste={(e) => {
          // Never let raw clipboard HTML in: sanitize it first.
          e.preventDefault();
          const html = e.clipboardData.getData("text/html");
          if (html) exec("insertHTML", sanitizeHtml(html));
          else exec("insertText", e.clipboardData.getData("text/plain"));
          onChange();
        }}
        onDrop={(e) => {
          // Files bubble up to the panel; other drops are inserted as plain text only.
          if (e.dataTransfer.files.length) return;
          e.preventDefault();
          const text = e.dataTransfer.getData("text/plain");
          if (text) {
            exec("insertText", text);
            onChange();
          }
        }}
        className="min-h-[160px] flex-1 overflow-y-auto px-4 py-3 text-[14px] leading-relaxed text-ink outline-none focus-visible:outline-none [&_a]:text-accent [&_a]:underline [&_blockquote]:my-2 [&_blockquote]:border-l [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-ink-soft [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:whitespace-pre-wrap [&_ul]:list-disc [&_ul]:pl-6"
      />
      <div
        role="toolbar"
        aria-label={t("label")}
        className="flex shrink-0 items-center gap-0.5 border-t border-line px-2 py-1"
      >
        {TOOLS.map(({ cmd, icon: Icon, label }) => (
          <button
            key={cmd}
            type="button"
            className="icon-btn h-8 w-8 aria-pressed:bg-primary-soft aria-pressed:text-ink"
            aria-label={t(label)}
            title={t(label)}
            aria-pressed={cmd === "link" ? undefined : !!active[cmd]}
            onMouseDown={(e) => e.preventDefault()} // keep the editor selection
            onClick={() => run(cmd)}
          >
            <Icon size={16} aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}
