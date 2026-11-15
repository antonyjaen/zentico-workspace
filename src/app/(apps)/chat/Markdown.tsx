"use client";

// Markdown-lite for chat messages, rendered as React nodes (never raw HTML):
// ```code blocks```, `inline code`, **bold**, *italic* / _italic_, ~~strike~~, [text](https://…),
// bare http(s) links and @mentions (highlighted; stronger when they mention me).
import { Fragment, type ReactNode } from "react";

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(~~[^~\n]+?~~)|((?<![\w*])\*[^*\s][^*\n]*?\*(?![\w*]))|((?<![\w])_[^_\s][^_\n]*?_(?![\w]))|(\[[^\]\n]{1,200}\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])|((?<![\w@])@[a-z0-9][a-z0-9._-]*[a-z0-9])/gi;

const LINK = "text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent break-words";

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function inline(text: string, me: string, keyBase: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  INLINE.lastIndex = 0;
  const matches = [...text.matchAll(INLINE)];
  for (const m of matches) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const key = `${keyBase}-${i++}`;
    const [whole, code, bold, strike, star, under, mdLink, url, mention] = m;
    const inner = (s: string) => (depth < 3 ? inline(s, me, key, depth + 1) : [s]);
    if (code) {
      out.push(
        <code key={key} className="rounded border border-line bg-sheet-muted px-1 py-px font-mono text-[0.88em]">
          {code.slice(1, -1)}
        </code>,
      );
    } else if (bold) out.push(<strong key={key} className="font-semibold">{inner(bold.slice(2, -2))}</strong>);
    else if (strike) out.push(<s key={key}>{inner(strike.slice(2, -2))}</s>);
    else if (star) out.push(<em key={key}>{inner(star.slice(1, -1))}</em>);
    else if (under) out.push(<em key={key}>{inner(under.slice(1, -1))}</em>);
    else if (mdLink) {
      const close = mdLink.indexOf("](");
      const href = safeHref(mdLink.slice(close + 2, -1));
      const label = mdLink.slice(1, close);
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" className={LINK}>
            {label}
          </a>
        ) : (
          whole
        ),
      );
    } else if (url) {
      const href = safeHref(url);
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" className={LINK}>
            {url}
          </a>
        ) : (
          url
        ),
      );
    } else if (mention) {
      const mine = mention.slice(1).toLowerCase() === me;
      out.push(
        <span
          key={key}
          className={`rounded px-0.5 font-medium ${mine ? "bg-amber/20 text-ink" : "text-accent"}`}
        >
          {mention}
        </span>,
      );
    } else out.push(whole);
    last = idx + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** `meHandle` is my email local part (mentions are written as @local-part). */
export function Markdown({ text, meHandle }: { text: string; meHandle: string }) {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 && i < parts.length - 1 ? (
          <pre
            key={i}
            className="my-1 overflow-x-auto rounded-md border border-line bg-sheet-muted px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre"
          >
            {part.replace(/^[a-z0-9+-]*\n/i, "").replace(/\n$/, "")}
          </pre>
        ) : (
          <Fragment key={i}>{inline(i % 2 === 1 ? "```" + part : part, meHandle, String(i))}</Fragment>
        ),
      )}
    </>
  );
}

/** Mentions of me in a message body (for notifications/highlighting). */
export const mentionsMe = (text: string, meHandle: string) =>
  new RegExp(`(^|[^\\w@])@${meHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-]*[a-z0-9])`, "i").test(text);
