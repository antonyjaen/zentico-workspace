import { initials as initialsOf } from "@/app/(apps)/contacts/hrefs";
// Small formatting helpers shared by the thread reader's client components.

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Deterministic two-hue gradient per sender (same recipe as the account avatar). */
export function avatarGradient(seed: string) {
  let h = 0;
  for (const ch of seed.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 80)) % 360;
  return `linear-gradient(135deg, oklch(0.72 0.16 ${a}), oklch(0.62 0.18 ${b}))`;
}

/** One or two letters for an avatar: "Ada Lovelace" → "AL", "Ana (x.dev)" → "A", "ops@x.io" → "O". */
export function initials(name: string | null, email: string) {
  return initialsOf(name?.trim() ? name : email.split("@")[0]);
}


/** "3:02 PM" today, "Nov 14, 3:02 PM" this year, "Nov 14, 2024" before. */
export function formatShort(d: Date, locale: string) {
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(d);
  if (d.getFullYear() === now.getFullYear())
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);
}

export function formatFull(d: Date, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(d);
}

/** "2 hours ago", "yesterday", "3 days ago"; null beyond ~4 weeks (the absolute date says enough). */
export function formatRelative(d: Date, locale: string): string | null {
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 28) return rtf.format(Math.round(diff / 86400), "day");
  return null;
}

export type FileKind = "image" | "pdf" | "video" | "audio" | "archive" | "spreadsheet" | "presentation" | "document" | "code" | "text" | "calendar" | "other";

export function fileKind(name: string, type: string): FileKind {
  const t = type.toLowerCase();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (t.startsWith("image/")) return "image";
  if (t === "application/pdf" || ext === "pdf") return "pdf";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "text/calendar" || ext === "ics") return "calendar";
  if (/zip|compressed|x-tar|gzip|x-7z|rar/.test(t) || ["zip", "rar", "7z", "gz", "tgz", "tar"].includes(ext)) return "archive";
  if (/spreadsheet|excel|csv/.test(t) || ["xls", "xlsx", "ods", "csv"].includes(ext)) return "spreadsheet";
  if (/presentation|powerpoint/.test(t) || ["ppt", "pptx", "odp", "key"].includes(ext)) return "presentation";
  if (/msword|wordprocessing|opendocument\.text|rtf/.test(t) || ["doc", "docx", "odt", "rtf", "pages"].includes(ext)) return "document";
  if (/json|xml|javascript|x-sh|x-python/.test(t) || ["json", "xml", "js", "ts", "py", "sh", "html", "css"].includes(ext)) return "code";
  if (t.startsWith("text/")) return "text";
  return "other";
}
