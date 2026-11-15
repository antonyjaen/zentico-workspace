// Client-safe Docs helpers: kinds, new-file presets, upload accept list and name handling.

/** Office kinds open in Collabora; whiteboards and Markdown have their own built-in editors. */
export type OfficeKind = "text" | "spreadsheet" | "presentation";
export type NativeKind = "whiteboard" | "markdown";
export type DocKind = OfficeKind | NativeKind;
export const DOC_KINDS: DocKind[] = ["text", "spreadsheet", "presentation", "whiteboard", "markdown"];

/** Built-in editors: file extensions, stored media type and the empty file a new one starts as. */
export const NATIVE: Record<NativeKind, { exts: string[]; ext: string; mediaType: string; route: string; blank: string }> = {
  whiteboard: {
    exts: ["excalidraw"],
    ext: "excalidraw",
    mediaType: "application/vnd.excalidraw+json",
    route: "draw",
    blank: JSON.stringify({ type: "excalidraw", version: 2, source: "zentico-workspace", elements: [], appState: {}, files: {} }),
  },
  markdown: { exts: ["md", "markdown"], ext: "md", mediaType: "text/markdown", route: "md", blank: "" },
};

/** Largest whiteboard / Markdown file the built-in editors load and save. */
export const MAX_NATIVE_BYTES = 10 * 1024 * 1024;

export function nativeKind(name: string): NativeKind | null {
  const e = extOf(name);
  if (!e) return null;
  for (const k of Object.keys(NATIVE) as NativeKind[]) if (NATIVE[k].exts.includes(e)) return k;
  return null;
}

export const isNativeKind = (k: DocKind): k is NativeKind => k === "whiteboard" || k === "markdown";

export type DocItem = {
  id: string;
  name: string;
  kind: DocKind;
  /** Drive folder holding the file; null = My Drive root. */
  folderId: string | null;
  /** Folder path ("Projects / 2026"); null = My Drive root. */
  location: string | null;
  modified: string | null;
  size: number;
};

export type ViewMode = "list" | "grid";
export const VIEW_COOKIE = "zw_docs_view";

/** Markdown editor layout: source only, side by side, or rendered only. */
export type MdView = "edit" | "split" | "preview";
export const MD_VIEW_COOKIE = "zw_md_view";

/**
 * "Start a new document" tiles. Templates are honest name presets: every new file starts as an
 * empty ODF file that Collabora opens as a blank document of that kind.
 */
export const PRESETS = [
  { id: "blankText", kind: "text" },
  { id: "blankSpreadsheet", kind: "spreadsheet" },
  { id: "blankPresentation", kind: "presentation" },
  { id: "meetingNotes", kind: "text" },
  { id: "projectPlan", kind: "text" },
  { id: "budget", kind: "spreadsheet" },
  { id: "pitchDeck", kind: "presentation" },
  { id: "blankWhiteboard", kind: "whiteboard" },
  { id: "blankMarkdown", kind: "markdown" },
] as const satisfies readonly { id: string; kind: DocKind }[];

export type PresetId = (typeof PRESETS)[number]["id"];

/** Office files the Upload button accepts (Collabora opens all of them). */
export const UPLOAD_EXTS = ["docx", "xlsx", "pptx", "odt", "ods", "odp", "doc", "xls", "ppt", "rtf", "csv", "txt", "md", "markdown", "excalidraw"];
export const UPLOAD_ACCEPT = UPLOAD_EXTS.map((e) => `.${e}`).join(",");
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/** "Report.final.docx" → ["Report.final", "docx"]. */
export function splitName(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i + 1)] : [name, ""];
}

/** Case- and accent-insensitive form for local substring search. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export const editHref = (id: string) => `/docs/edit/${encodeURIComponent(id)}`;

/** Editor for a file: Collabora for office files, the built-in editors for whiteboards / Markdown. */
export function openHref(id: string, kindOrName: DocKind | string, from?: "drive"): string {
  const k = DOC_KINDS.includes(kindOrName as DocKind) ? (kindOrName as DocKind) : nativeKind(kindOrName);
  const base = k && isNativeKind(k) ? `/docs/${NATIVE[k].route}/${encodeURIComponent(id)}` : editHref(id);
  return from ? `${base}?from=${from}` : base;
}
export const downloadHref = (id: string) => `/api/drive/file/${encodeURIComponent(id)}`;
export const folderHref = (folderId: string | null) =>
  folderId ? `/drive?folder=${encodeURIComponent(folderId)}` : "/drive";

export function formatSize(bytes: number, locale: string): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v)} ${units[i]}`;
}

export function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions =
    d.toDateString() === now.toDateString()
      ? { hour: "2-digit", minute: "2-digit" }
      : d.getFullYear() === now.getFullYear()
        ? { day: "numeric", month: "short" }
        : { day: "numeric", month: "short", year: "numeric" };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}
