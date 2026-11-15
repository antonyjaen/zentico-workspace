"use client";

// People on this server (JMAP principals): a cached directory, availability loading and a
// small combobox used by the people search, calendar sharing and the guest field.
import { Search, Users } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { BusyBlock, Principal } from "@/lib/calendar";
import { listPrincipals, principalsAvailability } from "./actions";
import { FIELD, matches } from "./shared";

let directory: Promise<Principal[]> | null = null;

/** All principals, loaded once per page (null while loading; [] when unavailable). */
export function usePrincipals(): Principal[] | null {
  const [list, setList] = useState<Principal[] | null>(null);
  useEffect(() => {
    directory ??= listPrincipals().then((r) => {
      if (!r.ok) directory = null;
      return r.ok ? (r.data ?? []) : [];
    });
    let live = true;
    directory.then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, []);
  return list;
}

/** Busy blocks per principal id for [start, end); refetched when the inputs change. */
export function useAvailability(ids: string[], start: number, end: number): Record<string, BusyBlock[]> {
  const [data, setData] = useState<Record<string, BusyBlock[]>>({});
  const idsKey = [...ids].sort().join(",");
  useEffect(() => {
    if (!idsKey) {
      setData({});
      return;
    }
    let live = true;
    principalsAvailability(idsKey.split(","), start, end).then((r) => {
      if (live && r.ok) setData(r.data ?? {});
    });
    return () => {
      live = false;
    };
  }, [idsKey, start, end]);
  return data;
}

export type ComboItem = { key: string; label: string; sub?: string; group?: boolean };

/** A text input with a suggestion list (arrow keys + Enter, or click). */
export function Combobox({
  value,
  onChange,
  items,
  onPick,
  onEnter,
  placeholder,
  label,
  icon = true,
  inputClass = "",
}: {
  value: string;
  onChange: (v: string) => void;
  items: ComboItem[];
  onPick: (item: ComboItem) => void;
  /** Enter / comma with no highlighted suggestion (free text). */
  onEnter?: () => void;
  placeholder: string;
  label: string;
  icon?: boolean;
  inputClass?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const show = open && value.trim() !== "" && items.length > 0;

  useEffect(() => setActive(-1), [value]);

  function pick(item: ComboItem) {
    onPick(item);
    setActive(-1);
  }

  return (
    <div className="relative min-w-0 flex-1">
      {icon && <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-mute" />}
      <input
        type="text"
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={show && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && show) {
            e.preventDefault();
            setActive((a) => (a + 1) % items.length);
          } else if (e.key === "ArrowUp" && show) {
            e.preventDefault();
            setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
          } else if (e.key === "Escape" && show) {
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === "Enter" || (e.key === "," && onEnter)) {
            if (show && active >= 0) {
              e.preventDefault();
              pick(items[active]);
            } else if (onEnter) {
              e.preventDefault();
              onEnter();
            } else if (show && items.length === 1) {
              e.preventDefault();
              pick(items[0]);
            }
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        className={`${FIELD} ${icon ? "pl-8" : ""} ${inputClass}`}
      />
      {show && (
        <ul id={listId} role="listbox" className="pop absolute inset-x-0 top-full z-50 mt-1 max-h-64 overflow-y-auto py-1">
          {items.map((it, i) => (
            <li
              key={it.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onPointerDown={(e) => {
                e.preventDefault();
                pick(it);
              }}
              onPointerEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] ${i === active ? "bg-hover" : ""}`}
            >
              {it.group && <Users size={13} aria-hidden className="shrink-0 text-ink-mute" />}
              <span className="min-w-0 flex-1 truncate">
                <span className="text-ink">{it.label}</span>
                {it.sub && it.sub !== it.label && <span className="ml-1.5 text-ink-mute">{it.sub}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Principals matching `q` by name or email, minus excluded ids (max `limit`). */
export function usePrincipalMatches(
  principals: Principal[] | null,
  q: string,
  opts: { exclude?: Set<string>; groups?: boolean; limit?: number } = {},
): Principal[] {
  const { exclude, groups = false, limit = 8 } = opts;
  return useMemo(() => {
    if (!principals || !q.trim()) return [];
    return principals
      .filter((p) => (p.type === "individual" || (groups && p.type === "group")) && !exclude?.has(p.id) && matches(q, p.name, p.email))
      .slice(0, limit);
  }, [principals, q, exclude, groups, limit]);
}

export const principalItem = (p: Principal): ComboItem => ({
  key: p.id,
  label: p.name || p.email,
  sub: p.email,
  group: p.type === "group",
});
