import { FileSpreadsheet, FileText, Presentation, type LucideIcon } from "lucide-react";
import type { DocKind } from "./shared";

export const KIND_ICON: Record<DocKind, LucideIcon> = {
  text: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
};

/** Per-kind tint, matching Drive's file icons. */
export const KIND_COLOR: Record<DocKind, string> = {
  text: "var(--color-app-mail)",
  spreadsheet: "var(--color-signal)",
  presentation: "var(--color-amber)",
};

export function DocIcon({ kind, size = 18, className = "" }: { kind: DocKind; size?: number; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon size={size} aria-hidden className={`shrink-0 ${className}`} style={{ color: KIND_COLOR[kind] }} />;
}

/** Centered empty/error state used across Docs pages. */
export function Notice({ icon: Icon = FileText, title, hint, children }: {
  icon?: LucideIcon;
  title: string;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="grid flex-1 place-items-center p-10 text-center">
      <div className="rise max-w-sm">
        <span
          className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-line bg-sheet-muted"
          style={{ color: "var(--color-app-docs)" }}
        >
          <Icon size={26} aria-hidden />
        </span>
        <p className="mt-6 text-[17px] font-medium text-ink">{title}</p>
        {hint && <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">{hint}</p>}
        {children}
      </div>
    </div>
  );
}

/** Pulsing placeholder block for loading skeletons. */
export function Bone({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`block animate-pulse rounded-md bg-hover ${className}`} />;
}
