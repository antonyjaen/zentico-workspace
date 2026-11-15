"use client";

import { Bold, Italic, Link2, List, RemoveFormatting, Underline } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

/**
 * Minimal contentEditable rich-text editor (no deps). The initial HTML must already be
 * sanitized; the server sanitizes again on save. Pastes are inserted as plain text.
 */
export function RichEditor({
  initialHtml,
  onChange,
  label,
  minHeight = 120,
}: {
  initialHtml: string;
  onChange: (html: string, text: string) => void;
  label: string;
  minHeight?: number;
}) {
  const t = useTranslations("mailSettings.editor");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.innerHTML = initialHtml;
    // Only on mount: the editor owns its DOM afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    const empty = !el.textContent?.trim() && !el.querySelector("img");
    onChange(empty ? "" : el.innerHTML, empty ? "" : el.innerText);
  };

  const exec = (cmd: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, value);
    emit();
  };

  const tools = [
    { icon: Bold, label: t("bold"), run: () => exec("bold") },
    { icon: Italic, label: t("italic"), run: () => exec("italic") },
    { icon: Underline, label: t("underline"), run: () => exec("underline") },
    { icon: List, label: t("list"), run: () => exec("insertUnorderedList") },
    {
      icon: Link2,
      label: t("link"),
      run: () => {
        const url = window.prompt(t("linkPrompt"), "https://");
        if (url && /^(https?:\/\/|mailto:)/i.test(url.trim())) exec("createLink", url.trim());
      },
    },
    { icon: RemoveFormatting, label: t("clear"), run: () => exec("removeFormat") },
  ];

  return (
    <div className="overflow-hidden rounded-md border border-line-strong focus-within:border-ink">
      <div role="toolbar" aria-label={label} className="flex items-center gap-0.5 border-b border-line bg-sheet-muted px-1 py-1">
        {tools.map(({ icon: Icon, label: l, run }) => (
          <button
            key={l}
            type="button"
            title={l}
            aria-label={l}
            onMouseDown={(e) => e.preventDefault()}
            onClick={run}
            className="icon-btn h-7 w-7"
          >
            <Icon size={15} aria-hidden />
          </button>
        ))}
      </div>
      <div
        ref={ref}
        role="textbox"
        aria-multiline
        aria-label={label}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
          emit();
        }}
        style={{ minHeight }}
        className="max-h-[360px] overflow-y-auto bg-sheet px-3 py-2 text-[14px] leading-relaxed text-ink outline-none [&_a]:text-accent [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
      />
    </div>
  );
}
