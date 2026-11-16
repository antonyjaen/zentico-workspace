import { getLocale } from "next-intl/server";
import { LogoMark } from "@/components/Logo";
import { LocaleSwitch } from "./LocaleSwitch";

/** Chrome of the public booking pages: no workspace UI, just a small header and a centered column. */
export async function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  const locale = await getLocale();
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
        <span className="flex items-center gap-2 text-[13px] font-medium text-ink-soft">
          <LogoMark size={22} />
          Zentico
        </span>
        <LocaleSwitch locale={locale === "en" ? "en" : "es"} />
      </header>
      <main className={`mx-auto w-full px-4 pb-12 ${wide ? "max-w-5xl" : "max-w-2xl"}`}>{children}</main>
    </div>
  );
}

export const BTN_PRIMARY =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors hover:bg-primary-hover disabled:opacity-50";
export const BTN_SECONDARY =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-line px-4 text-[14px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:opacity-50";
export const INPUT =
  "h-10 w-full rounded-lg border border-line bg-sheet px-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-mute hover:border-line-strong focus:border-ink-mute";
