"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

export type FrameMode = "themed" | "paper" | "inverted";
export type AppTheme = "light" | "dark";

/** The app's resolved theme (`<html data-theme>`), or null during SSR / hydration. */
export function useAppTheme(): AppTheme | null {
  return useSyncExternalStore(
    (cb) => {
      const obs = new MutationObserver(cb);
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return () => obs.disconnect();
    },
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
    () => null,
  );
}

/**
 * Renders a sanitized HTML message in a sandboxed frame. The sandbox has `allow-same-origin`
 * but never `allow-scripts`, so nothing inside can execute, while the parent can still read
 * the document height, apply the theme mode and fold quoted history.
 */
export function MessageFrame({
  srcDoc,
  title,
  theme,
  mode,
  showQuotes,
  onQuotes,
}: {
  srcDoc: string;
  title: string;
  theme: AppTheme;
  mode: FrameMode;
  showQuotes: boolean;
  /** Called after load with whether a quoted-history block was found (and hidden). */
  onQuotes?: (found: boolean) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const live = useRef({ theme, mode, showQuotes, onQuotes });
  live.current = { theme, mode, showQuotes, onQuotes };

  // Initial attributes go into the markup so the first paint already has the right look;
  // later changes are applied to the live document without reloading it.
  const doc = useMemo(
    () => srcDoc.replace("<html>", `<html data-theme="${live.current.theme}" data-mode="${live.current.mode}">`),
    [srcDoc],
  );

  const apply = () => {
    const root = ref.current?.contentDocument?.documentElement;
    if (!root) return;
    root.dataset.theme = live.current.theme;
    root.dataset.mode = live.current.mode;
    root.classList.toggle("zw-showq", live.current.showQuotes);
  };

  useEffect(apply, [theme, mode, showQuotes]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      const d = frame.contentDocument;
      if (!d?.documentElement || frame.offsetWidth === 0) return;
      // The <html> box is as tall as its content; scrollHeight would be at least the frame's own
      // height, which grows the frame forever once we observe it.
      const h = Math.ceil(d.documentElement.getBoundingClientRect().height);
      if (h > 0) setHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    };

    const attach = () => {
      const d = frame.contentDocument;
      apply();
      if (d?.body) live.current.onQuotes?.(markQuotes(d));
      measure();
      observer?.disconnect();
      observer = new ResizeObserver(measure);
      observer.observe(frame); // re-measure when a collapsed message is expanded or the width changes
      if (d?.body) observer.observe(d.body);
      // Late-loading images change the height without resizing <body> in some engines.
      d?.querySelectorAll("img").forEach((img) => {
        if (!img.complete) img.addEventListener("load", measure, { once: true });
      });
    };

    frame.addEventListener("load", attach);
    if (frame.contentDocument?.readyState === "complete" && frame.contentDocument.body?.childNodes.length) attach();
    return () => {
      frame.removeEventListener("load", attach);
      observer?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const surface =
    mode === "paper"
      ? "rounded-xl bg-white ring-1 ring-line"
      : mode === "inverted"
        ? "rounded-xl bg-sheet-muted ring-1 ring-line"
        : "bg-transparent";

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={doc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className={`block w-full border-0 print:ring-0 ${surface}`}
      style={{ height }}
    />
  );
}

// ---------------------------------------------------------------------------
// Quoted history

/** Markers clients put around quoted replies (Gmail, Apple Mail, Outlook, Yahoo, Thunderbird, Proton). */
const QUOTE_SELECTOR = [
  "div.gmail_quote",
  "blockquote.gmail_quote",
  'blockquote[type="cite"]',
  "div.yahoo_quoted",
  "div#divRplyFwdMsg",
  "div#appendonsend",
  "div.moz-cite-prefix",
  "div.protonmail_quote",
  "blockquote.protonmail_quote",
  "div.zmail_extra",
].join(",");

const ATTRIBUTION = /(wrote|escribió|a écrit|schrieb|scrisse|escreveu)\s*:?\s*$/i;

/**
 * Finds the start of the quoted history and marks it (plus everything after it) with
 * `data-zw-q`, so the frame's CSS hides it. Leaves messages alone when nothing would remain.
 */
function markQuotes(doc: Document): boolean {
  const body = doc.body;
  if (body.querySelector("[data-zw-q]")) return true; // already marked (re-attach)
  let start: Element | null = body.querySelector(QUOTE_SELECTOR);
  if (!start) {
    // Our own composer (and many others): "<div>On …, X wrote:</div><blockquote>…</blockquote>".
    const quotes = Array.from(body.querySelectorAll("blockquote")).filter((q) => !q.parentElement?.closest("blockquote"));
    const last = quotes.at(-1);
    const prev = last?.previousElementSibling;
    if (last && prev && ATTRIBUTION.test(prev.textContent ?? "")) start = prev;
  } else {
    // Outlook puts a separator rule (or an attribution line) right before the marker.
    const prev = start.previousElementSibling;
    if (prev && (prev.tagName === "HR" || ATTRIBUTION.test(prev.textContent ?? ""))) start = prev;
  }
  if (!start || start === body) return false;

  // Only fold when there's real content before the quote (a bare forward stays visible).
  const before = doc.createRange();
  before.setStart(body, 0);
  before.setEndBefore(start);
  if (!before.toString().trim()) return false;

  for (let el: Element | null = start; el && el !== body; el = el.parentElement) {
    if (el === start) el.setAttribute("data-zw-q", "");
    for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) sib.setAttribute("data-zw-q", "");
  }
  return true;
}
