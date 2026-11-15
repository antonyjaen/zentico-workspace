"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import type { Address } from "@/lib/mail-compose";
import { suggestContactsAction } from "./actions";

export type Recipient = { name: string | null; email: string; valid: boolean };

// Mirrors the server-side check in src/lib/mail-compose.ts (the server re-validates).
const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const toRecipient = (a: Address): Recipient => ({
  name: a.name,
  email: a.email.trim(),
  valid: a.email.length <= 254 && EMAIL.test(a.email.trim()),
});

/** Parses free text like `Ana <ana@x.com>, bob@y.com` into recipients. */
export function parseRecipients(text: string): Recipient[] {
  return text
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(.*?)\s*<([^>]+)>$/);
      const name = m ? m[1].replace(/^"|"$/g, "").trim() || null : null;
      return toRecipient({ name, email: m ? m[2] : s });
    });
}

export function RecipientField({
  label,
  value,
  onChange,
  autoFocus,
  trailing,
}: {
  label: string;
  value: Recipient[];
  onChange: (next: Recipient[]) => void;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
}) {
  const t = useTranslations("compose");
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<Address[]>([]);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Contact autocomplete (silently empty when the server has no contacts capability).
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      suggestContactsAction(q)
        .then((list) => {
          if (cancelled) return;
          const taken = new Set(value.map((r) => r.email.toLowerCase()));
          setSuggestions(list.filter((a) => !taken.has(a.email.toLowerCase())));
          setHighlight(0);
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, value]);

  const add = (list: Recipient[]) => {
    const taken = new Set(value.map((r) => r.email.toLowerCase()));
    const fresh = list.filter((r) => {
      const k = r.email.toLowerCase();
      if (taken.has(k)) return false;
      taken.add(k);
      return true;
    });
    if (fresh.length) onChange([...value, ...fresh]);
    setText("");
    setSuggestions([]);
  };

  const commit = () => {
    if (text.trim()) add(parseRecipients(text));
  };

  const open = suggestions.length > 0;

  return (
    <div className="relative flex min-h-10 items-start gap-2 border-b border-line px-4 py-1.5">
      <span className="mt-[5px] w-10 shrink-0 text-[13px] text-ink-mute">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" onClick={() => inputRef.current?.focus()}>
        {value.map((r, i) => (
          <span
            key={r.email + i}
            title={r.valid ? r.email : t("invalidAddress")}
            className={`inline-flex h-7 max-w-full items-center gap-1 rounded-md border pr-1 pl-2 text-[13px] ${
              r.valid ? "border-line-strong bg-sheet-muted text-ink" : "border-danger/60 text-danger"
            }`}
          >
            <span className="truncate">{r.name || r.email}</span>
            <button
              type="button"
              className="grid h-5 w-5 place-items-center rounded text-ink-mute hover:bg-hover hover:text-ink"
              aria-label={t("removeRecipient", { email: r.email })}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((_, j) => j !== i));
              }}
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          inputMode="email"
          autoComplete="off"
          autoFocus={autoFocus}
          aria-label={label}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]/.test(v)) add(parseRecipients(v));
            else setText(v);
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text/plain");
            if (/[,;\n]/.test(pasted)) {
              e.preventDefault();
              add(parseRecipients(text + pasted));
            }
          }}
          onKeyDown={(e) => {
            if (open && e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => (h + 1) % suggestions.length);
            } else if (open && e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
            } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              if (open) add([toRecipient(suggestions[highlight])]);
              else commit();
            } else if (e.key === "Tab" && text.trim()) {
              if (open) {
                e.preventDefault();
                add([toRecipient(suggestions[highlight])]);
              } else commit();
            } else if (e.key === "Escape" && open) {
              e.stopPropagation();
              setSuggestions([]);
            } else if (e.key === "Backspace" && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => {
            // Let a click on a suggestion land first.
            setTimeout(commit, 120);
          }}
          className="h-7 min-w-[120px] flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-mute focus-visible:outline-none"
        />
      </div>
      {trailing}
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="pop absolute top-full right-4 left-14 z-10 mt-1 max-h-60 overflow-y-auto py-1"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.email}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                add([toRecipient(s)]);
              }}
              onMouseEnter={() => setHighlight(i)}
              className="flex cursor-default flex-col px-3 py-1.5 text-[13px] aria-selected:bg-hover"
            >
              {s.name && <span className="text-ink">{s.name}</span>}
              <span className="font-mono text-[12px] text-ink-mute">{s.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
