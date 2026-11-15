"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Renders a sanitized HTML message in a sandboxed frame. The sandbox has `allow-same-origin`
 * but never `allow-scripts`, so nothing inside can execute, while the parent can still read
 * the document height to size the frame to its content.
 */
export function MessageFrame({ srcDoc, title }: { srcDoc: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement || frame.offsetWidth === 0) return;
      const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
      if (h > 0) setHeight(h + 2);
    };

    const attach = () => {
      measure();
      const doc = frame.contentDocument;
      observer?.disconnect();
      observer = new ResizeObserver(measure);
      observer.observe(frame); // re-measure when a collapsed message is expanded or the width changes
      if (doc?.body) observer.observe(doc.body);
      // Late-loading images change the height without resizing <body> in some engines.
      doc?.querySelectorAll("img").forEach((img) => {
        if (!img.complete) img.addEventListener("load", measure, { once: true });
      });
    };

    frame.addEventListener("load", attach);
    if (frame.contentDocument?.readyState === "complete") attach();
    return () => {
      frame.removeEventListener("load", attach);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="block w-full rounded-md border-0 bg-white"
      style={{ height }}
    />
  );
}
