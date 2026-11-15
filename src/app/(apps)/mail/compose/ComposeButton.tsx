"use client";

import { Pencil } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { composeHref } from "../hrefs";

const CLASS =
  "mb-4 ml-1 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors duration-150 hover:bg-primary-hover";

/** Opens a new message on top of the current view. */
export function ComposeButton({ label }: { label: string }) {
  const pathname = usePathname();
  const qs = useSearchParams().toString();
  return (
    <Link href={composeHref(qs ? `${pathname}?${qs}` : pathname, "new")} scroll={false} className={CLASS}>
      <Pencil size={15} aria-hidden />
      {label}
    </Link>
  );
}

/** Server-render fallback while search params are not yet available. */
export function ComposeButtonFallback({ label }: { label: string }) {
  return (
    <Link href="/mail?compose=new" className={CLASS}>
      <Pencil size={15} aria-hidden />
      {label}
    </Link>
  );
}
