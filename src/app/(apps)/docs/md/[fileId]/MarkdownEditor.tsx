"use client";

import {
  Bold,
  Code,
  Columns2,
  Eye,
  FileCode,
  Heading,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  Pencil,
  Quote,
  Table,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { countWords, renderMarkdown } from "./markdown";
import { NativeShell, useDocSaver } from "../../NativeShell";
import type { NativeDoc } from "../../native";
import { MD_VIEW_COOKIE, type MdView } from "../../shared";
import { Notice } from "../../ui";

const VIEWS: { id: MdView; icon: LucideIcon }[] = [
  { id: "edit", icon: Pencil },
  { id: "split", icon: Columns2 },
  { id: "preview", icon: Eye },
];

type Tool = "bold" | "italic" | "heading" | "link" | "list" | "checklist" | "code" | "quote" | "table";
const TOOLS: { id: Tool; icon: LucideIcon; keys?: string }[] = [
  { id: "bold", icon: Bold, keys: "B" },
  { id: "italic", icon: Italic, keys: "I" },
  { id: "heading", icon: Heading },
  { id: "link", icon: LinkIcon, keys: "K" },
  { id: "list", icon: List },
  { id: "checklist", icon: ListChecks },
  { id: "code", icon: Code },
  { id: "quote", icon: Quote },
  { id: "table", icon: Table },
];

/** Replaces [start, end) keeping the browser's undo history when possible. */
function insert(el: HTMLTextAreaElement, start: number, end: number, text: string, select?: [number, number]) {
  el.focus();
  el.setSelectionRange(start, end);
  // execCommand keeps Ctrl+Z working; it's deprecated but still the only way to do that.
  const ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
  if (!ok) {
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (select) el.setSelectionRange(select[0], select[1]);
}

function wrap(el: HTMLTextAreaElement, before: string, after: string, placeholder: string) {
  const { selectionStart: a, selectionEnd: b, value } = el;
  const sel = value.slice(a, b);
  // Toggle off when the selection is already wrapped.
  if (sel && value.slice(a - before.length, a) === before && value.slice(b, b + after.length) === after) {
    insert(el, a - before.length, b + after.length, sel, [a - before.length, b - before.length]);
    return;
  }
  const body = sel || placeholder;
  insert(el, a, b, before + body + after, [a + before.length, a + before.length + body.length]);
}

/** Adds (or, when every line already has it, removes) a prefix on each selected line. */
function prefixLines(el: HTMLTextAreaElement, prefix: string, strip: RegExp) {
  const { selectionStart: a, selectionEnd: b, value } = el;
  const start = value.lastIndexOf("\n", a - 1) + 1;
  const nl = value.indexOf("\n", b > a && value[b - 1] === "\n" ? b - 1 : b);
  const end = nl === -1 ? value.length : nl;
  const lines = value.slice(start, end).split("\n");
  const all = lines.every((l) => l.startsWith(prefix));
  const next = lines.map((l) => (all ? l.slice(prefix.length) : prefix + l.replace(strip, ""))).join("\n");
  insert(el, start, end, next, [start, start + next.length]);
}

function applyTool(el: HTMLTextAreaElement, tool: Tool, t: (k: string) => string) {
  const { selectionStart: a, selectionEnd: b, value } = el;
  switch (tool) {
    case "bold":
      return wrap(el, "**", "**", t("md.placeholder.bold"));
    case "italic":
      return wrap(el, "_", "_", t("md.placeholder.italic"));
    case "heading":
      return prefixLines(el, "## ", /^#{1,6}\s+/);
    case "list":
      return prefixLines(el, "- ", /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/);
    case "checklist":
      return prefixLines(el, "- [ ] ", /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/);
    case "quote":
      return prefixLines(el, "> ", /^>\s?/);
    case "code": {
      const sel = value.slice(a, b);
      if (sel.includes("\n")) {
        const lead = a > 0 && value[a - 1] !== "\n" ? "\n" : "";
        const block = `${lead}\`\`\`\n${sel.replace(/\n$/, "")}\n\`\`\`\n`;
        return insert(el, a, b, block, [a + lead.length + 4, a + lead.length + 4 + sel.replace(/\n$/, "").length]);
      }
      return wrap(el, "`", "`", t("md.placeholder.code"));
    }
    case "link": {
      const sel = value.slice(a, b) || t("md.placeholder.link");
      const text = `[${sel}](https://)`;
      const urlAt = a + sel.length + 3;
      return insert(el, a, b, text, [urlAt, urlAt + "https://".length]);
    }
    case "table": {
      const lead = a > 0 && value[a - 1] !== "\n" ? "\n\n" : a > 1 && value[a - 2] !== "\n" ? "\n" : "";
      const c1 = t("md.placeholder.column");
      const snippet = `${lead}| ${c1} 1 | ${c1} 2 |\n| --- | --- |\n|  |  |\n`;
      return insert(el, b, b, snippet, [b + lead.length + 2, b + lead.length + 2 + c1.length + 2]);
    }
  }
}

export function MarkdownEditor({
  doc,
  back,
  notice,
  initialView,
}: {
  doc: NativeDoc | null;
  back: { href: string; label: string };
  notice?: { title: string; hint?: string };
  initialView: MdView;
}) {
  const t = useTranslations("docs");
  const readOnly = !doc || doc.readOnly;
  const [text, setText] = useState(doc?.content ?? "");
  const [view, setView] = useState<MdView>(readOnly ? "preview" : initialView);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef(text);
  const area = useRef<HTMLTextAreaElement>(null);
  textRef.current = text;

  const errText = useCallback(
    (code: string) =>
      code === "too_large" ? t("nativeTooLarge") : t.has(`errors.${code}`) ? t(`errors.${code}` as "errors.failed") : t("errors.failed"),
    [t],
  );
  const saver = useDocSaver({
    fileId: doc?.id ?? "",
    readOnly,
    getBody: () => textRef.current,
    onError: (code) => setError(errText(code)),
  });

  const deferred = useDeferredValue(text);
  const preview = useMemo(() => renderMarkdown(deferred), [deferred]);
  const words = useMemo(() => countWords(deferred), [deferred]);

  const pickView = (v: MdView) => {
    setView(v);
    document.cookie = `${MD_VIEW_COOKIE}=${v}; path=/; max-age=31536000; samesite=lax`;
  };

  const tool = (id: Tool) => {
    const el = area.current;
    if (!el || readOnly) return;
    applyTool(el, id, (k) => t(k as "md.placeholder.bold"));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    const id: Tool | null = k === "b" ? "bold" : k === "i" ? "italic" : k === "k" ? "link" : null;
    if (!id) return;
    e.preventDefault();
    tool(id);
  };

  const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

  const viewSwitch = (
    <div className="flex shrink-0 items-center rounded-md border border-line p-0.5" role="radiogroup" aria-label={t("md.view")}>
      {VIEWS.map(({ id, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={view === id}
          disabled={readOnly && id !== "preview"}
          onClick={() => pickView(id)}
          className="inline-flex h-7 items-center gap-1.5 rounded px-2 text-[12.5px] text-ink-mute transition-colors hover:text-ink disabled:opacity-40 aria-checked:bg-hover aria-checked:font-medium aria-checked:text-ink"
          title={t(`md.views.${id}`)}
        >
          <Icon size={14} aria-hidden />
          <span className="hidden lg:inline">{t(`md.views.${id}`)}</span>
        </button>
      ))}
    </div>
  );

  const showEditor = !readOnly && view !== "preview";
  const showPreview = view !== "edit" || readOnly;

  return (
    <NativeShell
      file={doc ? { id: doc.id, name: doc.name } : null}
      kind="markdown"
      folderId={doc?.folderId ?? null}
      back={back}
      readOnly={readOnly}
      status={doc && !readOnly ? saver.status : null}
      error={error}
      onError={setError}
      onSave={() => void saver.saveNow()}
      tools={doc ? viewSwitch : undefined}
      access={doc?.access}
    >
      {notice || !doc ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Notice icon={FileCode} title={notice?.title ?? t("notFound")} hint={notice?.hint} />
        </div>
      ) : (
        <>
          {!readOnly && (
            <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-2" role="toolbar" aria-label={t("md.toolbar")}>
              {TOOLS.map(({ id, icon: Icon, keys }) => (
                <button
                  key={id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => tool(id)}
                  disabled={view === "preview"}
                  className="icon-btn h-8 w-8 shrink-0 disabled:opacity-40"
                  aria-label={t(`md.tools.${id}`)}
                  title={keys ? `${t(`md.tools.${id}`)} (${mod}${keys})` : t(`md.tools.${id}`)}
                >
                  <Icon size={16} aria-hidden />
                </button>
              ))}
              <span className="flex-1" />
              <span className="shrink-0 px-2 font-mono text-[11.5px] tabular-nums text-ink-mute" aria-live="off">
                {t("md.words", { count: words })}
              </span>
            </div>
          )}
          <div
            className={`grid min-h-0 flex-1 ${showEditor && showPreview ? "grid-rows-2 md:grid-cols-2 md:grid-rows-1" : "grid-cols-1"}`}
          >
            {showEditor && (
              <textarea
                ref={area}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  saver.markDirty();
                }}
                onKeyDown={onKeyDown}
                spellCheck
                autoFocus
                aria-label={t("md.editorLabel")}
                placeholder={t("md.empty")}
                className={`min-h-0 w-full resize-none bg-sheet p-5 font-mono text-[13.5px] leading-relaxed text-ink placeholder:text-ink-mute focus:outline-none ${
                  showPreview ? "border-b border-line md:border-r md:border-b-0" : ""
                }`}
              />
            )}
            {showPreview && (
              <div className="min-h-0 overflow-y-auto bg-sheet" aria-label={t("md.previewLabel")} role="region">
                <article className="mx-auto max-w-3xl px-6 py-5 text-[15px] leading-relaxed break-words text-ink-soft">
                  {deferred.trim() ? preview : <p className="text-ink-mute">{t("md.emptyPreview")}</p>}
                </article>
              </div>
            )}
          </div>
        </>
      )}
    </NativeShell>
  );
}
