"use client";

// Small building blocks shared by the Chat views: avatars, the people picker, the modal shell,
// the cached directory and date formatting.
import { Hash, Lock, Users, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { meetHref } from "../meet/shared";
import { listPeople } from "./actions";
import { avatarGradient, initials, type ConversationSummary, type Person } from "./shared";

export const FIELD =
  "h-9 w-full rounded-md border border-line bg-sheet px-2.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-mute hover:border-line-strong focus:border-ink-mute";
export const BTN =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-line px-3 text-[13px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:opacity-50";
export const BTN_PRIMARY =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors hover:bg-primary-hover disabled:opacity-50";
export const BTN_MEET =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50";

const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
export const isEmail = (s: string) => EMAIL.test(s);

export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function Avatar({ name, email, size = 32, className = "" }: { name: string; email: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full font-semibold text-white select-none ${className}`}
      style={{ width: size, height: size, background: avatarGradient(email || name), fontSize: Math.max(10, Math.round(size * 0.38)) }}
    >
      {initials(name || email)}
    </span>
  );
}

/** The icon/avatar used for a conversation in lists and headers. */
export function ConversationIcon({ c, size = 32 }: { c: Pick<ConversationSummary, "kind" | "peer" | "isPrivate" | "name">; size?: number }) {
  if (c.kind === "dm" && c.peer) return <Avatar name={c.peer.name} email={c.peer.email} size={size} />;
  const Icon = c.kind === "channel" ? (c.isPrivate ? Lock : Hash) : Users;
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-lg border border-line bg-sheet-muted text-ink-soft"
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.45)} />
    </span>
  );
}

let directory: Promise<Person[]> | null = null;

/** Directory people (excluding me), loaded once per page; null while loading. */
export function usePeople(): Person[] | null {
  const [list, setList] = useState<Person[] | null>(null);
  useEffect(() => {
    directory ??= listPeople().then((r) => {
      if (!r.ok) directory = null;
      return r.ok ? r.data : [];
    });
    let live = true;
    directory.then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, []);
  return list;
}

/** Multi-select of people: chips + a search box over the directory (optionally free emails). */
export function PeoplePicker({
  value,
  onChange,
  people,
  allowFree = false,
  autoFocus = false,
  placeholder,
}: {
  value: Person[];
  onChange: (v: Person[]) => void;
  people: Person[] | null;
  allowFree?: boolean;
  autoFocus?: boolean;
  placeholder: string;
}) {
  const t = useTranslations("chat");
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const picked = useMemo(() => new Set(value.map((p) => p.email)), [value]);

  const matches = useMemo(() => {
    const q = fold(query.trim());
    if (!people) return [];
    return people
      .filter((p) => !picked.has(p.email) && (!q || fold(p.name).includes(q) || fold(p.email).includes(q)))
      .slice(0, 50);
  }, [people, query, picked]);

  useEffect(() => setActive(0), [query]);

  const add = (p: Person) => {
    onChange([...value, p]);
    setQuery("");
    inputRef.current?.focus();
  };

  const free = query.trim().toLowerCase();
  const canFree = allowFree && isEmail(free) && !picked.has(free) && matches.length === 0;
  const show = open && (matches.length > 0 || canFree) && (query.trim() !== "" || value.length === 0);

  return (
    <div className="relative">
      <div
        className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-line bg-sheet px-1.5 py-1 transition-colors focus-within:border-ink-mute hover:border-line-strong"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((p) => (
          <span key={p.email} className="flex max-w-full items-center gap-1 rounded bg-hover py-0.5 pr-1 pl-0.5 text-[12.5px] text-ink">
            <Avatar name={p.name} email={p.email} size={18} />
            <span className="truncate">{p.name || p.email}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((x) => x.email !== p.email));
              }}
              className="text-ink-mute hover:text-ink"
              aria-label={t("removePerson", { name: p.name || p.email })}
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => (setQuery(e.target.value), setOpen(true))}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && matches.length) {
              e.preventDefault();
              setActive((a) => (a + 1) % matches.length);
            } else if (e.key === "ArrowUp" && matches.length) {
              e.preventDefault();
              setActive((a) => (a <= 0 ? matches.length - 1 : a - 1));
            } else if (e.key === "Enter" || e.key === ",") {
              if (matches[active] && query.trim()) {
                e.preventDefault();
                add(matches[active]);
              } else if (canFree) {
                e.preventDefault();
                add({ email: free, name: free });
              } else if (e.key === ",") e.preventDefault();
            } else if (e.key === "Backspace" && !query && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          placeholder={value.length ? "" : placeholder}
          maxLength={200}
          autoComplete="off"
          role="combobox"
          aria-expanded={show}
          aria-controls={listId}
          aria-label={placeholder}
          className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-[13.5px] text-ink outline-none placeholder:text-ink-mute"
        />
      </div>
      {show && (
        <ul id={listId} role="listbox" className="pop mt-1 max-h-80 overflow-y-auto overscroll-contain p-1">
          {matches.map((p, i) => (
            <li key={p.email} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(p)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${i === active ? "bg-hover" : "hover:bg-hover"}`}
              >
                <Avatar name={p.name} email={p.email} size={26} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] text-ink">{p.name}</span>
                  <span className="block truncate text-[12px] text-ink-mute">{p.email}</span>
                </span>
              </button>
            </li>
          ))}
          {canFree && (
            <li role="option" aria-selected>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add({ email: free, name: free })}
                className="flex w-full items-center gap-2.5 rounded-md bg-hover px-2 py-1.5 text-left text-[13.5px] text-ink"
              >
                <Avatar name={free} email={free} size={26} />
                {t("addEmail", { email: free })}
              </button>
            </li>
          )}
        </ul>
      )}
      {people === null && <p className="mt-1.5 text-[12px] text-ink-mute">{t("loadingPeople")}</p>}
      {people !== null && people.length === 0 && !allowFree && <p className="mt-1.5 text-[12px] text-ink-mute">{t("noDirectory")}</p>}
    </div>
  );
}

/** Centered modal dialog with a title bar; closes on Escape and backdrop click. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const t = useTranslations("chat");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`pop flex max-h-[88dvh] w-full flex-col ${wide ? "max-w-xl" : "max-w-md"}`}>
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
          <h2 className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-ink">{title}</h2>
          <button type="button" onClick={onClose} className="icon-btn h-8 w-8" aria-label={t("close")}>
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[12.5px] font-medium text-ink-soft">
      {children}
    </label>
  );
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Short timestamp for lists: time today, weekday this week, date otherwise. */
export function shortTime(ms: number, locale: string): string {
  const d = new Date(ms);
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (now.getTime() - ms < 6 * 86_400_000) return d.toLocaleDateString(locale, { weekday: "short" });
  return d.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

export const timeOf = (ms: number, locale: string) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

export function dayLabel(ms: number, locale: string, t: (k: "today" | "yesterday") => string): string {
  const d = new Date(ms);
  const now = new Date();
  if (sameDay(d, now)) return t("today");
  if (sameDay(d, new Date(now.getTime() - 86_400_000))) return t("yesterday");
  return d.toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

export const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** Error code from an action → translated message. */
export function useErrorText() {
  const t = useTranslations("chat");
  return (code: string) => (t.has(`errors.${code}`) ? t(`errors.${code}` as "errors.failed") : t("errors.failed"));
}

/** Opens a meeting in a new tab; the tab is opened synchronously so popup blockers allow it. */
export async function openMeeting(getCode: () => Promise<string | null>) {
  const w = window.open("about:blank", "_blank");
  const code = await getCode();
  if (!code) {
    w?.close();
    return false;
  }
  if (w) w.location.href = meetHref(code);
  else window.open(meetHref(code), "_blank");
  return true;
}
