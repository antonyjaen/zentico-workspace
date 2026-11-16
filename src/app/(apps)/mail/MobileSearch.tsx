"use client";

import { ArrowLeft, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { AdvancedSearchForm } from "@/components/SearchBox";

/**
 * Phone search (the top-bar search box is hidden below `sm`): a button that opens the advanced
 * search form full screen. Submitting goes to the same /mail/search route.
 */
export function MobileSearch() {
  const t = useTranslations("mailActions.mobile");
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-btn h-10 w-10 sm:hidden"
        aria-label={t("search")}
        title={t("search")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Search size={18} aria-hidden />
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("search")}
          className="fixed inset-0 z-[60] flex flex-col bg-sheet pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:hidden"
        >
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-2">
            <button type="button" className="icon-btn h-10 w-10" aria-label={t("closeSearch")} onClick={close}>
              <ArrowLeft size={18} aria-hidden />
            </button>
            <h2 className="text-[16px] font-medium text-ink">{t("search")}</h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AdvancedSearchForm stacked onDone={() => setOpen(false)} className="flex flex-col gap-4 p-4 text-[14px] text-ink-soft" />
          </div>
        </div>
      )}
    </>
  );
}
