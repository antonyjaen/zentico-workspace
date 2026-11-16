"use client";

import { Bell, ExternalLink, Languages, LogOut, Plug, UserPlus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import type { AccountSummary } from "@/lib/auth";
import { initials as initialsOf } from "@/app/(apps)/contacts/hrefs";
import { usePopover } from "./usePopover";

/** Deterministic two-hue gradient per account, so every user gets a recognizable avatar. */
function avatarGradient(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 80)) % 360;
  return `linear-gradient(135deg, oklch(0.72 0.16 ${a}), oklch(0.62 0.18 ${b}))`;
}

function initials(name: string, email: string) {
  return initialsOf(name.trim() && !name.includes("@") ? name : email);
}

const domainOf = (email: string) => email.split("@")[1] ?? email;

function Avatar({ account, size }: { account: Pick<AccountSummary, "name" | "email">; size: number }) {
  return (
    <span
      className="grid shrink-0 select-none place-items-center rounded-full font-semibold text-white ring-1 ring-line"
      style={{ background: avatarGradient(account.email), width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden
    >
      {initials(account.name, account.email)}
    </span>
  );
}

const itemClass =
  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink";

export function AccountMenu({ accounts, accountUrl }: { accounts: AccountSummary[]; accountUrl: string }) {
  const t = useTranslations("account");
  const tn = useTranslations("notifications");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const { open, toggle, ref } = usePopover();

  const active = accounts.find((a) => a.active) ?? accounts[0];
  const others = accounts.filter((a) => a !== active);
  const multiple = accounts.length > 1;

  // Written client-side (the cookie isn't httpOnly) instead of via a server action, so it keeps
  // working in tabs left open across a deploy, where stale action ids fail silently.
  const switchLocale = (next: "es" | "en") =>
    startTransition(() => {
      document.cookie = `zw_locale=${next}; path=/; max-age=31536000; samesite=lax`;
      router.refresh();
    });

  if (!active) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={`${t("menu")}: ${active.email}`}
        aria-haspopup="true"
        aria-expanded={open}
        className="group ml-1 flex items-center gap-1.5 rounded-full"
      >
        {multiple && (
          <span className="hidden h-6 max-w-[150px] items-center truncate rounded-full border border-line bg-sheet-muted px-2 text-[12px] text-ink-soft transition-colors group-hover:border-line-strong sm:inline-flex">
            {domainOf(active.email)}
          </span>
        )}
        <span className="rounded-full transition-shadow group-hover:ring-2 group-hover:ring-line-strong">
          <Avatar account={active} size={32} />
        </span>
      </button>
      {open && (
        <div role="menu" className="pop absolute right-0 top-12 z-50 w-[320px] p-2">
          <div className="flex items-center gap-3 px-3 py-3">
            <Avatar account={active} size={40} />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-medium text-ink">{active.name}</span>
              <span className="block truncate text-[13px] text-ink-mute">{active.email}</span>
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
            {others.length > 0 && (
              <ul aria-label={t("otherAccounts")}>
                {others.map((account) => (
                  <li key={account.slot}>
                    <form action="/api/auth/switch" method="post">
                      <input type="hidden" name="slot" value={account.slot} />
                      <input type="hidden" name="returnTo" value={pathname} />
                      <button type="submit" aria-label={t("switchTo", { email: account.email })} className={itemClass}>
                        <Avatar account={account} size={28} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] text-ink">{account.name}</span>
                          <span className="block truncate text-[12.5px] text-ink-mute">{account.email}</span>
                        </span>
                        {account.expired && (
                          <span className="shrink-0 rounded-md border border-line bg-sheet-muted px-1.5 py-0.5 text-[11px] text-ink-mute">
                            {t("signedOut")}
                          </span>
                        )}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <a href={`/api/auth/login?add=1&returnTo=${encodeURIComponent(pathname)}`} className={itemClass}>
              <UserPlus size={16} aria-hidden /> {t("addAccount")}
            </a>
          </div>

          <div className="border-t border-line p-1 py-1.5">
            <Link href="/settings/integrations" onClick={toggle} className={itemClass}>
              <Plug size={16} aria-hidden /> {locale === "es" ? "Integraciones (Claude / MCP)" : "Integrations (Claude / MCP)"}
            </Link>
            <Link href="/settings/notifications" onClick={toggle} className={itemClass}>
              <Bell size={16} aria-hidden /> {tn("title")}
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

          <div className="border-t border-line p-1 pt-2">
            <form action="/api/auth/logout" method="post">
              <input type="hidden" name="scope" value="current" />
              <input type="hidden" name="returnTo" value={pathname} />
              <button type="submit" className={itemClass}>
                <LogOut size={16} aria-hidden /> {multiple ? t("signoutCurrent") : t("signout")}
              </button>
            </form>
            {multiple && (
              <form action="/api/auth/logout" method="post">
                <input type="hidden" name="scope" value="all" />
                <button type="submit" className={itemClass}>
                  <LogOut size={16} className="opacity-0" aria-hidden /> {t("signoutAll")}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
