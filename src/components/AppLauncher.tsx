"use client";

import { Grip } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { APPS } from "./apps";
import { usePopover } from "./usePopover";

export function AppLauncher() {
  const t = useTranslations("apps");
  const { open, toggle, setOpen, ref } = usePopover();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="icon-btn"
        aria-label={t("launcher")}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggle}
      >
        <Grip size={20} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="pop absolute right-0 top-12 z-50 w-[300px] p-3">
          <p className="px-2 pb-2 font-mono text-[10.5px] uppercase tracking-[0.2em] text-ink-mute">
            {t("launcher")}
          </p>
          <div className="grid grid-cols-3 gap-1">
            {APPS.map(({ id, href, icon: Icon, color }) => (
              <Link
                key={id}
                role="menuitem"
                href={href}
                onClick={() => setOpen(false)}
                className="flex flex-col items-center gap-2 rounded-xl px-2 py-3 text-[12.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
              >
                <span
                  className="grid h-11 w-11 place-items-center rounded-2xl"
                  style={{ background: `color-mix(in oklab, ${color} 14%, transparent)`, color }}
                >
                  <Icon size={22} aria-hidden />
                </span>
                {t(id)}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
