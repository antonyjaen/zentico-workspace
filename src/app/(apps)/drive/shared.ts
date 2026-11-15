// Client-safe Drive helpers: item shape, file kinds, MIME guessing and formatting.

export type Item = {
  id: string;
  parentId: string | null;
  name: string;
  isFolder: boolean;
  type: string;
  size: number;
  modified: string | null;
};

export type Section = "my" | "recent" | "trash" | "search";
export type ViewMode = "list" | "grid";
export type SortKey = "name" | "modified" | "size";
export const VIEW_COOKIE = "zw_drive_view";

export type Kind =
  | "folder"
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "archive"
  | "code"
  | "other";

const EXT_MIME: Record<string, string> = {
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  zip: "application/zip",
};

export const ext = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/** Best MIME type for a file: the declared one unless it's empty/generic, else by extension. */
export function guessType(name: string, declared?: string | null): string {
  const d = (declared ?? "").toLowerCase();
  if (d && d !== "application/octet-stream") return d;
  return EXT_MIME[ext(name)] ?? "application/octet-stream";
}

const OFFICE = new Set(["odt", "ods", "odp", "docx", "xlsx", "pptx", "doc", "xls", "ppt"]);
const CODE = new Set(["js", "ts", "tsx", "jsx", "py", "go", "rs", "java", "c", "cpp", "h", "sh", "css", "sql", "yml", "yaml", "toml"]);
const TEXT = new Set(["txt", "md", "csv", "log", "json", "xml", "ini", "conf", "html", "htm"]);

export const isOffice = (name: string) => OFFICE.has(ext(name));

export function kindOf(item: { name: string; isFolder: boolean; type: string }): Kind {
  if (item.isFolder) return "folder";
  const e = ext(item.name);
  const t = guessType(item.name, item.type);
  if (["odt", "docx", "doc", "rtf"].includes(e)) return "document";
  if (["ods", "xlsx", "xls"].includes(e)) return "spreadsheet";
  if (["odp", "pptx", "ppt"].includes(e)) return "presentation";
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (["zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz"].includes(e)) return "archive";
  if (CODE.has(e)) return "code";
  if (TEXT.has(e) || t.startsWith("text/") || t === "application/json") return "text";
  return "other";
}

/** Kinds the preview modal can show inline. */
export const PREVIEWABLE = new Set<Kind>(["image", "pdf", "video", "audio", "text", "code"]);

export function formatSize(bytes: number, locale: string): string {
  if (!bytes) return "0 B";
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
  const sameDay = d.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { hour: "2-digit", minute: "2-digit" } : d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(d);
}

export function driveHref(p: { folder?: string | null; section?: Section; q?: string; sort?: SortKey; dir?: "asc" | "desc" }): string {
  const q = new URLSearchParams();
  if (p.section === "recent") q.set("view", "recent");
  if (p.section === "trash") q.set("view", "trash");
  if (p.folder) q.set("folder", p.folder);
  if (p.q) q.set("q", p.q);
  if (p.sort && p.sort !== "name") q.set("sort", p.sort);
  if (p.dir === "desc") q.set("dir", "desc");
  const s = q.toString();
  return s ? `/drive?${s}` : "/drive";
}

export const fileUrl = (id: string, opts: { inline?: boolean; text?: boolean } = {}) =>
  `/api/drive/file/${encodeURIComponent(id)}${opts.text ? "?text=1" : opts.inline ? "?inline=1" : ""}`;

export const docsHref = (id: string) => `/docs/edit/${encodeURIComponent(id)}`;
