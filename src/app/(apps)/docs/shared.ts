// Client-safe Docs helpers: kinds, new-file presets, upload accept list and name handling.

export type DocKind = "text" | "spreadsheet" | "presentation";
export const DOC_KINDS: DocKind[] = ["text", "spreadsheet", "presentation"];

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
] as const satisfies readonly { id: string; kind: DocKind }[];

export type PresetId = (typeof PRESETS)[number]["id"];

/** Office files the Upload button accepts (Collabora opens all of them). */
export const UPLOAD_EXTS = ["docx", "xlsx", "pptx", "odt", "ods", "odp", "doc", "xls", "ppt", "rtf", "csv", "txt", "md"];
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
