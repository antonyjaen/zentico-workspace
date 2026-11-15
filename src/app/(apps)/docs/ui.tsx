import { FileSpreadsheet, FileText, Presentation, type LucideIcon } from "lucide-react";
import type { DocKind } from "@/lib/wopi";

export const KIND_ICON: Record<DocKind, LucideIcon> = {
  text: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
};

/** Centered empty/error state used across Docs pages. */
export function Notice({ icon: Icon = FileText, title, hint, children }: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
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
