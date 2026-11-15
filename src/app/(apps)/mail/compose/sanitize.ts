// Client-side HTML allowlist sanitizer for content placed into the composer's contentEditable
// (quoted originals, reopened drafts, signatures, pasted HTML). Parsing happens in an inert
// DOMParser document, and only allowlisted tags survive, with no attributes except safe link
// hrefs. Images are dropped (remote content is never loaded in the composer).

const KEEP = new Set([
  "P", "BR", "DIV", "SPAN", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "A", "UL", "OL", "LI",
  "BLOCKQUOTE", "PRE", "CODE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "THEAD", "TBODY",
  "TFOOT", "TR", "TD", "TH", "HR", "SUB", "SUP", "SMALL",
]);

// Removed together with their content.
const DROP = new Set([
  "SCRIPT", "STYLE", "IFRAME", "FRAME", "FRAMESET", "OBJECT", "EMBED", "TEMPLATE", "HEAD", "TITLE",
  "META", "LINK", "BASE", "NOSCRIPT", "SVG", "MATH", "FORM", "INPUT", "BUTTON", "TEXTAREA",
  "SELECT", "OPTION", "IMG", "PICTURE", "VIDEO", "AUDIO", "SOURCE", "TRACK", "CANVAS", "MAP",
]);

/** Marks the signature block so it can be swapped when the From identity changes. */
export const SIGNATURE_ATTR = "data-zw-signature";

export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.trim());
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function copy(from: Node, to: Node, doc: Document) {
  for (const child of Array.from(from.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      to.appendChild(doc.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toUpperCase();
    if (DROP.has(tag)) continue;
    if (!KEEP.has(tag)) {
      copy(el, to, doc); // unwrap unknown elements, keep their content
      continue;
    }
    const clean = doc.createElement(tag.toLowerCase());
    if (tag === "A") {
      const href = safeHref(el.getAttribute("href"));
      if (href) {
        clean.setAttribute("href", href);
        clean.setAttribute("target", "_blank");
        clean.setAttribute("rel", "noopener noreferrer");
      }
    }
    if (tag === "DIV" && el.hasAttribute(SIGNATURE_ATTR)) clean.setAttribute(SIGNATURE_ATTR, "");
    copy(el, clean, doc);
    to.appendChild(clean);
  }
}

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = doc.createElement("div");
  copy(doc.body, out, doc);
  return out.innerHTML;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

const TEXT_BLOCKS = new Set([
  "P", "DIV", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "TABLE", "TR", "SECTION", "ARTICLE",
]);

/**
 * Plain-text alternative of the composed HTML: line breaks from blocks and <br>, "- " bullets,
 * link targets in <…>, and quoted history prefixed with "> " like every mail client expects.
 */
export function htmlToText(root: Node): string {
  let text = "";
  const newline = () => {
    if (text && !text.endsWith("\n")) text += "\n";
  };
  const walk = (node: Node, pre: boolean) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const s = child.textContent ?? "";
        text += pre ? s : s.replace(/\s+/g, " ");
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toUpperCase();
      if (tag === "BR") {
        text += "\n";
      } else if (tag === "BLOCKQUOTE") {
        newline();
        const inner = htmlToText(el).replace(/\n+$/, "");
        if (inner) text += inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") + "\n";
      } else if (tag === "LI") {
        newline();
        text += "- ";
        walk(el, pre);
        newline();
      } else if (tag === "HR") {
        newline();
        text += "----------\n";
      } else if (tag === "A") {
        walk(el, pre);
        const href = el.getAttribute("href");
        if (href && /^https?:/i.test(href) && href !== el.textContent?.trim()) text += ` <${href}>`;
      } else if (tag === "TD" || tag === "TH") {
        walk(el, pre);
        text += " ";
      } else if (TEXT_BLOCKS.has(tag)) {
        newline();
        walk(el, pre || tag === "PRE");
        newline();
      } else {
        walk(el, pre);
      }
    }
  };
  walk(root, false);
  return text
    .replace(/([^\n-])[ \t]+\n/g, "$1\n") // keeps the "-- " signature delimiter
    .replace(/\n[ ]+(?=\S)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
