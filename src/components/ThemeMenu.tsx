"use client";

import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { setTheme } from "@/lib/preferences";
import type { Theme } from "@/lib/theme";
import { usePopover } from "./usePopover";

function apply(pref: Theme) {
  const d = document.documentElement;
  d.dataset.themePref = pref;
  d.dataset.theme =
    pref === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : pref;
}

export function ThemeMenu() {
  const t = useTranslations("topbar");
  const { open, toggle, setOpen, ref } = usePopover();
  const [pref, setPref] = useState<Theme>("system");
  const [, startTransition] = useTransition();

  useEffect(() => {
    setPref((document.documentElement.dataset.themePref as Theme) ?? "system");
  }, []);

  const options: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "light", label: t("themeLight"), icon: Sun },
    { value: "dark", label: t("themeDark"), icon: Moon },
    { value: "system", label: t("themeSystem"), icon: Monitor },
  ];
  const Current = options.find((o) => o.value === pref)?.icon ?? Monitor;

  return (
    <div ref={ref} className="relative">
      <button type="button" className="icon-btn" aria-label={t("theme")} aria-expanded={open} onClick={toggle}>
        <Current size={19} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="pop absolute right-0 top-12 z-50 w-44 p-1.5">
          {options.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              role="menuitemradio"
              aria-checked={pref === value}
              type="button"
              onClick={() => {
                setPref(value);
                apply(value);
                setOpen(false);
                startTransition(() => setTheme(value));
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
            >
              <Icon size={16} aria-hidden />
              <span className="flex-1">{label}</span>
              {pref === value && <Check size={15} className="text-primary" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
