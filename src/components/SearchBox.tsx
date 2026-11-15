"use client";

import { Search } from "lucide-react";
import { useEffect, useRef } from "react";

/** Mail search field; "/" focuses it from anywhere (unless typing in another field). */
export function SearchBox({ placeholder, defaultValue }: { placeholder: string; defaultValue?: string }) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key !== "/" || target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form action="/mail/search" role="search" className="hidden max-w-[640px] flex-1 sm:block">
      <label className="flex h-10 items-center gap-2.5 rounded-lg border border-line bg-sheet px-3 transition-colors duration-150 focus-within:border-line-strong hover:border-line-strong">
        <Search size={16} className="shrink-0 text-ink-mute" aria-hidden />
        <span className="sr-only">{placeholder}</span>
        <input
          ref={input}
          name="q"
          type="search"
          defaultValue={defaultValue}
          placeholder={placeholder}
          autoComplete="off"
          className="h-full w-full bg-transparent text-[14px] text-ink placeholder:text-ink-mute focus:outline-none"
        />
        <kbd className="kbd">/</kbd>
      </label>
    </form>
  );
}
