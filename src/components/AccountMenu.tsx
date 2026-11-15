"use client";

import { ExternalLink, Languages, LogOut, Plug } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocale } from "@/lib/preferences";
import { usePopover } from "./usePopover";

/** Deterministic two-hue gradient per account, so every user gets a recognizable avatar. */
function avatarGradient(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 80)) % 360;
  return `linear-gradient(135deg, oklch(0.72 0.16 ${a}), oklch(0.62 0.18 ${b}))`;
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
        className="ml-1 h-8 w-8 rounded-full ring-1 ring-line transition-shadow hover:ring-2 hover:ring-line-strong"
        style={{ background: avatarGradient(email) }}
      />
      {open && (
        <div role="menu" className="pop absolute right-0 top-12 z-50 w-[300px] p-2">
          <div className="flex items-center gap-3 px-3 py-3">
            <span
              className="h-10 w-10 shrink-0 rounded-full ring-1 ring-line"
              style={{ background: avatarGradient(email) }}
              aria-hidden
            />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-medium text-ink">{name}</span>
              <span className="block truncate text-[13px] text-ink-mute">{email}</span>
            </span>
          </div>

          <a
            href={accountUrl}
            target="_blank"
            rel="noreferrer"
            className="mx-1 mb-2 flex h-9 items-center justify-center gap-2 rounded-lg border border-line px-4 text-[13.5px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
          >
            {t("manage")}
            <ExternalLink size={14} aria-hidden />
          </a>

          <div className="border-t border-line p-1 py-1.5">
            <Link
              href="/settings/integrations"
              onClick={toggle}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
            >
              <Plug size={16} aria-hidden /> {locale === "es" ? "Integraciones (Claude / MCP)" : "Integrations (Claude / MCP)"}
            </Link>
          </div>

          <div className="border-t border-line px-3 py-3">
            <p className="mb-2 flex items-center gap-2 text-[12.5px] text-ink-mute">
              <Languages size={14} aria-hidden /> {t("language")}
            </p>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-sheet-muted p-1" role="radiogroup">
              {(["es", "en"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={locale === l}
                  disabled={pending}
                  onClick={() => switchLocale(l)}
                  className="rounded-md py-1.5 text-[13px] text-ink-mute transition-colors aria-checked:bg-sheet aria-checked:text-ink aria-checked:shadow-[0_0_0_1px_var(--color-line)]"
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
