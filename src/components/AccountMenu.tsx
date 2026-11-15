"use client";

import { ExternalLink, Languages, LogOut } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocale } from "@/lib/preferences";
import { usePopover } from "./usePopover";

function initials(name: string) {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function AccountMenu({
  name,
  email,
  accountUrl,
}: {
  name: string;
  email: string;
  accountUrl: string;
}) {
  const t = useTranslations("account");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { open, toggle, ref } = usePopover();

  const switchLocale = (next: "es" | "en") =>
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={t("menu")}
        aria-expanded={open}
        className="ml-1 grid h-9 w-9 place-items-center rounded-full bg-primary text-[13px] font-semibold text-primary-ink ring-offset-2 ring-offset-canvas transition-shadow hover:ring-2 hover:ring-primary-soft"
      >
        {initials(name)}
      </button>
      {open && (
        <div role="menu" className="pop absolute right-0 top-12 z-50 w-[300px] p-2">
          <div className="flex items-center gap-3 px-3 py-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary text-[15px] font-semibold text-primary-ink">
              {initials(name)}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-medium text-ink">{name}</span>
              <span className="block truncate text-[13px] text-ink-mute">{email}</span>
            </span>
          </div>

          <a
            href={accountUrl}
            target="_blank"
            rel="noreferrer"
            className="mx-1 mb-2 flex items-center justify-center gap-2 rounded-full border border-line-strong px-4 py-2 text-[13.5px] font-medium text-ink-soft transition-colors hover:bg-hover hover:text-ink"
          >
            {t("manage")}
            <ExternalLink size={14} aria-hidden />
          </a>

          <div className="border-t border-line px-3 py-3">
            <p className="mb-2 flex items-center gap-2 text-[12.5px] text-ink-mute">
              <Languages size={14} aria-hidden /> {t("language")}
            </p>
            <div className="grid grid-cols-2 gap-1 rounded-full bg-sheet-muted p-1" role="radiogroup">
              {(["es", "en"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={locale === l}
                  disabled={pending}
                  onClick={() => switchLocale(l)}
                  className="rounded-full py-1.5 font-mono text-[12px] uppercase tracking-[0.12em] text-ink-mute transition-colors aria-checked:bg-sheet aria-checked:text-ink aria-checked:shadow-sm"
                >
                  {l === "es" ? "Español" : "English"}
                </button>
              ))}
            </div>
          </div>

          <form action="/api/auth/logout" method="post" className="border-t border-line p-1 pt-2">
            <button
              type="submit"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
            >
              <LogOut size={16} aria-hidden /> {t("signout")}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
