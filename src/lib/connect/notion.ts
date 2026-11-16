// Notion: search pages, read a page as text, append paragraphs. Only pages the person shared
// with the integration when connecting are visible. Server-only.
import { callApi } from "./api";
import { arr, clip, obj, ProviderError, str } from "./http";

const API = "https://api.notion.com/v1";
const HEADERS = { "Notion-Version": "2022-06-28" };

/** A page id from a 32-hex id, a UUID or a Notion URL → canonical UUID form. */
export function parsePageId(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  const path = /^https?:\/\//i.test(s) ? (() => { try { return new URL(s).pathname; } catch { return ""; } })() : s;
  const hex = (/([0-9a-f]{32})(?:[^0-9a-f]|$)/i.exec(path.replace(/-/g, ""))?.[1] ?? "").toLowerCase();
  if (hex.length !== 32) throw new ProviderError("invalid", "Expected a Notion page id or URL.");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const notion = (token: string, path: string, opts: Parameters<typeof callApi>[3] = {}) =>
  callApi("notion", token, `${API}${path}`, { ...opts, headers: { ...HEADERS, ...(opts.headers ?? {}) } });

const plain = (rich: unknown) => arr(rich).map((r) => str(obj(r).plain_text)).join("");

function pageTitle(page: Record<string, unknown>): string {
  for (const p of Object.values(obj(page.properties))) {
    const prop = obj(p);
    if (prop.type === "title") return plain(prop.title);
  }
  return "";
}

function pageView(raw: unknown) {
  const p = obj(raw);
  return {
    id: str(p.id),
    title: clip(pageTitle(p), 300) || "Untitled",
    url: str(p.url),
    lastEdited: str(p.last_edited_time),
    archived: p.archived === true || p.in_trash === true,
  };
}

export async function search(token: string, query: string, limit: number) {
  const { json } = await notion(token, "/search", {
    method: "POST",
    body: { ...(query ? { query } : {}), filter: { property: "object", value: "page" }, page_size: limit },
  });
  return arr(obj(json).results).map(pageView);
}

export async function getPage(token: string, id: string) {
  const { json } = await notion(token, `/pages/${id}`);
  return pageView(json);
}

function blockText(raw: unknown): string | null {
  const b = obj(raw);
  const type = str(b.type);
  const data = obj(b[type]);
  const text = plain(data.rich_text);
  switch (type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${data.checked ? "x" : " "}] ${text}`;
    case "quote":
    case "callout":
      return `> ${text}`;
    case "toggle":
      return `▸ ${text}`;
    case "code":
      return `\`\`\`${str(data.language)}\n${text}\n\`\`\``;
    case "divider":
      return "---";
    case "child_page":
      return `[page: ${str(data.title)}]`;
    case "child_database":
      return `[database: ${str(data.title)}]`;
    case "bookmark":
    case "embed":
    case "link_preview":
      return str(data.url);
    default:
      return text || null;
  }
}

const MAX_BLOCK_PAGES = 5;

export async function readPage(token: string, id: string, maxChars: number) {
  const page = await getPage(token, id);
  const lines: string[] = [];
  let cursor: string | null = null;
  let size = 0;
  let truncated = false;
  for (let i = 0; i < MAX_BLOCK_PAGES; i++) {
    const q = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
    const { json } = await notion(token, `/blocks/${id}/children?${q}`);
    const o = obj(json);
    for (const b of arr(o.results)) {
      const line = blockText(b);
      if (line == null) continue;
      lines.push(line);
      size += line.length + 1;
      if (size > maxChars) break;
    }
    cursor = o.has_more === true ? str(o.next_cursor) || null : null;
    if (size > maxChars || !cursor) {
      truncated = size > maxChars || !!cursor;
      break;
    }
    if (i === MAX_BLOCK_PAGES - 1) truncated = true;
  }
  const text = lines.join("\n");
  return { ...page, truncated: truncated || text.length > maxChars, text: text.slice(0, maxChars) };
}

/** Appends the text as paragraphs (≤ 2000 chars of rich text each, ≤ 100 blocks). */
export async function appendText(token: string, id: string, text: string) {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => p.match(/[\s\S]{1,2000}/g) ?? []);
  if (!paragraphs.length) throw new ProviderError("invalid", "Nothing to append.");
  if (paragraphs.length > 100) throw new ProviderError("invalid", "Too much text (more than 100 paragraphs).");
  const { json } = await notion(token, `/blocks/${id}/children`, {
    method: "PATCH",
    body: {
      children: paragraphs.map((p) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: p } }] } })),
    },
  });
  return { appended: arr(obj(json).results).length || paragraphs.length };
}
