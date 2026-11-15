"use client";

import { useEffect, useRef } from "react";

/** True when the key event comes from a place where the user is typing. */
export function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/**
 * Global single-key shortcuts. The handler returns true when it handled the key (the default is
 * then prevented). Ignored while typing in fields and when Ctrl/Meta/Alt are held.
 */
export function useShortcuts(handler: (e: KeyboardEvent) => boolean) {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (isTyping(e.target)) return;
      if (ref.current(e)) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
