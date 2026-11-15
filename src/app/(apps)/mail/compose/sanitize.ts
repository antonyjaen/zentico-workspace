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
