"use client";

import { useTranslations } from "next-intl";
import type { ActionResult } from "./actions";

export const inputCls =
  "h-10 sm:h-9 w-full rounded-md border border-line-strong bg-sheet px-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-mute focus:border-ink disabled:opacity-60";
export const textareaCls =
  "w-full rounded-md border border-line-strong bg-sheet px-3 py-2 text-[14px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-mute focus:border-ink";
export const primaryBtn =
  "inline-flex h-10 sm:h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60";
export const secondaryBtn =
  "inline-flex h-10 sm:h-9 items-center justify-center gap-2 rounded-md border border-line-strong px-3 text-[14px] text-ink transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60";
export const labelCls = "mb-1.5 block text-[13px] font-medium text-ink-soft";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ink-mute">{hint}</span>}
    </label>
  );
}

/** Inline result of a save: "Saved" or a translated error. */
export function Status({ result }: { result: ActionResult | null }) {
  const t = useTranslations("mailSettings.errors");
  if (!result) return null;
  if (result.ok)
    return (
      <span role="status" className="font-mono text-[12px] uppercase tracking-[0.15em] text-signal">
        {t("saved")}
      </span>
    );
  return (
    <span role="alert" className="text-[13px] text-danger">
      {t.has(result.error) ? t(result.error) : t("unknown")}
      {result.detail && <span className="block font-mono text-[11.5px] text-ink-mute">{result.detail}</span>}
    </span>
  );
}
