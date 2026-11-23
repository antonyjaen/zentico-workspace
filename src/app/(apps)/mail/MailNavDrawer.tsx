"use client";

import { Settings, X } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const OpenNav = createContext<(() => void) | null>(null);

/** Opens the phone/tablet mailbox drawer; null outside the mail layout. */
export const useOpenMailNav = () => useContext(OpenNav);

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Below `lg` the mail sidebar is hidden; this renders the same sidebar content (compose button,
 * folders and labels of every address) in a left drawer that list headers open with `useOpenMailNav`.
 */
export function MailNavDrawer({ nav, children }: { nav: React.ReactNode; children: React.ReactNode }) {
  const t = useTranslations("mailActions.mobile");
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    opener.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    opener.current?.focus?.();
  }, []);

  // Any navigation (folder, label, another address, compose) closes the drawer.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("[data-drawer-close]")?.focus();
    // The drawer is lg:hidden; if the window grows past lg, drop it.
    const wide = window.matchMedia("(min-width: 64rem)");
    const onWide = () => wide.matches && setOpen(false);
    wide.addEventListener("change", onWide);
    return () => wide.removeEventListener("change", onWide);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // Let inline editors (rename/new folder) and open folder/label menus close first.
      if ((e.target as HTMLElement).tagName === "INPUT" || panel.current?.querySelector('[role="menu"]')) return;
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <OpenNav.Provider value={show}>
      {children}
      {open && (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <div className="mail-drawer-fade absolute inset-0 bg-black/40" aria-hidden onClick={close} />
          <div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={t("folders")}
            onKeyDown={onKeyDown}
            onClick={(e) => {
              // Same-URL links (e.g. the open folder) don't change the pathname: close on any link tap.
              if ((e.target as HTMLElement).closest("a[href]")) setOpen(false);
            }}
            className="mail-drawer-in absolute inset-y-0 left-0 flex w-[min(304px,86vw)] flex-col bg-sheet pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-[var(--shadow-pop)]"
          >
            <div className="flex h-14 shrink-0 items-center justify-between pr-2 pl-4">
              <span className="text-[15px] font-medium text-ink">{t("mail")}</span>
              <button type="button" data-drawer-close className="icon-btn h-10 w-10" aria-label={t("closeFolders")} onClick={close}>
                <X size={18} aria-hidden />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col pl-2">{nav}</div>
            <Link
              href="/mail/settings"
              className="flex h-12 shrink-0 items-center gap-3 border-t border-line px-5 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
            >
              <Settings size={16} aria-hidden />
              {t("mailSettings")}
            </Link>
          </div>
          <style>{`
            @keyframes mail-drawer-in{from{transform:translateX(-100%)}to{transform:none}}
            @keyframes mail-drawer-fade{from{opacity:0}to{opacity:1}}
            .mail-drawer-in{animation:mail-drawer-in 200ms var(--ease-out-soft)}
            .mail-drawer-fade{animation:mail-drawer-fade 200ms ease-out}
            @media (prefers-reduced-motion:reduce){.mail-drawer-in,.mail-drawer-fade{animation:none}}
          `}</style>
        </div>
      )}
    </OpenNav.Provider>
  );
}
