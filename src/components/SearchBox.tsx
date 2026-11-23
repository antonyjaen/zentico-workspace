"use client";

import { Search, SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getSearchScopes } from "@/app/(apps)/mail/actions";
import type { Label } from "@/lib/mail-labels";
import { usePopover } from "./usePopover";

type Scopes = Awaited<ReturnType<typeof getSearchScopes>>;
const FIELDS = ["from", "to", "subject", "q", "not", "within", "in"] as const;
type Field = (typeof FIELDS)[number];

/** Mail search field; "/" focuses it from anywhere (unless typing in another field). */
export function SearchBox({ placeholder, defaultValue }: { placeholder: string; defaultValue?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const pathname = usePathname();
  const onMail = pathname.startsWith("/mail");

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
    <div className="relative hidden max-w-[640px] flex-1 sm:block">
      <form
        action="/mail/search"
        role="search"
        onSubmit={(e) => {
          // Keep searching the mailbox being viewed (another address or a shared one).
          const field = e.currentTarget.elements.namedItem("account") as HTMLInputElement | null;
          const account = new URLSearchParams(window.location.search).get("account");
          if (field) {
            field.value = account ?? "";
            field.disabled = !account;
          }
        }}
      >
        <input type="hidden" name="account" disabled />
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
          {onMail && <span className="w-8 shrink-0" aria-hidden />}
          <kbd className="kbd">/</kbd>
        </label>
      </form>
      {onMail && <AdvancedSearch mainInput={input} />}
    </div>
  );
}

/** Gmail-style "show search options" panel that builds /mail/search?from=…&to=…&in=… */
function AdvancedSearch({ mainInput }: { mainInput: React.RefObject<HTMLInputElement | null> }) {
  const t = useTranslations("mailActions.search");
  const { open, toggle, setOpen, ref } = usePopover();

  return (
    <div ref={ref}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={t("options")}
        title={t("options")}
        className="icon-btn absolute top-1/2 right-10 h-8 w-8 -translate-y-1/2"
      >
        <SlidersHorizontal size={15} aria-hidden />
      </button>
      {open && (
        <AdvancedSearchForm
          initialQuery={mainInput.current?.value}
          onDone={() => setOpen(false)}
          className="pop absolute top-12 right-0 left-0 z-50 grid grid-cols-[120px_1fr] items-center gap-x-4 gap-y-2.5 p-5 text-[13.5px] text-ink-soft"
          style={{ transformOrigin: "top center" }}
        />
      )}
    </div>
  );
}

// Folders and labels for the "Search in" select, fetched once per page load.
let scopesCache: Promise<Scopes> | null = null;
const loadScopes = () =>
  (scopesCache ??= getSearchScopes().catch(() => {
    scopesCache = null;
    return { folders: [], labels: [] };
  }));

/**
 * The advanced search fields (from, to, subject, words, not, within, in, attachment). Starts from
 * the current search, if any. `stacked` lays it out as a full-width phone form.
 */
export function AdvancedSearchForm({
  initialQuery,
  onDone,
  className,
  style,
  stacked = false,
}: {
  initialQuery?: string;
  onDone: () => void;
  className: string;
  style?: React.CSSProperties;
  stacked?: boolean;
}) {
  const t = useTranslations("mailActions.search");
  const router = useRouter();
  const [scopes, setScopes] = useState<Scopes | null>(null);
  const [values, setValues] = useState<Record<Field, string>>(() => blank());
  const [att, setAtt] = useState(false);

  useEffect(() => {
    // Start from the current search (if any) and the text typed in the main box.
    const sp = new URLSearchParams(window.location.pathname === "/mail/search" ? window.location.search : "");
    const next = blank();
    for (const f of FIELDS) next[f] = sp.get(f) ?? "";
    if (initialQuery) next.q = initialQuery;
    setValues(next);
    setAtt(sp.get("att") === "1");
    let live = true;
    loadScopes().then((s) => live && setScopes(s));
    return () => {
      live = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (f: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [f]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const qs = new URLSearchParams();
    for (const f of FIELDS) if (values[f].trim()) qs.set(f, values[f].trim());
    if (att) qs.set("att", "1");
    if (![...qs.keys()].length) return;
    const account = new URLSearchParams(window.location.search).get("account");
    if (account) qs.set("account", account);
    onDone();
    router.push(`/mail/search?${qs.toString()}`);
  };

  // 16px text on phones keeps iOS from zooming into the focused field.
  const inputCls = stacked
    ? "h-11 w-full rounded-md border border-line-strong bg-sheet px-3 text-[16px] text-ink outline-none placeholder:text-ink-mute focus:border-ink"
    : "h-9 w-full rounded-md border border-line-strong bg-sheet px-3 text-[14px] text-ink outline-none placeholder:text-ink-mute focus:border-ink";
  const btn = stacked ? "h-11 flex-1 justify-center" : "h-9";
  // Phones lead with the words to search for; the desktop panel keeps Gmail's order.
  const textFields = stacked ? (["q", "from", "to", "subject", "not"] as const) : (["from", "to", "subject", "q", "not"] as const);
  const first = stacked ? "q" : "from";

  return (
    <form onSubmit={submit} aria-label={t("options")} className={className} style={style}>
      {textFields.map((f) => (
        <Row key={f} label={t(`fields.${f}`)} id={`as-${f}`} stacked={stacked}>
          <input
            id={`as-${f}`}
            type={stacked && f === "q" ? "search" : undefined}
            enterKeyHint={stacked ? "search" : undefined}
            value={values[f]}
            onChange={set(f)}
            maxLength={200}
            className={inputCls}
            autoFocus={f === first}
          />
        </Row>
      ))}
      <Row label={t("fields.within")} id="as-within" stacked={stacked}>
        <select id="as-within" value={values.within} onChange={set("within")} className={inputCls}>
          <option value="">{t("anyTime")}</option>
          {(["1d", "3d", "1w", "2w", "1m", "6m", "1y"] as const).map((w) => (
            <option key={w} value={w}>
              {t(`within.${w}`)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("fields.in")} id="as-in" stacked={stacked}>
        <select id="as-in" value={values.in} onChange={set("in")} className={inputCls}>
          <option value="">{t("allMail")}</option>
          {scopes?.folders.length ? (
            <optgroup label={t("folders")}>
              {scopes.folders.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {scopes?.labels.length ? (
            <optgroup label={t("labels")}>
              {scopes.labels.map((l: Label) => (
                <option key={l.id} value={`label:${l.id}`}>
                  {l.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </Row>
      {!stacked && <span />}
      <label className={`flex items-center gap-2 ${stacked ? "min-h-11" : ""}`}>
        <input type="checkbox" className={stacked ? "h-5 w-5 accent-primary" : "h-4 w-4 accent-primary"} checked={att} onChange={(e) => setAtt(e.target.checked)} />
        {t("fields.att")}
      </label>
      <div className={stacked ? "mt-2 flex gap-2" : "col-span-2 mt-2 flex justify-end gap-2"}>
        <button
          type="button"
          className={`inline-flex ${btn} items-center rounded-md px-3 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink`}
          onClick={() => {
            setValues(blank());
            setAtt(false);
          }}
        >
          {t("clear")}
        </button>
        <button
          type="submit"
          className={`inline-flex ${btn} items-center rounded-md bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors hover:bg-primary-hover`}
        >
          {t("submit")}
        </button>
      </div>
    </form>
  );
}

function Row({ label, id, stacked, children }: { label: string; id: string; stacked: boolean; children: React.ReactNode }) {
  if (stacked)
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-[13px] font-medium text-ink-soft">
          {label}
        </label>
        {children}
      </div>
    );
  return (
    <>
      <label htmlFor={id} className="text-ink-soft">
        {label}
      </label>
      {children}
    </>
  );
}

const blank = (): Record<Field, string> => ({ from: "", to: "", subject: "", q: "", not: "", within: "", in: "" });
