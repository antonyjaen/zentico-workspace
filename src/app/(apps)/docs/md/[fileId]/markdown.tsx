// Small, safe Markdown renderer for the Markdown editor preview.
// Output is React elements, never an HTML string: text always goes through React's escaping and
// raw HTML in the source is shown literally (no passthrough, no dangerouslySetInnerHTML).
// Supported: ATX headings, emphasis (bold / italic / strike), inline code, fenced code blocks,
// links (http/https/mailto only), images (https only), ordered / unordered / task lists (nested),
// blockquotes, GFM tables and horizontal rules.
import { Fragment, type ReactNode } from "react";

/* ------------------------------------------------------------------ urls */

function safeUrl(raw: string, protocols: string[]): string | null {
  const s = raw.trim().replace(/^<|>$/g, "");
  if (!s || /[\u0000-\u001f\s]/.test(s)) return null;
  try {
    const u = new URL(s);
    return protocols.includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

const linkUrl = (s: string) => safeUrl(s, ["http:", "https:", "mailto:"]);
const imageUrl = (s: string) => safeUrl(s, ["https:"]);

/* ---------------------------------------------------------------- inline */

const cls = {
  code: "rounded bg-sheet-muted px-1 py-0.5 font-mono text-[0.88em] text-ink",
  link: "text-accent underline underline-offset-2 hover:opacity-80",
};

/** Finds the closing delimiter for emphasis starting at `from` (not escaped, not empty). */
function findClose(s: string, delim: string, from: number): number {
  for (let i = from; i <= s.length - delim.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > 0) i = end;
      continue;
    }
    if (s.startsWith(delim, i) && i > from && s[i - 1] !== " ") return i;
  }
  return -1;
}

/** Matching "]" for a "[" at `open`, honoring nesting and escapes. */
function closeBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

/** "(url "title")" right after "]": returns the url and the index after ")". */
function parseTarget(s: string, at: number): { url: string; end: number } | null {
  if (s[at] !== "(") return null;
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) {
      const inner = s.slice(at + 1, i).trim();
      const m = /^(<[^>]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/.exec(inner);
      return m ? { url: m[1], end: i + 1 } : null;
    }
  }
  return null;
}

const BARE_URL = /^(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}*_~])/;

export function inline(src: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let text = "";
  let n = 0;
  const flush = () => {
    if (text) out.push(text);
    text = "";
  };
  const push = (node: ReactNode) => {
    flush();
    out.push(<Fragment key={`${key}.${n++}`}>{node}</Fragment>);
  };

  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const rest = src.slice(i);

    // Backslash escape / hard break.
    if (c === "\\") {
      if (src[i + 1] === "\n") {
        push(<br />);
        i += 2;
        continue;
      }
      if (i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(src[i + 1])) {
        text += src[i + 1];
        i += 2;
        continue;
      }
    }

    // Line break: two trailing spaces keep it, otherwise it's a space.
    if (c === "\n") {
      if (/ {2,}$/.test(text)) {
        text = text.replace(/ +$/, "");
        push(<br />);
      } else text += " ";
      i++;
      continue;
    }

    // Inline code.
    if (c === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = src.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        const code = src.slice(i + ticks.length, end).replace(/\n/g, " ");
        push(<code className={cls.code}>{code.length > 2 && code.startsWith(" ") && code.endsWith(" ") ? code.slice(1, -1) : code}</code>);
        i = end + ticks.length;
        continue;
      }
      text += ticks;
      i += ticks.length;
      continue;
    }

    // Image.
    if (c === "!" && src[i + 1] === "[") {
      const close = closeBracket(src, i + 1);
      const target = close > 0 ? parseTarget(src, close + 1) : null;
      if (target) {
        const alt = src.slice(i + 2, close);
        const url = imageUrl(target.url);
        push(
          url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" className="inline-block max-w-full rounded-md" />
          ) : (
            <span className="text-ink-mute">{`[${alt || "image"}]`}</span>
          ),
        );
        i = target.end;
        continue;
      }
    }

    // Link.
    if (c === "[") {
      const close = closeBracket(src, i);
      const target = close > 0 ? parseTarget(src, close + 1) : null;
      if (target) {
        const label = inline(src.slice(i + 1, close), `${key}.${n}l`);
        const url = linkUrl(target.url);
        push(
          url ? (
            <a href={url} target="_blank" rel="noopener noreferrer nofollow" className={cls.link}>
              {label}
            </a>
          ) : (
            <>{label}</>
          ),
        );
        i = target.end;
        continue;
      }
    }

    // Autolink <https://…> and bare URLs.
    if (c === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(rest);
      const url = m && linkUrl(m[1]);
      if (m && url) {
        push(
          <a href={url} target="_blank" rel="noopener noreferrer nofollow" className={cls.link}>
            {m[1].replace(/^mailto:/, "")}
          </a>,
        );
        i += m[0].length;
        continue;
      }
    }
    if ((c === "h" || c === "H") && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      const m = BARE_URL.exec(rest);
      const url = m && linkUrl(m[1]);
      if (m && url) {
        push(
          <a href={url} target="_blank" rel="noopener noreferrer nofollow" className={cls.link}>
            {m[1]}
          </a>,
        );
        i += m[1].length;
        continue;
      }
    }

    // Emphasis: **bold**, __bold__, ~~strike~~, *italic*, _italic_.
    const strong = rest.startsWith("**") ? "**" : rest.startsWith("__") ? "__" : null;
    if (strong && src[i + 2] && src[i + 2] !== " ") {
      const end = findClose(src, strong, i + 2);
      if (end > 0) {
        push(<strong className="font-semibold text-ink">{inline(src.slice(i + 2, end), `${key}.${n}b`)}</strong>);
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith("~~") && src[i + 2] && src[i + 2] !== " ") {
      const end = findClose(src, "~~", i + 2);
      if (end > 0) {
        push(<del>{inline(src.slice(i + 2, end), `${key}.${n}s`)}</del>);
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && src[i + 1] && src[i + 1] !== " " && src[i + 1] !== c) {
      // "_" inside words (snake_case) isn't emphasis.
      const wordBefore = c === "_" && i > 0 && /\w/.test(src[i - 1]);
      const end = wordBefore ? -1 : findClose(src, c, i + 1);
      if (end > 0 && !(c === "_" && /\w/.test(src[end + 1] ?? ""))) {
        push(<em>{inline(src.slice(i + 1, end), `${key}.${n}e`)}</em>);
        i = end + 1;
        continue;
      }
    }

    text += c;
    i++;
  }
  flush();
  return out;
}

/* ---------------------------------------------------------------- blocks */

const RE = {
  fence: /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/,
  heading: /^ {0,3}(#{1,6})(?:\s+(.*))?$/,
  hr: /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
  quote: /^ {0,3}> ?/,
  item: /^( *)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/,
};

/** GFM table delimiter row: "| --- | :-: |" (checked without a backtracking regex). */
function isTableSep(line: string): boolean {
  let s = line.trim();
  if (!s.includes("-")) return false;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").every((c) => /^:?-+:?$/.test(c.trim()));
}

/** Heading text without the optional closing "#" sequence. */
function headingText(raw: string | undefined): string {
  const t = (raw ?? "").trimEnd();
  let j = t.length;
  while (j > 0 && t[j - 1] === "#") j--;
  return j === 0 ? "" : j < t.length && /\s/.test(t[j - 1]) ? t.slice(0, j).trimEnd() : t;
}

const blank = (l: string) => !l.trim();
const indentOf = (l: string) => /^ */.exec(l.replace(/\t/g, "    "))![0].length;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** True when a line starts a block other than a paragraph (ends paragraphs). */
function startsBlock(line: string, next: string | undefined): boolean {
  return (
    RE.fence.test(line) ||
    RE.heading.test(line) ||
    RE.hr.test(line) ||
    RE.quote.test(line) ||
    (RE.item.test(line) && !!RE.item.exec(line)![3]) ||
    (line.includes("|") && next !== undefined && isTableSep(next))
  );
}

const H = [
  "mt-6 mb-3 text-[1.75em] font-semibold leading-tight text-ink first:mt-0",
  "mt-6 mb-3 border-b border-line pb-1.5 text-[1.4em] font-semibold leading-snug text-ink first:mt-0",
  "mt-5 mb-2 text-[1.2em] font-semibold text-ink first:mt-0",
  "mt-4 mb-2 text-[1.05em] font-semibold text-ink first:mt-0",
  "mt-4 mb-2 text-[1em] font-semibold text-ink first:mt-0",
  "mt-4 mb-2 text-[0.9em] font-semibold uppercase tracking-wide text-ink-soft first:mt-0",
];

export function blocks(lines: string[], key = "b", depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const k = () => `${key}.${n++}`;

  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }

    // Fenced code block.
    const fence = RE.fence.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of document)
      out.push(
        <pre key={k()} className="my-3 overflow-x-auto rounded-md border border-line bg-sheet-muted p-3 text-[0.86em] leading-relaxed">
          <code className="font-mono text-ink" data-lang={fence[2] || undefined}>
            {body.join("\n")}
          </code>
        </pre>,
      );
      continue;
    }

    // Heading.
    const h = RE.heading.exec(line);
    if (h) {
      const level = h[1].length;
      const Tag = `h${level}` as "h1";
      out.push(
        <Tag key={k()} className={H[level - 1]}>
          {inline(headingText(h[2]), `${key}.${n}h`)}
        </Tag>,
      );
      i++;
      continue;
    }

    // Horizontal rule.
    if (RE.hr.test(line)) {
      out.push(<hr key={k()} className="my-6 border-line" />);
      i++;
      continue;
    }

    // Blockquote.
    if (RE.quote.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !blank(lines[i]) && (RE.quote.test(lines[i]) || !startsBlock(lines[i], lines[i + 1]))) {
        body.push(lines[i].replace(RE.quote, ""));
        i++;
      }
      out.push(
        <blockquote key={k()} className="my-3 border-l-2 border-line-strong pl-4 text-ink-soft">
          {depth < 8 ? blocks(body, `${key}.${n}q`, depth + 1) : body.join(" ")}
        </blockquote>,
      );
      continue;
    }

    // Table: header row, separator row, body rows.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const tk = `${key}.${n}t`;
      out.push(
        <div key={k()} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-[0.94em]">
            <thead>
              <tr>
                {head.map((c, ci) => (
                  <th key={ci} className="border border-line bg-sheet-muted px-3 py-1.5 text-left font-semibold text-ink" style={{ textAlign: aligns[ci] }}>
                    {inline(c, `${tk}.h${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, ci) => (
                    <td key={ci} className="border border-line px-3 py-1.5 align-top" style={{ textAlign: aligns[ci] }}>
                      {inline(r[ci] ?? "", `${tk}.${ri}.${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // List (ordered / unordered / task), nested by indentation.
    const first = RE.item.exec(line);
    if (first) {
      const baseIndent = first[1].length;
      const ordered = /\d/.test(first[2]);
      const start = ordered ? parseInt(first[2], 10) : 1;
      const items: string[][] = [];
      let cur: string[] | null = null;
      let contentIndent = baseIndent + first[2].length + 1;
      while (i < lines.length) {
        const l = lines[i];
        const m = RE.item.exec(l);
        if (m && m[1].length <= baseIndent + 1 && /\d/.test(m[2]) === ordered) {
          cur = [m[3] ?? ""];
          items.push(cur);
          contentIndent = m[1].length + m[2].length + 1;
          i++;
          continue;
        }
        if (blank(l)) {
          // A blank line continues the list only if more (indented or sibling) content follows.
          const nextIdx = lines.slice(i + 1).findIndex((x) => !blank(x));
          const next = nextIdx >= 0 ? lines[i + 1 + nextIdx] : undefined;
          const nm = next !== undefined ? RE.item.exec(next) : null;
          const continues =
            next !== undefined &&
            (indentOf(next) >= contentIndent || (!!nm && nm[1].length <= baseIndent + 1 && /\d/.test(nm[2]) === ordered));
          if (!continues) break;
          cur?.push("");
          i++;
          continue;
        }
        if (indentOf(l) >= Math.min(contentIndent, baseIndent + 2)) {
          cur?.push(l.replace(/\t/g, "    ").slice(Math.min(indentOf(l), contentIndent)));
          i++;
          continue;
        }
        // Lazy continuation of the item's paragraph.
        if (cur && !blank(cur[cur.length - 1]) && !startsBlock(l, lines[i + 1])) {
          cur.push(l.trim());
          i++;
          continue;
        }
        break;
      }
      const lk = `${key}.${n}l`;
      const children = items.map((body, ii) => {
        const task = /^\[([ xX])\]\s+/.exec(body[0]);
        if (task) body = [body[0].slice(task[0].length), ...body.slice(1)];
        // Tight items render their first paragraph inline.
        const content = depth < 8 ? blocks(body, `${lk}.${ii}`, depth + 1) : [body.join(" ")];
        const unwrapped = content.map((c) =>
          c && typeof c === "object" && "type" in c && c.type === "p" ? (
            <span key={(c as { key: string }).key} className="block">
              {(c as { props: { children: ReactNode } }).props.children}
            </span>
          ) : (
            c
          ),
        );
        return task ? (
          <li key={ii} className="my-0.5 flex list-none items-start gap-2 [&>div]:min-w-0 [&>div]:flex-1">
            <input type="checkbox" checked={task[1] !== " "} disabled readOnly className="mt-[0.35em] shrink-0 accent-[var(--color-accent)]" />
            <div>{unwrapped}</div>
          </li>
        ) : (
          <li key={ii} className="my-0.5 pl-1">
            {unwrapped}
          </li>
        );
      });
      const hasTasks = items.some((b) => /^\[([ xX])\]\s+/.test(b[0]));
      out.push(
        ordered ? (
          <ol key={k()} start={start !== 1 ? start : undefined} className="my-2 list-decimal pl-6 marker:text-ink-mute">
            {children}
          </ol>
        ) : (
          <ul key={k()} className={`my-2 ${hasTasks ? "pl-1" : "list-disc pl-6"} marker:text-ink-mute`}>
            {children}
          </ul>
        ),
      );
      continue;
    }

    // Paragraph.
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) {
      // A paragraph line directly followed by a table separator starts a table instead.
      if (para.length && lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
      para.push(lines[i]);
      i++;
    }
    out.push(
      <p key={k()} className="my-3 first:mt-0">
        {inline(para.join("\n").trim(), `${key}.${n}p`)}
      </p>,
    );
  }
  return out;
}

/** Renders Markdown source to React elements. */
export function renderMarkdown(src: string): ReactNode {
  return blocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

/** Words in the Markdown source (formatting markers ignored). */
export function countWords(src: string): number {
  const text = src
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[#>*_~`|[\]-]+/g, " ");
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;
}
