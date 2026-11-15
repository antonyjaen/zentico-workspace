// Turning files into text for MCP clients: text-like files are decoded, HTML is flattened, and
// office documents go through Collabora's convert-to (when COLLABORA_URL is set).
import { convertWithCollabora, docKind } from "../wopi";
import { htmlToText } from "./text";

const TEXT_EXTS = new Set([
  "md", "markdown", "txt", "json", "csv", "tsv", "log", "yaml", "yml", "xml", "html", "htm", "ics", "vcf", "ini",
  "toml", "srt", "vtt", "excalidraw", "css", "js", "ts", "py", "sql", "sh", "eml",
]);

export const extOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

/** Text-like by extension or media type (Markdown, CSV, JSON, HTML, Excalidraw scenes…). */
export const isTextLike = (name: string, type: string) =>
  TEXT_EXTS.has(extOf(name)) ||
  /^text\//i.test(type) ||
  /(^application\/(json|xml|x-yaml|yaml|javascript|sql)$)|\+(json|xml)$/i.test(type);

const isHtml = (name: string, type: string) => /^html?$/.test(extOf(name)) || /^text\/html/i.test(type);

/** Office document (Writer, Calc, Impress formats; plain .txt/.csv excluded) that Collabora can read. */
export const isOffice = (name: string) => {
  const ext = extOf(name);
  return ext !== "txt" && ext !== "csv" && (!!docKind(name) || ext === "pdf");
};

export type Extracted =
  | { ok: true; text: string; truncated: boolean; via?: "html" | "collabora" }
  | { ok: false; binary: true; reason: string };

const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

function clip(text: string, maxChars: number, truncated: boolean): { text: string; truncated: boolean } {
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated };
}

/**
 * Readable text of a file. `partial` = the bytes were cut short (only the start was read), which
 * office conversion can't work with. HTML is returned as text unless `rawHtml`.
 */
export async function extractText(
  bytes: Uint8Array,
  name: string,
  type: string,
  { maxChars, partial = false, rawHtml = false }: { maxChars: number; partial?: boolean; rawHtml?: boolean },
): Promise<Extracted> {
  if (isTextLike(name, type)) {
    const text = decode(bytes);
    if (isHtml(name, type) && !rawHtml) return { ok: true, ...clip(htmlToText(text), maxChars, partial), via: "html" };
    return { ok: true, ...clip(text, maxChars, partial) };
  }
  if (!isOffice(name)) return { ok: false, binary: true, reason: `binary file (${type || "unknown type"})` };
  if (partial) return { ok: false, binary: true, reason: "file too large to convert to text" };
  // Spreadsheets convert better to CSV; Writer/Impress/PDF to plain text.
  const format = docKind(name) === "spreadsheet" ? "csv" : "txt";
  let out: ArrayBuffer | null;
  try {
    out = await convertWithCollabora(bytes, name, format);
  } catch (e) {
    console.error("[mcp] collabora convert-to:", e instanceof Error ? e.message : e);
    return { ok: false, binary: true, reason: "office document (text conversion failed)" };
  }
  if (!out) return { ok: false, binary: true, reason: "office document (text conversion needs Collabora; COLLABORA_URL is not set)" };
  return { ok: true, ...clip(decode(new Uint8Array(out)).replace(/^﻿/, ""), maxChars, false), via: "collabora" };
}

/** Reads a response body, keeping at most `maxBytes` (and telling whether more was available). */
export async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, bytes.byteLength - offset);
    bytes.set(c.subarray(0, take), offset);
    offset += take;
    if (offset >= bytes.byteLength) break;
  }
  return { bytes, truncated };
}

/** Exact ArrayBuffer for a Uint8Array view (uploads want a standalone buffer). */
export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
