// Client-safe Drive helpers: item shape, file kinds, MIME guessing and formatting.
import type { Rights, ShareRole } from "@/lib/drive";
import { nativeKind, openHref } from "@/app/(apps)/docs/shared";

export type { Rights, ShareRole };

export type Item = {
  id: string;
  /** Owning JMAP account; null = the user's own (primary) account. */
  accountId: string | null;
  parentId: string | null;
  name: string;
  isFolder: boolean;
  type: string;
  size: number;
  modified: string | null;
  /** Owner label for items outside My Drive (account name); null = me. */
  owner: string | null;
  rights: Rights;
  shared: boolean;
};

/** "shared" = Shared with me, "spaces" = Shared spaces (team drives). */
export type Section = "my" | "recent" | "trash" | "search" | "shared" | "spaces";
export type ViewMode = "list" | "grid";
export type SortKey = "name" | "modified" | "size";
export const VIEW_COOKIE = "zw_drive_view";
/** Default sort, "<key>.<asc|desc>". */
export const SORT_COOKIE = "zw_drive_sort";
/** "0" hides file extensions in lists. */
export const EXT_COOKIE = "zw_drive_ext";
/** Set once the default folders were offered, so they're never re-created. */
export const INIT_COOKIE = "zw_drive_init";

export type Grant = {
  principalId: string;
  name: string;
  email: string | null;
  type: "individual" | "group" | "unknown";
  role: ShareRole;
};

export type PrincipalOption = { id: string; name: string; email: string | null; type: "individual" | "group" };

export function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
}

/** Name as shown in lists: files lose their extension when extensions are hidden. */
export function displayName(item: { name: string; isFolder: boolean }, showExt: boolean): string {
  if (showExt || item.isFolder) return item.name;
  const dot = item.name.lastIndexOf(".");
  return dot > 0 ? item.name.slice(0, dot) : item.name;
}

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
  | "whiteboard"
  | "markdown"
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
  markdown: "text/markdown",
  excalidraw: "application/vnd.excalidraw+json",
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
  const native = nativeKind(item.name);
  if (native) return native;
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
export const PREVIEWABLE = new Set<Kind>(["image", "pdf", "video", "audio", "text", "code", "markdown"]);

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

export function driveHref(p: {
  folder?: string | null;
  account?: string | null;
  section?: Section;
  q?: string;
  sort?: SortKey;
  dir?: "asc" | "desc";
}): string {
  const q = new URLSearchParams();
  if (p.account) q.set("account", p.account);
  else if (p.section === "recent" || p.section === "trash" || p.section === "shared" || p.section === "spaces") q.set("view", p.section);
  if (p.folder) q.set("folder", p.folder);
  if (p.q) q.set("q", p.q);
  if (p.sort && p.sort !== "name") q.set("sort", p.sort);
  if (p.dir === "desc") q.set("dir", "desc");
  const s = q.toString();
  return s ? `/drive?${s}` : "/drive";
}

export function fileUrl(id: string, opts: { inline?: boolean; text?: boolean; account?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (opts.text) q.set("text", "1");
  else if (opts.inline) q.set("inline", "1");
  if (opts.account) q.set("account", opts.account);
  const s = q.toString();
  return `/api/drive/file/${encodeURIComponent(id)}${s ? `?${s}` : ""}`;
}

export const docsHref = (id: string) => `/docs/edit/${encodeURIComponent(id)}`;

/**
 * Built-in Docs editor (whiteboard / Markdown) for a file, or null. Docs only opens files from
 * the user's own drive, so shared files keep the regular preview.
 */
export function nativeEditorHref(item: { id: string; name: string; isFolder: boolean; accountId: string | null }): string | null {
  if (item.isFolder || item.accountId || !nativeKind(item.name)) return null;
  return openHref(item.id, item.name, "drive");
}
